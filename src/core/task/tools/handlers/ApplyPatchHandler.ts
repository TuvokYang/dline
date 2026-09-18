import { readFile } from "node:fs/promises"
import * as path from "node:path"
import { resolve as resolvePath } from "node:path"
import type { ToolUse } from "@core/assistant-message"
import { getPrompt } from "@core/prompts/i18n"
import { resolveWorkspacePath } from "@core/workspace"
import type { ClineSayTool } from "@shared/ExtensionMessage"
import { fileExistsAtPath } from "@utils/fs"
import { isLocatedInWorkspace } from "@utils/path"
import { applyPatch } from "diff"
import { telemetryService } from "@/services/telemetry"
import { BASH_WRAPPERS, DiffError, PATCH_MARKERS, type Patch, PatchActionType, type PatchChunk } from "@/shared/Patch"
import { preserveEscaping } from "@/shared/string"
import { ClineDefaultTool } from "@/shared/tools"
import type { ToolResponse } from "../../index"
import type { IFullyManagedTool } from "../ToolExecutorCoordinator"
import type { ToolValidator } from "../ToolValidator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { captureAccepted, getModelInfo } from "../utils/AiOutputTelemetry"
import { type FileOpsResult, FileProviderOperations } from "../utils/FileProviderOperations"
import { PatchParser } from "../utils/PatchParser"
import { PathResolver } from "../utils/PathResolver"

interface FileChange {
	type: PatchActionType
	oldContent?: string
	newContent?: string
	movePath?: string
	/** Starting line numbers (1-indexed) for each chunk in the patch */
	startLineNumbers?: number[]
}

interface Commit {
	changes: Record<string, FileChange>
}

export interface ApplyPatchFileOutcome {
	path: string
	status: "added" | "updated" | "deleted"
	result: FileOpsResult
}

/** Format per-file apply_patch outcomes with stable path and operation mapping. */
export function formatApplyPatchOutcomes(outcomes: readonly ApplyPatchFileOutcome[]): string[] {
	return outcomes.map(({ path, status, result }) => {
		if (status === "deleted" || result.deleted) {
			return `${path}: [deleted]`
		}
		return `${path}: [${status}] (wrote ${result.wroteLines ?? 0} lines, saved ${result.savedLines ?? 0} lines)`
	})
}

export const PatchClineSayMap = {
	[PatchActionType.ADD]: "newFileCreated",
	[PatchActionType.DELETE]: "fileDeleted",
	[PatchActionType.UPDATE]: "editedExistingFile",
} as const

export class ApplyPatchHandler implements IFullyManagedTool {
	readonly name = ClineDefaultTool.APPLY_PATCH
	private config?: TaskConfig
	private pathResolver?: PathResolver
	private providerOps?: FileProviderOperations

	constructor(private validator: ToolValidator) {}

	private initializeHelpers(config: TaskConfig): void {
		if (!this.pathResolver || this.config !== config) {
			this.pathResolver = new PathResolver(config, this.validator)
		}
		if (!this.providerOps) {
			this.providerOps = new FileProviderOperations(config.services.diffViewProvider)
		}
	}

	getDescription(_block: ToolUse): string {
		return `[${this.name} for patch application]`
	}

	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const rawInput = block.params.input
		if (!rawInput) return

		const lines = this.stripBashWrapper(rawInput.split("\n"))
		let targetPath: string | undefined
		let actionType: PatchActionType | undefined
		let contentStartIndex = -1
		for (let index = 0; index < lines.length; index++) {
			const line = lines[index]
			for (const [marker, type] of [
				[PATCH_MARKERS.ADD, PatchActionType.ADD],
				[PATCH_MARKERS.UPDATE, PatchActionType.UPDATE],
				[PATCH_MARKERS.DELETE, PatchActionType.DELETE],
			] as const) {
				if (line.startsWith(marker)) {
					targetPath = line.substring(marker.length).trim()
					actionType = type
					contentStartIndex = index + 1
					break
				}
			}
			if (targetPath) break
		}
		if (!targetPath || !actionType || targetPath.includes("***")) return

