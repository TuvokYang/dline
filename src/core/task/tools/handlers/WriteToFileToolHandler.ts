import path from "node:path"
import { setTimeout as setTimeoutPromise } from "node:timers/promises"
import type { ToolUse } from "@core/assistant-message"
import { DiffParser, type DiffResult, type ParsedBlock } from "@core/assistant-message/diff"

/** Run a full diff parse (process all lines + finalize) and return the result. */
function runDiffParser(diff: string, originalContent: string, isPartial = false): DiffResult {
	const parser = new DiffParser(originalContent, isPartial)
	for (const line of diff.split("\n")) {
		parser.processLine(line)
	}
	parser.finalize()
	return parser.getResult()
}

import { getPrompt } from "@core/prompts/i18n"
import { formatResponse } from "@core/prompts/responses"
import { resolveWorkspacePath } from "@core/workspace"
import { ClineSayTool } from "@shared/ExtensionMessage"
import { getLastApiReqTotalTokens } from "@shared/getApiMetrics"
import { fileExistsAtPath } from "@utils/fs"
import { arePathsEqual, getReadablePath, isLocatedInWorkspace } from "@utils/path"
import { applyPatch } from "diff"
import { telemetryService } from "@/services/telemetry"
import { Logger } from "@/shared/services/Logger"
import { ClineDefaultTool } from "@/shared/tools"
import type { ToolResponse } from "../../index"
import type { IFullyManagedTool } from "../ToolExecutorCoordinator"
import type { ToolValidator } from "../ToolValidator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { captureAccepted, getModelInfo } from "../utils/AiOutputTelemetry"
import {
	countAppliedLines,
	describeBlockOutcomes,
	describeFailureReminder,
	projectFinalCard,
	projectMissingFileCard,
	projectStreamingCard,
} from "../utils/diffBlockPresentation"
import { applyModelContentFixes } from "../utils/ModelContentProcessor"

export class WriteToFileToolHandler implements IFullyManagedTool {
	readonly name = ClineDefaultTool.FILE_NEW // This handler supports write_to_file, replace_in_file, and new_rule

	/** Cache for diff error from validateAndPrepareFileOperation to return via execute(). */
	private _lastDiffError: string | null = null

	/**
	 * Cache for an ignore denial raised by validateAndPrepareFileOperation.
	 *
	 * The denial must travel back through execute()'s return value. Pushing it
	 * here and then returning an empty string let ToolExecutor commit that empty
	 * string over the same function_id, which replaced the denial with the
	 * "(tool did not return anything)" placeholder and hid the refusal from the
	 * model.
	 */
	private _lastAccessDenial: string | null = null

	constructor(private validator: ToolValidator) {}

	/**
	 * Explain what a rejected edit left on disk.
	 *
	 * A denied write is not only refused, it also leaves the target in a known
	 * state. Reporting that state keeps the model from assuming a partial edit
	 * landed and retrying against content that was never written.
	 */
	async describeDenial(config: TaskConfig, block: ToolUse): Promise<string> {
		const rawRelPath = block.params.path || block.params.absolutePath
		if (!rawRelPath) return formatResponse.toolDenied()
		const pathResult = resolveWorkspacePath(config, rawRelPath, "WriteToFileToolHandler.describeDenial")
		const absolutePath = typeof pathResult === "string" ? pathResult : pathResult.absolutePath
		const fileExists =
			config.services.diffViewProvider.editType !== undefined
				? config.services.diffViewProvider.editType === "modify"
				: await fileExistsAtPath(absolutePath)
		const note = fileExists
			? getPrompt("toolHandlers", "writeToFileNotUpdated")
			: getPrompt("toolHandlers", "writeToFileNotCreated")
		return `${formatResponse.toolDenied()} ${note}`
	}

