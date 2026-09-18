import path from "node:path"
import { resolveProvider } from "@core/api"
import type { ToolUse } from "@core/assistant-message"
import { getCompactionPassIdentity } from "@core/context/context-management/target-window-fitting"
import { getHookModelContext } from "@core/hooks/hook-model-context"
import { getHooksEnabledSafe } from "@core/hooks/hooks-utils"
import { executePreCompactHookWithCleanup, HookCancellationError } from "@core/hooks/precompact-executor"
import { continuationPrompt } from "@core/prompts/contextManagement"
import { getPrompt } from "@core/prompts/i18n"
import { formatResponse } from "@core/prompts/responses"
import { StateManager } from "@core/storage/StateManager"
import { resolveWorkspacePath } from "@core/workspace"
import { extractFileContent } from "@integrations/misc/extract-file-content"
import { ClineSayTool } from "@shared/ExtensionMessage"
import { telemetryService } from "@/services/telemetry"
import { Logger } from "@/shared/services/Logger"
import { ClineDefaultTool } from "@/shared/tools"
import { prepareRegisteredToolAdmission } from "../../executors/tool/ToolAdmissionRegistry"
import type { ToolResponse } from "../../index"
import type { IPartialBlockHandler, IToolHandler } from "../ToolExecutorCoordinator"
import type { ToolValidator } from "../ToolValidator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { NO_TOOL_RESULT } from "../utils/ToolResultUtils"

export class SummarizeTaskHandler implements IToolHandler, IPartialBlockHandler {
	readonly name = ClineDefaultTool.SUMMARIZE_TASK

	constructor(private validator: ToolValidator) {}

