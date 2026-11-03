import * as path from "node:path"
import { FocusChainSettings } from "@shared/FocusChainSettings"
import * as chokidar from "chokidar"
import * as fs from "fs/promises"
import { telemetryService } from "@/services/telemetry"
import { Logger } from "@/shared/services/Logger"
import { UiSay } from "../../../shared/ExtensionMessage"
import { Mode } from "../../../shared/storage/types"
import { writeFile } from "../../../utils/fs"
import { ensureTaskDirectoryExists } from "../../storage/disk"
import { StateManager } from "../../storage/StateManager"
import { type ChecklistChange, type ChecklistReport, diffChecklist, parseChecklist } from "../telemetry/ChecklistDiff"
import type { ToolConversationState } from "../tools/state/ToolHandlerState"
import { type ChecklistUpdateDecision, evaluateChecklistUpdate } from "./ChecklistUpdate"
import {
    appendToFocusChainHistory,
    createFocusChainMarkdownContent,
    ensureFocusChainFile,
    extractFocusChainListFromText,
    getFocusChainFilePath,
    getFocusChainHistoryFilePath,
    getUncheckedFocusChainItemAtIndex,
    hasValidTodoItem,
    isAllItemsCompleted,
    isEquivalentFocusChainList,
} from "./file-utils"
import { selectFocusChainInstructionPolicy } from "./instruction-policy"
import { FocusChainPrompts } from "./prompts"
import type { FocusChainUpdateResult } from "./update-result"
import { parseFocusChainListCounts } from "./utils"

export interface FocusChainProjectionOptions {
    preview?: boolean
    mode?: Mode
    didSwitchFromPlan?: boolean
}

export interface FocusChainInstructionPort {
    ready?(): Promise<void>
    beginRequest(requestId?: string): void
    project(options?: FocusChainProjectionOptions): string
}

export interface FocusChainState
    extends Pick<
        ToolConversationState,
        | "apiRequestCount"
        | "apiRequestsSinceLastTodoUpdate"
        | "currentFocusChainChecklist"
        | "currentInProgressItemIndex"
        | "todoListWasUpdatedByUser"
        | "didRespondToPlanAskBySwitchingMode"
        | "focusChainRejectionMessage"
        | "focusChainHistory"
        | "hasWarnedSkipOrder"
        | "blockNextToolCalls"
    > {
    consecutiveMistakeCount: number
}

export interface FocusChainDependencies {
    taskId: string
    taskState: FocusChainState
    getMode: () => Mode
    stateManager: StateManager
    postStateToWebview: () => Promise<void>
    say: (type: UiSay, text?: string, images?: string[], files?: string[], partial?: boolean) => Promise<number | undefined>
    focusChainSettings: FocusChainSettings
    /** Count real request rows after the last committed progress row when reopening. */
    requestsSinceProgress?: () => number
    /**
     * Receive item-level checklist changes for usage.
     *
     * Optional: a task that reports no usage needs no observer, and an absent
     * observer must stay distinguishable from one that saw no changes.
     */
    observeChecklist?: (changes: readonly ChecklistChange[]) => void
}

export class FocusChainManager {
    private taskId: string
    private taskState: FocusChainState
    private stateManager: StateManager
    private getMode: () => Mode
    private postStateToWebview: () => Promise<void>
    private say: (
        type: UiSay,
        text?: string,
        images?: string[],
        files?: string[],
        partial?: boolean,
    ) => Promise<number | undefined>
    private focusChainFileWatcher?: chokidar.FSWatcher
    private hasTrackedFirstProgress = false
    /** The last accepted checklist, so the next accepted one can be compared. */
    private lastObservedChecklist: ChecklistReport | undefined
    private readonly observeUsageChecklist?: (changes: readonly ChecklistChange[]) => void
    private focusChainSettings: FocusChainSettings
    private fileUpdateDebounceTimer?: NodeJS.Timeout
    private disposed = false
    private loading?: Promise<void>
    private mutationTail: Promise<void> = Promise.resolve()
    private completedRequests: number | undefined
    private lastRequestId: string | undefined
    private readonly requestsSinceProgress?: () => number