	getDescription(block: ToolUse): string {
		const rawPath = block.params.path || block.params.absolutePath || ""
		const basename = rawPath ? rawPath.replace(/^.*[/\\]/, "") : rawPath
		return `[${block.name} for '${basename}']`
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const rawRelPath = block.params.path || block.params.absolutePath
		if (!rawRelPath) return

		const config = uiHelpers.getConfig()
		const rawContent = block.params.content
		const rawDiff = block.params.diff
		const relPath = uiHelpers.removeClosingTag(block, block.params.path ? "path" : "absolutePath", rawRelPath)

		// The streamed card must use the same projection as the final card.
		// Sending the raw SEARCH/REPLACE text here made the webview colour the
		// delimiter lines instead of the content, because it classifies a line
		// by its first character.
		const streamingCard =
			block.name === "replace_in_file" && rawDiff
				? projectStreamingCard(
						runDiffParser(rawDiff, config.services.diffViewProvider.originalContent || "", true).blocks,
					)
				: undefined

		const contentArr = rawDiff
			? (streamingCard?.content ?? [])
			: rawContent != null
				? [
						rawContent
							.split("\n")
							.map((line) => `+ ${line}`)
							.join("\n"),
					]
				: []

		const message: ClineSayTool = {
			tool: block.name === "replace_in_file" ? "editedExistingFile" : "newFileCreated",
			path: getReadablePath(config.cwd, relPath),
			content: contentArr,
			startLineNumbers: rawDiff ? (streamingCard?.startLineNumbers ?? []) : [1],
			blockErrors: rawDiff ? (streamingCard?.blockErrors ?? []) : undefined,
			operationIsLocatedInWorkspace: await isLocatedInWorkspace(relPath),
		}
		await uiHelpers.say("tool", JSON.stringify(message), undefined, undefined, true, block.ts)
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const rawRelPath = block.params.path || block.params.absolutePath
		const rawContent = block.params.content // for write_to_file
		const rawDiff = block.params.diff // for replace_in_file

		// Extract provider information for telemetry
		const { providerId, modelId } = getModelInfo(config)

		// Validate required parameters based on tool type
		if (!rawRelPath) {
			config.taskState.consecutiveMistakeCount++
			await config.services.diffViewProvider.reset()
			return await config.callbacks.sayAndCreateMissingParamError(
				block.name,
				block.params.absolutePath ? "absolutePath" : "path",
				undefined,
				block.ts,
			)
		}

		if (block.name === "replace_in_file" && !rawDiff) {
			config.taskState.consecutiveMistakeCount++
			await config.services.diffViewProvider.reset()
			const relPath = rawRelPath || "unknown"
			await config.callbacks.say(
				"error",
				`Dline tried to use replace_in_file for '${relPath}' without value for required parameter 'diff'. Retrying...`,
			)
			return formatResponse.toolError(formatResponse.replaceInFileMissingDiffError(relPath))
		}

		if (block.name === "write_to_file" && rawContent == null) {
			config.taskState.consecutiveMistakeCount++
			await config.services.diffViewProvider.reset()

			// Use progressive error with token budget awareness
			const relPath = rawRelPath || "unknown"
			const contextWindow = config.api.getModel().info.capabilities?.contextWindow ?? 128_000
			const lastApiReqTotalTokens = getLastApiReqTotalTokens(config.messageState.clineMessages)
			const contextUsagePercent = contextWindow > 0 ? Math.round((lastApiReqTotalTokens / contextWindow) * 100) : undefined
			const errorMessage = formatResponse.writeToFileMissingContentError(
				relPath,
				config.taskState.consecutiveMistakeCount,
				contextUsagePercent,
			)

			await config.callbacks.say(
				"error",
				`Dline tried to use write_to_file for '${relPath}' without value for required parameter 'content'. ${
					config.taskState.consecutiveMistakeCount >= 2
						? getPrompt("toolHandlers", "writeToFileApproachChange")
						: getPrompt("toolHandlers", "writeToFileRetrying")
				}`,
			)
			return formatResponse.toolError(errorMessage)
		}

		if (block.name === "new_rule" && !rawContent) {
			config.taskState.consecutiveMistakeCount++
			await config.services.diffViewProvider.reset()
			return await config.callbacks.sayAndCreateMissingParamError(block.name, "content", undefined, block.ts)
		}

		// NOTE: Do NOT reset consecutiveMistakeCount here - it should only be reset after successful completion
		// The reset was moved to after saveChanges() succeeds to properly track consecutive failures

		try {
			// Reset cached failures before each execution
			this._lastDiffError = null
			this._lastAccessDenial = null

			const result = await this.validateAndPrepareFileOperation(config, block, rawRelPath, rawDiff, rawContent)
			if (!result) {
				// If validateAndPrepareFileOperation stored a failure, return it as toolError
				// so ToolExecutor.handleCompleteBlock pushes it to the API exactly once.
				if (this._lastAccessDenial) {
					return this._lastAccessDenial
				}
				if (this._lastDiffError) {
					return this._lastDiffError
				}
				return ""
			}

			const { relPath, absolutePath, fileExists, diff, content, newContent, workspaceContext, blocks } = result

			let webviewStartLines: number[] = []
			let contentArr: string[] = []
			let webviewBlockErrors: (string | undefined)[] | undefined
			if (diff && block.name === "replace_in_file") {
				const card = projectFinalCard(runDiffParser(diff, config.services.diffViewProvider.originalContent || "").blocks)
				contentArr = card.content
				webviewStartLines = card.startLineNumbers
				webviewBlockErrors = card.blockErrors
			} else if (content != null) {
				contentArr = [
					content
						.split("\n")
						.map((l) => `+ ${l}`)
						.join("\n"),
				]
				webviewStartLines = [1]
			}
			const sharedMessageProps: ClineSayTool = {
				tool: block.name === "replace_in_file" ? "editedExistingFile" : "newFileCreated",
				path: getReadablePath(config.cwd, relPath),
				content: contentArr,
				startLineNumbers: webviewStartLines,
				blockErrors: webviewBlockErrors,
				operationIsLocatedInWorkspace: await isLocatedInWorkspace(relPath),
			}
			// if isEditingFile false, that means we have the full contents of the file already.
			// it's important to note how this function works, you can't make the assumption that the block.partial conditional will always be called since it may immediately get complete, non-partial data. So this part of the logic will always be called.
			// in other words, you must always repeat the block.partial logic here
			if (!config.services.diffViewProvider.isEditing) {
				// show gui message before showing edit animation
				const partialMessage = JSON.stringify(sharedMessageProps)
				await config.callbacks.say("tool", partialMessage, undefined, undefined, true, block.ts)
				await config.services.diffViewProvider.open(absolutePath, { displayPath: relPath })
			}
			await config.services.diffViewProvider.update(newContent, true)
			await setTimeoutPromise(300) // wait for diff view to update
			await config.services.diffViewProvider.scrollToFirstDiff()
			// showOmissionWarning(this.diffViewProvider.originalContent || "", newContent)

			const completeMessage = JSON.stringify({
				...sharedMessageProps,
				operationIsLocatedInWorkspace: await isLocatedInWorkspace(relPath),
			} satisfies ClineSayTool)

			await config.callbacks.say("tool", completeMessage, undefined, undefined, false, block.ts)
			const outcome = block.dline_tid ? config.admissionOutcomes?.get(block.dline_tid) : undefined

			telemetryService.captureToolUsage(
				config.ulid ?? "",
				block.name,
				modelId,
				providerId,
				outcome === undefined,
				true,
				workspaceContext,
				block.isNativeToolCall,
			)
			captureAccepted({
				ulid: config.ulid ?? "",
				tool: block.name,
				source: "agent",
				beforeContent: config.services.diffViewProvider.originalContent || "",
				afterContent: newContent,
				providerId,
				modelId,
				filesCreated: fileExists ? 0 : 1,
			})
			await setTimeoutPromise(3_500)

			// Run PreToolUse hook after admission but before execution
			try {
				const { ToolHookUtils } = await import("../utils/ToolHookUtils")
				await ToolHookUtils.runPreToolUseIfEnabled(config, block)
			} catch (error) {
				const { PreToolUseHookCancellationError } = await import("@core/hooks/PreToolUseHookCancellationError")
				if (error instanceof PreToolUseHookCancellationError) {
					Logger.warn(`WriteToFileToolHandler.execute: revertChanges after PreToolUseHook cancel, path=${relPath}`)
					await config.services.diffViewProvider.revertChanges()
					await config.services.diffViewProvider.reset()
					return formatResponse.toolDenied()
				}
				throw error
			}

			const { newProblemsMessage, userEdits, autoFormattingEdits, finalContent, wroteLines, savedLines, formatterChanged } =
				await this.saveAsClineEdit(config, relPath, absolutePath)

			// Reset consecutive mistake counter on successful file operation
			config.taskState.consecutiveMistakeCount = 0

			// Reset the diff view
			await config.services.diffViewProvider.reset()

			// Handle user edits if any
			if (userEdits) {
				await config.services.fileContextTracker.trackFileContext(relPath, "user_edited")
				await config.callbacks.say(
					"user_feedback_diff",
					JSON.stringify({
						tool: block.name === "replace_in_file" ? "editedExistingFile" : "newFileCreated",
						path: relPath,
						diff: userEdits,
					}),
				)

				// Capture human edit telemetry: diff between agent's proposed content and user's pre-save edits
				// Use applyPatch to reconstruct pre-save content from userEdits, excluding auto-formatting noise
				const preSaveContent = applyPatch(newContent, userEdits)
				captureAccepted({
					ulid: config.ulid ?? "",
					tool: block.name,
					source: "human",
					beforeContent: newContent,
					afterContent: preSaveContent || finalContent || "",
					providerId,
					modelId,
				})

				return formatResponse.fileEditWithUserChanges(
					getReadablePath(config.cwd, relPath),
					userEdits,
					autoFormattingEdits,
					wroteLines,
					savedLines,
					formatterChanged,
					newProblemsMessage,
				)
			}
			let replaceDeletedLines: number | undefined
			let replaceAddedLines: number | undefined
			let blockDetail = ""
			if (diff && blocks && blocks.length > 0) {
				// Every block reports the original range it replaced: a line-prefix
				// SEARCH or a SKIP range covers more text than the model wrote.
				blockDetail = `\n${describeBlockOutcomes(blocks)}`
				if (blocks.length > 1) {
					blockDetail += `\nTotal saved: ${savedLines} lines`
				}
				const diffCounts = countDiffLines(blocks, diff)
				replaceDeletedLines = diffCounts.deletedLines
				replaceAddedLines = diffCounts.addedLines
			} else if (diff) {
				const diffCounts = countDiffLines(blocks ?? [], diff)
				replaceDeletedLines = diffCounts.deletedLines
				replaceAddedLines = diffCounts.addedLines
			}
			return (
				formatResponse.fileEditWithoutUserChanges(
					getReadablePath(config.cwd, relPath),
					autoFormattingEdits,
					wroteLines,
					savedLines,
					formatterChanged,
					newProblemsMessage,
					replaceDeletedLines,
					replaceAddedLines,
				) + blockDetail
			)
		} catch (error) {
			// Reset diff view on error
			Logger.warn(
				`WriteToFileToolHandler.execute: revertChanges after error, path=${rawRelPath}, error=${(error as Error)?.message}`,
			)
			await config.services.diffViewProvider.revertChanges()
			await config.services.diffViewProvider.reset()
			throw error
		}
	}

