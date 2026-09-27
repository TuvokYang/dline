import { getTaskMetadata, saveTaskMetadata } from "@core/storage/disk"
import type { ClineMessage } from "@shared/ExtensionMessage"
import * as path from "path"
import { Controller } from "@/core/controller"
import { StateManager } from "@/core/storage/StateManager"
import { Logger } from "@/shared/services/Logger"
import { getCwd } from "@/utils/path"
import type { FileMetadataEntry } from "./ContextTrackerTypes"
import {
	fileContextKey,
	getWorkspaceFileContextRegistry,
	type WorkspaceFileContextRegistry,
	type WorkspaceFileSubscription,
} from "./WorkspaceFileContextRegistry"

export interface RecentlyModifiedFilesSnapshot {
	files: string[]
	revisions: Record<string, number>
}

// This class is responsible for tracking file operations that may result in stale context.
// If a user modifies a file outside of Cline, the context may become stale and need to be updated.
// We do not want Cline to reload the context every time a file is modified, so we use this class merely
// to inform Cline that the change has occurred, and tell Cline to reload the file before making
// any changes to it. This fixes an issue with diff editing, where Cline was unable to complete a diff edit.
// a diff edit because the file was modified since Cline last read it.

// FileContextTracker
/**
This class is responsible for tracking file operations.
If the full contents of a file are passed to Cline via a tool, mention, or edit, the file is marked as active.
If a file is modified outside of Cline, we detect and track this change to prevent stale context.
This is used when restoring a task (non-git "checkpoint" restore), and mid-task.
*/
export class FileContextTracker {
	private controller: Controller
	readonly taskId: string

	// Workspace-shared watching; per-task acknowledgement state stays local.
	// Every map below is keyed by fileContextKey, so relative and absolute
	// spellings of one file share a single entry and acknowledgement cursor.
	private readonly registry: WorkspaceFileContextRegistry
	private readonly subscriptions = new Map<string, WorkspaceFileSubscription>()
	private readonly acknowledgedRevisions = new Map<string, number>()
	private readonly restoredRevisions = new Map<string, number>()
	/** Workspace-relative display path reported to the model, per key. */
	private readonly displayPaths = new Map<string, string>()
	/** Keys whose current external edit was already published by the shared watcher. */
	private readonly watcherPublishedPaths = new Set<string>()
	/** Most recently resolved workspace root; used to key registry lookups. */
	private workspaceRoot?: string

	constructor(
		controller: Controller,
		taskId: string,
		registry: WorkspaceFileContextRegistry = getWorkspaceFileContextRegistry(),
	) {
		this.controller = controller
		this.taskId = taskId
		this.registry = registry
		// Resolve eagerly so the synchronous markFileAsEditedByCline can reach the
		// registry even when this task writes a file before tracking anything.
		void this.resolveWorkspaceRoot()
	}

	/** Cache the workspace root, tolerating hosts without an open folder. */
	private async resolveWorkspaceRoot(): Promise<string | undefined> {
		try {
			const cwd = await getCwd()
			if (cwd) {
				this.workspaceRoot = cwd
			}
			return this.workspaceRoot
		} catch (error) {
			Logger.error("Failed to resolve workspace root:", error)
			return this.workspaceRoot
		}
	}

	/**
	 * Subscribes this task to the workspace-shared watcher for the given file.
	 * The registry keeps a single underlying watcher per path across all tasks.
	 */
	async setupFileWatcher(filePath: string) {
		const cwd = await this.resolveWorkspaceRoot()
		if (!cwd) {
			Logger.info("No workspace folder available - cannot determine current working directory")
			return
		}

		// Only subscribe once per file for this task, whatever the spelling.
		const key = this.keyFor(cwd, filePath)
		if (this.subscriptions.has(key)) {
			return
		}

		const subscription = this.registry.subscribe(cwd, filePath, (change) => {
			if (change.isMetadataAuthor) {
				// Exactly one subscriber records the external edit in task metadata.
				// The registry already published this revision, so do not publish it again.
				this.watcherPublishedPaths.add(this.keyFor(cwd, change.filePath))
				this.trackFileContext(change.filePath, "user_edited")
			}
		})

		this.subscriptions.set(key, subscription)

		// A snapshot restored before this subscription existed could not reach the
		// registry yet; publish it now so later real edits still outrank it.
		const restoredRevision = this.restoredRevisions.get(key)
		if (restoredRevision !== undefined) {
			this.registry.adoptRevision(cwd, filePath, restoredRevision)
		}
	}

