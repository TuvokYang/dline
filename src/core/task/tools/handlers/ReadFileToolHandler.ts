import path from "node:path"
import { resolveProvider } from "@core/api"
import { isTaskReadScopePath } from "@core/artifacts/runtime"
import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import { resolveWorkspacePath } from "@core/workspace"
import { extractFileContent, type FileContentResult, isPlainTextFile } from "@integrations/misc/extract-file-content"
import { readTextLineRange, type TextLineRange } from "@integrations/misc/read-text-line-range"
import { arePathsEqual, getReadablePath, isLocatedInWorkspace } from "@utils/path"
import { telemetryService } from "@/services/telemetry"
import { MAX_TOOL_RESULT_TEXT_BYTES, TRUNCATION_MARKER_PREFIX } from "@/shared/content-limits"
import { UiSayTool } from "@/shared/ExtensionMessage"
import { DlineDefaultTool } from "@/shared/tools"
import type { IFullyManagedTool } from "../ToolExecutorCoordinator"
import type { ToolResponse } from "../ToolResponse"
import type { ToolValidator } from "../ToolValidator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { resolveToolResultBytes } from "../utils/tool-result-budget"

export const DEFAULT_MAX_LINES = 1000

/** Room kept in the tool result for a read prefix and the continuation footer. */
const READ_RESULT_RESERVE_BYTES = 2 * 1024
/** Bytes the line labels and lines of one plain-text read may take. */
const READ_LINES_BUDGET_BYTES = MAX_TOOL_RESULT_TEXT_BYTES - READ_RESULT_RESERVE_BYTES
/** Shortest part of each line a wide read keeps; a narrower range leaves each line more room. */
const MIN_LINE_BYTES = 2 * 1024
/** Lines a read still returns when the context budget leaves no room, so it can name where to continue. */
const MIN_READ_LINES_BYTES = 512

/**
 * Bytes the lines of this read may take.
 *
 * The call's share of the context budget, not a fixed size: parallel reads
 * split what the conversation can still hold, and a read that stops early
 * names the line to continue from.
 */
function resolveReadLinesBudget(config: Pick<TaskConfig, "contextBudget">): number {
    const resultBytes = resolveToolResultBytes(config.contextBudget, MAX_TOOL_RESULT_TEXT_BYTES)
    // Never more lines than the whole result may hold: a smaller result keeps
    // half of itself for the lines and half for the prefix and footer.
    const minLinesBytes = Math.min(MIN_READ_LINES_BYTES, Math.floor(resultBytes / 2))
    return Math.min(READ_LINES_BUDGET_BYTES, Math.max(minLinesBytes, resultBytes - READ_RESULT_RESERVE_BYTES))
}

/** What one read produced for the model and for the chat row. */
interface ReadFileOutcome {
    readonly text: string
    readonly imageBlock?: FileContentResult["imageBlock"]
    readonly displayedRange?: { readonly start: number; readonly end: number }
}

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
    const truncationIndex = content.indexOf(TRUNCATION_MARKER_PREFIX)
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

/** The lines a read asks for, normalized the same way for every file type. */
function resolveLineWindow(startLine?: number, endLine?: number): { start: number; maxLines: number } {
    const requestedStart = Math.max(1, startLine ?? 1)
    const requestedEnd = endLine !== undefined ? Math.max(1, endLine) : requestedStart + DEFAULT_MAX_LINES - 1
    const start = Math.min(requestedStart, requestedEnd)
    const end = Math.max(requestedStart, requestedEnd)
    return { start, maxLines: Math.min(end - start + 1, DEFAULT_MAX_LINES) }
}

function lineLabel(lineNumber: number): string {
    return `${lineNumber} | `
}

function lineCutSuffix(omittedBytes: number): string {
    return omittedBytes > 0 ? ` …[line cut: ${omittedBytes} more bytes]` : ""
}

/**
 * Label the lines of a plain-text read and append the footer that tells the
 * model where the file continues, why the read stopped, and what it cut.
 */
export function formatTextLineRange(range: TextLineRange): string {
    const labeled = range.lines
        .map((line, index) => `${lineLabel(range.startLine + index)}${line.text}${lineCutSuffix(line.omittedBytes)}`)
        .join("\n")
    const footer = describeLineRange(range)
    return labeled ? `${labeled}\n\n${footer}` : footer
}

function describeLineRange(range: TextLineRange): string {
    const total = range.totalLines
    if (range.lines.length === 0) {
        // An empty file reads as empty text, as it always has.
        if (total === 0) return ""
        if (total !== undefined) return `(start_line=${range.startLine} is past the end of the file, which has ${total} lines.)`
        return `(Scanned ${range.scannedLines} lines without reaching start_line=${range.startLine}; the file is too large to read that far. Use search_files to locate the text instead.)`
    }
    const notes: string[] = []
    if (total !== undefined && range.endLine >= total) notes.push(`(File has ${total} lines total.)`)
    else if (range.stop === "scan_limit") {
        // A follow-up read rescans from the top and would stop at the same point.
        notes.push(
            `(Showing lines ${range.startLine}-${range.endLine} of at least ${range.scannedLines}. The file is too large to read past this line; use search_files to locate later text.)`,
        )
    } else {
        const extent = total !== undefined ? `of ${total} total` : `of at least ${range.scannedLines}`
        const reason = range.stop === "max_bytes" ? " The read stopped early to stay within the result size limit." : ""
        notes.push(
            `(Showing lines ${range.startLine}-${range.endLine} ${extent}.${reason} Use start_line=${range.endLine + 1} to continue reading.)`,
        )
    }
    const cutLines = range.lines.filter((line) => line.omittedBytes > 0).length
    if (cutLines > 0) {
        notes.push(`(${cutLines} long line(s) were cut at the per-line limit; use search_files to find text inside them.)`)
    }
    return notes.join("\n")
}