    constructor(dependencies: FocusChainDependencies) {
        this.taskId = dependencies.taskId
        this.taskState = dependencies.taskState
        this.stateManager = dependencies.stateManager
        this.getMode = dependencies.getMode
        this.postStateToWebview = dependencies.postStateToWebview
        this.say = dependencies.say
        this.focusChainSettings = dependencies.focusChainSettings
        this.observeUsageChecklist = dependencies.observeChecklist
        this.requestsSinceProgress = dependencies.requestsSinceProgress
    }

    /**
     * Sets up a file watcher to monitor changes to the focus chain list markdown file.
     * Automatically updates the UI when the file is created, modified, or deleted by external editors.
     * @requires this.taskId, this.context to be initialized
     * @returns Promise<void> - Resolves when watcher is set up, logs errors if setup fails
     */
    public async setupFocusChainFileWatcher() {
        if (this.disposed || this.focusChainFileWatcher) return
        try {
            const taskDir = path.resolve(await ensureTaskDirectoryExists(this.taskId))
            const focusChainFilePath = getFocusChainFilePath(taskDir, this.taskId)

            // Ensure focus chain file exists (create empty file for new tasks)
            // This prevents EPERM errors when user manually opens the file
            // and ensures the file is available for watcher events
            if (this.disposed) return
            await ensureFocusChainFile(this.taskId, "")

            // Keep observing the file even when the first read fails, so an
            // external repair can recover without reopening the task again.
            await this.ready()

            if (this.disposed) return
            // Watch the parent so replacing or repairing the target does not retire
            // its watch. Filter discovery to this checklist, never the other task files.
            this.focusChainFileWatcher = chokidar.watch(taskDir, {
                persistent: true,
                ignoreInitial: true,
                depth: 0,
                ignored: (watchedPath) => {
                    const resolved = path.resolve(watchedPath)
                    return resolved !== taskDir && resolved !== focusChainFilePath
                },
                awaitWriteFinish: {
                    stabilityThreshold: 300,
                    pollInterval: 100,
                },
            })

            // Handle file changes
            this.focusChainFileWatcher
                .on("add", async () => {
                    await this.updateFCListFromMarkdownFileAndNotifyUI()
                })
                .on("change", async () => {
                    await this.updateFCListFromMarkdownFileAndNotifyUI()
                })
                .on("unlink", async () => {
                    await this.updateFCListFromMarkdownFileAndNotifyUI()
                })
                .on("error", (error) => {
                    Logger.error(`[Task ${this.taskId}] Failed to watch focus chain file:`, error)
                })

            Logger.log(`[Task ${this.taskId}] Todo file watcher initialized`)
        } catch (error) {
            Logger.error(`[Task ${this.taskId}] Failed to setup todo file watcher:`, error)
        }
    }

    /**
     * Reads the current focus chain list from the markdown file and updates the UI with any changes.
     * Uses debouncing (300ms) to prevent excessive updates and only notifies the webview when content actually changes.
     * @requires File watcher to be active and markdown file to exist
     * @returns Promise<void> - Updates taskState.currentFocusChainChecklist and calls postStateToWebview()
     */
    private async updateFCListFromMarkdownFileAndNotifyUI() {
        if (this.fileUpdateDebounceTimer) {
            clearTimeout(this.fileUpdateDebounceTimer)
        }

        // Read inside the same queue as model commits, so an own-write echo cannot
        // race its memory publication or be mistaken for an external edit.
        this.fileUpdateDebounceTimer = setTimeout(() => {
            void this.enqueueMutation(async () => {
                if (this.disposed) return
                const checklist = await this.readFocusChainFromDisk()
                const previous = this.taskState.currentFocusChainChecklist
                if (previous === checklist || (previous && checklist && isEquivalentFocusChainList(previous, checklist))) return
                this.taskState.currentFocusChainChecklist = checklist
                this.taskState.currentInProgressItemIndex =
                    checklist && getUncheckedFocusChainItemAtIndex(checklist, this.taskState.currentInProgressItemIndex) !== null
                        ? this.taskState.currentInProgressItemIndex
                        : null
                if (!checklist || !isAllItemsCompleted(checklist)) this.completedRequests = undefined
                else if (!previous || !isAllItemsCompleted(previous)) this.completedRequests = 0
                this.taskState.todoListWasUpdatedByUser = true
                await this.postStateToWebview()
                telemetryService.captureFocusChainListWritten(this.taskId)
            }).catch((error: unknown) => Logger.error(`[Task ${this.taskId}] Failed to load external checklist edit:`, error))
        }, 300)
    }

