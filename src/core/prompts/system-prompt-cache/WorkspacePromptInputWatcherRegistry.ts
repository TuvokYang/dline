import path from "node:path"
import { Logger } from "@shared/services/Logger"
import type { ChokidarOptions, FSWatcher } from "chokidar"
import { PromptInputFileWatcher, type PromptInputFileWatcherDeps } from "./PromptInputFileWatcher"

/**
 * One task's handle on a shared workspace watcher.
 *
 * Disposing a subscription only detaches that task; the underlying recursive
 * watch stays alive until the last subscriber of the workspace releases it.
 */
export interface PromptInputWatcherSubscription {
	readonly ready: Promise<void>
	dispose(): Promise<void>
}

export type WorkspacePromptInputWatcherSubscribeRequest = Omit<PromptInputFileWatcherDeps, "watch">

export interface WorkspacePromptInputWatcherRegistryDeps {
	readonly watch?: (paths: readonly string[], options: ChokidarOptions) => FSWatcher
}

/**
 * One subscriber's contribution to a shared watch scope.
 *
 * The ignore predicate is kept per subscriber because it reads the owning
 * task's `IgnoreController`, whose rule snapshot dies with that task.
 */
interface WatcherSubscriber {
	readonly notify: () => void
	readonly shouldIgnoreDirectory?: (absolutePath: string) => boolean
}

interface WorkspaceWatcherEntry {
	readonly watcher: PromptInputFileWatcher
	readonly started: Promise<void>
	readonly subscribers: Set<WatcherSubscriber>
}

function resolveUnique(paths: readonly string[]): string[] {
	return Array.from(new Set(paths.map((candidate) => path.resolve(candidate)))).sort()
}

/**
 * A directory is skipped only when every live subscriber ignores it.
 *
 * Subscribers hold different ignore rules while their controllers reload, so
 * traversing on any dissent keeps the shared watch a superset of what each task
 * would have watched alone. Over-watching only costs a redundant invalidation,
 * whereas under-watching would silently drop a prompt-input change.
 */
function shouldIgnoreForAnySubscriber(subscribers: ReadonlySet<WatcherSubscriber>, absolutePath: string): boolean {
	let hasOpinion = false
	for (const subscriber of subscribers) {
		if (!subscriber.shouldIgnoreDirectory) {
			return false
		}
		hasOpinion = true
		if (!subscriber.shouldIgnoreDirectory(absolutePath)) {
			return false
		}
	}
	return hasOpinion
}

/**
 * Identify a watch scope by the directories it actually observes.
 *
 * Tasks in one workspace normally resolve identical roots, so they share a
 * single recursive watch instead of paying one descriptor tree per task.
 */
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
 * Share one recursive prompt-input watch across every task of a workspace.
 *
 * The registry only owns watcher lifetime and event fan-out. Each subscriber
 * keeps its own invalidation handling, so downstream validation, capability
 * toggles and prompt rebuilds stay task-local and unchanged.
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
			notify: () => request.invalidate(),
			...(request.shouldIgnoreDirectory ? { shouldIgnoreDirectory: request.shouldIgnoreDirectory } : {}),
		}
		const entry = this.entries.get(key) ?? this.createEntry(key, request)
		entry.subscribers.add(subscriber)
		let released = false
		return {
			ready: entry.started,
			dispose: async () => {
				if (released) return
				released = true
				await this.releaseSubscriber(key, entry, subscriber)
			},
		}
	}

	/** Close every shared watcher. Intended for host shutdown and test isolation. */
	async disposeAll(): Promise<void> {
		const entries = [...this.entries.values()]
		this.entries.clear()
		for (const entry of entries) {
			entry.subscribers.clear()
			await entry.watcher.dispose().catch((error) => {
				Logger.error("[WorkspacePromptInputWatcherRegistry] Failed to dispose shared watcher:", error)
			})
		}
	}

	private createEntry(key: string, request: WorkspacePromptInputWatcherSubscribeRequest): WorkspaceWatcherEntry {
		const subscribers = new Set<WatcherSubscriber>()
		const watcher = new PromptInputFileWatcher({
			taskId: `workspace:${path.resolve(request.cwd)}`,
			cwd: request.cwd,
			globalRulesDirectory: request.globalRulesDirectory,
			workflowDirectories: request.workflowDirectories,
			skillDirectories: request.skillDirectories,
			subagentDirectories: request.subagentDirectories,
			invalidate: () => {
				for (const subscriber of [...subscribers]) {
					try {
						subscriber.notify()
					} catch (error) {
						Logger.error("[WorkspacePromptInputWatcherRegistry] Subscriber invalidation failed:", error)
					}
				}
			},
			// Delegate to whichever subscribers are alive now. Capturing the first
			// task's predicate would outlive its IgnoreController and freeze the
			// traversal on a rule snapshot that no longer updates.
			shouldIgnoreDirectory: (absolutePath: string) => shouldIgnoreForAnySubscriber(subscribers, absolutePath),
			...(this.watch ? { watch: this.watch } : {}),
		})
		const started = watcher.start()
		const entry: WorkspaceWatcherEntry = { watcher, started, subscribers }
		this.entries.set(key, entry)
		started.catch(() => {
			if (this.entries.get(key) === entry) this.entries.delete(key)
		})
		return entry
	}

	private async releaseSubscriber(key: string, entry: WorkspaceWatcherEntry, subscriber: WatcherSubscriber): Promise<void> {
		entry.subscribers.delete(subscriber)
		if (entry.subscribers.size > 0) return
		if (this.entries.get(key) === entry) this.entries.delete(key)
		await entry.watcher.dispose().catch((error) => {
			Logger.error("[WorkspacePromptInputWatcherRegistry] Failed to dispose shared watcher:", error)
		})
	}
}

let sharedRegistry: WorkspacePromptInputWatcherRegistry | undefined

/** Process-wide registry used by tasks; tests should construct their own instance. */
export function getWorkspacePromptInputWatcherRegistry(): WorkspacePromptInputWatcherRegistry {
	sharedRegistry ??= new WorkspacePromptInputWatcherRegistry()
	return sharedRegistry
}
