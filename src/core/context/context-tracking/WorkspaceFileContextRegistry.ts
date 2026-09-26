import { createHash } from "node:crypto"
import * as fs from "node:fs"
import { Logger } from "@shared/services/Logger"
import chokidar, { type ChokidarOptions, type FSWatcher } from "chokidar"
import * as path from "path"

/** Content identity of a file, or undefined when it cannot be read or is too large to hash. */
export type FileFingerprint = (absolutePath: string) => string | undefined

const MAX_FINGERPRINT_BYTES = 8 * 1024 * 1024

/**
 * Hash small files synchronously. Change events only arrive for files a task
 * has read or edited, and a bounded read keeps the event handler cheap.
 */
function defaultFingerprint(absolutePath: string): string | undefined {
	try {
		if (fs.statSync(absolutePath).size > MAX_FINGERPRINT_BYTES) return undefined
		return createHash("sha256").update(fs.readFileSync(absolutePath)).digest("hex")
	} catch {
		return undefined
	}
}

/**
 * Identity of a workspace file across path spellings.
 *
 * Relative and absolute spellings resolve to one absolute path; on Windows the
 * key is also case-folded because the file system is case-insensitive. The
 * function is idempotent, so a key can be passed back in as a path.
 */
export function fileContextKey(cwd: string, filePath: string): string {
	const absolutePath = path.resolve(cwd, filePath)
	return process.platform === "win32" ? absolutePath.toLowerCase() : absolutePath
}

/**
 * One tracker's handle on a shared workspace file watch.
 *
 * Disposing a subscription only detaches that tracker; the underlying watcher
 * stays alive until the last subscriber of the same absolute path releases it.
 */
export interface WorkspaceFileSubscription {
	dispose(): Promise<void>
}

export interface WorkspaceFileContextRegistryDeps {
	readonly watch?: (paths: string, options: ChokidarOptions) => FSWatcher
	readonly fingerprint?: FileFingerprint
}

/** Reported to every subscriber watching the changed path. */
export interface WorkspaceFileChange {
	/** Workspace-relative path as originally requested by the subscriber. */
	readonly filePath: string
	/** Monotonic registry revision assigned to this change. */
	readonly revision: number
	/**
	 * True for exactly one subscriber per change. That subscriber records the
	 * external edit in task metadata so a single edit is not written N times.
	 */
	readonly isMetadataAuthor: boolean
}

interface FileSubscriber {
	readonly filePath: string
	readonly onExternalChange: (change: WorkspaceFileChange) => void
}

interface WatchEntry {
	readonly absolutePath: string
	readonly watcher: FSWatcher
	readonly subscribers: Set<FileSubscriber>
}

const WATCH_OPTIONS: ChokidarOptions = {
	persistent: true, // Keep process alive while watching
	ignoreInitial: true, // Don't emit events for existing files on startup
	atomic: true, // Handle atomic writes (editors that use temp files)
	awaitWriteFinish: {
		// Wait for writes to finish before emitting events
		stabilityThreshold: 100, // Wait 100ms for file size to stabilize
		pollInterval: 100, // Check every 100ms while waiting
	},
}

/**
 * Share one file watcher per absolute path across every tracker of a workspace.
 *
 * The registry owns watcher lifetime, the monotonic revision of "this file's
 * content changed outside Dline", and the content baseline that decides it.
 * A change event only counts when the content differs from the baseline, so
 * metadata-only events are ignored. While Dline writes a file every event is
 * absorbed, and settling the write moves the baseline to the written content.
 * Acknowledgement cursors stay with each subscriber so one task consuming a
 * change never hides it from another.
 */
export class WorkspaceFileContextRegistry {
	private readonly watch: (paths: string, options: ChokidarOptions) => FSWatcher
	private readonly fingerprint: FileFingerprint
	/** Keyed by {@link fileContextKey}. */
	private readonly entries = new Map<string, WatchEntry>()
	private readonly revisions = new Map<string, number>()
	private readonly baselines = new Map<string, string | undefined>()
	private readonly selfEditsInProgress = new Set<string>()
	/** Writes in progress that already absorbed at least one change event. */
	private readonly absorbedSelfEdits = new Set<string>()
	/** Settled writes that could not be fingerprinted and whose event is still due. */
	private readonly unverifiedSelfEdits = new Set<string>()
	private revisionCounter = 0

	constructor(deps: WorkspaceFileContextRegistryDeps = {}) {
		this.watch = deps.watch ?? ((paths, options) => chokidar.watch(paths, options))
		this.fingerprint = deps.fingerprint ?? defaultFingerprint
	}

	/**
	 * Subscribe to a workspace-relative path.
	 *
	 * `cwd` and `filePath` are resolved to one absolute key so trackers that
	 * spell the same file differently still share a single watcher.
	 */
	subscribe(cwd: string, filePath: string, onExternalChange: (change: WorkspaceFileChange) => void): WorkspaceFileSubscription {
		const key = fileContextKey(cwd, filePath)
		const subscriber: FileSubscriber = { filePath, onExternalChange }
		const entry = this.entries.get(key) ?? this.createEntry(key, path.resolve(cwd, filePath))
		entry.subscribers.add(subscriber)

		let released = false
		return {
			dispose: async () => {
				if (released) return
				released = true
				await this.releaseSubscriber(key, entry, subscriber)
			},
		}
	}