	/**
	 * Shared validation and preparation logic used by both handlePartialBlock and execute methods.
	 * This validates file access permissions, checks if the file exists, and constructs the new content
	 * from either direct content or diff patches. It handles both creation of new files and modifications
	 * to existing ones.
	 *
	 * @param config The task configuration containing services and state
	 * @param block The tool use block containing the operation parameters
	 * @param relPath The relative path to the target file
	 * @param diff Optional diff content for replace operations
	 * @param content Optional direct content for write operations
	 * @param provider Optional provider string for telemetry (used when capturing diff edit failures)
	 * @returns Object containing validated path, file existence status, diff/content, and constructed new content,
	 *          or undefined if validation fails
	 */
	async validateAndPrepareFileOperation(config: TaskConfig, block: ToolUse, relPath: string, diff?: string, content?: string) {
		// Parse workspace hint and resolve path for multi-workspace support
		const pathResult = resolveWorkspacePath(config, relPath, "WriteToFileToolHandler.validateAndPrepareFileOperation")
		const { absolutePath, resolvedPath } =
			typeof pathResult === "string"
				? { absolutePath: pathResult, resolvedPath: relPath }
				: { absolutePath: pathResult.absolutePath, resolvedPath: pathResult.resolvedPath }

		// Determine workspace context for telemetry
		const fallbackAbsolutePath = path.resolve(config.cwd, relPath)
		const workspaceContext = {
			isMultiRootEnabled: config.isMultiRootEnabled || false,
			usedWorkspaceHint: typeof pathResult !== "string", // multi-root path result indicates hint usage
			resolvedToNonPrimary: !arePathsEqual(absolutePath, fallbackAbsolutePath),
			resolutionMethod: (typeof pathResult !== "string" ? "hint" : "primary_fallback") as "hint" | "primary_fallback",
		}

		// Writing has its own permission, so a read-only directory is refused here
		// even though its files can still be opened.
		const accessValidation = this.validator.checkWritePath(resolvedPath)
		if (!accessValidation.ok) {
			// Show error and return early (full original behavior)
			await config.callbacks.say("clineignore_error", resolvedPath)

			// Hand the denial back through execute()'s return value so
			// ToolExecutor.handleCompleteBlock commits it exactly once. Pushing
			// it here would be overwritten by execute()'s own empty result.
			this._lastAccessDenial = formatResponse.toolError(formatResponse.clineIgnoreError(resolvedPath))
			if (!config.enableParallelToolCalling) {
				config.taskState.didAlreadyUseTool = true
			}

			return
		}

		// Check if file exists to determine the correct UI message
		let fileExists: boolean
		if (config.services.diffViewProvider.editType !== undefined) {
			fileExists = config.services.diffViewProvider.editType === "modify"
		} else {
			fileExists = await fileExistsAtPath(absolutePath)
			// replace_in_file only edits existing files. Refusing here, before the
			// editor opens, keeps the create path from writing an empty file and
			// its missing directories just to match against empty content.
			if (diff && !fileExists) {
				await this.rejectMissingFile(config, block, resolvedPath, diff)
				return
			}
			config.services.diffViewProvider.editType = fileExists ? "modify" : "create"
		}

		// Construct newContent from diff
		let newContent: string
		let blocks: ParsedBlock[] = []
		newContent = "" // default to original content if not editing

		if (diff) {
			// Handle replace_in_file with diff construction
			// Apply model-specific fixes (deepseek models tend to use unescaped html entities in diffs)
			diff = applyModelContentFixes(diff, config.api.getModel().id, resolvedPath)

			// open the editor if not done already.  This is to fix diff error when model provides correct search-replace text but Cline throws error
			// because file is not open.
			if (!config.services.diffViewProvider.isEditing) {
				await config.services.diffViewProvider.open(absolutePath, { displayPath: relPath })
			}

			try {
				const result = runDiffParser(diff, config.services.diffViewProvider.originalContent || "")
				newContent = result.newContent
				blocks = result.blocks
				const hasAnyError = result.blocks.some((b) => b.hasError)
				if (hasAnyError && !block.partial) {
					const hasPartialSuccess = newContent !== (config.services.diffViewProvider.originalContent || "")
					const { content: blockContents, startLineNumbers, blockErrors } = projectFinalCard(result.blocks)
					const blockResults = describeBlockOutcomes(result.blocks)

					if (hasPartialSuccess) {
						config.taskState.consecutiveMistakeCount++
						const existingTs = block.ts
						const updatedToolJson = JSON.stringify({
							tool: "editedExistingFile",
							path: getReadablePath(config.cwd, resolvedPath),
							content: blockContents,
							startLineNumbers,
							blockErrors,
							operationIsLocatedInWorkspace: await isLocatedInWorkspace(resolvedPath),
						} satisfies ClineSayTool)
						await config.callbacks.say("tool", updatedToolJson, undefined, undefined, false, existingTs)
						await config.services.diffViewProvider.open(absolutePath, { displayPath: resolvedPath })
						await config.services.diffViewProvider.update(newContent, true)
						await this.saveAsClineEdit(config, resolvedPath, absolutePath)
						await config.services.diffViewProvider.reset()
						this._lastDiffError = `${blockResults}${describeFailureReminder(result.blocks)}`
						return
					}
					config.taskState.consecutiveMistakeCount++
					const noPartialJson = JSON.stringify({
						tool: "editedExistingFile",
						path: getReadablePath(config.cwd, resolvedPath),
						content: blockContents,
						startLineNumbers,
						blockErrors,
						operationIsLocatedInWorkspace: await isLocatedInWorkspace(resolvedPath),
					} satisfies ClineSayTool)
					await config.callbacks.say("tool", noPartialJson, undefined, undefined, false, block.ts)
					this._lastDiffError = `${blockResults}${describeFailureReminder(result.blocks)}`
					return
				}
			} catch (error) {
				if (block.partial) {
					return
				}

				config.taskState.consecutiveMistakeCount++

				const existingTs = block.ts
				const origContent = config.services.diffViewProvider.originalContent || ""
				const parsedBlocks = runDiffParser(diff, origContent).blocks
				const card = projectFinalCard(parsedBlocks)
				const updatedToolJson = JSON.stringify({
					tool: "editedExistingFile",
					path: getReadablePath(config.cwd, relPath),
					content: card.content,
					startLineNumbers: card.startLineNumbers,
					blockErrors: card.blockErrors,
					operationIsLocatedInWorkspace: await isLocatedInWorkspace(relPath),
				} satisfies ClineSayTool)
				await config.callbacks.say("tool", updatedToolJson, undefined, undefined, false, existingTs)

				// Extract provider information for telemetry
				const { providerId, modelId } = getModelInfo(config)

				// Extract error type from error message if possible
				const errorType =
					error instanceof Error && error.message.includes("does not match anything")
						? "search_not_found"
						: "other_diff_error"

				// Add telemetry for diff edit failure
				const isNativeToolCall = block.isNativeToolCall === true
				telemetryService.captureDiffEditFailure(config.ulid ?? "", modelId, providerId, errorType, isNativeToolCall)

				// Store error message for execute() to return as toolError to the API.
				// Do NOT pushToolResult here — let ToolExecutor.handleCompleteBlock
				// do it once from execute()'s return value to avoid double-push overwrite.
				this._lastDiffError = `${(error as Error)?.message}${describeFailureReminder(parsedBlocks)}`

				if (!config.enableParallelToolCalling) {
					config.taskState.didAlreadyUseTool = true
				}

				// Revert changes and reset diff view
				Logger.warn(
					`WriteToFileToolHandler.validateAndPrepareFileOperation: revertChanges after diff error, path=${resolvedPath}`,
				)
				await config.services.diffViewProvider.revertChanges()
				await config.services.diffViewProvider.reset()

				return
			}
		} else if (content != null) {
			// Handle write_to_file with direct content (empty string is valid)
			newContent = content

			// pre-processing newContent for cases where weaker models might add artifacts like markdown codeblock markers (deepseek/llama) or extra escape characters (gemini)
			if (newContent.startsWith("```")) {
				// this handles cases where it includes language specifiers like ```python ```js
				newContent = newContent.split("\n").slice(1).join("\n").trim()
			}
			if (newContent.endsWith("```")) {
				newContent = newContent.split("\n").slice(0, -1).join("\n").trim()
			}

			// Apply model-specific fixes (llama, gemini, and other models may add escape characters)
			newContent = applyModelContentFixes(newContent, config.api.getModel().id, resolvedPath)
		} else {
			// can't happen, since we already checked for content/diff above. but need to do this for type error
			return
		}

		return { relPath, absolutePath, fileExists, diff, content, newContent, workspaceContext, blocks }
	}