	/**
	 * Tracks a file operation in metadata and sets up a watcher for the file
	 * This is the main entry point for FileContextTracker and is called when a file is passed to Cline via a tool, mention, or edit.
	 */
	async trackFileContext(filePath: string, operation: "read_tool" | "user_edited" | "cline_edited" | "file_mentioned") {
		// Consume the marker before any await so a concurrent explicit call still publishes.
		const alreadyPublished = this.workspaceRoot
			? this.watcherPublishedPaths.delete(this.keyFor(this.workspaceRoot, filePath))
			: false
		try {
			const cwd = await this.resolveWorkspaceRoot()
			if (!cwd) {
				Logger.info("No workspace folder available - cannot determine current working directory")
				return
			}

			// Add file to metadata
			await this.addFileToFileContextTracker(this.taskId, filePath, operation)

			// Set up file watcher for this file
			await this.setupFileWatcher(filePath)

			if (operation === "user_edited" && !alreadyPublished) {
				// Publish the edit so every task watching this path can see it.
				this.registry.recordExternalEdit(cwd, filePath)
			}
			if (operation === "cline_edited") {
				// The write is on disk and now watched: its content is the new baseline.
				this.registry.settleSelfEdit(cwd, filePath)
			}
		} catch (error) {
			Logger.error("Failed to track file operation:", error)
		}
	}

	/**
	 * Adds a file to the metadata tracker
	 * This handles the business logic of determining if the file is new, stale, or active.
	 * It also updates the metadata with the latest read/edit dates.
	 */
	async addFileToFileContextTracker(taskId: string, filePath: string, source: FileMetadataEntry["record_source"]) {
		try {
			const metadata = await getTaskMetadata(taskId)
			const now = Date.now()

			// Mark existing entries for this file as stale
			metadata.files_in_context.forEach((entry) => {
				if (entry.path === filePath && entry.record_state === "active") {
					entry.record_state = "stale"
				}
			})

			// Helper to get the latest date for a specific field and file
			const getLatestDateForField = (path: string, field: keyof FileMetadataEntry): number | null => {
				const relevantEntries = metadata.files_in_context
					.filter((entry) => entry.path === path && entry[field])
					.sort((a, b) => (b[field] as number) - (a[field] as number))

				return relevantEntries.length > 0 ? (relevantEntries[0][field] as number) : null
			}

			const newEntry: FileMetadataEntry = {
				path: filePath,
				record_state: "active",
				record_source: source,
				cline_read_date: getLatestDateForField(filePath, "cline_read_date"),
				cline_edit_date: getLatestDateForField(filePath, "cline_edit_date"),
				user_edit_date: getLatestDateForField(filePath, "user_edit_date"),
			}

			switch (source) {
				// user_edited: The user has edited the file
				case "user_edited":
					newEntry.user_edit_date = now
					break

				// cline_edited: Cline has edited the file
				case "cline_edited":
					newEntry.cline_read_date = now
					newEntry.cline_edit_date = now
					break

				// read_tool/file_mentioned: Cline has read the file via a tool or file mention
				case "read_tool":
				case "file_mentioned":
					newEntry.cline_read_date = now
					break
			}

			metadata.files_in_context.push(newEntry)
			await saveTaskMetadata(taskId, metadata)
		} catch (error) {
			Logger.error("Failed to add file to metadata:", error)
		}
	}

	/** Return a non-destructive snapshot of files this task has not acknowledged yet. */
	peekRecentlyModifiedFiles(): RecentlyModifiedFilesSnapshot {
		const files: string[] = []
		const revisions: Record<string, number> = {}
		for (const [key, revision] of this.currentRevisions()) {
			if (revision > (this.acknowledgedRevisions.get(key) ?? 0)) {
				const displayPath = this.displayPaths.get(key) ?? key
				files.push(displayPath)
				revisions[displayPath] = revision
			}
		}
		return { files, revisions }
	}

	/** Merge a durable snapshot without replacing file edits recorded after that snapshot. */
	restoreRecentlyModifiedFiles(snapshot: RecentlyModifiedFilesSnapshot): void {
		for (const filePath of snapshot.files) {
			const restoredRevision = snapshot.revisions[filePath]
			if (!Number.isSafeInteger(restoredRevision) || restoredRevision <= 0) continue
			const key = this.remember(filePath)
			if (this.workspaceRoot) {
				this.registry.adoptRevision(this.workspaceRoot, filePath, restoredRevision)
			}
			const currentRestored = this.restoredRevisions.get(key) ?? 0
			if (restoredRevision > currentRestored) {
				this.restoredRevisions.set(key, restoredRevision)
			}
			const acknowledged = this.acknowledgedRevisions.get(key) ?? 0
			if (acknowledged >= restoredRevision) {
				// Re-expose a restored edit that this task had already acknowledged.
				this.acknowledgedRevisions.delete(key)
			}
		}
	}

