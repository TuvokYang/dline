import { createRuntimeContract } from "../../helpers/create-contract"
import { defineLegacyModule } from "../../helpers/define-legacy-module"

import accessMcpResource from "./accessMcpResource"
import actModeRespond from "./actModeRespond"
import applyPatch from "./applyPatch"
import askFollowupQuestion from "./askFollowupQuestion"
import attemptCompletion from "./attemptCompletion"
import browserAction from "./browserAction"
import executeCommand from "./executeCommand"
import findReferences from "./findReferences"
import generateExplanation from "./generateExplanation"
import generateImage from "./generateImage"
import generateReport from "./generateReport"
import killCommand from "./killCommand"
import listCodeDefinitionNames from "./listCodeDefinitionNames"
import listFiles from "./listFiles"
import loadCapability from "./loadCapability"
import loadMcpDocumentation from "./loadMcpDocumentation"
import loadMcpDocumentationTool from "./loadMcpDocumentationTool"
import makePlan from "./makePlan"
import newTask from "./newTask"
import qnaRespond from "./qnaRespond"
import readFile from "./readFile"
import rename from "./rename"
import replaceInFile from "./replaceInFile"
import replaceText from "./replaceText"
import searchFiles from "./searchFiles"
import spawnTask from "./spawnTask"
import statusUpdate from "./statusUpdate"
import subagent from "./subagent"
import toolHandlers from "./toolHandlers"
import useMcpTool from "./useMcpTool"
import webFetch from "./webFetch"
import webSearch from "./webSearch"
import writeToFile from "./writeToFile"
import xmlProjection from "./xmlProjection"

