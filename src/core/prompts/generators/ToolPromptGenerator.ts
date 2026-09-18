import { ClineDefaultTool, type ClineTool } from "../../../shared/tools"
import type { PromptProfile } from "../profiles/types"
import type { SystemPromptContext } from "../system-prompt/context"
import { createSystemPromptConfig, prepareSystemRuntimeEnv } from "../system-prompt/pipeline"
import { PromptTemplate } from "../template/PromptTemplate"
import type { PromptContract, PromptEnv } from "../template/types"
import { createMcpToolSpecs } from "../tools/mcp-tool-adapter"
import type { ProfileToolSet } from "../tools/profile-tool-set"
import { projectTool } from "../tools/provider-projector"
import { createToolSet, LITE_TOOL_IDS, STANDARD_TOOL_IDS } from "../tools/tool-profile"
import { projectXmlTool } from "../tools/xml-tool-projector"

const TOOL_RUNTIME_KEYS = [
	"CWD",
	"MULTI_ROOT_HINT",
	"BROWSER_VIEWPORT_WIDTH",
	"BROWSER_VIEWPORT_HEIGHT",
	"SUBAGENT_TIMEOUT_SECONDS",
	"MAX_SUBAGENTS_PER_BATCH",
	"TERMINAL_COMMAND_TIMEOUT_SECONDS",
] as const
const TOOL_RUNTIME_RULE = { stages: ["runtime"] as const, required: true }
const RETIRED_DEFAULT_TOOL_NAMES = new Set<string>([ClineDefaultTool.SUMMARIZE_TASK, "use_skill"])
const TOOL_PROJECTION_CONTRACT: PromptContract = {
	variables: Object.fromEntries(TOOL_RUNTIME_KEYS.map((key) => [key, TOOL_RUNTIME_RULE])),
}

/** Collects strings from a plain provider-tool projection in stable traversal order. */
function collectStrings(value: unknown, strings: string[]): void {
	if (typeof value === "string") {
		strings.push(value)
		return
	}
	if (Array.isArray(value)) {
		for (const item of value) collectStrings(item, strings)
		return
	}
	if (value !== null && typeof value === "object") {
		for (const item of Object.values(value)) collectStrings(item, strings)
	}
}

/** Rebuilds a plain provider-tool projection with rendered strings in traversal order. */
function rebuildStrings(value: unknown, strings: Iterator<string>): unknown {
	if (typeof value === "string") {
		const next = strings.next()
		if (next.done) throw new Error("Tool projection string frame underflow")
		return next.value
	}
	if (Array.isArray(value)) return value.map((item) => rebuildStrings(item, strings))
	if (value !== null && typeof value === "object") {
		return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, rebuildStrings(item, strings)]))
	}
	return value
}

/** Chooses a frame delimiter absent from templates and runtime values. */
function createFrameDelimiter(values: readonly string[]): string {
	let sequence = 0
	while (true) {
		const delimiter = `\u0000DLINE_TOOL_FIELD_${sequence}\u0000`
		if (values.every((value) => !value.includes(delimiter))) return delimiter
		sequence += 1
	}
}

/** Reads a provider-native function name from any supported schema shape. */
function projectedToolName(tool: ClineTool): string | undefined {
	return "function" in tool && typeof tool.function?.name === "string"
		? tool.function.name
		: "name" in tool && typeof tool.name === "string"
			? tool.name
			: undefined
}

/** Generates ordered provider-native schemas from exact profile tool descriptors. */
export class ToolPromptGenerator {
	/** Creates a tool generator over an injected exact-profile set. */
	public constructor(private readonly toolSet: ProfileToolSet = createToolSet()) {}

