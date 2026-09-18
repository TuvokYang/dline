import { MAX_SUBAGENTS_PER_BATCH } from "../../../shared/concurrency-limits"
import { GPT_IMAGE_1_MODEL_ID, GPT_IMAGE_2_MODEL_ID, GPT_IMAGE_2_SUBSCRIPTION_MODEL_ID } from "../../../shared/image-generation"
import { ClineDefaultTool } from "../../../shared/tools"
import { getPrompt } from "../i18n"
import { PromptProfile } from "../profiles/types"
import type { SystemPromptContext } from "../system-prompt/context"
import type { ProfilePromptFragment, ProfileToolParam, ProfileToolSpec } from "./profile-tool-set"

const whenFocusTracking = (context: SystemPromptContext): boolean =>
	context.promptProfile !== PromptProfile.Lite && context.focusChainSettings?.enabled === true
const whenFocusTrackingDisabled = (context: SystemPromptContext): boolean => !whenFocusTracking(context)
const whenImageSupportDisabled = (context: SystemPromptContext): boolean =>
	context.providerInfo.model.info.capabilities?.supportsImages !== true
const readFileImageSupportDescription = ` ${getPrompt("readFile", "imageSupportDescription")}`

/** Creates one conditional canonical prompt fragment. */
function fragment(text: string, contextRequirements: (context: SystemPromptContext) => boolean): ProfilePromptFragment {
	return { text, contextRequirements }
}

const taskProgress: ProfileToolParam = {
	name: "task_progress",
	required: false,
	instruction: getPrompt("taskProgress", "paramInstruction"),
	contextRequirements: whenFocusTracking,
}

/** Creates one immutable tool parameter descriptor. */
function param(
	name: string,
	required: boolean,
	instruction: string,
	type: ProfileToolParam["type"] = "string",
	enumValues?: readonly string[],
): ProfileToolParam {
	return { name, required, instruction, type, ...(enumValues ? { enumValues } : {}) }
}

/** Reports whether at least one connected enabled MCP server is available. */
function hasMcp(context: SystemPromptContext): boolean {
	return context.mcpHub?.getServers()?.some((server) => server.status === "connected" && server.disabled !== true) ?? false
}

/** Reports whether browser tools are enabled for this runtime. */
function hasBrowser(context: SystemPromptContext): boolean {
	return context.supportsBrowserUse === true && context.browserSettings?.disableToolUse !== true
}

/** Reports whether a tool may be exposed in an interactive environment. */
function isInteractive(context: SystemPromptContext): boolean {
	return context.yoloModeToggled !== true
}

/**
 * Reports whether the local Dline Web Fetch tool is exposed.
 *
 * Web Fetch has no hosted counterpart today, so every route other than an
 * explicit "off" resolves to the local executor. Reading the same routing plan as
 * Web Search keeps one Web Tools switch governing both tools.
 */
function hasWebFetch(context: SystemPromptContext): boolean {
	if (context.clineWebToolsEnabled !== true) return false
	const route = context.webSearchRoutingPlan?.route
	return route !== "disabled"
}

/** Reports whether this request selected the local Web Search executor. */
function hasLocalWebSearch(context: SystemPromptContext): boolean {
	if (context.clineWebToolsEnabled !== true) return false
	return context.webSearchRoutingPlan?.route === "local"
}

/** Reports whether configured skills are available. */
function hasSkills(context: SystemPromptContext): boolean {
	return (context.skills?.length ?? 0) > 0
}

/** Reports whether an independent task may be spawned from the current task. */
function canSpawnTask(context: SystemPromptContext): boolean {
	return context.isSubagentRun !== true
}

/** Reports whether subagents may be invoked from the current task. */
function hasSubagents(context: SystemPromptContext): boolean {
	return context.subagentsEnabled === true && context.isSubagentRun !== true
}

/** Reports whether at least one valid image generation profile is available. */
function hasImageGeneration(context: SystemPromptContext): boolean {
	return context.imageGenerationAvailable === true
}

/** Creates a predicate that keeps one model-specific sizing fragment only for its bound image model. */
function whenImageModelIsNot(modelId: string): (context: SystemPromptContext) => boolean {
	return (context) => context.imageModelId !== modelId
}

