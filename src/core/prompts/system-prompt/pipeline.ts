import { MAX_SUBAGENTS_PER_BATCH } from "@shared/concurrency-limits"
import { DEFAULT_SUBAGENT_TIMEOUT_SECONDS } from "@shared/subagent-settings"
import { DEFAULT_TERMINAL_COMMAND_TIMEOUT_SECONDS } from "@shared/terminal-settings"
import { getShellForProfile } from "@utils/shell"
import { getPrompt } from "../i18n"
import { PromptProfile, requirePromptProfile } from "../profiles/types"
import { PromptTemplate } from "../template/PromptTemplate"
import type { EnvRule, PromptContract, PromptEnv, PromptOutput } from "../template/types"
import { assemblePromptFragments } from "./assembly/prompt-fragment-assembler"
import type { SystemPromptContext } from "./context"
import { assembleSystemSections } from "./templates/system-template-registry"
import type { SystemSectionContentConfig } from "./variants/section-content-config"

export interface SystemPromptConfig extends SystemSectionContentConfig {
	readonly templateId: "integrated"
	readonly variant: PromptProfile
	readonly browserEnabled: boolean
	readonly cliEnvironment: boolean
	readonly webToolsEnabled: boolean
	readonly localWebSearchEnabled: boolean
	readonly serverWebSearchEnabled: boolean
}

const COMPLETE_TEMPLATE_ENV_KEYS = [
	"WORKSPACE_NAMES",
	"WORKSPACE_PATH_RULE",
	"BROWSER_SUPPORT",
	"YOLO_ASK_TEXT",
	"BROWSER_CAPABILITIES",
	"WEB_TOOLS_CAPABILITIES",
	"CUSTOM_INSTRUCTIONS",
	"OS",
	"IDE",
	"SHELL",
	"PARALLEL_TOOLS_RULE",
	"BROWSER_WAIT_RULES",
	"MCP_RULE",
	"CLARIFY_PERMISSION",
	"PARALLEL_TOOL_POLICY",
	"CLARIFY_RULE",
	"MISSING_PARAM_POLICY",
	"MCP_SERVERS_SECTION",
	"MULTI_ROOT_HINT",
	"BROWSER_VIEWPORT_WIDTH",
	"BROWSER_VIEWPORT_HEIGHT",
	"SUBAGENT_TIMEOUT_SECONDS",
	"MAX_SUBAGENTS_PER_BATCH",
	"TERMINAL_COMMAND_TIMEOUT_SECONDS",
] as const

const RUNTIME_RULE: EnvRule = { stages: ["runtime"], required: true }
const COMPLETE_TEMPLATE_CONTRACT: PromptContract = {
	variables: Object.fromEntries(COMPLETE_TEMPLATE_ENV_KEYS.map((key) => [key, RUNTIME_RULE])),
}

export function createSystemPromptConfig(context: SystemPromptContext): SystemPromptConfig {
	const servers = context.mcpHub?.getServers() ?? []
	const variant = requirePromptProfile(context.promptProfile)
	const webToolsEnabled = variant === PromptProfile.Standard && context.clineWebToolsEnabled === true
	const userInstructionsEnabled = [
		context.preferredLanguageInstructions,
		context.globalClineRulesFileInstructions,
		context.localClineRulesFileInstructions,
		context.localCursorRulesFileInstructions,
		context.localCursorRulesDirInstructions,
		context.localWindsurfRulesFileInstructions,
		context.localAgentsRulesFileInstructions,
		context.clineIgnoreInstructions,
	].some(Boolean)

	return Object.freeze({
		templateId: "integrated",
		variant,
		transport: context.enableNativeToolCalls === true ? "native" : "xml",
		parallelTools: context.enableParallelToolCalling === true,
		mcpEnabled: servers.some((server) => server.status === "connected" && server.disabled !== true),
		browserEnabled:
			variant === PromptProfile.Standard &&
			context.supportsBrowserUse === true &&
			context.browserSettings?.disableToolUse !== true,
		focusChainEnabled: variant === PromptProfile.Standard && context.focusChainSettings?.enabled === true,
		subagentsEnabled: variant === PromptProfile.Standard && context.subagentsEnabled === true,
		subagentRun: context.isSubagentRun === true,
		yoloModeEnabled: context.yoloModeToggled === true,
		cliEnvironment: context.isCliEnvironment === true,
		webToolsEnabled,
		localWebSearchEnabled: webToolsEnabled && context.webSearchRoutingPlan?.route === "local",
		serverWebSearchEnabled: webToolsEnabled && context.webSearchRoutingPlan?.route === "hosted",
		userInstructionsEnabled,
	})
}