	/**
	 * Save the open diff view as a Dline-authored write.
	 *
	 * Every save path goes through here, so each write marks itself before the
	 * file changes on disk, records the checkpoint modification, clears the read
	 * cache, and settles the self-edit once the new content is tracked. A save
	 * that fails still settles, so the marker never swallows a later user edit.
	 */
	private async saveAsClineEdit(config: TaskConfig, relPath: string, absolutePath: string) {
		const tracker = config.services.fileContextTracker
		tracker.markFileAsEditedByCline(relPath)
		try {
			config.services.taskFileTracker.trackModification(absolutePath)
			const saved = await config.services.diffViewProvider.saveChanges()
			// Used to decide whether to wait for a busy terminal before the next API request.
			config.taskState.didEditFile = true
			config.taskState.fileReadCache.delete(absolutePath.toLowerCase())
			await tracker.trackFileContext(relPath, "cline_edited")
			return saved
		} finally {
			tracker.settleClineEdit(relPath)
		}
	}

	/**
	 * Refuse a replace_in_file call whose target does not exist.
	 *
	 * The diff card shows every block as refused and the tool result tells the
	 * model that nothing was created. Like other failed edits, the refusal counts
	 * as a consecutive mistake.
	 */
	private async rejectMissingFile(config: TaskConfig, block: ToolUse, resolvedPath: string, diff: string): Promise<void> {
		config.taskState.consecutiveMistakeCount++
		await config.services.diffViewProvider.reset()
		const card = projectMissingFileCard(runDiffParser(diff, "").blocks)
		const refusedJson = JSON.stringify({
			tool: "editedExistingFile",
			path: getReadablePath(config.cwd, resolvedPath),
			content: card.content,
			startLineNumbers: card.startLineNumbers,
			blockErrors: card.blockErrors,
			operationIsLocatedInWorkspace: await isLocatedInWorkspace(resolvedPath),
		} satisfies ClineSayTool)
		await config.callbacks.say("tool", refusedJson, undefined, undefined, false, block.ts)
		this._lastDiffError = formatResponse.toolError(
			formatResponse.replaceInFileFileNotFound(getReadablePath(config.cwd, resolvedPath)),
		)
	}
}

