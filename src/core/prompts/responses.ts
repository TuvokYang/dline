import { Anthropic } from "@anthropic-ai/sdk"
import type { FileInfo } from "@services/glob/list-files"
import * as diff from "diff"
import * as path from "path"
import { type IgnoreController, LOCK_TEXT_SYMBOL } from "../ignore/IgnoreController"
import { RuntimePromptGenerator } from "./generators/RuntimePromptGenerator"
import { englishTemplateStore } from "./i18n/en"
import type { PromptEnv } from "./template/types"

const CONTEXT_WINDOW_WARNING_THRESHOLD_PERCENT = 50
const runtimeGenerator = new RuntimePromptGenerator(englishTemplateStore)

/**
 * Generates one exact response prompt and returns its text.
 *
 * @param key Stable key in the responses namespace.
 * @param env Declared runtime prompt values.
 * @returns Rendered response prompt text.
 */
function generateResponse(key: string, env: PromptEnv = {}): string {
	return runtimeGenerator.generate(`responses.${key}`, env).text
}

/**
 * Generates one exact tool prompt and returns its text.
 *
 * @param module Stable tool prompt module name.
 * @param key Stable key in the tool prompt module.
 * @param env Declared runtime prompt values.
 * @returns Rendered tool prompt text.
 */
function generateToolResponse(module: string, key: string, env: PromptEnv = {}): string {
	return runtimeGenerator.generate(`${module}.${key}`, env).text
}