export function prepareToolUseSection(config: SystemPromptConfig, baseSection: string, xmlTools: string): string {
	const subagentGuidance =
		config.transport === "native" && config.subagentsEnabled && !config.subagentRun
			? getPrompt("variants.lite", "subagentsGuidance")
			: ""
	if (config.variant === PromptProfile.Lite) {
		return assemblePromptFragments(baseSection, {
			XML_TOOLS_SECTION: xmlTools,
			SUBAGENTS_GUIDANCE: subagentGuidance,
		})
	}
	if (config.transport === "native") {
		return baseSection
	}

	const formatting = assemblePromptFragments(getPrompt("toolUseFormatting", "main"), {
		FOCUS_CHATIN_FORMATTING: config.focusChainEnabled ? getPrompt("toolUseFormatting", "focusChainExample") : "",
	})
	const examples = assemblePromptFragments(getPrompt("toolUseExamples", "main"), {
		FOCUS_CHAIN_EXAMPLE_BASH: config.focusChainEnabled ? getPrompt("toolUseExamples", "focusChainBash") : "",
		FOCUS_CHAIN_EXAMPLE_NEW_FILE: config.focusChainEnabled ? getPrompt("toolUseExamples", "focusChainNewFile") : "",
		FOCUS_CHAIN_EXAMPLE_EDIT: config.focusChainEnabled ? getPrompt("toolUseExamples", "focusChainEdit") : "",
	})
	return assemblePromptFragments(getPrompt("toolUseIndex", "main"), {
		TOOL_USE_FORMATTING_SECTION: formatting,
		TOOLS_SECTION: xmlTools,
		TOOL_USE_EXAMPLES_SECTION: examples,
		TOOL_USE_GUIDELINES_SECTION: getPrompt("toolUseGuidelines", "main"),
	})
}

