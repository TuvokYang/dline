import { FocusChainSettings } from "@shared/FocusChainSettings"
import { isCompletedFocusChainItem } from "@shared/focus-chain-utils"
import * as chokidar from "chokidar"
import * as fs from "fs/promises"
import { telemetryService } from "@/services/telemetry"
import { Logger } from "@/shared/services/Logger"
import { ClineSay } from "../../../shared/ExtensionMessage"
import { Mode } from "../../../shared/storage/types"
import { writeFile } from "../../../utils/fs"
import { ensureTaskDirectoryExists } from "../../storage/disk"
import { StateManager } from "../../storage/StateManager"
import { TaskState } from "../TaskState"
import {
	appendToFocusChainHistory,
	createFocusChainMarkdownContent,
	ensureFocusChainFile,
	extractExampleItems,
	extractFocusChainItemsFromText,
	extractFocusChainListFromText,
	getFocusChainFilePath,
	getFocusChainHistoryFilePath,
	getUncheckedFocusChainItemAtIndex,
	hasChecklistTitle,
	hasNewChecklistHeader,
	hasUncheckedFocusChainItem,
	hasValidTodoItem,
	isAllItemsCompleted,
	mergeCompletedItems,
	mergeInProgressItem,
} from "./file-utils"
import { selectFocusChainInstructionPolicy } from "./instruction-policy"
import { FocusChainPrompts } from "./prompts"
import { parseFocusChainListCounts } from "./utils"

export interface FocusChainProjectionOptions {
	preview?: boolean
	mode?: Mode
	didSwitchFromPlan?: boolean
}

export interface FocusChainDependencies {
	taskId: string
	taskState: TaskState
	getMode: () => Mode
	stateManager: StateManager
	postStateToWebview: () => Promise<void>
	say: (type: ClineSay, text?: string, images?: string[], files?: string[], partial?: boolean) => Promise<number | undefined>
	focusChainSettings: FocusChainSettings
}

export class FocusChainManager {
	private taskId: string
	private taskState: TaskState
	private stateManager: StateManager
	private getMode: () => Mode
	private postStateToWebview: () => Promise<void>
	private say: (
		type: ClineSay,
		text?: string,
		images?: string[],
		files?: string[],
		partial?: boolean,
	) => Promise<number | undefined>
	private focusChainFileWatcher?: chokidar.FSWatcher
	private hasTrackedFirstProgress = false
	private focusChainSettings: FocusChainSettings
	private fileUpdateDebounceTimer?: NodeJS.Timeout

	constructor(dependencies: FocusChainDependencies) {
		this.taskId = dependencies.taskId
		this.taskState = dependencies.taskState
		this.stateManager = dependencies.stateManager
		this.getMode = dependencies.getMode
		this.postStateToWebview = dependencies.postStateToWebview
		this.say = dependencies.say
		this.focusChainSettings = dependencies.focusChainSettings
	}