	/** Advance the acknowledgement cursor only for entries that still match the snapshot. */
	acknowledgeRecentlyModifiedFiles(snapshot: RecentlyModifiedFilesSnapshot): void {
		for (const filePath of snapshot.files) {
			const snapshotRevision = snapshot.revisions[filePath]
			if (snapshotRevision === undefined) continue
			const key = this.remember(filePath)
			if (this.currentRevisionFor(key) !== snapshotRevision) continue
			this.acknowledgedRevisions.set(key, snapshotRevision)
		}
	}

	/** Returns and clears the exact set of recently modified files observed by this call. */
	getAndClearRecentlyModifiedFiles(): string[] {
		const snapshot = this.peekRecentlyModifiedFiles()
		this.acknowledgeRecentlyModifiedFiles(snapshot)
		return snapshot.files
	}

	/** Latest known revision per tracked key, combining live watches and restored snapshots. */
	private currentRevisions(): Map<string, number> {
		const revisions = new Map(this.restoredRevisions)
		for (const key of this.subscriptions.keys()) {
			const revision = this.registryRevisionFor(key)
			if (revision > (revisions.get(key) ?? 0)) {
				revisions.set(key, revision)
			}
		}
		return revisions
	}

	private currentRevisionFor(key: string): number {
		return Math.max(this.restoredRevisions.get(key) ?? 0, this.registryRevisionFor(key))
	}

	/** Registry keys are idempotent, so a tracker key can be passed back as a path. */
	private registryRevisionFor(key: string): number {
		return this.workspaceRoot ? this.registry.getRevision(this.workspaceRoot, key) : 0
	}