    /**
     * Generates contextual instructions for focus chain list creation and management based on current task state.
     * Returns formatted markdown instructions that guide the AI on when and how to update progress tracking.
     * @requires this.taskState with current focus chain list state and API request counts
     * @returns string - Formatted markdown instructions for focus chain list management, varies by context
     */
    public generateFocusChainInstructions(options: FocusChainProjectionOptions = {}): string {
        // If rejection/warning message is pending, return it directly
        if (this.taskState.focusChainRejectionMessage) {
            const msg = this.taskState.focusChainRejectionMessage
            if (!options.preview) this.taskState.focusChainRejectionMessage = null
            return `\n\n${msg}\n`
        }

        // If list exists, show progress reminder (no full checklist — it's in environment_details)
        if (this.taskState.currentFocusChainChecklist) {
            const { totalItems, completedItems } = parseFocusChainListCounts(this.taskState.currentFocusChainChecklist)
            const percentComplete = totalItems > 0 ? Math.round((completedItems / totalItems) * 100) : 0

            const policy = selectFocusChainInstructionPolicy(completedItems, totalItems)
            const listCurrentProgress = `**Current Progress: ${completedItems}/${totalItems} items completed (${percentComplete}%)**`
            const noteChecklistInEnv =
                "(Full checklist shown in environment_details above — report exact completed updates and, when current work changes, one exact unchecked item.)"

            if (policy.kind === "terminal") {
                return `\n
				${listCurrentProgress}\n
				${noteChecklistInEnv}\n
				<focus_chain_reminder kind="completed">${FocusChainPrompts.completed(totalItems)}</focus_chain_reminder>\n
				`
            }

            const progressInstruction = policy.requireTaskProgressWhenSupported
                ? FocusChainPrompts.progressUpdateWhenSupported
                : ""

            // If user has updated the list, inform the model
            if (this.taskState.todoListWasUpdatedByUser) {
                return `\n\n
				${progressInstruction}\n
				${listCurrentProgress}\n
				${noteChecklistInEnv}\n
				**CRITICAL:** The user has modified this todo list. Review the checklist in environment_details carefully.\n
				${FocusChainPrompts.reminder}\n
			`
            }

            let progressBasedMessageStub = ""
            if (completedItems === 0 && totalItems > 0) {
                progressBasedMessageStub =
                    "\n\n**Note:** No items are marked complete yet. Report completed items via task_progress as you work."
            } else if (percentComplete >= 25 && percentComplete < 50) {
                progressBasedMessageStub = `\n\n**Note:** ${percentComplete}% of items are complete.`
            } else if (percentComplete >= 50 && percentComplete < 75) {
                progressBasedMessageStub = `\n\n**Note:** ${percentComplete}% of items are complete. Proceed with the task.`
            } else if (percentComplete >= 75) {
                progressBasedMessageStub = `\n\n**Note:** ${percentComplete}% of items are complete! Focus on finishing the remaining items.`
            }

            return `\n
				${progressInstruction}\n
				${listCurrentProgress}\n
				${noteChecklistInEnv}\n
				${FocusChainPrompts.reminder}\n
				${progressBasedMessageStub}\n
				`
        }
        // When switching from Plan to Act, request that a new list be generated
        if (options.didSwitchFromPlan || this.taskState.didRespondToPlanAskBySwitchingMode) {
            return `${FocusChainPrompts.initial}`
        }
        // When in plan mode, lists are optional
        if ((options.mode ?? this.getMode()) === "plan") {
            return FocusChainPrompts.planModeReminder
        }
        // Check if we're early in the task
        const isEarlyInTask = this.taskState.apiRequestCount < 10
        if (isEarlyInTask) {
            return FocusChainPrompts.recommended
        }
        return FocusChainPrompts.apiRequestCount(this.taskState.apiRequestCount)
    }