/**
 * Count deleted and added lines from parsed blocks.
 *
 * @param blocks - Parsed blocks; deleted lines come from the matched range, not the SEARCH text
 * @param diff - Raw diff string as fallback (unused when blocks available)
 */
function countDiffLines(blocks: readonly ParsedBlock[], diff?: string): { deletedLines: number; addedLines: number } {
	if (blocks.length > 0) {
		return countAppliedLines(blocks)
	}
	// Fallback: regex parsing when blocks not available (should rarely be needed)
	let deleted = 0
	let added = 0
	const rawDiff = diff || ""
	const firstSearchMatch = rawDiff.match(/^(-{7,}) SEARCH/m)
	const delimiterN = firstSearchMatch ? firstSearchMatch[1].length : 7
	const blockRegex = new RegExp(`\\n?\\+{${delimiterN}} REPLACE`)
	const regexBlocks = rawDiff.split(blockRegex)
	for (const block of regexBlocks) {
		if (!block.trim()) continue
		const sepRegex = new RegExp(`\\n?={${delimiterN}}\\s*\\n`)
		const parts = block.split(sepRegex)
		if (parts.length < 2) continue
		const searchMarkerRegex = new RegExp(`^-{${delimiterN}} SEARCH\\s*\\n?`)
		const search = parts[0].replace(searchMarkerRegex, "")
		const replace = parts[1]
		deleted += search.split("\n").filter((l) => l !== "").length
		added += replace.split("\n").filter((l) => l !== "").length
	}
	return { deletedLines: deleted, addedLines: added }
}