	/**
	 * Canonical key for a path and the display path recorded for it.
	 *
	 * Paths inside the workspace are shown relative to it with forward slashes;
	 * paths outside keep their absolute form.
	 */
	private keyFor(cwd: string, filePath: string): string {
		const key = fileContextKey(cwd, filePath)
		if (!this.displayPaths.has(key)) {
			const relative = path.relative(cwd, path.resolve(cwd, filePath))
			const inside = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)
			this.displayPaths.set(key, inside ? relative.split(path.sep).join("/") : path.resolve(cwd, filePath))
		}
		return key
	}

	/** Key a path before the workspace root is known by its original spelling. */
	private remember(filePath: string): string {
		if (this.workspaceRoot) return this.keyFor(this.workspaceRoot, filePath)
		this.displayPaths.set(filePath, filePath)
		return filePath
	}

	/**
	 * Marks a Dline write as in progress so its change events are not reported
	 * as external edits. The registry ignores paths without a live watcher, so a
	 * task that has not resolved a workspace root yet cannot leave a stale marker.
	 * Pair every call with {@link settleClineEdit}, including when the write fails.
	 */
	markFileAsEditedByCline(filePath: string): void {
		if (!this.workspaceRoot) return
		this.registry.markSelfEdit(this.workspaceRoot, filePath)
	}

	/** Ends a Dline write so later changes to the file are reported again. */
	settleClineEdit(filePath: string): void {
		if (!this.workspaceRoot) return
		this.registry.settleSelfEdit(this.workspaceRoot, filePath)
	}

	/**
	 * Releases this task's watch subscriptions; shared watchers stay alive for other tasks.
	 */
	async dispose(): Promise<void> {
		const subscriptions = Array.from(this.subscriptions.values())
		this.subscriptions.clear()
		await Promise.all(subscriptions.map((subscription) => subscription.dispose()))
	}

	/**
	 * Detects files that were edited by Cline or users after a specific message timestamp
	 * This is used when restoring checkpoints to warn about potential file content mismatches
	 */
	async detectFilesEditedAfterMessage(messageTs: number, deletedMessages: ClineMessage[]): Promise<string[]> {
		const editedFiles: string[] = []

		try {
			// Check task metadata for files that were edited by Cline or users after the message timestamp
			const taskMetadata = await getTaskMetadata(this.taskId)

			if (taskMetadata?.files_in_context) {
				for (const fileEntry of taskMetadata.files_in_context) {
					const clineEditedAfter = fileEntry.cline_edit_date && fileEntry.cline_edit_date > messageTs
					const userEditedAfter = fileEntry.user_edit_date && fileEntry.user_edit_date > messageTs

					if (clineEditedAfter || userEditedAfter) {
						editedFiles.push(fileEntry.path)
					}
				}
			}
		} catch (error) {
			Logger.error("Error checking file context metadata:", error)
		}

		// Also check deleted task messages for file operations
		for (const message of deletedMessages) {
			if (message.say === "tool" && message.text) {
				try {
					const toolData = JSON.parse(message.text)
					if ((toolData.tool === "editedExistingFile" || toolData.tool === "newFileCreated") && toolData.path) {
						if (!editedFiles.includes(toolData.path)) {
							editedFiles.push(toolData.path)
						}
					}
				} catch (error) {
					Logger.error("Error checking task messages:", error)
				}
			}
		}
		return [...new Set(editedFiles)]
	}

	/**
	 * Stores pending file context warning in workspace state so it persists across task reinitialization
	 */
	async storePendingFileContextWarning(files: string[]): Promise<void> {
		try {
			const key = `pendingFileContextWarning_${this.taskId}`
			// NOTE: Using 'as any' because dynamic keys like pendingFileContextWarning_${taskId}
			// are legitimate workspace state keys but don't fit the strict LocalStateKey type system
			this.controller.stateManager.setWorkspaceState(key as any, files)
		} catch (error) {
			Logger.error("Error storing pending file context warning:", error)
		}
	}

	/**
	 * Retrieves pending file context warning from workspace state (without clearing it)
	 */
	async retrievePendingFileContextWarning(): Promise<string[] | undefined> {
		try {
			const key = `pendingFileContextWarning_${this.taskId}`
			// NOTE: Using 'as any' because dynamic keys like pendingFileContextWarning_${taskId}
			// are legitimate workspace state keys but don't fit the strict LocalStateKey type system
			const files = this.controller.stateManager.getWorkspaceStateKey(key as any) as string[]
			return files
		} catch (error) {
			Logger.error("Error retrieving pending file context warning:", error)
		}
		return undefined
	}

	/**
	 * Retrieves and clears pending file context warning from workspace state
	 */
	async retrieveAndClearPendingFileContextWarning(): Promise<string[] | undefined> {
		try {
			const files = await this.retrievePendingFileContextWarning()
			if (files) {
				// NOTE: Using 'as any' because dynamic keys like pendingFileContextWarning_${taskId}
				// are legitimate workspace state keys but don't fit the strict LocalStateKey type system
				this.controller.stateManager.setWorkspaceState(`pendingFileContextWarning_${this.taskId}` as any, undefined)
				return files
			}
		} catch (error) {
			Logger.error("Error retrieving pending file context warning:", error)
		}
		return undefined
	}

	/**
	 * Static method to clean up orphaned pending file context warnings at startup
	 * This removes warnings for tasks that may no longer exist
	 */
	static async cleanupOrphanedWarnings(stateManager: StateManager): Promise<void> {
		const startTime = Date.now()
		try {
			const taskHistory = await stateManager.taskHistory.getDeduplicated()
			const existingTaskIds = new Set(taskHistory.map((task) => task.id))
			const allStateKeys = Object.keys(stateManager.getAllWorkspaceStateEntries())
			const pendingWarningKeys = allStateKeys.filter((key) => key.startsWith("pendingFileContextWarning_"))

			const orphanedPendingContextTasks: string[] = []
			for (const key of pendingWarningKeys) {
				const taskId = key.replace("pendingFileContextWarning_", "")
				if (!existingTaskIds.has(taskId)) {
					orphanedPendingContextTasks.push(key)
				}
			}

			if (orphanedPendingContextTasks.length > 0) {
				for (const key of orphanedPendingContextTasks) {
					// NOTE: Using 'as any' because dynamic keys like pendingFileContextWarning_${taskId}
					// are legitimate workspace state keys but don't fit the strict LocalStateKey type system
					await stateManager.setWorkspaceState(key as any, undefined)
				}
			}

			const duration = Date.now() - startTime
			Logger.log(
				`FileContextTracker: Processed ${existingTaskIds.size} tasks, found ${pendingWarningKeys.length} pending warnings, ${orphanedPendingContextTasks.length} orphaned, deleted ${orphanedPendingContextTasks.length}, took ${duration}ms`,
			)
		} catch (error) {
			Logger.error("[FileContextTracker] Error cleaning up orphaned file context warnings:", error)
		}
	}
}