    /** Count one real provider request; previews never call this boundary. */
    public beginRequest(requestId?: string): void {
        if (this.currentSettings().enabled !== true) return
        if (requestId !== undefined && requestId === this.lastRequestId) return
        this.lastRequestId = requestId
        this.taskState.apiRequestCount += 1
        this.taskState.apiRequestsSinceLastTodoUpdate += 1
        if (this.completedRequests !== undefined) this.completedRequests += 1
    }

    /** Project reminder text only when the configured cadence or another trigger requires it. */
    public projectInstructions(options: FocusChainProjectionOptions = {}): string {
        return this.shouldIncludeFocusChainInstructions(options) ? this.generateFocusChainInstructions(options) : ""
    }

    /**
     * Reads the focus chain list from the task's markdown file on disk and extracts the checklist content.
     * Returns the raw focus chain list string if found, or null if the file doesn't exist or contains no valid todos.
     * @requires this.taskId and this.context to locate the task directory
     * @returns Promise<string | null> - focus chain list content as string, or null if file missing/invalid
     * @throws Non-ENOENT read errors: an unreadable checklist must never be treated as an empty plan.
     */
    public async readFocusChainFromDisk(): Promise<string | null> {
        try {
            const taskDir = await ensureTaskDirectoryExists(this.taskId)
            const todoFilePath = getFocusChainFilePath(taskDir, this.taskId)
            const markdownContent = await fs.readFile(todoFilePath, "utf8")
            const todoList = extractFocusChainListFromText(markdownContent)

            return todoList || null
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
            throw error
        }
    }

    /**
     * Reads the focus chain history from the task's history markdown file on disk.
     * Returns the raw history content if found, or null if the file doesn't exist.
     * @returns Promise<string | null> - history content as string, or null if file missing
     */
    public async readFocusChainHistory(): Promise<string | null> {
        try {
            const taskDir = await ensureTaskDirectoryExists(this.taskId)
            const historyPath = getFocusChainHistoryFilePath(taskDir, this.taskId)
            const content = await fs.readFile(historyPath, "utf8")
            return content || null
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return null
            throw error
        }
    }

    /**
     * Writes the provided focus chain list to the task's markdown file on disk with proper formatting.
     * Creates the full markdown document structure and triggers file watchers to update the UI.
     * @param todoList - Raw focus chain list string with markdown checklist items
     * @requires this.taskId and this.context for file path generation
     * @returns Promise<void> - Resolves when file is written successfully
     * @throws Error if file write fails (disk full, permissions, etc.)
     */
    private async writeFocusChainToDisk(todoList: string): Promise<void> {
        try {
            const taskDir = await ensureTaskDirectoryExists(this.taskId)
            const todoFilePath = getFocusChainFilePath(taskDir, this.taskId)
            const fileContent = createFocusChainMarkdownContent(this.taskId, todoList)
            await writeFile(todoFilePath, fileContent, "utf8")
        } catch (error) {
            Logger.error(`[Task ${this.taskId}] focus chain list: FILE WRITE FAILED - Error:`, error)
            throw error
        }
    }

    /**
     * Processes TODO list updates from the AI model's task_progress parameter and persists them to disk.
     * Missing, blank, or structurally empty values are treated as no-ops.
     * Also manages the apiRequestsSinceLastTodoUpdate counter and includes comprehensive error handling.
     * @param taskProgress - Optional focus chain list string from AI model's task_progress parameter
     * @requires this.taskState, this.say method, and telemetryService to be available
     * @returns Whether progress was applied, unchanged, ignored, rejected, or failed to persist.
     */
    public async updateFCListFromToolResponse(taskProgress: string | undefined): Promise<FocusChainUpdateResult> {
        if (!taskProgress?.trim() || !hasValidTodoItem(taskProgress)) return { kind: "ignored" }
        try {
            await this.ensureLoaded()
        } catch (error) {
            Logger.error(`[Task ${this.taskId}] Checklist loading failed; update refused:`, error)
            await this.say("error", FocusChainPrompts.loadingFailed)
            return { kind: "failed", message: FocusChainPrompts.loadingFailed }
        }
        return this.enqueueMutation(async () => {
            if (this.disposed) return { kind: "ignored" }
            const decision = evaluateChecklistUpdate(
                {
                    checklist: this.taskState.currentFocusChainChecklist,
                    currentItem: this.taskState.currentInProgressItemIndex,
                    warnedSkip: this.taskState.hasWarnedSkipOrder,
                },
                taskProgress.trim(),
            )
            if (decision.kind === "rejected") {
                this.taskState.consecutiveMistakeCount++
                this.taskState.focusChainRejectionMessage = decision.message
                if (decision.blockTools) this.taskState.blockNextToolCalls = true
                await this.say("error", decision.diagnostic ?? decision.message)
                await this.checkConsecutiveErrors()
                return { kind: "rejected", message: decision.message }
            }
            return this.commitChecklist(decision)
        })
    }