	/**
	 * Generates ordered tools for one profile and runtime context.
	 *
	 * @param profile Exact Standard/Lite prompt profile.
	 * @param context Runtime context used for native-tool and feature gating.
	 * @returns Provider tools, or undefined when native tools are disabled.
	 */
	public generate(profile: PromptProfile, context: SystemPromptContext): readonly ClineTool[] | undefined {
		if (!context.enableNativeToolCalls) {
			return undefined
		}
		const projectionContext = this.resolveProfileContext(profile, context)
		const enabledSpecs = this.listEnabled(profile, projectionContext)
		const enabledToolIds = new Set(enabledSpecs.map((spec) => spec.id))
		const builtInTools = this.resolveNativeProjection(
			enabledSpecs.map((spec) => projectTool(spec, projectionContext, enabledToolIds)),
			projectionContext,
		)
		if (profile === "lite" || projectionContext.disableTools?.includes(ClineDefaultTool.MCP_USE)) {
			return builtInTools
		}
		const mcpTools = (projectionContext.mcpHub?.getServers() ?? [])
			.filter((server) => server.status === "connected" && server.disabled !== true)
			.flatMap((server) => createMcpToolSpecs(profile, server))
			.map((spec) => projectTool(spec, projectionContext, enabledToolIds))
		return [...builtInTools, ...mcpTools]
	}

	/** Removes retired default-tool schemas from a frozen projection loaded from an older task cache. */
	public filterCachedDefaultTools(tools: readonly ClineTool[] | undefined): readonly ClineTool[] | undefined {
		return tools?.filter((tool) => {
			const name = projectedToolName(tool)
			return name === undefined || !RETIRED_DEFAULT_TOOL_NAMES.has(name)
		})
	}

	/** Returns the frozen ordinary tool projection for every request, including explicit control instructions. */
	public generateToolsForRequest(
		_profile: PromptProfile,
		_context: SystemPromptContext,
		cachedTools: readonly ClineTool[] | undefined,
	): readonly ClineTool[] | undefined {
		return this.filterCachedDefaultTools(cachedTools)
	}

	/** Generates complete XML documentation from the exact-profile descriptors. */
	public generateXml(profile: PromptProfile, context: SystemPromptContext): string {
		const projectionContext = this.resolveProfileContext(profile, context)
		const enabledSpecs = this.listEnabled(profile, projectionContext).filter((spec) => spec.transport !== "native")
		const enabledToolIds = new Set(enabledSpecs.map((spec) => spec.id))
		return enabledSpecs.map((spec) => projectXmlTool(spec, projectionContext, enabledToolIds)).join("\n\n")
	}

	/** Applies profile-owned gates before projecting tool descriptions and parameters. */
	private resolveProfileContext(profile: PromptProfile, context: SystemPromptContext): SystemPromptContext {
		if (profile !== "lite" || context.focusChainSettings?.enabled !== true) {
			return context
		}
		return {
			...context,
			focusChainSettings: { ...context.focusChainSettings, enabled: false },
		}
	}

	/** Resolves runtime tokens once across the complete provider-native projection. */
	private resolveNativeProjection(tools: readonly ClineTool[], context: SystemPromptContext): readonly ClineTool[] {
		const config = createSystemPromptConfig(context)
		const systemEnv = prepareSystemRuntimeEnv(context, config)
		const env: PromptEnv = Object.fromEntries(TOOL_RUNTIME_KEYS.map((key) => [key, systemEnv[key]]))
		const templates: string[] = []
		collectStrings(tools, templates)
		const delimiter = createFrameDelimiter([...templates, ...Object.values(env).map(String)])
		const output = PromptTemplate.create("tools.native.complete", templates.join(delimiter), TOOL_PROJECTION_CONTRACT)
			.env("runtime", env, "tool-runtime-env")
			.generate()
		const rendered = output.text.split(delimiter)
		if (rendered.length !== templates.length) throw new Error("Tool projection string frame mismatch")
		return rebuildStrings(tools, rendered.values()) as readonly ClineTool[]
	}

	/** Resolves the ordered built-in descriptors that pass profile and runtime gates. */
	private listEnabled(profile: PromptProfile, context: SystemPromptContext) {
		const ids = profile === "lite" ? LITE_TOOL_IDS : STANDARD_TOOL_IDS
		const disabled = new Set(context.disableTools ?? [])
		return this.toolSet
			.list(profile, ids)
			.filter((spec) => !disabled.has(spec.id))
			.filter((spec) => !spec.contextRequirements || spec.contextRequirements(context))
	}
}
