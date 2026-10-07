import path from "node:path"
import { Logger } from "@shared/services/Logger"
import type { ChokidarOptions, FSWatcher } from "chokidar"
import { type PromptInputFileChange, PromptInputFileWatcher, type PromptInputFileWatcherDeps } from "./PromptInputFileWatcher"

/** One task's handle on a process-owned workspace prompt-input monitor. */
export interface PromptInputWatcherSubscription {
	readonly ready: Promise<void>
	trackExact(paths: readonly string[]): Promise<void>
	untrackExact(paths: readonly string[]): Promise<void>
	dispose(): Promise<void>
}

export type WorkspacePromptInputWatcherSubscribeRequest = Omit<PromptInputFileWatcherDeps, "watch">

export interface WorkspacePromptInputWatcherRegistryDeps {
	readonly watch?: (paths: readonly string[], options: ChokidarOptions) => FSWatcher
}

interface WatcherSubscriber {
	readonly notify: (change: PromptInputFileChange) => void
	readonly shouldIgnoreDirectory?: (absolutePath: string) => boolean
	readonly trackedPaths: Set<string>
}

interface WorkspaceWatcherEntry {
	readonly watcher: PromptInputFileWatcher
	readonly started: Promise<void>
	readonly subscribers: Set<WatcherSubscriber>
	readonly trackedPathSubscribers: Map<string, Set<WatcherSubscriber>>
}

function resolveUnique(paths: readonly string[]): string[] {
	return Array.from(new Set(paths.map((candidate) => path.resolve(candidate)))).sort()
}

/** A directory is skipped only when every live subscriber ignores it. */
function shouldIgnoreForAnySubscriber(subscribers: ReadonlySet<WatcherSubscriber>, absolutePath: string): boolean {
	let hasOpinion = false
	for (const subscriber of subscribers) {
		if (!subscriber.shouldIgnoreDirectory) return false
		hasOpinion = true
		if (!subscriber.shouldIgnoreDirectory(absolutePath)) return false
	}
	return hasOpinion
}

function buildEntryKey(request: WorkspacePromptInputWatcherSubscribeRequest): string {
	return JSON.stringify({
		cwd: path.resolve(request.cwd),
		globalRules: path.resolve(request.globalRulesDirectory),
		workflows: resolveUnique(request.workflowDirectories),
		skills: resolveUnique(request.skillDirectories),
		subagents: resolveUnique(request.subagentDirectories),
	})
}

/**
 * Process-owned registry for prompt-input monitors.
 *
 * Task subscriptions only own callbacks and exact scoped paths. Empty entries
 * intentionally remain warm until host shutdown so sequential tasks do not pay
 * another cold filesystem scan.
 */
export class WorkspacePromptInputWatcherRegistry {
	private readonly watch?: (paths: readonly string[], options: ChokidarOptions) => FSWatcher
	private readonly entries = new Map<string, WorkspaceWatcherEntry>()

	constructor(deps: WorkspacePromptInputWatcherRegistryDeps = {}) {
		this.watch = deps.watch
	}

	async subscribe(request: WorkspacePromptInputWatcherSubscribeRequest): Promise<PromptInputWatcherSubscription> {
		const key = buildEntryKey(request)
		const subscriber: WatcherSubscriber = {
			notify: request.invalidate,
			...(request.shouldIgnoreDirectory ? { shouldIgnoreDirectory: request.shouldIgnoreDirectory } : {}),
			trackedPaths: new Set<string>(),
		}
		let entry = this.entries.get(key)
		if (entry) entry.subscribers.add(subscriber)
		else entry = this.createEntry(key, request, subscriber)

		let released = false
		return {
			ready: entry.started,
			trackExact: async (paths) => {
				if (!released) await this.trackSubscriberPaths(entry, subscriber, paths)
			},
			untrackExact: async (paths) => {
				if (!released) await this.untrackSubscriberPaths(entry, subscriber, paths)
			},
			dispose: async () => {
				if (released) return
				released = true
				await this.releaseSubscriber(entry, subscriber)
			},
		}
	}