    /** A broken optional checklist must not prevent the task from asking for recovery guidance. */
    public async ready(): Promise<void> {
        try {
            await this.ensureLoaded()
        } catch (error) {
            Logger.warn(`[Task ${this.taskId}] Checklist unavailable during environment projection:`, error)
            this.taskState.focusChainRejectionMessage = FocusChainPrompts.loadingFailed
        }
    }

    /** One initial read is shared by startup, environment construction, and the first report. */
    public ensureLoaded(): Promise<void> {
        this.loading ??= (async () => {
            const [checklist, history] = await Promise.all([this.readFocusChainFromDisk(), this.readFocusChainHistory()])
            if (this.disposed) return
            if (!this.taskState.currentFocusChainChecklist && checklist) {
                this.taskState.currentFocusChainChecklist = checklist
                this.taskState.currentInProgressItemIndex =
                    getUncheckedFocusChainItemAtIndex(checklist, this.taskState.currentInProgressItemIndex) !== null
                        ? this.taskState.currentInProgressItemIndex
                        : null
            }
            const loaded = this.taskState.currentFocusChainChecklist
            if (loaded && isAllItemsCompleted(loaded)) this.completedRequests = this.requestsSinceProgress?.() ?? 0
            if (loaded) this.lastObservedChecklist = parseChecklist(loaded)
            if (!this.taskState.focusChainHistory && history) this.taskState.focusChainHistory = history
            if (checklist || history) await this.publishState()
        })().catch((error: unknown) => {
            this.loading = undefined
            throw error
        })
        return this.loading
    }

    private enqueueMutation<T>(run: () => Promise<T>): Promise<T> {
        const result = this.mutationTail.then(run)
        this.mutationTail = result.then(
            () => undefined,
            () => undefined,
        )
        return result
    }

    /** Publish only what was accepted and written; a failed file write leaves canonical state untouched. */
    private async commitChecklist(
        decision: Extract<ChecklistUpdateDecision, { kind: "accepted" }>,
    ): Promise<FocusChainUpdateResult> {
        const previous = this.taskState.currentFocusChainChecklist
        const changed = previous !== decision.checklist || this.taskState.currentInProgressItemIndex !== decision.currentItem
        if (!changed) return { kind: "unchanged" }
        try {
            await this.writeFocusChainToDisk(decision.checklist)
        } catch (error) {
            Logger.error(`[Task ${this.taskId}] Failed to commit checklist:`, error)
            const message = FocusChainPrompts.persistenceFailed
            await this.say("error", message)
            return { kind: "failed", message }
        }
        if (decision.archive) {
            try {
                const taskDir = await ensureTaskDirectoryExists(this.taskId)
                await appendToFocusChainHistory(taskDir, this.taskId, decision.archive)
                this.taskState.focusChainHistory = await this.readFocusChainHistory()
            } catch (error) {
                Logger.error(`[Task ${this.taskId}] Failed to archive checklist:`, error)
                await this.say("error", FocusChainPrompts.archiveFailed)
            }
        }
        this.taskState.currentFocusChainChecklist = decision.checklist
        this.taskState.currentInProgressItemIndex = decision.currentItem
        if (!isAllItemsCompleted(decision.checklist)) this.completedRequests = undefined
        else if (!previous || !isAllItemsCompleted(previous)) this.completedRequests = 0
        this.taskState.apiRequestsSinceLastTodoUpdate = 0
        this.taskState.todoListWasUpdatedByUser = false
        this.taskState.consecutiveMistakeCount = 0
        this.taskState.blockNextToolCalls = false
        this.taskState.focusChainRejectionMessage = decision.warnSkip ? FocusChainPrompts.skipOrderWarning : null
        this.taskState.hasWarnedSkipOrder = decision.archive
            ? false
            : this.taskState.hasWarnedSkipOrder || decision.warnSkip === true
        try {
            this.trackTelemetry(decision.checklist)
        } catch (error) {
            Logger.warn(`[Task ${this.taskId}] Checklist telemetry failed:`, error)
        }
        // Persistence already succeeded. A presentation failure must not claim that
        // the old checklist is still canonical or undo an unrelated successful tool.
        try {
            await this.say("task_progress", decision.checklist)
        } catch (error) {
            Logger.warn(`[Task ${this.taskId}] Failed to publish checklist row:`, error)
        }
        await this.publishState()
        if (decision.warnSkip) await this.say("error", FocusChainPrompts.skipOrderWarning)
        return { kind: "applied" }
    }