const gptImage2Sizing = ` ${getPrompt("generateImage", "gptImage2SizingDescription")}`
const gptImage2SubscriptionSizing = ` ${getPrompt("generateImage", "gptImage2SubscriptionSizingDescription")}`
const gptImage1Sizing = ` ${getPrompt("generateImage", "gptImage1SizingDescription")}`

/** Complete generate_image description carrying every model-specific sizing fragment. */
const generateImageDescription = `${getPrompt("generateImage", "standardDescription")}${gptImage2Sizing}${gptImage2SubscriptionSizing}${gptImage1Sizing}`

const imageSizingFragments: readonly ProfilePromptFragment[] = [
	fragment(gptImage2Sizing, whenImageModelIsNot(GPT_IMAGE_2_MODEL_ID)),
	fragment(gptImage2SubscriptionSizing, whenImageModelIsNot(GPT_IMAGE_2_SUBSCRIPTION_MODEL_ID)),
	fragment(gptImage1Sizing, whenImageModelIsNot(GPT_IMAGE_1_MODEL_ID)),
]

/** Creates the canonical Standard descriptor for one built-in tool. */
function spec(
	id: ClineDefaultTool,
	description: string,
	parameters: readonly ProfileToolParam[] = [],
	contextRequirements?: (context: SystemPromptContext) => boolean,
	descriptionFragments?: readonly ProfilePromptFragment[],
): Omit<ProfileToolSpec, "profile"> {
	return { transport: "both", id, name: id, description, descriptionFragments, parameters, contextRequirements }
}

/** Creates a provider-native-only canonical tool descriptor. */
function nativeSpec(
	id: ClineDefaultTool,
	description: string,
	parameters: readonly ProfileToolParam[] = [],
	contextRequirements?: (context: SystemPromptContext) => boolean,
): Omit<ProfileToolSpec, "profile"> {
	return { ...spec(id, description, parameters, contextRequirements), transport: "native" }
}

const LOAD_MCP_PARAMS = [param("name", true, getPrompt("loadCapability", "mcpNameInstruction"))]
const LOAD_SKILL_PARAMS = [param("name", true, getPrompt("loadCapability", "skillNameInstruction"))]
const LOAD_WORKFLOW_PARAMS = [param("name", true, getPrompt("loadCapability", "workflowNameInstruction"))]
const SINGLE_SUBAGENT_PARAMS = [
	param("agent_name", false, getPrompt("subagent", "agentNameInstruction")),
	param("task", true, getPrompt("subagent", "taskInstruction")),
	param("context", true, getPrompt("subagent", "contextInstruction")),
	param("background", false, getPrompt("subagent", "backgroundInstruction"), "boolean"),
	param("timeout", false, getPrompt("subagent", "timeoutInstruction"), "integer"),
]
const SUBAGENT_PARAMS = [
	param("subagents", true, getPrompt("subagent", "subagentsInstruction"), "array"),
	param("background", false, getPrompt("subagent", "backgroundInstruction"), "boolean"),
	param("timeout", false, getPrompt("subagent", "timeoutInstruction"), "integer"),
]

/**
 * Element shape for the batch tool's one structured parameter.
 *
 * A plain parameter descriptor can say a value is an array but not what the
 * array holds, so the batch tool supplies its own schema. Declaring the item
 * fields here is what lets a provider validate a malformed batch before it
 * reaches the parser, instead of the model discovering the shape by failing.
 */
const SUBAGENTS_INPUT_SCHEMA = {
	type: "object",
	properties: {
		subagents: {
			type: "array",
			description: getPrompt("subagent", "subagentsInstruction"),
			minItems: 1,
			maxItems: MAX_SUBAGENTS_PER_BATCH,
			items: {
				type: "object",
				properties: {
					agent_name: { type: "string", description: getPrompt("subagent", "itemAgentNameInstruction") },
					task: { type: "string", description: getPrompt("subagent", "itemTaskInstruction") },
					context: { type: "string", description: getPrompt("subagent", "itemContextInstruction") },
					profile: { type: "string", description: getPrompt("subagent", "itemProfileInstruction") },
					timeout: { type: "integer", description: getPrompt("subagent", "itemTimeoutInstruction") },
				},
				required: ["task", "context"],
				additionalProperties: false,
			},
		},
		background: { type: "boolean", description: getPrompt("subagent", "backgroundInstruction") },
		timeout: { type: "integer", description: getPrompt("subagent", "timeoutInstruction") },
	},
	required: ["subagents"],
	additionalProperties: false,
}