export function prepareSystemRuntimeEnv(context: SystemPromptContext, config: SystemPromptConfig): PromptEnv {
	const cwd = context.cwd ?? process.cwd()
	const cwdSegments = cwd.split(/[\\/]/).filter(Boolean)
	const fallbackWorkspaceName = cwdSegments[cwdSegments.length - 1] || "workspace"
	const roots = context.workspaceRoots?.length ? context.workspaceRoots : [{ name: fallbackWorkspaceName, path: cwd }]
	const workspaceNames = roots.map((root) => root.name.replace(/[\r\n\t]+/g, " ").trim()).filter((name) => name.length > 0)
	const visibleWorkspaceNames = workspaceNames.length > 0 ? workspaceNames : [fallbackWorkspaceName]
	const workspaceList = visibleWorkspaceNames.map((name) => `\n- ${name}`).join("")
	const multiRoot = context.isMultiRootEnabled === true && roots.length > 1
	const customInstructions = [
		context.preferredLanguageInstructions,
		context.globalClineRulesFileInstructions,
		context.localClineRulesFileInstructions,
		context.localCursorRulesFileInstructions,
		context.localCursorRulesDirInstructions,
		context.localWindsurfRulesFileInstructions,
		context.localAgentsRulesFileInstructions,
		context.clineIgnoreInstructions,
	]
		.filter((value): value is string => Boolean(value))
		.join("\n\n")
	const multiRootHint = multiRoot
		? assemblePromptFragments(getPrompt("runtimeEnvironment", "multiRootHint"), {
				NAMES: visibleWorkspaceNames.join(", "),
			})
		: ""
	const browserSupport = config.browserEnabled ? getPrompt("runtimeEnvironment", "browserSupport") : ""
	const browserCapabilities = config.browserEnabled ? getPrompt("runtimeEnvironment", "browserCapabilities") : ""
	const webToolsCapabilities = [
		config.webToolsEnabled ? getPrompt("runtimeEnvironment", "webToolsCapabilities") : "",
		config.localWebSearchEnabled ? getPrompt("runtimeEnvironment", "localWebSearchCapabilities") : "",
		config.serverWebSearchEnabled ? getPrompt("runtimeEnvironment", "serverWebSearchCapabilities") : "",
	].join("")

	return Object.freeze({
		WORKSPACE_NAMES: workspaceList,
		WORKSPACE_PATH_RULE: getPrompt("runtimeEnvironment", "workspacePathRule"),
		BROWSER_SUPPORT: browserSupport,
		YOLO_ASK_TEXT: config.yoloModeEnabled ? "" : getPrompt("runtimeEnvironment", "yoloAskText"),
		BROWSER_CAPABILITIES: browserCapabilities,
		WEB_TOOLS_CAPABILITIES: webToolsCapabilities,
		CUSTOM_INSTRUCTIONS: customInstructions,
		OS: context.isTesting ? "macOS" : process.platform,
		IDE: context.isTesting ? "TestIde" : context.ide,
		SHELL: context.isTesting
			? "/bin/zsh"
			: process.platform === "win32"
				? getShellForProfile(context.defaultTerminalProfile ?? "default")
				: process.env.SHELL || "/bin/bash",
		PARALLEL_TOOLS_RULE: config.parallelTools ? getPrompt("runtimeEnvironment", "parallelToolsRule") : "",
		BROWSER_WAIT_RULES: config.browserEnabled ? getPrompt("rules", "browserWaitRules") : "",
		MCP_RULE: "",
		CLARIFY_PERMISSION: config.yoloModeEnabled ? "" : getPrompt("runtimeEnvironment", "clarifyPermission"),
		PARALLEL_TOOL_POLICY: getPrompt(
			"runtimeEnvironment",
			config.parallelTools ? "parallelToolPolicyEnabled" : "parallelToolPolicyDisabled",
		),
		CLARIFY_RULE: getPrompt("runtimeEnvironment", config.yoloModeEnabled ? "clarifyRuleYolo" : "clarifyRuleInteractive"),
		MISSING_PARAM_POLICY: getPrompt(
			"runtimeEnvironment",
			config.yoloModeEnabled ? "missingParamPolicyYolo" : "missingParamPolicyInteractive",
		),
		MCP_SERVERS_SECTION: "",
		MULTI_ROOT_HINT: multiRootHint,
		BROWSER_VIEWPORT_WIDTH: String(context.browserSettings?.viewport.width ?? 0),
		BROWSER_VIEWPORT_HEIGHT: String(context.browserSettings?.viewport.height ?? 0),
		SUBAGENT_TIMEOUT_SECONDS: String(DEFAULT_SUBAGENT_TIMEOUT_SECONDS),
		MAX_SUBAGENTS_PER_BATCH: String(MAX_SUBAGENTS_PER_BATCH),
		TERMINAL_COMMAND_TIMEOUT_SECONDS: String(
			context.terminalCommandTimeoutSeconds ?? DEFAULT_TERMINAL_COMMAND_TIMEOUT_SECONDS,
		),
	})
}

export function assembleSystemPrompt(
	_sectionIds: readonly string[],
	_sections: ReadonlyMap<string, string>,
	_separator: string,
): string
export function assembleSystemPrompt(
	_sectionIds: readonly string[],
	_sections: ReadonlyMap<string, string>,
	_separator: string,
	_env: PromptEnv,
): PromptOutput
export function assembleSystemPrompt(
	sectionIds: readonly string[],
	sections: ReadonlyMap<string, string>,
	separator: string,
	env?: PromptEnv,
): string | PromptOutput {
	const template = assembleSystemSections(sectionIds, sections, separator)
	if (!env) {
		return template
	}
	return PromptTemplate.create("system.complete", template, COMPLETE_TEMPLATE_CONTRACT)
		.env("runtime", env, "system-runtime-env")
		.generate()
}