    private async publishState(): Promise<void> {
        try {
            await this.postStateToWebview()
        } catch (error) {
            Logger.warn(`[Task ${this.taskId}] Failed to publish checklist state:`, error)
        }
    }

    /**
     * Check if focus chain errors have reached the threshold (3+ consecutive).
     * Sends a prominent warning to the user in the webview.
     */
    private async checkConsecutiveErrors() {
        const maxMistakes = this.stateManager.getGlobalSettingsKey("maxConsecutiveMistakes")
        if (this.taskState.consecutiveMistakeCount >= 3 && this.taskState.consecutiveMistakeCount >= maxMistakes) {
            await this.say(
                "error",
                `⚠️ Focus Chain: AI has failed to update the task plan ${this.taskState.consecutiveMistakeCount} times in a row. ` +
                    `The current model may lack the reasoning capability to follow the planned task. ` +
                    `Consider stopping and switching to a more capable model.`,
            )
        }
    }

    /**
     * Track telemetry for focus chain progress updates.
     */
    private trackTelemetry(checklist: string) {
        const { totalItems, completedItems } = parseFocusChainListCounts(checklist)
        if (!this.hasTrackedFirstProgress && totalItems > 0) {
            telemetryService.captureFocusChainProgressFirst(this.taskId, totalItems)
            this.hasTrackedFirstProgress = true
        } else if (this.hasTrackedFirstProgress && totalItems > 0) {
            telemetryService.captureFocusChainProgressUpdate(this.taskId, totalItems, completedItems)
        }
        // Reached only after a checklist was accepted, so the counted changes are
        // the ones the user actually sees rather than every report the model sent.
        this.observeChecklist(checklist)
    }

    /**
     * Report item-level changes to the usage collector.
     *
     * Focus-chain telemetry counts items; usage needs to know which items moved,
     * because "how many rounds did a completion take" is a per-item question. The
     * diff is computed from the last accepted report, so a rejected update
     * contributes nothing.
     */
    private observeChecklist(checklist: string) {
        try {
            const previous = this.lastObservedChecklist
            const report = parseChecklist(checklist)
            const changes = diffChecklist(previous, report)
            this.lastObservedChecklist = report
            if (changes.length > 0) this.observeUsageChecklist?.(changes)
        } catch (error) {
            // Usage bookkeeping must never fail a checklist update.
            Logger.error(`[Task ${this.taskId}] focus chain: Failed to observe checklist for usage:`, error)
        }
    }