	/** Close every process-owned monitor. Intended for host shutdown and test isolation. */
	async disposeAll(): Promise<void> {
		const entries = [...this.entries.values()]
		this.entries.clear()
		for (const entry of entries) {
			entry.subscribers.clear()
			entry.trackedPathSubscribers.clear()
			await entry.watcher.dispose().catch((error) => {
				Logger.error("[WorkspacePromptInputWatcherRegistry] Failed to dispose shared watcher:", error)
			})
		}
	}

	private createEntry(
		key: string,
		request: WorkspacePromptInputWatcherSubscribeRequest,
		firstSubscriber: WatcherSubscriber,
	): WorkspaceWatcherEntry {
		const subscribers = new Set<WatcherSubscriber>([firstSubscriber])
		const trackedPathSubscribers = new Map<string, Set<WatcherSubscriber>>()
		const watcher = new PromptInputFileWatcher({
			taskId: `workspace:${path.resolve(request.cwd)}`,
			cwd: request.cwd,
			globalRulesDirectory: request.globalRulesDirectory,
			workflowDirectories: request.workflowDirectories,
			skillDirectories: request.skillDirectories,
			subagentDirectories: request.subagentDirectories,
			invalidate: (change) => {
				const recipients =
					change.kind === "scoped_agents"
						? (trackedPathSubscribers.get(change.absolutePath) ?? new Set<WatcherSubscriber>())
						: subscribers
				for (const subscriber of [...recipients]) {
					try {
						subscriber.notify(change)
					} catch (error) {
						Logger.error("[WorkspacePromptInputWatcherRegistry] Subscriber invalidation failed:", error)
					}
				}
			},
			shouldIgnoreDirectory: (absolutePath: string) => shouldIgnoreForAnySubscriber(subscribers, absolutePath),
			...(this.watch ? { watch: this.watch } : {}),
		})
		const started = watcher.start()
		const entry: WorkspaceWatcherEntry = { watcher, started, subscribers, trackedPathSubscribers }
		this.entries.set(key, entry)
		started.catch(() => {
			if (this.entries.get(key) === entry) this.entries.delete(key)
		})
		return entry
	}

	private async trackSubscriberPaths(
		entry: WorkspaceWatcherEntry,
		subscriber: WatcherSubscriber,
		paths: readonly string[],
	): Promise<void> {
		const watcherAdditions: string[] = []
		for (const absolutePath of resolveUnique(paths)) {
			if (subscriber.trackedPaths.has(absolutePath)) continue
			subscriber.trackedPaths.add(absolutePath)
			let recipients = entry.trackedPathSubscribers.get(absolutePath)
			if (!recipients) {
				recipients = new Set<WatcherSubscriber>()
				entry.trackedPathSubscribers.set(absolutePath, recipients)
				watcherAdditions.push(absolutePath)
			}
			recipients.add(subscriber)
		}
		if (watcherAdditions.length > 0) await entry.watcher.trackExact(watcherAdditions)
	}

	private async untrackSubscriberPaths(
		entry: WorkspaceWatcherEntry,
		subscriber: WatcherSubscriber,
		paths: readonly string[],
	): Promise<void> {
		const watcherRemovals: string[] = []
		for (const absolutePath of resolveUnique(paths)) {
			if (!subscriber.trackedPaths.delete(absolutePath)) continue
			const recipients = entry.trackedPathSubscribers.get(absolutePath)
			recipients?.delete(subscriber)
			if (recipients?.size === 0) {
				entry.trackedPathSubscribers.delete(absolutePath)
				watcherRemovals.push(absolutePath)
			}
		}
		if (watcherRemovals.length > 0) await entry.watcher.untrackExact(watcherRemovals)
	}

	private async releaseSubscriber(entry: WorkspaceWatcherEntry, subscriber: WatcherSubscriber): Promise<void> {
		await this.untrackSubscriberPaths(entry, subscriber, [...subscriber.trackedPaths])
		entry.subscribers.delete(subscriber)
	}
}

let sharedRegistry: WorkspacePromptInputWatcherRegistry | undefined

/** Process-wide registry used by tasks; tests should construct their own instance. */
export function getWorkspacePromptInputWatcherRegistry(): WorkspacePromptInputWatcherRegistry {
	sharedRegistry ??= new WorkspacePromptInputWatcherRegistry()
	return sharedRegistry
}