	/**
	 * Sets up a file watcher to monitor changes to the focus chain list markdown file.
	 * Automatically updates the UI when the file is created, modified, or deleted by external editors.
	 * @requires this.taskId, this.context to be initialized
	 * @returns Promise<void> - Resolves when watcher is set up, logs errors if setup fails
	 */
	public async setupFocusChainFileWatcher() {
		try {
			const taskDir = await ensureTaskDirectoryExists(this.taskId)
			const focusChainFilePath = getFocusChainFilePath(taskDir, this.taskId)

			// Ensure focus chain file exists (create empty file for new tasks)
			// This prevents EPERM errors when user manually opens the file
			// and ensures the file is available for watcher events
			await ensureFocusChainFile(this.taskId, "")

			// Load existing checklist from disk into taskState
			// This is critical for task resumption: without this, taskState.currentFocusChainChecklist
			// remains null even if the file exists, causing "no task plan exists" errors
			const existingChecklist = await this.readFocusChainFromDisk()
			if (existingChecklist) {
				this.taskState.currentFocusChainChecklist = existingChecklist
				this.taskState.currentInProgressItemIndex =
					getUncheckedFocusChainItemAtIndex(existingChecklist, this.taskState.currentInProgressItemIndex) !== null
						? this.taskState.currentInProgressItemIndex
						: null
				await this.postStateToWebview()
			}

			// Initialize chokidar watcher
			this.focusChainFileWatcher = chokidar.watch(focusChainFilePath, {
				persistent: true,
				ignoreInitial: true,
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
					this.taskState.currentFocusChainChecklist = null
					this.taskState.currentInProgressItemIndex = null
					await this.postStateToWebview()
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

		// Debounce file watcher to prevent false positives
		this.fileUpdateDebounceTimer = setTimeout(async () => {
			try {
				const markdownTodoList = await this.readFocusChainFromDisk()
				if (markdownTodoList) {
					const previousList = this.taskState.currentFocusChainChecklist

					// Only update if the content actually changed
					if (previousList !== markdownTodoList) {
						this.taskState.currentFocusChainChecklist = markdownTodoList
						this.taskState.currentInProgressItemIndex =
							getUncheckedFocusChainItemAtIndex(markdownTodoList, this.taskState.currentInProgressItemIndex) !==
							null
								? this.taskState.currentInProgressItemIndex
								: null
						this.taskState.todoListWasUpdatedByUser = true

						await this.postStateToWebview()
						telemetryService.captureFocusChainListWritten(this.taskId)
					} else {
						Logger.log(
							`[Task ${this.taskId}] Focus Chain List: File watcher triggered but content unchanged, skipping update`,
						)
					}
				}
			} catch (error) {
				Logger.error(`[Task ${this.taskId}] Error updating focuss chain list from markdown file:`, error)
			}
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
				${FocusChainPrompts.completed(totalItems)}\n
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

	/**
	 * Reads the focus chain list from the task's markdown file on disk and extracts the checklist content.
	 * Returns the raw focus chain list string if found, or null if the file doesn't exist or contains no valid todos.
	 * @requires this.taskId and this.context to locate the task directory
	 * @returns Promise<string | null> - focus chain list content as string, or null if file missing/invalid
	 * @throws Returns null on file read errors (file not found, permission issues)
	 */
	private async readFocusChainFromDisk(): Promise<string | null> {
		try {
			const taskDir = await ensureTaskDirectoryExists(this.taskId)
			const todoFilePath = getFocusChainFilePath(taskDir, this.taskId)
			const markdownContent = await fs.readFile(todoFilePath, "utf8")
			const todoList = extractFocusChainListFromText(markdownContent)

			if (todoList) {
				const _todoLines = extractFocusChainItemsFromText(markdownContent)
				return todoList
			}

			return null
		} catch (error) {
			// File doesn't exist or can't be read, return null
			Logger.log(`[Task ${this.taskId}] focus chain list: Could not load from markdown file: ${error}`)
			return null
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
		} catch {
			// File doesn't exist yet, return null
			return null
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
	 * @returns Promise<void> - Updates taskState.currentFocusChainChecklist and sends UI messages
	 */
	public async updateFCListFromToolResponse(taskProgress: string | undefined) {
		try {
			if (!taskProgress?.trim()) {
				return
			}

			const newContent = taskProgress.trim()
			if (!hasValidTodoItem(newContent)) {
				return
			}

			this.taskState.apiRequestsSinceLastTodoUpdate = 0
			let previousList = this.taskState.currentFocusChainChecklist
			if (!previousList) {
				const persistedList = await this.readFocusChainFromDisk()
				if (persistedList) {
					this.taskState.currentFocusChainChecklist = persistedList
					previousList = persistedList
				}
			}
			const hasChecklistHeader = hasNewChecklistHeader(newContent)
			const isNewChecklist = hasChecklistTitle(newContent)

			if (hasChecklistHeader && !isNewChecklist) {
				this.taskState.consecutiveMistakeCount++
				this.taskState.focusChainRejectionMessage = FocusChainPrompts.titleRequired
				await this.say("error", "Focus Chain: A new checklist requires a # Title. Update rejected.")
				this.checkConsecutiveErrors()
				return
			}

			if (isNewChecklist && !hasUncheckedFocusChainItem(newContent)) {
				this.taskState.consecutiveMistakeCount++
				this.taskState.focusChainRejectionMessage = FocusChainPrompts.uncheckedItemRequired
				await this.say("error", "Focus Chain: A new checklist requires at least one unchecked item. Update rejected.")
				this.checkConsecutiveErrors()
				return
			}

			if (isNewChecklist) {
				if (previousList && !isAllItemsCompleted(previousList)) {
					this.taskState.consecutiveMistakeCount++
					Logger.warn(`[Task ${this.taskId}] focus chain: New checklist rejected — old checklist not fully completed.`)
					this.taskState.focusChainRejectionMessage = FocusChainPrompts.tamperingRejected
					await this.say(
						"error",
						"Focus Chain: AI attempted to replace the plan before all items were completed. Update rejected.",
					)
					this.checkConsecutiveErrors()
					return
				}

				if (previousList && isAllItemsCompleted(previousList)) {
					try {
						const taskDir = await ensureTaskDirectoryExists(this.taskId)
						await appendToFocusChainHistory(taskDir, this.taskId, previousList)
						this.taskState.focusChainHistory = await this.readFocusChainHistory()
					} catch (error) {
						Logger.error(`[Task ${this.taskId}] focus chain: Failed to archive:`, error)
					}
				}

				this.taskState.currentFocusChainChecklist = newContent
				this.taskState.currentInProgressItemIndex = null
				this.taskState.hasWarnedSkipOrder = false
				this.trackTelemetry(newContent)
				await this.persistAndNotify(newContent)
				return
			}

			if (!previousList) {
				this.taskState.consecutiveMistakeCount++
				Logger.warn(`[Task ${this.taskId}] focus chain: Completed items reported but no checklist exists.`)
				this.taskState.focusChainRejectionMessage = FocusChainPrompts.recommended
				await this.say("error", "Focus Chain: AI attempted to report progress but no task plan exists. Update rejected.")
				this.checkConsecutiveErrors()
				return
			}

			// Check if all items are already completed — reject, show guidance only in AI prompt
			if (isAllItemsCompleted(previousList)) {
				this.taskState.consecutiveMistakeCount++
				Logger.warn(`[Task ${this.taskId}] focus chain: Items reported but checklist already 100% complete.`)
				this.taskState.focusChainRejectionMessage = FocusChainPrompts.allCompletedAlready
				this.checkConsecutiveErrors()
				return
			}

			const hasCompletedItems = newContent.includes("- [x]")
			const hasInProgressItems = newContent.includes("- [ ]")

			// Handle in-progress-only reports (no completed items)
			if (!hasCompletedItems && hasInProgressItems) {
				const { updatedText, matchedItem: _matchedItem, matchedItemIndex } = mergeInProgressItem(previousList, newContent)

				if (!updatedText) {
					// - [ ] text mismatch — warn but don't block tools
					const examples = extractExampleItems(previousList, 3)
					const exampleStr = examples.join("\n")
					const msg = FocusChainPrompts.inProgressMismatchRejected(exampleStr)
					this.taskState.consecutiveMistakeCount++
					Logger.warn(`[Task ${this.taskId}] focus chain: In-progress item mismatch.`)
					this.taskState.focusChainRejectionMessage = msg
					await this.say("error", `Focus Chain: In-progress item doesn't match the plan. Use exact item text.`)
					this.checkConsecutiveErrors()
					return
				}

				this.taskState.currentFocusChainChecklist = updatedText
				this.taskState.currentInProgressItemIndex = matchedItemIndex
				this.trackTelemetry(updatedText)
				await this.persistAndNotify(updatedText)
				return
			}

			const mergeResult = mergeCompletedItems(previousList, newContent)
			let mergedText = mergeResult.mergedText
			let nextCurrentInProgressItemIndex =
				getUncheckedFocusChainItemAtIndex(mergedText, this.taskState.currentInProgressItemIndex) !== null
					? this.taskState.currentInProgressItemIndex
					: null
			const unmatchedItems = mergeResult.unmatchedItems

			if (unmatchedItems.length > 0) {
				this.taskState.consecutiveMistakeCount++
				// BLOCK next tool calls for - [x] mismatch (fabricated progress)
				this.taskState.blockNextToolCalls = true
				const unmatchedStr = unmatchedItems.map((i) => `- ${i}`).join("\n")
				const examples = extractExampleItems(previousList, 3)
				const exampleStr = examples.join("\n")
				const msg = FocusChainPrompts.itemMismatchRejected(unmatchedStr, exampleStr)
				Logger.warn(
					`[Task ${this.taskId}] focus chain: Item mismatch — ${unmatchedItems.length} items not found in checklist. Blocking next tools.`,
				)
				this.taskState.focusChainRejectionMessage = msg
				await this.say(
					"error",
					`Focus Chain: AI reported fabricated progress. Next tool calls BLOCKED. Unmatched: ${unmatchedStr}`,
				)
				this.checkConsecutiveErrors()
				return
			}

			// Process in-progress item when submitted alongside completed items
			if (hasCompletedItems && hasInProgressItems) {
				const progressResult = mergeInProgressItem(mergedText, newContent)
				if (progressResult.updatedText) {
					mergedText = progressResult.updatedText
					nextCurrentInProgressItemIndex = progressResult.matchedItemIndex
				}
				// If in-progress item didn't match, silently ignore
			}

			// Compute which items are newly completed in this report (vs. already [x] in previousList)
			// This prevents historical skip-order artifacts from blocking legitimate backfill updates.
			const normalizeItemText = (item: string): string => {
				return item.replace(/^-\s*\[[ xX]\]\s*/, "").trim()
			}
			const oldCompletedSet = new Set(
				extractFocusChainItemsFromText(previousList)
					.filter((item) => isCompletedFocusChainItem(item))
					.map(normalizeItemText),
			)
			const mergedCompletedSet = new Set(
				extractFocusChainItemsFromText(mergedText)
					.filter((item) => isCompletedFocusChainItem(item))
					.map(normalizeItemText),
			)
			// Items that are [x] in merged but were NOT [x] in previous = newly completed
			const newlyCompletedSet = new Set([...mergedCompletedSet].filter((item) => !oldCompletedSet.has(item)))

			let seenUnchecked = false
			let skipDetected = false
			const mergedItems = extractFocusChainItemsFromText(mergedText)
			for (const item of mergedItems) {
				const completed = isCompletedFocusChainItem(item)
				const isNewlyCompleted = completed && newlyCompletedSet.has(normalizeItemText(item))
				if (isNewlyCompleted) {
					if (seenUnchecked) {
						skipDetected = true
						break
					}
				} else if (!completed) {
					seenUnchecked = true
				}
				// Pre-existing [x] items (already completed before this report) do NOT
				// participate in skip detection — only newly-completed items can "skip".
			}

			if (skipDetected) {
				if (this.taskState.hasWarnedSkipOrder) {
					this.taskState.consecutiveMistakeCount++
					const examples = extractExampleItems(previousList, 3)
					const exampleStr = examples.join("\n")
					const msg = FocusChainPrompts.skipOrderRejected(exampleStr)
					Logger.warn(`[Task ${this.taskId}] focus chain: Second skip-order violation — rejecting.`)
					this.taskState.focusChainRejectionMessage = msg
					await this.say(
						"error",
						"Focus Chain: AI skipped items again (second violation). Update rejected. Complete earlier items first.",
					)
					this.checkConsecutiveErrors()
					return
				}
				this.taskState.hasWarnedSkipOrder = true
				Logger.warn(`[Task ${this.taskId}] focus chain: First skip-order violation — accepted with warning.`)
				this.taskState.focusChainRejectionMessage = FocusChainPrompts.skipOrderWarning
				await this.say(
					"error",
					"Focus Chain Warning: AI skipped unchecked items (first offense). Accepted this time, next skip will be rejected.",
				)
			}

			this.taskState.currentFocusChainChecklist = mergedText
			this.taskState.currentInProgressItemIndex = nextCurrentInProgressItemIndex
			this.trackTelemetry(mergedText)
			await this.persistAndNotify(mergedText)
		} catch (error) {
			Logger.error(`[Task ${this.taskId}] focus chain: Error in updateFCListFromToolResponse:`, error)
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
	}

	/**
	 * Persist checklist to disk and notify the UI.
	 */
	private async persistAndNotify(checklist: string) {
		try {
			await this.writeFocusChainToDisk(checklist)
			this.taskState.todoListWasUpdatedByUser = false
			this.taskState.consecutiveMistakeCount = 0
			this.taskState.blockNextToolCalls = false
			await this.say("task_progress", checklist)
		} catch (error) {
			Logger.error(`[Task ${this.taskId}] focus chain: Failed to write to disk:`, error)
			await this.say("task_progress", checklist)
		}
	}

	/**
	 * Evaluates multiple conditions to determine if focus chain list instructions should be included in the AI prompt.
	 * Returns true when in plan mode, after mode switches, when user edits exist, or at reminder intervals.
	 * @requires this.mode, this.taskState, and this.focusChainSettings to be initialized
	 * @returns boolean - True if instructions should be included in AI prompt, false otherwise
	 */
	public shouldIncludeFocusChainInstructions(options: FocusChainProjectionOptions = {}): boolean {
		// Include when switching from Plan > Act
		const justSwitchedFromPlanMode = options.didSwitchFromPlan || this.taskState.didRespondToPlanAskBySwitchingMode
		// Include when user had edited the list manually
		const userUpdatedList = this.taskState.todoListWasUpdatedByUser
		// Include when reaching the reminder interval, configured by settings
		const reachedReminderInterval =
			this.taskState.apiRequestsSinceLastTodoUpdate >= this.focusChainSettings.remindClineInterval
		// Include on first API request if list does not exist
		const isFirstApiRequest = this.taskState.apiRequestCount === 1 && !this.taskState.currentFocusChainChecklist

		const hasPendingRejection = this.taskState.focusChainRejectionMessage !== null

		const shouldInclude =
			reachedReminderInterval || justSwitchedFromPlanMode || userUpdatedList || isFirstApiRequest || hasPendingRejection

		return shouldInclude
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
	 * Performs cleanup operations when the focus chain manager is no longer needed.
	 * Cancels active file watchers and clears any pending debounce timers to prevent memory leaks.
	 * @requires No parameters needed
	 * @returns void - Cleans up timers and watchers, no return value
	 */
	/**
	 * Force-replace the current focus chain with a new plan.
	 * Archives the old plan to history and writes the new plan to disk.
	 * Used by FocusChainHandler for user-approved plan overrides.
	 */
	public async forceReplaceFocusChain(newPlan: string): Promise<void> {
		const normalizedPlan = newPlan.trim()
		if (!hasValidTodoItem(normalizedPlan)) {
			return
		}

		const oldPlan = this.taskState.currentFocusChainChecklist
		if (oldPlan) {
			try {
				const taskDir = await ensureTaskDirectoryExists(this.taskId)
				await appendToFocusChainHistory(taskDir, this.taskId, oldPlan)
				this.taskState.focusChainHistory = await this.readFocusChainHistory()
			} catch (error) {
				Logger.error(`[Task ${this.taskId}] focus chain: Failed to archive old plan:`, error)
			}
		}
		this.taskState.currentFocusChainChecklist = normalizedPlan
		this.taskState.currentInProgressItemIndex = null
		this.taskState.hasWarnedSkipOrder = false
		this.taskState.focusChainRejectionMessage = null
		try {
			await this.writeFocusChainToDisk(normalizedPlan)
			await this.say("task_progress", normalizedPlan)
		} catch (error) {
			Logger.error(`[Task ${this.taskId}] focus chain: Failed to write new plan:`, error)
		}
	}

	public dispose() {
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
