import path from "node:path"
import { resolveProvider } from "@core/api"
import { isTaskReadScopePath } from "@core/artifacts/runtime"
import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { resolveWorkspacePath } from "@core/workspace"
import { extractFileContent, type FileContentResult } from "@integrations/misc/extract-file-content"
import { arePathsEqual, getReadablePath, isLocatedInWorkspace } from "@utils/path"
import { telemetryService } from "@/services/telemetry"
import { ClineSayTool } from "@/shared/ExtensionMessage"
import { ClineDefaultTool } from "@/shared/tools"
import type { ToolResponse } from "../../index"
import type { IFullyManagedTool } from "../ToolExecutorCoordinator"
import type { ToolValidator } from "../ToolValidator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"

export const DEFAULT_MAX_LINES = 1000
const FILE_TRUNCATED_MARKER = "\n\n---\n\n[FILE TRUNCATED:"

type DisplayedLineSlice = {
	start: number
	end: number
	totalLines: number
	lines: string[]
	truncationSuffix: string
}

function getDisplayedLineSlice(content: string, startLine?: number, endLine?: number): DisplayedLineSlice | null {
	if (!content) {
		return null
	}

	let body = content
	let truncationSuffix = ""
	const truncationIndex = content.indexOf(FILE_TRUNCATED_MARKER)
	if (truncationIndex !== -1) {
		body = content.slice(0, truncationIndex)
		truncationSuffix = content.slice(truncationIndex)
	}

	const lines = body.split(/\r?\n/)
	if (body.endsWith("\n") && lines.length > 0) {
		lines.pop()
	}
	const totalLines = lines.length

	const requestedStart = Math.max(1, startLine ?? 1)
	const requestedEnd = endLine !== undefined ? Math.max(1, endLine) : requestedStart + DEFAULT_MAX_LINES - 1
	const start = Math.min(requestedStart, requestedEnd)
	const requestedRangeEnd = Math.max(requestedStart, requestedEnd)
	const end = Math.min(totalLines, requestedRangeEnd, start + DEFAULT_MAX_LINES - 1)

	return { start, end, totalLines, lines, truncationSuffix }
}

/**
 * Line range shown for a read_file result (matches formatFileContentWithLineNumbers). Omits image reads and empty files.
 */
export function getReadToolDisplayedLineRange(
	block: ToolUse,
	fileContent: FileContentResult,
): { start: number; end: number } | undefined {
	if (fileContent.imageBlock) {
		return undefined
	}
	const { startLine, endLine } = parseRequestedLineRange(block)
	const slice = getDisplayedLineSlice(fileContent.text, startLine, endLine)
	if (!slice || slice.totalLines === 0) {
		return undefined
	}
	return { start: slice.start, end: slice.end }
}

/**
 * Slice file content to the requested line range, add one-based `N |` line labels,
 * and append a continuation hint when the file has more lines to read.
 */
export function formatFileContentWithLineNumbers(content: string, startLine?: number, endLine?: number): string {
	if (!content) {
		return content
	}

	const meta = getDisplayedLineSlice(content, startLine, endLine)
	if (!meta) {
		return content
	}

	const { start, end, totalLines, lines, truncationSuffix } = meta
	const slice = lines.slice(start - 1, end)
	const labeled = slice.map((line, i) => `${start + i} | ${line}`).join("\n")

	let suffix = truncationSuffix
	if (!truncationSuffix) {
		if (end < totalLines) {
			suffix = `\n\n(Showing lines ${start}-${end} of ${totalLines} total. Use start_line=${end + 1} to continue reading.)`
		} else {
			suffix = `\n\n(File has ${totalLines} lines total.)`
		}
	}

	return labeled + suffix
}

function parseRequestedLineRange(block: ToolUse): { startLine?: number; endLine?: number } {
	const startLine = block.params.start_line ? Number.parseInt(block.params.start_line, 10) : undefined
	const endLine = block.params.end_line ? Number.parseInt(block.params.end_line, 10) : undefined

	return {
		startLine: startLine !== undefined && !Number.isNaN(startLine) ? startLine : undefined,
		endLine: endLine !== undefined && !Number.isNaN(endLine) ? endLine : undefined,
	}
}

function buildReadResponse(block: ToolUse, fileContent: FileContentResult, prefix?: string): string {
	const { startLine, endLine } = parseRequestedLineRange(block)
	const text = fileContent.imageBlock
		? fileContent.text
		: formatFileContentWithLineNumbers(fileContent.text, startLine, endLine)

	return prefix ? `${prefix}\n${text}` : text
}

async function isProjectScopedRead(config: TaskConfig, requestedPath: string, absolutePath?: string): Promise<boolean> {
	if (await isLocatedInWorkspace(requestedPath)) return true
	const resolvedPath =
		absolutePath ?? (path.isAbsolute(requestedPath) ? path.resolve(requestedPath) : path.resolve(config.cwd, requestedPath))
	return isTaskReadScopePath(config.taskId, resolvedPath)
}