export const STANDARD_TOOL_SPECS: readonly Omit<ProfileToolSpec, "profile">[] = [
	spec(ClineDefaultTool.FILE_NEW, getPrompt("writeToFile", "standardDescription"), [
		param("absolutePath", true, getPrompt("writeToFile", "standardPathInstruction")),
		param("content", true, getPrompt("writeToFile", "standardContentInstruction")),
		taskProgress,
	]),
	spec(ClineDefaultTool.FILE_EDIT, getPrompt("replaceInFile", "standardDescription"), [
		param("absolutePath", true, getPrompt("replaceInFile", "standardPathInstruction")),
		param("diff", true, getPrompt("replaceInFile", "baseDiffInstructions")),
		taskProgress,
	]),
	spec(
		ClineDefaultTool.FILE_READ,
		`${getPrompt("readFile", "description")}${readFileImageSupportDescription}`,
		[
			param("path", true, getPrompt("readFile", "pathInstruction")),
			param("start_line", false, getPrompt("readFile", "startLineInstruction"), "integer"),
			param("end_line", false, getPrompt("readFile", "endLineInstruction"), "integer"),
			taskProgress,
		],
		undefined,
		[fragment(readFileImageSupportDescription, whenImageSupportDisabled)],
	),
	spec(ClineDefaultTool.SEARCH, getPrompt("searchFiles", "description"), [
		param("path", true, getPrompt("searchFiles", "pathInstruction")),
		param("regex", true, getPrompt("searchFiles", "regexInstruction")),
		param("file_pattern", false, getPrompt("searchFiles", "filePatternInstruction")),
		taskProgress,
	]),
	spec(ClineDefaultTool.LIST_FILES, getPrompt("listFiles", "description"), [
		param("path", true, getPrompt("listFiles", "standardPathInstruction")),
		param("recursive", false, getPrompt("listFiles", "recursiveInstruction"), "boolean"),
		param("show_metadata", false, getPrompt("listFiles", "showMetadataInstruction"), "boolean"),
		taskProgress,
	]),
	spec(ClineDefaultTool.LIST_CODE_DEF, getPrompt("listCodeDefinitionNames", "description"), [
		param("path", true, getPrompt("listCodeDefinitionNames", "pathInstruction")),
		taskProgress,
	]),
	spec(
		ClineDefaultTool.ASK,
		getPrompt("askFollowupQuestion", "standardDescription"),
		[
			param("question", true, getPrompt("askFollowupQuestion", "standardQuestionInstruction")),
			param("options", true, getPrompt("askFollowupQuestion", "standardOptionsInstruction")),
			taskProgress,
		],
		isInteractive,
	),
	spec(
		ClineDefaultTool.ATTEMPT,
		getPrompt("attemptCompletion", "standardDescription"),
		[param("result", true, getPrompt("attemptCompletion", "standardResultInstruction"))],
		undefined,
		[fragment(getPrompt("attemptCompletion", "focusOmissionChecklistSentence"), whenFocusTrackingDisabled)],
	),
	spec(
		ClineDefaultTool.MAKE_PLAN,
		getPrompt("makePlan", "description"),
		[
			param("response", true, getPrompt("makePlan", "standardResponseInstruction")),
			param("needs_more_exploration", false, getPrompt("makePlan", "needsMoreExplorationInstruction"), "boolean"),
			taskProgress,
		],
		undefined,
		[fragment(getPrompt("makePlan", "focusOmissionDescriptionClause"), whenFocusTrackingDisabled)],
	),
	spec(ClineDefaultTool.QNA_RESPOND, getPrompt("qnaRespond", "standardDescription"), [
		param("response", true, getPrompt("qnaRespond", "standardResponseInstruction")),
	]),
	spec(ClineDefaultTool.ACT_MODE, getPrompt("actModeRespond", "description"), [
		param("response", true, getPrompt("actModeRespond", "responseInstruction")),
		taskProgress,
	]),
	spec(ClineDefaultTool.BASH, getPrompt("executeCommand", "standardDescription"), [
		param("command", true, getPrompt("executeCommand", "standardCommandInstruction")),
		param("workdirectory", false, getPrompt("executeCommand", "standardWorkdirectoryInstruction")),
		param("requires_approval", true, getPrompt("executeCommand", "standardRequiresApprovalInstruction"), "boolean"),
		param("background", false, getPrompt("executeCommand", "standardBackgroundInstruction"), "boolean"),
		param("synchronous", false, getPrompt("executeCommand", "standardSynchronousInstruction"), "boolean"),
		param("timeout", false, getPrompt("executeCommand", "standardTimeoutInstruction"), "integer"),
		param("mute_stdout", false, getPrompt("executeCommand", "standardMuteStdoutInstruction"), "boolean"),
	]),
	spec(ClineDefaultTool.KILL_COMMAND, getPrompt("killCommand", "standardDescription"), [
		param("function_id", true, getPrompt("killCommand", "standardFunctionIdInstruction")),
	]),
	spec(
		ClineDefaultTool.BROWSER,
		getPrompt("browserAction", "description"),
		[
			param("action", true, getPrompt("browserAction", "standardActionInstruction")),
			param("url", false, getPrompt("browserAction", "standardUrlInstruction")),
			param("coordinate", false, getPrompt("browserAction", "standardCoordinateInstruction")),
			param("text", false, getPrompt("browserAction", "standardTextInstruction")),
		],
		hasBrowser,
	),
	spec(
		ClineDefaultTool.WEB_FETCH,
		getPrompt("webFetch", "standardDescription"),
		[
			param("url", true, getPrompt("webFetch", "urlInstruction")),
			param("prompt", true, getPrompt("webFetch", "standardPromptInstruction")),
			taskProgress,
		],
		hasWebFetch,
	),
	spec(
		ClineDefaultTool.WEB_SEARCH,
		getPrompt("webSearch", "standardDescription"),
		[
			param("query", true, getPrompt("webSearch", "queryInstruction")),
			param("allowed_domains", false, getPrompt("webSearch", "allowedDomainsInstruction")),
			param("blocked_domains", false, getPrompt("webSearch", "blockedDomainsInstruction")),
			taskProgress,
		],
		hasLocalWebSearch,
	),
	spec(
		ClineDefaultTool.MCP_USE,
		getPrompt("useMcpTool", "description"),
		[
			param("server_name", true, getPrompt("useMcpTool", "serverNameInstruction")),
			param("tool_name", true, getPrompt("useMcpTool", "toolNameInstruction")),
			param("arguments", true, getPrompt("useMcpTool", "argumentsInstruction")),
			taskProgress,
		],
		hasMcp,
	),
	spec(
		ClineDefaultTool.MCP_ACCESS,
		getPrompt("accessMcpResource", "standardDescription"),
		[
			param("server_name", true, getPrompt("accessMcpResource", "serverNameInstruction")),
			param("uri", true, getPrompt("accessMcpResource", "uriInstruction")),
			taskProgress,
		],
		hasMcp,
	),
	spec(ClineDefaultTool.MCP_DOCS, getPrompt("loadMcpDocumentationTool", "description"), [], hasMcp),
	spec(ClineDefaultTool.LOAD_MCP, getPrompt("loadCapability", "mcpDescription"), LOAD_MCP_PARAMS, hasMcp),
	spec(ClineDefaultTool.LOAD_SKILL, getPrompt("loadCapability", "skillDescription"), LOAD_SKILL_PARAMS, hasSkills),
	spec(ClineDefaultTool.LOAD_WORKFLOW, getPrompt("loadCapability", "workflowDescription"), LOAD_WORKFLOW_PARAMS),
	spec(ClineDefaultTool.FIND_REFERENCES, getPrompt("findReferences", "standardDescription"), [
		param("file_path", true, getPrompt("findReferences", "filePathInstruction")),
		param("line", true, getPrompt("findReferences", "lineInstruction"), "integer"),
		param("character", true, getPrompt("findReferences", "characterInstruction"), "integer"),
		taskProgress,
	]),
	spec(ClineDefaultTool.RENAME, getPrompt("rename", "standardDescription"), [
		param("file_path", true, getPrompt("rename", "filePathInstruction")),
		param("line", true, getPrompt("rename", "lineInstruction"), "integer"),
		param("character", true, getPrompt("rename", "characterInstruction"), "integer"),
		param("new_name", true, getPrompt("rename", "newNameInstruction")),
		param("dry_run", false, getPrompt("rename", "dryRunInstruction"), "boolean"),
		taskProgress,
	]),
	spec(ClineDefaultTool.REPLACE_TEXT, getPrompt("replaceText", "standardDescription"), [
		param("find", true, getPrompt("replaceText", "findInstruction")),
		param("replace", true, getPrompt("replaceText", "replaceInstruction")),
		param("file_pattern", true, getPrompt("replaceText", "filePatternInstruction")),
		param("dry_run", false, getPrompt("replaceText", "dryRunInstruction"), "boolean"),
		param("literal", false, getPrompt("replaceText", "literalInstruction"), "boolean"),
		taskProgress,
	]),
	spec(ClineDefaultTool.APPLY_PATCH, getPrompt("applyPatch", "description"), [
		param("input", true, getPrompt("applyPatch", "inputInstruction")),
		taskProgress,
	]),
	spec(
		ClineDefaultTool.SPAWN_TASK,
		getPrompt("spawnTask", "description"),
		[
			param("task", true, getPrompt("spawnTask", "taskInstruction")),
			param("mode", true, getPrompt("spawnTask", "modeInstruction"), "string", ["plan", "act"]),
			param("context", false, getPrompt("spawnTask", "contextInstruction")),
		],
		canSpawnTask,
	),
	spec(
		ClineDefaultTool.CHANGE_TODO_LIST,
		getPrompt("focusChain", "focusChainChangeToolDescription"),
		[
			param("new_plan", true, getPrompt("focusChain", "focusChainChangeNewPlanNativeInstruction")),
			param("reason", false, getPrompt("focusChain", "focusChainChangeReasonNativeInstruction")),
		],
		whenFocusTracking,
	),
	spec(ClineDefaultTool.USE_SUBAGENT, getPrompt("subagent", "singleDescription"), SINGLE_SUBAGENT_PARAMS, hasSubagents),
	{
		...spec(ClineDefaultTool.USE_SUBAGENTS, getPrompt("subagent", "description"), SUBAGENT_PARAMS, hasSubagents),
		inputSchema: SUBAGENTS_INPUT_SCHEMA,
	},
	spec(
		ClineDefaultTool.STATUS_UPDATE,
		getPrompt("statusUpdate", "standardDescription"),
		[
			param("response", true, getPrompt("statusUpdate", "responseInstruction")),
			param("requires_acknowledgment", false, getPrompt("statusUpdate", "requiresAcknowledgmentInstruction"), "boolean"),
			taskProgress,
		],
		undefined,
		[fragment(getPrompt("statusUpdate", "focusOmissionDescriptionSentence"), whenFocusTrackingDisabled)],
	),
	spec(
		ClineDefaultTool.GENERATE_IMAGE,
		generateImageDescription,
		[
			param("prompt", true, getPrompt("generateImage", "promptInstruction")),
			param("profile", false, getPrompt("generateImage", "profileInstruction")),
			param("count", false, getPrompt("generateImage", "countInstruction"), "integer"),
			param("width", false, getPrompt("generateImage", "widthInstruction"), "integer"),
			param("height", false, getPrompt("generateImage", "heightInstruction"), "integer"),
			param("aspect_ratio", false, getPrompt("generateImage", "aspectRatioInstruction")),
			param("quality", false, getPrompt("generateImage", "qualityInstruction")),
			param("background", false, getPrompt("generateImage", "backgroundInstruction")),
			param("output_format", false, getPrompt("generateImage", "outputFormatInstruction")),
			param("output_compression", false, getPrompt("generateImage", "outputCompressionInstruction"), "integer"),
			param("reference_artifact_ids", false, getPrompt("generateImage", "referenceArtifactIdsInstruction")),
			param("mask_artifact_id", false, getPrompt("generateImage", "maskArtifactIdInstruction")),
			taskProgress,
		],
		hasImageGeneration,
		imageSizingFragments,
	),
	spec(
		ClineDefaultTool.GENERATE_EXPLANATION,
		getPrompt("generateExplanation", "description"),
		[
			param("title", true, getPrompt("generateExplanation", "titleInstruction")),
			param("from_ref", true, getPrompt("generateExplanation", "fromRefInstruction")),
			param("to_ref", false, getPrompt("generateExplanation", "toRefInstruction")),
		],
		(context) => context.isCliEnvironment !== true,
	),
	spec(ClineDefaultTool.GENERATE_REPORT, getPrompt("generateReport", "standardDescription"), [
		param("title", true, getPrompt("generateReport", "titleInstruction")),
		param("content", true, getPrompt("generateReport", "contentInstruction")),
		taskProgress,
	]),
]