	getDescription(block: ToolUse): string {
		return `[${block.name}]`
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		try {
			const authorization = config.explicitInstructionAuthorization
			if (
				!authorization ||
				authorization.type !== "summarize_task" ||
				authorization.targetTool !== ClineDefaultTool.SUMMARIZE_TASK ||
				authorization.state !== "consumed"
			) {
				return formatResponse.toolError("summarize_task requires a consumed explicit instruction authorization.")
			}
			const context: string | undefined = block.params.context

			// Validate required parameters
			if (!context) {
				config.taskState.consecutiveMistakeCount++
				return await config.callbacks.sayAndCreateMissingParamError(this.name, "context", undefined, block.ts)
			}

			config.taskState.consecutiveMistakeCount = 0

			const fittingState = config.taskState.targetWindowFittingState
			if (
				fittingState &&
				(config.compactionAttemptGuard === undefined ||
					!config.compactionAttemptGuard.isCurrent(getCompactionPassIdentity(fittingState), authorization.attemptId))
			) {
				Logger.debug(
					`[Task ${config.taskId}] Discarded stale compaction attempt for operation=${fittingState.operationId}, pass=${fittingState.passIndex}`,
				)
				return NO_TOOL_RESULT
			}

			// Variable to store context modification from PreCompact hook
			let hookContextModification: string | undefined

			// Run PreCompact hook right before showing the condensing message
			const hooksEnabled = getHooksEnabledSafe(config.services.stateManager.getGlobalSettingsKey("hooksEnabled"))
			if (hooksEnabled) {
				try {
					// Determine compaction strategy
					const useAutoCondense = StateManager.get().getGlobalSettingsKey("useAutoCondense")
					const strategy = useAutoCondense ? "auto-condense" : "standard-truncation-firstpair"

					const apiHistory = config.messageState.apiConversationHistory

					const result = await executePreCompactHookWithCleanup({
						taskId: config.taskId,
						ulid: config.ulid ?? "",
						modelContext: getHookModelContext(config.api, config.services.stateManager),
						apiConversationHistory: apiHistory,
						conversationHistoryDeletedRange: config.taskState.conversationHistoryDeletedRange,
						contextManager: config.services.contextManager,
						clineMessages: config.messageState.clineMessages,
						messageStateHandler: config.messageState,
						compactionStrategy: strategy,
						say: config.callbacks.say,
						setActiveHookExecution: async (hookExecution) => {
							if (hookExecution) {
								await config.callbacks.setActiveHookExecution(hookExecution)
							}
						},
						clearActiveHookExecution: config.callbacks.clearActiveHookExecution,
						postStateToWebview: config.callbacks.postStateToWebview,
						taskState: config.taskState,
						cancelTask: config.callbacks.cancelTask,
						hooksEnabled,
					})

					// Hook completed successfully - capture context modification if provided
					if (result.contextModification) {
						hookContextModification = result.contextModification
						Logger.log(`[PreCompact] Hook provided context modification for task ${config.taskId}`)
					}
				} catch (error) {
					// Check if this is a hook cancellation error
					if (error instanceof HookCancellationError) {
						// Hook was cancelled - show message and return early without executing summarization
						// (State already saved and task already cancelled by executePreCompactHookWithCleanup)
						await config.callbacks.say("error", getPrompt("toolHandlers", "contextCompactionCancelled"))
						return getPrompt("toolHandlers", "contextCompactionCancelled")
					}

					// Graceful degradation: Show warning but continue with compaction
					// Hook UI already shows "Failed" status with error details
					await config.callbacks.say(
						"error",
						`PreCompact hook failed, continuing with compaction: ${error instanceof Error ? error.message : String(error)}`,
					)
					Logger.error("[PreCompact] Hook execution failed, continuing with compaction:", error)
				}
			}

			// Render the model-produced summary. The internal instruction that requested
			// compaction is separate API input and must remain backend-only.
			const completeMessage = JSON.stringify({
				tool: "summarizeTask",
				content: context,
				compactionStatus: "completed",
			} satisfies ClineSayTool)
			const compactionMessageTs = config.taskState.contextCompactionMessageTs
			await config.callbacks.say("tool", completeMessage, undefined, undefined, false, compactionMessageTs ?? block.ts)
			if (compactionMessageTs !== undefined) {
				config.taskState.contextCompactionMessageTs = undefined
			}

			// Parse "Required Files" section from context and read files
			// We impose a max number of files which are allowed to be read in as well as on
			// the number of files which are allowed to be processed in total
			// We also impose a limit on the max number of chars these files reads can consume
			const loadedFilePaths: string[] = []
			let fileContents = ""
			const filePathRegex = /9\.\s*(?:Optional\s+)?Required Files:\s*((?:\n\s*-\s*.+)+)/m
			const match = context.match(filePathRegex)

			if (match) {
				const fileListText = match[1]
				const filePaths: string[] = []
				const lines = fileListText.split("\n")

				for (const line of lines) {
					const pathMatch = line.match(/^\s*-\s*(.+)$/)
					if (pathMatch) {
						filePaths.push(pathMatch[1].trim())
					}
				}

				let filesProcessed = 0
				let filesLoaded = 0
				let totalChars = 0
				const MAX_FILES_LOADED = 8
				const MAX_FILES_PROCESSED = 10
				const MAX_CHARS = 100_000

				// Prevents duplicate file reads, if occurs
				const loadedFiles = new Set<string>()

				// Read each file only if auto-approved
				// We consider the list of files still good context for task continuation even if user doesn't have auto approval on
				for (const relPath of filePaths) {
					// Validate that we have not loaded this file previously
					const normalizedPath = relPath.toLowerCase()
					if (loadedFiles.has(normalizedPath)) {
						continue
					}
					loadedFiles.add(normalizedPath)

					filesProcessed++
					if (filesProcessed > MAX_FILES_PROCESSED) {
						break
					}

					// Check .clineignore first and skip ignored files
					const accessValidation = this.validator.checkClineIgnorePath(relPath)
					if (!accessValidation.ok) {
						continue
					}

					// Optional enrichment never opens another prompt. The complete target I/O
					// effect stays inside the retained Admission closure, and canonical
					// confirmation returns the exact closure that is allowed to execute.
					let readAdmission = prepareRegisteredToolAdmission({
						canonicalToolName: ClineDefaultTool.FILE_READ,
						block: { ...block, name: ClineDefaultTool.FILE_READ, params: { path: relPath } },
						description: `[read_file for '${relPath}']`,
						snapshot: {
							taskId: config.taskId,
							cwd: config.cwd,
							workspaceRoots: config.workspaceManager?.getRoots().map((root) => root.path) ?? [config.cwd],
							workspaceRootEntries: config.workspaceManager
								?.getRoots()
								.map((root) => ({ name: root.name || path.basename(root.path), path: root.path })),
							primaryWorkspaceRoot: config.workspaceManager?.getPrimaryRoot()?.path,
							isMultiRootEnabled: config.isMultiRootEnabled,
							settings: config.autoApprovalSettings,
							blanket: {
								yoloMode: config.yoloModeToggled,
								approveAll: config.services.stateManager.getGlobalSettingsKey("autoApproveAllToggled") === true,
							},
							inheritsApproval: config.isSubagentExecution,
						},
						run: async () => {
							const pathResult = resolveWorkspacePath(config, relPath, "SummarizeTaskHandler")
							const { absolutePath, displayPath } =
								typeof pathResult === "string" ? { absolutePath: pathResult, displayPath: relPath } : pathResult
							const fileContent = await extractFileContent(absolutePath, false)
							return { displayPath, fileContent }
						},
					})
					if (readAdmission.outcome === "admitted" && readAdmission.confirm) {
						readAdmission = await readAdmission.confirm()
					}
					if (
						readAdmission.outcome === "admitted" &&
						(readAdmission.decision.kind === "automatic" || readAdmission.decision.kind === "none")
					) {
						try {
							const { displayPath, fileContent } = await readAdmission.run()

							// Check if adding this file would exceed character limit
							if (totalChars + fileContent.text.length > MAX_CHARS) {
								break // exceed our character alotment
							}

							// Track the file read
							await config.services.fileContextTracker.trackFileContext(relPath, "file_mentioned")

							// Append file content in the same format as file mentions
							fileContents += `\n\n<file_content path="${displayPath}">\n${fileContent.text}\n</file_content>`
							loadedFilePaths.push(displayPath)

							totalChars += fileContent.text.length
							filesLoaded++

							if (filesLoaded >= MAX_FILES_LOADED) {
								break
							}
						} catch (error) {
							// File read failed - log but continue with other files
							Logger.error(`Failed to read ${relPath} during summarization:`, error)
						}
					}
					// If not auto-approved, skip silently
				}
			}

			// Use the continuationPrompt to format the tool result, appending file contents
			if (fileContents) {
				const fileMentionString = `${loadedFilePaths.map((path) => `'${path}'`).join(", ")} (see below for file content)`
				fileContents =
					`\n\nThe following files were automatically read based on the files listed in the Required Files section: ${fileMentionString}. These are the latest versions of these files - you should reference them directly and not re-read them:` +
					fileContents
			}

			// Build the tool result with all components
			let toolResultContent = continuationPrompt(context) + fileContents

			// Append hook's context modification if provided
			if (hookContextModification) {
				toolResultContent += `\n\n[Context Modification from PreCompact Hook]\n${hookContextModification}`
			}

			const toolResult = formatResponse.toolResult(toolResultContent)

			// ContextCompactionSession owns review, acceptance, checkpointing, fitting state, and canonical writes.
			// This compatibility handler only formats an authorized summary result.

			// Capture telemetry after main business logic is complete
			const telemetryData = config.services.contextManager.getContextTelemetryData(
				config.messageState.clineMessages,
				config.api,
				config.taskState.lastAutoCompactTriggerIndex,
			)

			if (telemetryData) {
				// Extract provider information for telemetry
				const apiConfig = config.services.stateManager.getApiConfiguration()
				const currentMode = config.services.stateManager.getGlobalSettingsKey("mode")

				const provider = resolveProvider(apiConfig, currentMode)

				telemetryService.captureSummarizeTask(
					config.ulid ?? "",
					config.api.getModel().id,
					provider ?? "",
					telemetryData.tokensUsed,
					telemetryData.maxContextWindow,
				)
			}

			return toolResult
		} catch (error) {
			return `Error summarizing context window: ${(error as Error).message}`
		}
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const context = block.params.context || ""
		if (!context.trim()) return
		const config = uiHelpers.getConfig()
		// Session-owned compaction streams bypass this compatibility handler.
		// Mode-switch internal compact signals and any unauthorized invocation stay hidden.
		if (!config.taskState.isInternalContextCompactionRequest) return
		const existingTs = config.taskState.contextCompactionMessageTs

		// Show streaming summary generation in the stable compaction row.
		const partialMessage = JSON.stringify({
			tool: "summarizeTask",
			content: uiHelpers.removeClosingTag(block, "context", context),
			compactionStatus: "running",
		} satisfies ClineSayTool)

		const messageTs = await uiHelpers.say("tool", partialMessage, undefined, undefined, true, existingTs ?? block.ts)
		if (config.taskState.isInternalContextCompactionRequest && messageTs !== undefined) {
			config.taskState.contextCompactionMessageTs = messageTs
		}
	}
}