		let displayPath = targetPath
		if (actionType === PatchActionType.UPDATE) {
			const moveLine = lines[contentStartIndex]
			if (moveLine?.startsWith(PATCH_MARKERS.MOVE)) {
				displayPath = moveLine.substring(PATCH_MARKERS.MOVE.length).trim() || targetPath
			}
		}
		const message: ClineSayTool = {
			tool: PatchClineSayMap[actionType],
			path: displayPath,
			content: rawInput,
		}
		await uiHelpers.say("tool", JSON.stringify(message), undefined, undefined, true, block.ts)
	}

	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		const provider = config.services.diffViewProvider
		const rawInput = block.params.input

		if (!rawInput) {
			config.taskState.consecutiveMistakeCount++
			return await config.callbacks.sayAndCreateMissingParamError(block.name, "input", undefined, block.ts)
		}

		config.taskState.consecutiveMistakeCount = 0
		this.initializeHelpers(config)

		if (provider.isEditing) {
			try {
				await provider.reset()
			} catch {
				// Ignore reset errors
			}
		}

		try {
			const lines = this.preprocessLines(rawInput)

			// Identify files needed
			const filesToLoad = this.extractFilesForOperations(rawInput, [PATCH_MARKERS.UPDATE, PATCH_MARKERS.DELETE])
			const currentFiles = await this.loadFiles(config, filesToLoad)

			// Parse patch
			const parser = new PatchParser(lines, currentFiles)
			const { patch, fuzz } = parser.parse()

			// Convert to commit
			const commit = await this.patchToCommit(patch, currentFiles)

			this.config = config

			// Run PreToolUse hook before applying changes
			try {
				const { ToolHookUtils } = await import("../utils/ToolHookUtils")
				await ToolHookUtils.runPreToolUseIfEnabled(config, block)
			} catch (error) {
				const { PreToolUseHookCancellationError } = await import("@core/hooks/PreToolUseHookCancellationError")
				if (error instanceof PreToolUseHookCancellationError) {
					await provider.reset()
					return getPrompt("toolHandlers", "patchDenied")
				}
				throw error
			}

			// Generate summary
			const changedFiles = Object.keys(commit.changes)
			const messages = await this.generateChangeSummary(commit.changes)

			const finalResponses = []
			const applyResults: Record<string, FileOpsResult> = {}
			const fileOutcomes: ApplyPatchFileOutcome[] = []
			const admissionOutcome = block.dline_tid ? config.admissionOutcomes?.get(block.dline_tid) : undefined

			// Create a mapping from message path to original commit change key
			// (needed because for move operations, message.path is the new path, but commit.changes key is the old path)
			const pathToChangeKey = new Map<string, string>()
			for (const [originalPath, change] of Object.entries(commit.changes)) {
				if (change.type === PatchActionType.UPDATE && change.movePath) {
					pathToChangeKey.set(change.movePath, originalPath)
				} else {
					pathToChangeKey.set(originalPath, originalPath)
				}
			}

			// Admission covers the whole patch. Prepare and save each file under that grant.
			for (const message of messages) {
				const messagePath = message.path
				if (!messagePath) {
					continue
				}

				// Get the original change key (for move operations, this is the old path)
				const originalPath = pathToChangeKey.get(messagePath)
				if (!originalPath) {
					continue
				}

				const change = commit.changes[originalPath]
				if (!change) {
					continue
				}

				// Determine the actual file path to use for operations
				// For move operations, we prepare the new file, but the change is keyed by the old path
				const operationPath = change.type === PatchActionType.UPDATE && change.movePath ? change.movePath : originalPath

				// Prepare the change for this file (open and update, but don't save)
				await this.prepareFileChange(change, operationPath)
				await this.presentAcceptedChange(config, block, message, rawInput, change, admissionOutcome === undefined)

				// Save the changes for this file after admission
				const fileResult = await this.saveFileChange(change, operationPath)
				if (fileResult) {
					// For move operations, we need to handle both old and new paths
					if (change.type === PatchActionType.UPDATE && change.movePath) {
						applyResults[change.movePath] = fileResult
						fileOutcomes.push({ path: change.movePath, status: "added", result: fileResult })
						// Delete the old file after saving the new one
						await this.providerOps?.deleteFile(originalPath)
						applyResults[originalPath] = { deleted: true }
						fileOutcomes.push({ path: originalPath, status: "deleted", result: { deleted: true } })
					} else {
						applyResults[originalPath] = fileResult
						fileOutcomes.push({
							path: originalPath,
							status: change.type === PatchActionType.ADD ? "added" : "updated",
							result: fileResult,
						})
					}
				}

				// Reset provider state to ensure clean state for the next file operation
				await provider.reset()

				finalResponses.push(messagePath)
			}

			// Track all changed files for per-file checkpointing
			for (const changedFilePath of changedFiles) {
				const change = commit.changes[changedFilePath]
				// For move operations, track the new path instead.
				// Resolve to absolute path using config.cwd as base, since
				// patch file paths may be workspace-relative.
				const relPathToTrack =
					change.type === PatchActionType.UPDATE && change.movePath ? change.movePath : changedFilePath
				const absPathToTrack = path.resolve(config.cwd, relPathToTrack)
				config.services.taskFileTracker.trackModification(absPathToTrack)
				// Also track the old path for move operations
				if (change.type === PatchActionType.UPDATE && change.movePath) {
					const absOldPath = path.resolve(config.cwd, changedFilePath)
					config.services.taskFileTracker.trackModification(absOldPath)
				}
			}

			// Track all changed files once after all operations are complete
			for (const changedFilePath of changedFiles) {
				const change = commit.changes[changedFilePath]
				// For move operations, track the new path instead
				const pathToTrack = change.type === PatchActionType.UPDATE && change.movePath ? change.movePath : changedFilePath
				config.services.fileContextTracker.markFileAsEditedByCline(pathToTrack)
				await config.services.fileContextTracker.trackFileContext(pathToTrack, "cline_edited")

				// Invalidate file read cache for all changed files so re-reads get fresh content
				config.taskState.fileReadCache.delete(resolvePath(config.cwd, pathToTrack).toLowerCase())
				// Also invalidate old path for move operations
				if (change.type === PatchActionType.UPDATE && change.movePath) {
					config.taskState.fileReadCache.delete(resolvePath(config.cwd, changedFilePath).toLowerCase())
				}
			}

			this.config = undefined

			// Extract provider info for human edit telemetry
			const { providerId, modelId } = getModelInfo(config)

			// Build response with file contents and diagnostics
			const responseLines = [getPrompt("toolHandlers", "patchSuccess")]

			responseLines.push(...formatApplyPatchOutcomes(fileOutcomes).map((line) => `\n${line}`))

			for (const [path, result] of Object.entries(applyResults)) {
				if (result.deleted) {
					config.taskState.didEditFile = true
					// Note: cache invalidation for deleted files is already handled in the changedFiles loop above
				} else {
					// Format response similar to WriteToFileToolHandler
					if (result.userEdits) {
						// User made edits during approval
						responseLines.push(`\nThe user made edits to the file:\n${result.userEdits}\n`)
						await config.callbacks.say(
							"user_feedback_diff",
							JSON.stringify({
								tool: "editedExistingFile",
								path,
								diff: result.userEdits,
							}),
						)

						// Capture human edit telemetry: diff between agent's proposed content and user's pre-save edits
						// Use applyPatch to reconstruct pre-save content from userEdits, excluding auto-formatting noise
						const change = commit.changes[path] || Object.values(commit.changes).find((c) => c.movePath === path)
						const preSaveContent = result.userEdits ? applyPatch(change?.newContent || "", result.userEdits) : false
						captureAccepted({
							ulid: config.ulid ?? "",
							tool: this.name,
							source: "human",
							beforeContent: change?.newContent || "",
							afterContent: preSaveContent || result.finalContent || "",
							providerId,
							modelId,
						})
					}
					if (result.autoFormattingEdits) {
						responseLines.push(`\nAuto-formatting was applied to ${path}:\n${result.autoFormattingEdits}\n`)
					}
					if (result.formatterChanged) {
						responseLines.push(
							`\nNote: The file was modified by formatter after saving. Re-read before replace_in_file.`,
						)
					}
					if (result.newProblemsMessage) {
						responseLines.push(`\n\n${result.newProblemsMessage}`)
					}
				}
			}

			if (fuzz > 0) {
				responseLines.push(`\nNote: Patch applied with fuzz factor ${fuzz}`)
			}

			return responseLines.join("\n")
		} catch (error) {
			await provider.revertChanges()
			throw error
		} finally {
			await provider.reset()
		}
	}

	private preprocessLines(text: string): string[] {
		let lines = text.split("\n").map((line) => line.replace(/\r$/, ""))
		lines = this.stripBashWrapper(lines)

		const hasBegin = lines.length > 0 && lines[0].startsWith(PATCH_MARKERS.BEGIN)
		const hasEnd = lines.length > 0 && lines[lines.length - 1] === PATCH_MARKERS.END

		if (!hasBegin && !hasEnd) {
			return [PATCH_MARKERS.BEGIN, ...lines, PATCH_MARKERS.END]
		}
		if (hasBegin && hasEnd) {
			return lines
		}
		// Missing one of the sentinels: BEGIN or END PATCH
		throw new DiffError(getPrompt("toolHandlers", "patchInvalidSentinels"))
	}

	private stripBashWrapper(lines: string[]): string[] {
		const result: string[] = []
		let insidePatch = false
		let foundBegin = false
		let foundContent = false

		for (let i = 0; i < lines.length; i++) {
			const line = lines[i]
			if (!insidePatch && BASH_WRAPPERS.some((wrapper) => line.startsWith(wrapper))) {
				continue
			}

			if (line.startsWith(PATCH_MARKERS.BEGIN)) {
				insidePatch = true
				foundBegin = true
				result.push(line)
				continue
			}

			if (line === PATCH_MARKERS.END) {
				insidePatch = false
				result.push(line)
				continue
			}

			const isPatchContent = this.isPatchLine(line)
			if (isPatchContent && i !== lines.length - 1) {
				foundContent = true
			}

			if (insidePatch || (!foundBegin && isPatchContent) || (line === "" && foundContent)) {
				result.push(line)
			}
		}

		while (result.length > 0 && result[result.length - 1] === "") {
			result.pop()
		}

		return !foundBegin && !foundContent ? lines : result
	}

	private isPatchLine(line: string): boolean {
		return (
			line.startsWith(PATCH_MARKERS.ADD) ||
			line.startsWith(PATCH_MARKERS.UPDATE) ||
			line.startsWith(PATCH_MARKERS.DELETE) ||
			line.startsWith(PATCH_MARKERS.MOVE) ||
			line.startsWith(PATCH_MARKERS.SECTION) ||
			line.startsWith("+") ||
			line.startsWith("-") ||
			line.startsWith(" ") ||
			line === "***"
		)
	}

	private extractFilesForOperations(text: string, markers: readonly string[]): string[] {
		const lines = this.stripBashWrapper(text.split("\n"))
		const files: string[] = []

		for (const line of lines) {
			for (const marker of markers) {
				if (line.startsWith(marker)) {
					const file = line.substring(marker.length).trim()
					if (text.trim().endsWith(file)) {
						// Ignore if the file path is at the very end of the text (likely incomplete)
						continue
					}
					files.push(file)
					break
				}
			}
		}

		return files
	}

	private extractAllFiles(text: string): string[] {
		return this.extractFilesForOperations(text, [PATCH_MARKERS.ADD, PATCH_MARKERS.UPDATE, PATCH_MARKERS.DELETE])
	}

	private async loadFiles(config: TaskConfig, filePaths: string[]): Promise<Record<string, string>> {
		const files: Record<string, string> = {}

		for (const filePath of filePaths) {
			const pathResult = resolveWorkspacePath(config, filePath, "ApplyPatchHandler.loadFiles")
			const absolutePath = typeof pathResult === "string" ? pathResult : pathResult.absolutePath
			const resolvedPath = typeof pathResult === "string" ? filePath : pathResult.resolvedPath

			// A patch reads the original and then rewrites it, so both permissions
			// must hold before any hunk is applied.
			const accessValidation = this.validator.checkClineIgnorePath(resolvedPath)
			const writeValidation = this.validator.checkWritePath(resolvedPath)
			if (!accessValidation.ok || !writeValidation.ok) {
				await config.callbacks.say("clineignore_error", resolvedPath)
				throw new DiffError(`Access denied: ${resolvedPath}`)
			}

			if (!(await fileExistsAtPath(absolutePath))) {
				throw new DiffError(`File not found: ${filePath}`)
			}
			const fileContent = await readFile(absolutePath, "utf8")
			const normalizedContent = fileContent.replace(/\r\n/g, "\n")
			files[filePath] = normalizedContent
		}

		return files
	}

	private async patchToCommit(patch: Patch, originalFiles: Record<string, string>): Promise<Commit> {
		const changes: Record<string, FileChange> = {}

		for (const [path, action] of Object.entries(patch.actions)) {
			const targetResolution = await this.pathResolver?.resolveAndValidate(path, "ApplyPatchHandler.previewPatch")
			if (!targetResolution) {
				continue
			}

			switch (action.type) {
				case PatchActionType.DELETE:
					changes[path] = { type: PatchActionType.DELETE, oldContent: originalFiles[path] }
					break
				case PatchActionType.ADD:
					if (!action.newFile) {
						throw new DiffError("ADD action without file content")
					}
					changes[path] = { type: PatchActionType.ADD, newContent: action.newFile }
					break
				case PatchActionType.UPDATE: {
					const originalContent = originalFiles[path]
					if (originalContent === undefined) throw new DiffError(`UPDATE action has no original content for ${path}`)
					// Extract starting line numbers from chunks (convert from 0-indexed to 1-indexed)
					const startLineNumbers = action.chunks.map((chunk) => chunk.origIndex + 1)
					changes[path] = {
						type: PatchActionType.UPDATE,
						oldContent: originalContent,
						newContent: this.applyChunks(originalContent, action.chunks, path),
						movePath: action.movePath,
						startLineNumbers,
					}
					break
				}
			}
		}

		return { changes }
	}

	/**
	 * Applies patch chunks to the given content.
	 * @param content The original file content.
	 * @param chunks The patch chunks to apply.
	 * @param path The file path (for error messages).
	 * NOTE: Remove tryPreserveEscaping and related logic once we can confirm this is not an issue across providers.
	 * @param tryPreserveEscaping Whether to attempt preserving escaping style in cases where the provider has escaped the shared content during the API call.
	 * @returns The modified content after applying the chunks.
	 */
	private applyChunks(content: string, chunks: PatchChunk[], path: string, tryPreserveEscaping = false): string {
		if (chunks.length === 0) {
			return content
		}

		const lines = content.split("\n")
		const result: string[] = []
		let currentIndex = 0

		for (const chunk of chunks) {
			if (chunk.origIndex > lines.length) {
				throw new DiffError(`${path}: chunk.origIndex ${chunk.origIndex} > lines.length ${lines.length}`)
			}
			if (currentIndex > chunk.origIndex) {
				throw new DiffError(`${path}: currentIndex ${currentIndex} > chunk.origIndex ${chunk.origIndex}`)
			}

			// Copy lines before the chunk
			result.push(...lines.slice(currentIndex, chunk.origIndex))

			// Get the original lines being replaced to detect escaping style
			const originalLines = lines.slice(chunk.origIndex, chunk.origIndex + chunk.delLines.length)
			const originalText = originalLines.join("\n")

			// Add inserted lines, preserving escaping style from original
			const insertedLines = chunk.insLines.map((line) => {
				// Only preserve escaping if we have original text to compare against
				if (tryPreserveEscaping && originalText) {
					return preserveEscaping(originalText, line)
				}
				return line
			})
			result.push(...insertedLines)

			// Skip deleted lines
			currentIndex = chunk.origIndex + chunk.delLines.length
		}

		// Copy remaining lines
		result.push(...lines.slice(currentIndex))

		return result.join("\n")
	}

	/**
	 * Prepares a single file change (opens file and updates content) without saving.
	 * Call saveFileChange() after approval.
	 */
	private async prepareFileChange(change: FileChange, path: string): Promise<void> {
		const ops = this.providerOps
		if (!ops) throw new Error("ApplyPatch provider operations are not initialized")

		switch (change.type) {
			case PatchActionType.DELETE:
				await ops.deleteFile(path, false)
				break
			case PatchActionType.ADD:
				if (!change.newContent) {
					throw new DiffError(`Cannot create ${path} with no content`)
				}
				await ops.createFile(path, change.newContent, false)
				break
			case PatchActionType.UPDATE:
				if (!change.newContent) {
					throw new DiffError(`UPDATE change for ${path} has no new content`)
				}
				if (change.movePath) {
					// For move operations, prepare the new file (the old file will be handled separately)
					await ops.createFile(change.movePath, change.newContent, false)
				} else {
					await ops.modifyFile(path, change.newContent, false)
				}
				break
		}
	}

	/**
	 * Saves the changes for a single file after approval.
	 */
	private async saveFileChange(change: FileChange, path: string): Promise<FileOpsResult | undefined> {
		const ops = this.providerOps
		if (!ops) throw new Error("ApplyPatch provider operations are not initialized")

		switch (change.type) {
			case PatchActionType.DELETE:
				// For delete operations, actually delete the file now (after approval)
				await ops.deleteFile(path)
				return { deleted: true }
			case PatchActionType.ADD:
				if (!change.newContent) {
					throw new DiffError(`Cannot create ${path} with no content`)
				}
				return await ops.saveChanges()
			case PatchActionType.UPDATE:
				if (!change.newContent) {
					throw new DiffError(`UPDATE change for ${path} has no new content`)
				}
				// For move operations, we're saving the new file (the old file deletion is handled in the calling code)
				return await ops.saveChanges()
		}
	}

	private async generateChangeSummary(changes: Record<string, FileChange>): Promise<ClineSayTool[]> {
		const summaries = await Promise.all(
			Object.entries(changes).map(async ([file, change]) => {
				const operationIsLocatedInWorkspace = await isLocatedInWorkspace(file)
				switch (change.type) {
					case PatchActionType.ADD:
						return {
							tool: "newFileCreated",
							path: file,
							content: change.newContent,
							operationIsLocatedInWorkspace,
						} as ClineSayTool
					case PatchActionType.UPDATE:
						return {
							tool: change.movePath ? "newFileCreated" : "editedExistingFile",
							path: change.movePath || file,
							content: change.movePath ? change.oldContent : change.newContent,
							operationIsLocatedInWorkspace,
							startLineNumbers: change.startLineNumbers,
						} as ClineSayTool
					case PatchActionType.DELETE:
						return {
							tool: "fileDeleted",
							path: file,
							content: change.newContent,
							operationIsLocatedInWorkspace,
						} as ClineSayTool
				}
			}),
		)

		return summaries
	}

	private async presentAcceptedChange(
		config: TaskConfig,
		block: ToolUse,
		message: ClineSayTool,
		rawInput: string,
		change: FileChange | undefined,
		wasAutoApproved: boolean,
	): Promise<void> {
		const completeMessage = JSON.stringify({ ...message, content: rawInput })
		const { providerId, modelId } = getModelInfo(config)
		const fileOps = change
			? {
					filesCreated: change.type === PatchActionType.ADD ? 1 : 0,
					filesDeleted: change.type === PatchActionType.DELETE ? 1 : 0,
					filesMoved: change.type === PatchActionType.UPDATE && change.movePath ? 1 : 0,
				}
			: { filesCreated: 0, filesDeleted: 0, filesMoved: 0 }

		await config.callbacks.say("tool", completeMessage, undefined, undefined, false, block.ts)
		telemetryService.captureToolUsage(
			config.ulid ?? "",
			this.name,
			modelId,
			providerId,
			wasAutoApproved,
			true,
			undefined,
			block.isNativeToolCall,
		)
		captureAccepted({
			ulid: config.ulid ?? "",
			tool: this.name,
			source: "agent",
			beforeContent: change?.oldContent || "",
			afterContent: change?.newContent || "",
			providerId,
			modelId,
			...fileOps,
		})
	}
}