export const formatResponse = {
	duplicateFileReadNotice: () => generateResponse("duplicateFileReadNotice"),

	contextTruncationNotice: () => generateResponse("contextTruncationNotice"),

	processFirstUserMessageForTruncation: () => generateResponse("continueAssisting"),

	condense: () => generateResponse("condense"),

	toolDenied: () => generateToolResponse("toolHandlers", "toolDenied"),

	toolError: (error?: string) => generateToolResponse("toolHandlers", "toolError", { ERROR: error ?? "" }),

	clineIgnoreError: (pathStr: string) => generateToolResponse("executeCommand", "clineIgnoreError", { PATH: pathStr }),

	searchAgentRestricted: (pathStr: string) => generateToolResponse("toolHandlers", "searchAgentRestricted", { PATH: pathStr }),

	permissionDeniedError: (reason: string) =>
		generateToolResponse("executeCommand", "permissionDeniedError", { REASON: reason }),

	noToolsUsed: (usingNativeToolCalls: boolean) =>
		generateToolResponse("toolHandlers", "noToolsUsed", {
			TOOL_REMINDER: usingNativeToolCalls ? "" : generateToolResponse("toolHandlers", "toolUseInstructionsReminder"),
		}),

	tooManyMistakes: (feedback?: string) => generateToolResponse("toolHandlers", "tooManyMistakes", { FEEDBACK: feedback ?? "" }),

	missingToolParameterError: (paramName: string) =>
		generateToolResponse("toolHandlers", "missingToolParameterError", {
			PARAM_NAME: paramName,
			TOOL_REMINDER: generateToolResponse("toolHandlers", "toolUseInstructionsReminder"),
		}),

	/**
	 * Specialized error for write_to_file when the 'content' parameter is missing.
	 * Provides progressive guidance based on how many times this has happened consecutively,
	 * and includes token budget awareness to help the model understand output constraints.
	 */
	writeToFileMissingContentError: (relPath: string, consecutiveFailures: number, contextUsagePercent?: number): string => {
		const baseError = generateToolResponse("writeToFile", "writeToFileBaseError", { REL_PATH: relPath })

		const contextWarning =
			contextUsagePercent !== undefined && contextUsagePercent > CONTEXT_WINDOW_WARNING_THRESHOLD_PERCENT
				? `\n\n${generateToolResponse("writeToFile", "writeToFileContextWarning", { CONTEXT_USAGE_PERCENT: contextUsagePercent })}`
				: ""

		if (consecutiveFailures >= 3) {
			// After 3+ failures, be very directive — stop trying write_to_file entirely
			return `${baseError}${contextWarning}\n\n${generateToolResponse("writeToFile", "writeToFileCriticalFail", { CONSECUTIVE_FAILURES: consecutiveFailures })}`
		}
		if (consecutiveFailures >= 2) {
			// After 2 failures, strongly suggest alternative approaches
			const ordinalSuffix = generateResponse(consecutiveFailures === 2 ? "ordinalSecond" : "ordinalThird")
			return `${baseError}${contextWarning}\n\n${generateToolResponse("writeToFile", "writeToFileSecondFail", {
				ATTEMPT_ORDINAL: `${consecutiveFailures}${ordinalSuffix}`,
			})}`
		}
		// First failure — provide helpful guidance
		return `${baseError}${contextWarning}\n\n${generateToolResponse("writeToFile", "writeToFileFirstFail", {
			TOOL_REMINDER: generateToolResponse("toolHandlers", "toolUseInstructionsReminder"),
		})}`
	},

	replaceInFileMissingDiffError: (relPath: string): string =>
		generateToolResponse("replaceInFile", "replaceInFileMissingDiffError", { REL_PATH: relPath }),

	executeCommandMissingCommandError: (): string => generateToolResponse("executeCommand", "executeCommandMissingCommandError"),

	invalidMcpToolArgumentError: (serverName: string, toolName: string) =>
		generateToolResponse("useMcpTool", "invalidMcpToolArgumentError", { SERVER_NAME: serverName, TOOL_NAME: toolName }),

	toolResult: (
		text: string,
		images?: string[],
		fileString?: string,
	): string | Array<Anthropic.TextBlockParam | Anthropic.ImageBlockParam> => {
		const toolResultOutput = []

		if (!(images && images.length > 0) && !fileString) {
			return text
		}

		const textBlock: Anthropic.TextBlockParam = { type: "text", text }
		toolResultOutput.push(textBlock)

		if (images && images.length > 0) {
			const imageBlocks: Anthropic.ImageBlockParam[] = formatImagesIntoBlocks(images)
			toolResultOutput.push(...imageBlocks)
		}

		if (fileString) {
			const fileBlock: Anthropic.TextBlockParam = { type: "text", text: fileString }
			toolResultOutput.push(fileBlock)
		}

		return toolResultOutput
	},

	imageBlocks: (images?: string[]): Anthropic.ImageBlockParam[] => {
		return formatImagesIntoBlocks(images)
	},

	formatFilesList: (
		absolutePath: string,
		fileInfos: FileInfo[],
		didHitLimit: boolean,
		ignoreController?: IgnoreController,
	): string => {
		// Convert FileInfo to formatted strings with metadata
		const formatted = fileInfos
			.map((info) => {
				const relativePath = path.relative(absolutePath, info.path).toPosix()
				const displayPath = info.isDirectory ? `${relativePath}/` : relativePath

				// Format size: KB for files, empty for directories
				const sizeKB = info.isDirectory ? "" : generateResponse("fileSizeKb", { SIZE: (info.size / 1000).toFixed(1) })

				// Format modification time: YYYY-MM-DD HH:MM
				const mtimeStr =
					info.mtime.getTime() > 0
						? `${info.mtime.getFullYear()}-${String(info.mtime.getMonth() + 1).padStart(2, "0")}-${String(info.mtime.getDate()).padStart(2, "0")} ${String(info.mtime.getHours()).padStart(2, "0")}:${String(info.mtime.getMinutes()).padStart(2, "0")}`
						: ""

				// Format line count
				const lineInfo =
					info.isDirectory || info.lineCount === undefined
						? ""
						: generateResponse("fileLineCount", { COUNT: info.lineCount })

				// Build metadata suffix
				const metadataParts = [sizeKB, mtimeStr, lineInfo].filter((p) => p.length > 0)
				const metadata = metadataParts.length > 0 ? `  (${metadataParts.join(", ")})` : ""

				return { displayPath, metadata, relativePath }
			})
			// Sort so files are listed under their respective directories
			.sort((a, b) => {
				const aParts = a.relativePath.split("/")
				const bParts = b.relativePath.split("/")
				for (let i = 0; i < Math.min(aParts.length, bParts.length); i++) {
					if (aParts[i] !== bParts[i]) {
						if (i + 1 === aParts.length && i + 1 < bParts.length) {
							return -1
						}
						if (i + 1 === bParts.length && i + 1 < aParts.length) {
							return 1
						}
						return aParts[i].localeCompare(bParts[i], undefined, {
							numeric: true,
							sensitivity: "base",
						})
					}
				}
				return aParts.length - bParts.length
			})

		const clineIgnoreParsed = ignoreController
			? formatted.map(({ displayPath, metadata }) => {
					const absoluteFilePath = path.resolve(absolutePath, displayPath)
					// The lock marks what the agent may not open, so it follows the
					// read scope: a listed path excluded only by `.gitignore` is
					// still readable and must not appear locked.
					const isIgnored = !ignoreController.validateAccess(absoluteFilePath, "read")
					if (isIgnored) {
						return `${LOCK_TEXT_SYMBOL} ${displayPath}${metadata}`
					}
					return `${displayPath}${metadata}`
				})
			: formatted.map(({ displayPath, metadata }) => `${displayPath}${metadata}`)

		if (didHitLimit) {
			return `${clineIgnoreParsed.join("\n")}\n\n${generateResponse("fileListTruncated")}`
		}
		if (clineIgnoreParsed.length === 0 || (clineIgnoreParsed.length === 1 && clineIgnoreParsed[0] === "")) {
			return generateResponse("noFilesFound")
		}
		return clineIgnoreParsed.join("\n")
	},

	createPrettyPatch: (filename = "file", oldStr?: string, newStr?: string) => {
		// strings cannot be undefined or diff throws exception
		const patch = diff.createPatch(filename.toPosix(), oldStr || "", newStr || "")
		const lines = patch.split("\n")
		const prettyPatchLines = lines.slice(4)
		return prettyPatchLines.join("\n")
	},

	planModeInstructions: () => generateResponse("planModeInstructions"),

	/**
	 * Build a checkpoint-restore message for resuming after edited-input restore.
	 * Injects the edited text as a <user_message> block with a short explainer
	 * so the model knows the conversation was rewound and project files may differ.
	 */
	checkpointRestore: (editedText: string): string => {
		return generateResponse("checkpointRestoreAct", { EDITED_TEXT: editedText })
	},

	fileEditWithUserChanges: (
		relPath: string,
		userEdits: string,
		autoFormattingEdits: string | undefined,
		wroteLines: number,
		savedLines: number,
		formatterChanged: boolean,
		newProblemsMessage: string | undefined,
	) => {
		const rel = relPath.toPosix()
		const formatterNotice = formatterChanged ? generateToolResponse("writeToFile", "formatterChangedNotice") : ""
		return `${generateToolResponse("writeToFile", "fileEditUserChangesHead", { USER_EDITS: userEdits })}${autoFormattingEdits ? generateToolResponse("writeToFile", "fileEditAutoFormattingWithChanges", { AUTO_FORMATTING_EDITS: autoFormattingEdits }) : ""}${generateToolResponse("writeToFile", "fileEditUpdatedContent", { REL_PATH: rel, WROTE_LINES: wroteLines, SAVED_LINES: savedLines })}${formatterNotice}${generateToolResponse("writeToFile", "fileEditNotesWithChanges", { NEW_PROBLEMS_MESSAGE: newProblemsMessage ?? "" })}`
	},

	fileEditWithoutUserChanges: (
		relPath: string,
		autoFormattingEdits: string | undefined,
		wroteLines: number,
		savedLines: number,
		formatterChanged: boolean,
		newProblemsMessage: string | undefined,
		deletedLines?: number,
		addedLines?: number,
	) => {
		const rel = relPath.toPosix()
		const formatterNotice = formatterChanged ? generateToolResponse("writeToFile", "formatterChangedNotice") : ""
		const isReplace = deletedLines !== undefined && addedLines !== undefined
		const successTemplate = isReplace
			? generateToolResponse("writeToFile", "replaceEditSuccessContent", {
					REL_PATH: rel,
					DELETED_LINES: deletedLines,
					ADDED_LINES: addedLines,
					SAVED_LINES: savedLines,
				})
			: generateToolResponse("writeToFile", "fileEditSuccessContent", {
					REL_PATH: rel,
					WROTE_LINES: wroteLines,
					SAVED_LINES: savedLines,
				})
		return `${successTemplate}${autoFormattingEdits ? generateToolResponse("writeToFile", "fileEditAutoFormattingWithoutChanges", { AUTO_FORMATTING_EDITS: autoFormattingEdits }) : ""}${formatterNotice}${generateToolResponse("writeToFile", "fileEditNotesWithoutChanges", { NEW_PROBLEMS_MESSAGE: newProblemsMessage ?? "" })}`
	},

	diffErrorReminder: () => generateToolResponse("replaceInFile", "diffErrorReminder"),

	toolAlreadyUsed: (toolName: string) => generateToolResponse("toolHandlers", "toolAlreadyUsed", { TOOL_NAME: toolName }),

	repeatedToolCall: (toolName: string, count: number) =>
		generateToolResponse("toolHandlers", "repeatedToolCall", { TOOL_NAME: toolName, COUNT: count }),

	clineIgnoreInstructions: (content: string) =>
		generateResponse("clineIgnoreInstructions", { LOCK_SYMBOL: LOCK_TEXT_SYMBOL, CONTENT: content }),

	clineRulesGlobalDirectoryInstructions: (_globalClineRulesFilePath: string, content: string) =>
		generateResponse("clineRulesGlobalDirInstructions", { CONTENT: content }),

	clineRulesLocalDirectoryInstructions: (workspaceName: string, content: string) =>
		generateResponse("clineRulesLocalDirInstructions", { WORKSPACE_NAME: workspaceName, CONTENT: content }),

	clineRulesLocalFileInstructions: (workspaceName: string, content: string) =>
		generateResponse("clineRulesLocalFileInstructions", { WORKSPACE_NAME: workspaceName, CONTENT: content }),

	windsurfRulesLocalFileInstructions: (workspaceName: string, content: string) =>
		generateResponse("windsurfRulesWorkspaceInstructions", { WORKSPACE_NAME: workspaceName, CONTENT: content }),

	cursorRulesLocalFileInstructions: (workspaceName: string, content: string) =>
		generateResponse("cursorRulesWorkspaceFileInstructions", { WORKSPACE_NAME: workspaceName, CONTENT: content }),

	cursorRulesLocalDirectoryInstructions: (workspaceName: string, content: string) =>
		generateResponse("cursorRulesWorkspaceDirInstructions", { WORKSPACE_NAME: workspaceName, CONTENT: content }),

	agentsRulesLocalFileInstructions: (workspaceName: string, content: string) =>
		generateResponse("agentsRulesWorkspaceInstructions", { WORKSPACE_NAME: workspaceName, CONTENT: content }),

	fileContextWarning: (editedFiles: string[]): string => {
		const fileCount = editedFiles.length
		const singular = fileCount === 1
		const fileVerb = generateToolResponse("writeToFile", singular ? "fileVerbSingular" : "fileVerbPlural")
		const fileDemonstrativePronoun = generateToolResponse(
			"writeToFile",
			singular ? "fileDemonstrativeSingular" : "fileDemonstrativePlural",
		)
		const filePersonalPronoun = generateToolResponse("writeToFile", singular ? "filePronounSingular" : "filePronounPlural")
		const filesList = editedFiles.map((file) => ` ${path.resolve(file).toPosix()}`).join("\n")

		return generateToolResponse("writeToFile", "fileContextWarning", {
			FILE_COUNT: fileCount,
			FILE_VERB: fileVerb,
			FILE_DEMONSTRATIVE_PRONOUN: fileDemonstrativePronoun,
			FILE_PERSONAL_PRONOUN: filePersonalPronoun,
			FILES_LIST: filesList,
		})
	},
}

// to avoid circular dependency
const formatImagesIntoBlocks = (images?: string[]): Anthropic.ImageBlockParam[] => {
	return images
		? images.map((dataUrl) => {
				// data:image/png;base64,base64string
				const [rest, base64] = dataUrl.split(",")
				const mimeType = rest.split(":")[1].split(";")[0]
				return {
					type: "image",
					source: {
						type: "base64",
						media_type: mimeType,
						data: base64,
					},
				} as Anthropic.ImageBlockParam
			})
		: []
}