    /**
     * Evaluates multiple conditions to determine if focus chain list instructions should be included in the AI prompt.
     * Returns true when in plan mode, after mode switches, when user edits exist, or at reminder intervals.
     * @requires this.mode, this.taskState, and this.focusChainSettings to be initialized
     * @returns boolean - True if instructions should be included in AI prompt, false otherwise
     */
    public shouldIncludeFocusChainInstructions(options: FocusChainProjectionOptions = {}): boolean {
        const settings = this.currentSettings()
        if (settings.enabled !== true) return false
        // Include when switching from Plan > Act
        const justSwitchedFromPlanMode = options.didSwitchFromPlan || this.taskState.didRespondToPlanAskBySwitchingMode
        // Include when user had edited the list manually
        const userUpdatedList = this.taskState.todoListWasUpdatedByUser
        // Include when reaching the reminder interval, configured by settings
        const interval = Math.max(1, settings.remindClineInterval)
        const completedRound = this.completedRequests
        const reachedReminderInterval =
            completedRound === undefined
                ? this.taskState.apiRequestsSinceLastTodoUpdate >= interval
                : completedRound === 1 || completedRound === 2 || (completedRound > 2 && (completedRound - 2) % interval === 0)
        // Include on first API request if list does not exist
        const isFirstApiRequest = this.taskState.apiRequestCount === 1 && !this.taskState.currentFocusChainChecklist

        const hasPendingRejection = this.taskState.focusChainRejectionMessage !== null

        const shouldInclude =
            reachedReminderInterval || justSwitchedFromPlanMode || userUpdatedList || isFirstApiRequest || hasPendingRejection

        return shouldInclude
    }

    private currentSettings(): FocusChainSettings {
        return this.stateManager.getGlobalSettingsKey("focusChainSettings") ?? this.focusChainSettings
    }

    /**
     * Check if the next round of tool calls should be blocked due to a severe
     * focus chain violation (e.g., - [x] fabrication / item-mismatch).
     * Controller layer should read this before executing tools.
     */
    public shouldBlockNextToolCalls(): boolean {
        return this.taskState.blockNextToolCalls
    }

    /**
     * Clear the tool-call block flag. Called by Controller after the blocked
     * round has been processed (first tool call returns error, rest skipped).
     */
    public clearBlockNextToolCalls(): void {
        this.taskState.blockNextToolCalls = false
    }

    /**
     * Analyzes the current focus chain list for incomplete items when a task is marked as complete.
     * Captures telemetry data about unfinished progress items to help improve the focus chain system.
     * @param modelId The model ID being used (for telemetry)
     * @param provider The API provider being used (for telemetry)
     * @requires this.focusChainSettings.enabled and this.taskState.currentFocusChainChecklist to exist
     * @returns void - Sends telemetry data if incomplete items found, no return value
     */
    public checkIncompleteProgressOnCompletion(modelId: string, provider: string) {
        if (this.focusChainSettings.enabled && this.taskState.currentFocusChainChecklist) {
            const { totalItems, completedItems } = parseFocusChainListCounts(this.taskState.currentFocusChainChecklist)

            // Only track if there are items and not all are marked as completed
            if (totalItems > 0 && completedItems < totalItems) {
                const incompleteItems = totalItems - completedItems
                telemetryService.captureFocusChainIncompleteOnCompletion(
                    this.taskId,
                    totalItems,
                    completedItems,
                    incompleteItems,
                    modelId,
                    provider,
                )
            }
        }
    }

    /**
     * Force-replace the current focus chain with a new plan.
     * Archives the old plan to history and writes the new plan to disk.
     * Used by FocusChainHandler for user-approved plan overrides.
     */
    public async forceReplaceFocusChain(newPlan: string): Promise<void> {
        const normalizedPlan = newPlan.trim()
        if (!hasValidTodoItem(normalizedPlan)) return
        await this.ensureLoaded()
        await this.enqueueMutation(async () => {
            if (this.disposed) return
            const oldPlan = this.taskState.currentFocusChainChecklist
            const result = await this.commitChecklist({
                kind: "accepted",
                checklist: normalizedPlan,
                currentItem: null,
                ...(oldPlan ? { archive: oldPlan } : {}),
            })
            if (result.kind === "failed") throw new Error(result.message)
            this.taskState.hasWarnedSkipOrder = false
        })
    }

    public dispose() {
        this.disposed = true
        if (this.fileUpdateDebounceTimer) {
            clearTimeout(this.fileUpdateDebounceTimer)
            this.fileUpdateDebounceTimer = undefined
        }

        if (this.focusChainFileWatcher) {
            this.focusChainFileWatcher.close()
            this.focusChainFileWatcher = undefined
        }
    }
}