	/**
	 * Mark a Dline write to a watched path as in progress.
	 *
	 * Every change event is absorbed until {@link settleSelfEdit} records the
	 * written content as the new baseline. The marker is workspace-wide, so no
	 * task reports another task's write. Paths without a live watcher are
	 * ignored: their baseline is taken when a watcher is created.
	 */
	markSelfEdit(cwd: string, filePath: string): void {
		const key = fileContextKey(cwd, filePath)
		if (!this.entries.has(key)) return
		this.selfEditsInProgress.add(key)
	}

	/**
	 * Finish a Dline write: the current content becomes the baseline, so a
	 * change event that arrives later for the same content is not reported.
	 */
	settleSelfEdit(cwd: string, filePath: string): void {
		const key = fileContextKey(cwd, filePath)
		const wasInProgress = this.selfEditsInProgress.delete(key)
		const eventAbsorbed = this.absorbedSelfEdits.delete(key)
		const entry = this.entries.get(key)
		if (!entry) return
		const fingerprint = this.fingerprint(entry.absolutePath)
		this.baselines.set(key, fingerprint)
		// Without a content identity the write's late event cannot be recognized,
		// so fall back to swallowing exactly one event, as a one-shot marker did.
		if (fingerprint === undefined && wasInProgress && !eventAbsorbed) {
			this.unverifiedSelfEdits.add(key)
		}
	}

	/** Current revision of a path, or 0 when no external change was observed. */
	getRevision(cwd: string, filePath: string): number {
		return this.revisions.get(fileContextKey(cwd, filePath)) ?? 0
	}

	/**
	 * Record an external edit that a caller observed outside the shared watcher,
	 * so it becomes visible to every task tracking the same path.
	 */
	recordExternalEdit(cwd: string, filePath: string): number {
		const key = fileContextKey(cwd, filePath)
		this.revisionCounter += 1
		this.revisions.set(key, this.revisionCounter)
		return this.revisionCounter
	}

	/**
	 * Record an externally supplied revision so restored task snapshots stay
	 * visible and keep the registry counter monotonic.
	 */
	adoptRevision(cwd: string, filePath: string, revision: number): void {
		if (!Number.isSafeInteger(revision) || revision <= 0) return
		const key = fileContextKey(cwd, filePath)
		const current = this.revisions.get(key) ?? 0
		if (revision > current) {
			this.revisions.set(key, revision)
		}
		this.revisionCounter = Math.max(this.revisionCounter, revision)
	}

	/** Close every shared watcher. Intended for host shutdown and test isolation. */
	async disposeAll(): Promise<void> {
		const entries = [...this.entries.values()]
		this.entries.clear()
		this.revisions.clear()
		this.baselines.clear()
		this.selfEditsInProgress.clear()
		this.absorbedSelfEdits.clear()
		this.unverifiedSelfEdits.clear()
		for (const entry of entries) {
			entry.subscribers.clear()
			await entry.watcher.close().catch((error) => {
				Logger.error("[WorkspaceFileContextRegistry] Failed to dispose shared watcher:", error)
			})
		}
	}

	private createEntry(key: string, absolutePath: string): WatchEntry {
		const subscribers = new Set<FileSubscriber>()
		const watcher = this.watch(absolutePath, WATCH_OPTIONS)
		const entry: WatchEntry = { absolutePath, watcher, subscribers }
		watcher.on("change", () => this.handleChange(key, entry))
		watcher.on("error", (error) => {
			Logger.error("[WorkspaceFileContextRegistry] Watch error:", error)
		})
		this.entries.set(key, entry)
		this.baselines.set(key, this.fingerprint(absolutePath))
		return entry
	}

	private handleChange(key: string, entry: WatchEntry): void {
		const current = this.fingerprint(entry.absolutePath)
		const baseline = this.baselines.get(key)
		this.baselines.set(key, current)
		// Dline is writing this file; its own events are never external edits.
		if (this.selfEditsInProgress.has(key)) {
			this.absorbedSelfEdits.add(key)
			return
		}
		if (current === undefined) {
			if (this.unverifiedSelfEdits.delete(key)) return
		} else {
			this.unverifiedSelfEdits.delete(key)
			// Same content as last seen: a metadata-only or duplicate event.
			if (current === baseline) return
		}

		this.revisionCounter += 1
		const revision = this.revisionCounter
		this.revisions.set(key, revision)
		let isMetadataAuthor = true
		for (const subscriber of [...entry.subscribers]) {
			try {
				subscriber.onExternalChange({ filePath: subscriber.filePath, revision, isMetadataAuthor })
				isMetadataAuthor = false
			} catch (error) {
				Logger.error("[WorkspaceFileContextRegistry] Subscriber notification failed:", error)
			}
		}
	}

	private async releaseSubscriber(key: string, entry: WatchEntry, subscriber: FileSubscriber): Promise<void> {
		entry.subscribers.delete(subscriber)
		if (entry.subscribers.size > 0) return
		if (this.entries.get(key) === entry) this.entries.delete(key)
		// Without a watcher no event can be absorbed or compared; keeping the
		// marker or baseline would misjudge the first event after a new watch.
		this.selfEditsInProgress.delete(key)
		this.absorbedSelfEdits.delete(key)
		this.unverifiedSelfEdits.delete(key)
		this.baselines.delete(key)
		await entry.watcher.close().catch((error) => {
			Logger.error("[WorkspaceFileContextRegistry] Failed to dispose shared watcher:", error)
		})
	}
}

let sharedRegistry: WorkspaceFileContextRegistry | undefined

/** Process-wide registry used by trackers; tests should construct their own instance. */
export function getWorkspaceFileContextRegistry(): WorkspaceFileContextRegistry {
	sharedRegistry ??= new WorkspaceFileContextRegistry()
	return sharedRegistry
}