async function emitReadFileToolUiComplete(
	config: TaskConfig,
	sharedMessageProps: ClineSayTool,
	block: ToolUse,
	fileContent: FileContentResult,
): Promise<void> {
	if (config.isSubagentExecution) {
		return
	}
	const range = getReadToolDisplayedLineRange(block, fileContent)
	const payload: ClineSayTool = { ...sharedMessageProps }
	if (range) {
		payload.readLineStart = range.start
		payload.readLineEnd = range.end
	}
	await config.callbacks.say("tool", JSON.stringify(payload), undefined, undefined, false, block.ts)
}

export class ReadFileToolHandler implements IFullyManagedTool {
	readonly name = ClineDefaultTool.FILE_READ

	constructor(private validator: ToolValidator) {}

	getDescription(block: ToolUse): string {
		return `[${block.name} for '${block.params.path}']`
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const relPath = block.params.path

		// TODO: Add path integrity check here to skip obviously incomplete paths
		// during streaming (e.g. single-char paths like "e" before the full
		// "e:\workspace\..." is available). This would reduce meaningless
		// intermediate partial messages sent to the frontend.
		// Example guard:
		//   if (relPath && relPath.length < 3 && !relPath.includes(path.sep) && !relPath.includes("/")) {
		//       return  // wait for a more complete path
		//   }

		const config = uiHelpers.getConfig()
		if (config.isSubagentExecution) {
			return
		}

		// Create and show partial UI message
		const sharedMessageProps = {
			tool: "readFile",
			path: getReadablePath(config.cwd, uiHelpers.removeClosingTag(block, "path", relPath)),
			content: undefined,
			operationIsLocatedInWorkspace: relPath ? await isProjectScopedRead(config, relPath) : false,
		}

		const partialMessage = JSON.stringify(sharedMessageProps)

		await uiHelpers.say("tool", partialMessage, undefined, undefined, true, block.ts)
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const relPath: string | undefined = block.params.path

		// Extract provider information for telemetry
		const apiConfig = config.services.stateManager.getApiConfiguration()
		const currentMode = config.services.stateManager.getGlobalSettingsKey("mode")
		const provider = resolveProvider(apiConfig, currentMode)

		// Validate required parameters
		const pathValidation = this.validator.assertRequiredParams(block, "path")
		if (!pathValidation.ok) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(this.name, "path", undefined, block.ts)
		}
		if (!relPath) throw new Error("Validated read-file path is missing")

		// Check clineignore access
		const accessValidation = this.validator.checkClineIgnorePath(relPath)
		if (!accessValidation.ok) {
			if (!config.isSubagentExecution) {
				await config.callbacks.say("clineignore_error", relPath)
			}
			return formatResponse.toolError(formatResponse.clineIgnoreError(relPath))
		}

		// Resolve the absolute path based on multi-workspace configuration
		const pathResult = resolveWorkspacePath(config, relPath, "ReadFileToolHandler.execute")
		const { absolutePath, displayPath } =
			typeof pathResult === "string" ? { absolutePath: pathResult, displayPath: relPath } : pathResult

		// Determine workspace context for telemetry
		const fallbackAbsolutePath = path.resolve(config.cwd, relPath ?? "")
		const workspaceContext = {
			isMultiRootEnabled: config.isMultiRootEnabled || false,
			usedWorkspaceHint: typeof pathResult !== "string", // multi-root path result indicates hint usage
			resolvedToNonPrimary: !arePathsEqual(absolutePath, fallbackAbsolutePath),
			resolutionMethod: (typeof pathResult !== "string" ? "hint" : "primary_fallback") as "hint" | "primary_fallback",
		}

		// Handle approval flow
		const sharedMessageProps = {
			tool: "readFile",
			path: getReadablePath(config.cwd, displayPath),
			content: absolutePath,
			operationIsLocatedInWorkspace: await isProjectScopedRead(config, relPath, absolutePath),
		} satisfies ClineSayTool

		void sharedMessageProps
		telemetryService.captureToolUsage(
			config.ulid ?? "",
			block.name,
			config.api.getModel().id,
			provider ?? "",
			!block.dline_tid || !config.admissionOutcomes?.has(block.dline_tid),
			true,
			workspaceContext,
			block.isNativeToolCall,
		)

		// Run PreToolUse hook after approval but before execution
		try {
			const { ToolHookUtils } = await import("../utils/ToolHookUtils")
			await ToolHookUtils.runPreToolUseIfEnabled(config, block)
		} catch (error) {
			const { PreToolUseHookCancellationError } = await import("@core/hooks/PreToolUseHookCancellationError")
			if (error instanceof PreToolUseHookCancellationError) {
				return formatResponse.toolDenied()
			}
			throw error
		}