/**
 * Read a plain-text file line by line, so any range of a file of any size can be
 * reached and the result stays within the tool result limit.
 */
async function readPlainTextLines(
    absolutePath: string,
    block: ToolUse,
    linesBudgetBytes: number,
    signal: AbortSignal | undefined,
): Promise<ReadFileOutcome> {
    const { startLine, endLine } = parseRequestedLineRange(block)
    const window = resolveLineWindow(startLine, endLine)
    let range: TextLineRange
    try {
        range = await readTextLineRange(absolutePath, {
            startLine: window.start,
            maxLines: window.maxLines,
            maxBytes: linesBudgetBytes,
            maxLineBytes: Math.max(MIN_LINE_BYTES, Math.floor(linesBudgetBytes / window.maxLines)),
            lineOverheadBytes: (lineNumber, omittedBytes) =>
                Buffer.byteLength(lineLabel(lineNumber) + lineCutSuffix(omittedBytes), "utf8"),
            signal,
        })
    } catch (error) {
        if ((error as NodeJS.ErrnoException)?.code === "ENOENT") throw new Error(`File not found: ${absolutePath}`)
        throw new Error(`Error reading file: ${error instanceof Error ? error.message : String(error)}`)
    }
    return {
        text: formatTextLineRange(range),
        ...(range.lines.length > 0 ? { displayedRange: { start: range.startLine, end: range.endLine } } : {}),
    }
}

/** Plain text is read line by line; images and parsed documents keep their whole-file extraction. */
async function readFileForTool(
    absolutePath: string,
    block: ToolUse,
    supportsImages: boolean,
    linesBudgetBytes: number,
    signal?: AbortSignal,
): Promise<ReadFileOutcome> {
    if (isPlainTextFile(absolutePath)) return readPlainTextLines(absolutePath, block, linesBudgetBytes, signal)
    const fileContent = await extractFileContent(absolutePath, supportsImages)
    if (fileContent.imageBlock) return { text: fileContent.text, imageBlock: fileContent.imageBlock }
    const { startLine, endLine } = parseRequestedLineRange(block)
    const displayedRange = getReadToolDisplayedLineRange(block, fileContent)
    return {
        text: formatFileContentWithLineNumbers(fileContent.text, startLine, endLine),
        ...(displayedRange ? { displayedRange } : {}),
    }
}

function buildReadResponse(outcome: ReadFileOutcome, prefix?: string): string {
    return prefix ? `${prefix}\n${outcome.text}` : outcome.text
}

async function isProjectScopedRead(config: TaskConfig, requestedPath: string, absolutePath?: string): Promise<boolean> {
    if (await isLocatedInWorkspace(requestedPath)) return true
    const resolvedPath =
        absolutePath ?? (path.isAbsolute(requestedPath) ? path.resolve(requestedPath) : path.resolve(config.cwd, requestedPath))
    return isTaskReadScopePath(config.taskId, resolvedPath)
}

async function emitReadFileToolUiComplete(
    config: TaskConfig,
    sharedMessageProps: UiSayTool,
    block: ToolUse,
    outcome: ReadFileOutcome,
): Promise<void> {
    if (config.isSubagentExecution) {
        return
    }
    const range = outcome.displayedRange
    const payload: UiSayTool = { ...sharedMessageProps }
    if (range) {
        payload.readLineStart = range.start
        payload.readLineEnd = range.end
    }
    await config.callbacks.say("tool", JSON.stringify(payload), undefined, undefined, false, block.ts)
}

export class ReadFileToolHandler implements IFullyManagedTool {
    readonly name = DlineDefaultTool.FILE_READ

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
        } satisfies UiSayTool

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
            let outcome: ReadFileOutcome
            try {
                outcome = await readFileForTool(
                    absolutePath,
                    block,
                    supportsImages,
                    resolveReadLinesBudget(config),
                    config.taskState.operationSignal,
                )
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
                await emitReadFileToolUiComplete(config, sharedMessageProps, block, outcome)
                return buildReadResponse(
                    outcome,
                    `[DUPLICATE READ] You have already read '${displayPath}' ${validCached.readCount} times in this conversation. The content has not changed since your last read. Please use the information you already have and proceed with your task.`,
                )
            }

            await emitReadFileToolUiComplete(config, sharedMessageProps, block, outcome)
            return buildReadResponse(
                outcome,
                `[File already read] The file '${displayPath}' was already read earlier in this conversation. Returning content:`,
            )
        }

        // Execute the actual file read operation
        const supportsImages = config.api.getModel().info.capabilities?.supportsImages ?? false
        let outcome: ReadFileOutcome
        try {
            outcome = await readFileForTool(
                absolutePath,
                block,
                supportsImages,
                resolveReadLinesBudget(config),
                config.taskState.operationSignal,
            )
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
            imageBlock: outcome.imageBlock,
        })

        // Handle image blocks separately - they need to be pushed to userMessageContent
        if (outcome.imageBlock) {
            config.taskState.userMessageContent.push(outcome.imageBlock)
        }

        await emitReadFileToolUiComplete(config, sharedMessageProps, block, outcome)
        return buildReadResponse(outcome)
    }
}