export const toolPromptModules = [
	defineLegacyModule("accessMcpResource", "tools", accessMcpResource),
	defineLegacyModule("actModeRespond", "tools", actModeRespond),
	defineLegacyModule("applyPatch", "tools", applyPatch),
	defineLegacyModule("askFollowupQuestion", "tools", askFollowupQuestion),
	defineLegacyModule("attemptCompletion", "tools", attemptCompletion),
	defineLegacyModule("browserAction", "tools", browserAction, {
		description: createRuntimeContract("BROWSER_VIEWPORT_WIDTH", "BROWSER_VIEWPORT_HEIGHT"),
		coordinateInstruction: createRuntimeContract("BROWSER_VIEWPORT_WIDTH", "BROWSER_VIEWPORT_HEIGHT"),
		standardCoordinateInstruction: createRuntimeContract("BROWSER_VIEWPORT_WIDTH", "BROWSER_VIEWPORT_HEIGHT"),
	}),
	defineLegacyModule("executeCommand", "tools", executeCommand, {
		standardWorkdirectoryInstruction: createRuntimeContract("CWD"),
		standardTimeoutInstruction: createRuntimeContract("TERMINAL_COMMAND_TIMEOUT_SECONDS"),
		clineIgnoreError: createRuntimeContract("PATH"),
		permissionDeniedError: createRuntimeContract("REASON"),
	}),
	defineLegacyModule("killCommand", "tools", killCommand),
	defineLegacyModule("findReferences", "tools", findReferences, {
		errorPrefix: createRuntimeContract("ERROR"),
		invalidPath: createRuntimeContract("PATH"),
		outsideWorkspace: createRuntimeContract("PATH"),
	}),
	defineLegacyModule("generateExplanation", "tools", generateExplanation),
	defineLegacyModule("generateImage", "tools", generateImage),
	defineLegacyModule("generateReport", "tools", generateReport),
	defineLegacyModule("listCodeDefinitionNames", "tools", listCodeDefinitionNames, {
		pathInstruction: createRuntimeContract("CWD", "MULTI_ROOT_HINT"),
	}),
	defineLegacyModule("listFiles", "tools", listFiles),
	defineLegacyModule("loadCapability", "tools", loadCapability),
	defineLegacyModule("loadMcpDocumentation", "tools", loadMcpDocumentation, {
		main: createRuntimeContract("MCP_SERVERS_PATH", "MCP_SETTINGS_FILE_PATH", "CONNECTED_SERVERS"),
	}),
	defineLegacyModule("loadMcpDocumentationTool", "tools", loadMcpDocumentationTool),
	defineLegacyModule("makePlan", "tools", makePlan),
	defineLegacyModule("newTask", "tools", newTask),
	defineLegacyModule("qnaRespond", "tools", qnaRespond),
	defineLegacyModule("readFile", "tools", readFile, {
		pathInstruction: createRuntimeContract("CWD", "MULTI_ROOT_HINT"),
	}),
	defineLegacyModule("rename", "tools", rename, {
		errorPrefix: createRuntimeContract("ERROR"),
		invalidPath: createRuntimeContract("PATH"),
		outsideWorkspace: createRuntimeContract("PATH"),
		dryRunHeader: createRuntimeContract("OLD_NAME", "NEW_NAME", "FILES", "CHANGES"),
		successOutput: createRuntimeContract("OLD_NAME", "NEW_NAME", "FILES", "CHANGES"),
		fileEditLine: createRuntimeContract("FILE", "LINE", "CHARACTER", "ORIGINAL", "NEW"),
	}),
	defineLegacyModule("replaceInFile", "tools", replaceInFile, {
		replaceInFileMissingDiffError: createRuntimeContract("REL_PATH"),
		diffSearchNotFound: createRuntimeContract("LINE_COUNT"),
		diffDelimiterTooShort: createRuntimeContract("COUNT"),
		diffDelimiterConflict: createRuntimeContract("BLOCK_TYPE", "COUNT", "CHAR"),
		diffDelimiterMismatch: createRuntimeContract("SEARCH_N", "CLOSE_N"),
		diffBlockOverlap: createRuntimeContract("BLOCK_INDEX", "PREV_INDEX"),
		diffBlockOutOfOrder: createRuntimeContract("BLOCK_INDEX"),
	}),
	defineLegacyModule("replaceText", "tools", replaceText, {
		noFilesMatched: createRuntimeContract("PATTERN"),
		noOccurrences: createRuntimeContract("FIND", "COUNT", "PATTERN"),
		dryRunHeader: createRuntimeContract("FIND", "REPLACE", "FILES", "MATCHES", "PREVIEW"),
		successOutput: createRuntimeContract("FIND", "REPLACE", "FILES", "MATCHES"),
		writeErrors: createRuntimeContract("COUNT"),
		errorPrefix: createRuntimeContract("ERROR"),
	}),
	defineLegacyModule("searchFiles", "tools", searchFiles, {
		pathInstruction: createRuntimeContract("CWD", "MULTI_ROOT_HINT"),
	}),
	defineLegacyModule("spawnTask", "tools", spawnTask),
	defineLegacyModule("statusUpdate", "tools", statusUpdate),
	defineLegacyModule("subagent", "tools", subagent, {
		timeoutInstruction: createRuntimeContract("SUBAGENT_TIMEOUT_SECONDS"),
	}),
	defineLegacyModule("toolHandlers", "tools", toolHandlers, {
		toolError: createRuntimeContract("ERROR"),
		noToolsUsed: createRuntimeContract("TOOL_REMINDER"),
		tooManyMistakes: createRuntimeContract("FEEDBACK"),
		missingToolParameterError: createRuntimeContract("PARAM_NAME", "TOOL_REMINDER"),
		toolAlreadyUsed: createRuntimeContract("TOOL_NAME"),
		repeatedToolCall: createRuntimeContract("TOOL_NAME", "COUNT"),
		doubleCheckVerification: createRuntimeContract("TASK_SECTION"),
		yoloAutoRespond: createRuntimeContract("QUESTION"),
		yoloToolResult: createRuntimeContract("QUESTION"),
		generateExplanationNoChanges: createRuntimeContract("FROM_REF", "TO_REF"),
		planSwitchToActWithMessage: createRuntimeContract("TEXT"),
		subagentRetryablePaused: createRuntimeContract("SUBAGENT", "REASON", "JOB_ID"),
		subagentBatchRetryablePaused: createRuntimeContract("COUNT", "TOTAL"),
		searchAgentRestricted: createRuntimeContract("PATH"),
	}),
	defineLegacyModule("useMcpTool", "tools", useMcpTool, {
		invalidMcpToolArgumentError: createRuntimeContract("SERVER_NAME", "TOOL_NAME"),
	}),
	defineLegacyModule("webFetch", "tools", webFetch),
	defineLegacyModule("webSearch", "tools", webSearch),
	defineLegacyModule("xmlProjection", "tools", xmlProjection, {
		parameterLine: createRuntimeContract("NAME", "REQUIREMENT", "INSTRUCTION"),
		toolHeading: createRuntimeContract("NAME"),
		descriptionLine: createRuntimeContract("DESCRIPTION"),
	}),
	defineLegacyModule("writeToFile", "tools", writeToFile, {
		writeToFileBaseError: createRuntimeContract("REL_PATH"),
		writeToFileContextWarning: createRuntimeContract("CONTEXT_USAGE_PERCENT"),
		writeToFileCriticalFail: createRuntimeContract("CONSECUTIVE_FAILURES"),
		writeToFileSecondFail: createRuntimeContract("ATTEMPT_ORDINAL"),
		writeToFileFirstFail: createRuntimeContract("TOOL_REMINDER"),
		fileEditUserChangesHead: createRuntimeContract("USER_EDITS"),
		fileEditAutoFormattingWithChanges: createRuntimeContract("AUTO_FORMATTING_EDITS"),
		fileEditAutoFormattingWithoutChanges: createRuntimeContract("AUTO_FORMATTING_EDITS"),
		fileEditUpdatedContent: createRuntimeContract("REL_PATH", "WROTE_LINES", "SAVED_LINES"),
		fileEditSuccessContent: createRuntimeContract("REL_PATH", "WROTE_LINES", "SAVED_LINES"),
		replaceEditSuccessContent: createRuntimeContract("REL_PATH", "DELETED_LINES", "ADDED_LINES", "SAVED_LINES"),
		fileEditNotesWithChanges: createRuntimeContract("NEW_PROBLEMS_MESSAGE"),
		fileEditNotesWithoutChanges: createRuntimeContract("NEW_PROBLEMS_MESSAGE"),
		fileContextWarning: createRuntimeContract(
			"FILE_COUNT",
			"FILE_VERB",
			"FILE_DEMONSTRATIVE_PRONOUN",
			"FILE_PERSONAL_PRONOUN",
			"FILES_LIST",
		),
	}),
] as const