		// === File Read Deduplication ===
		// Check if we've already read this exact file in this task.
		// This prevents the model from endlessly reading the same file, which wastes API tokens.
		// The cache stores only metadata (readCount, mtime, imageBlock) �?not file content �?		// to keep memory usage minimal. On cache hits we re-read from disk to return fresh content.
		const cacheKey = absolutePath.toLowerCase()
		const cached = config.taskState.fileReadCache.get(cacheKey)

		if (cached) {
			// Check if the file has been modified externally (e.g. user edited in their editor)
			// by comparing the mtime. If it changed, treat this as a fresh read.
			try {
				const stat = await import("node:fs/promises").then((fs) => fs.stat(absolutePath))
				if (stat.mtimeMs !== cached.mtime) {
					// File was modified externally �?evict cache entry and fall through to fresh read
					config.taskState.fileReadCache.delete(cacheKey)
				}
			} catch {
				// If we can't stat the file, evict the cache and let extractFileContent handle the error
				config.taskState.fileReadCache.delete(cacheKey)
			}
		}

		// Re-check after possible mtime eviction
		const validCached = config.taskState.fileReadCache.get(cacheKey)

		if (validCached) {
			validCached.readCount++

			// Re-push image block for multimodal models so image context is not lost on cached reads
			if (validCached.imageBlock) {
				config.taskState.userMessageContent.push(validCached.imageBlock)
			}

			// Re-read from disk (cache doesn't store content to save memory)
			const supportsImages = config.api.getModel().info.capabilities?.supportsImages ?? false
			let fileContent: FileContentResult
			try {
				fileContent = await extractFileContent(absolutePath, supportsImages)
			} catch (error) {
				// Tool executed normally — returning a toolError result, not a tool crash.
				// Do NOT increment consecutiveMistakeCount: the model should see the error
				// and recover by trying a different path.
				const errorMessage = error instanceof Error ? error.message : String(error)
				const normalizedMessage = errorMessage.startsWith("Error reading file:")
					? errorMessage
					: `Error reading file: ${errorMessage}`
				return formatResponse.toolError(normalizedMessage)
			}

			if (validCached.readCount >= 3) {
				await emitReadFileToolUiComplete(config, sharedMessageProps, block, fileContent)
				return buildReadResponse(
					block,
					fileContent,
					`[DUPLICATE READ] You have already read '${displayPath}' ${validCached.readCount} times in this conversation. The content has not changed since your last read. Please use the information you already have and proceed with your task.`,
				)
			}

			await emitReadFileToolUiComplete(config, sharedMessageProps, block, fileContent)
			return buildReadResponse(
				block,
				fileContent,
				`[File already read] The file '${displayPath}' was already read earlier in this conversation. Returning content:`,
			)
		}

		// Execute the actual file read operation
		const supportsImages = config.api.getModel().info.capabilities?.supportsImages ?? false
		let fileContent: FileContentResult
		try {
			fileContent = await extractFileContent(absolutePath, supportsImages)
		} catch (error) {
			// Tool executed normally — returning a toolError result, not a tool crash.
			// Do NOT increment consecutiveMistakeCount: the model should see the error
			// and recover by trying a different path.
			const errorMessage = error instanceof Error ? error.message : String(error)
			const normalizedMessage = errorMessage.startsWith("Error reading file:")
				? errorMessage
				: `Error reading file: ${errorMessage}`
			return formatResponse.toolError(normalizedMessage)
		}

		// Only reset mistake count after a successful read, so that repeated
		// file-not-found errors accumulate toward the yolo-mode mistake limit.
		config.taskState.consecutiveMistakeCount = 0

		// Track file read operation
		await config.services.fileContextTracker.trackFileContext(relPath, "read_tool")

		// Cache metadata for deduplication (no content stored �?saves memory)
		let mtime = 0
		try {
			const stat = await import("node:fs/promises").then((fs) => fs.stat(absolutePath))
			mtime = stat.mtimeMs
		} catch {
			// If stat fails, use 0 �?the next cache hit will evict due to mtime mismatch
		}
		config.taskState.fileReadCache.set(cacheKey, {
			readCount: 1,
			mtime,
			imageBlock: fileContent.imageBlock,
		})

		// Handle image blocks separately - they need to be pushed to userMessageContent
		if (fileContent.imageBlock) {
			config.taskState.userMessageContent.push(fileContent.imageBlock)
			await emitReadFileToolUiComplete(config, sharedMessageProps, block, fileContent)
			return buildReadResponse(block, fileContent)
		}

		await emitReadFileToolUiComplete(config, sharedMessageProps, block, fileContent)
		return buildReadResponse(block, fileContent)
	}
}
