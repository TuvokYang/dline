import type { ModelInfo } from "@shared/proto/dline/models"
import { ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"
import { ImageGenerationSource } from "@shared/proto/dline/profile"
import { WebToolsMode } from "@shared/proto/dline/provider/common"

const KNOWN_SERVER_TOOLS = new Set<ServerTool>([
	ServerTool.WEB_SEARCH,
	ServerTool.CODE_EXECUTION,
	ServerTool.IMAGE_GENERATION,
	ServerTool.WEB_FETCH,
])

const SUPPORTED_TOOLS_BY_API_FORMAT: Readonly<Partial<Record<ApiFormat, ReadonlySet<ServerTool>>>> = {
	[ApiFormat.ANTHROPIC_CHAT]: new Set([ServerTool.WEB_SEARCH, ServerTool.CODE_EXECUTION, ServerTool.WEB_FETCH]),
	[ApiFormat.OPENAI_RESPONSES]: new Set([ServerTool.WEB_SEARCH, ServerTool.IMAGE_GENERATION]),
	[ApiFormat.OPENAI_RESPONSES_WEBSOCKET_MODE]: new Set([ServerTool.WEB_SEARCH, ServerTool.IMAGE_GENERATION]),
}

export type ServerToolDeclaration =
	| Readonly<{ type: "web_search" }>
	| Readonly<{ type: "web_search_20260318"; name: "web_search"; allowed_callers: readonly ["direct"] }>
	| Readonly<{ type: "code_execution_20260120"; name: "code_execution"; allowed_callers: readonly ["direct"] }>
	| Readonly<{ type: "web_fetch_20260318"; name: "web_fetch"; allowed_callers: readonly ["direct"] }>
	| Readonly<{ type: "image_generation" }>

export interface ServerToolProjection {
	readonly declarations: readonly ServerToolDeclaration[]
}

export interface ServerToolPlan {
	readonly apiFormat?: ApiFormat
	/** Hosted tools the model itself declares. Owned by the registry. */
	readonly declared: readonly ServerTool[]
	/** Declared tools the profile switched off. Owned by the user. */
	readonly disabled: readonly ServerTool[]
	/** Declared, enabled, and carried by the selected wire protocol. */
	readonly active: readonly ServerTool[]
	readonly unsupported: readonly ServerTool[]
	readonly unrecognized: readonly number[]
}

/** Execution route of one web tool: provider-hosted, the local Dline executor, off, or blocked. */
export type WebToolRoute = "disabled" | "local" | "hosted" | "unavailable"
export type WebSearchRoute = WebToolRoute

export type WebToolUnavailableReason =
	| "local_web_search_unavailable"
	| "server_tool_not_declared"
	| "server_tool_disabled_by_profile"
	| "server_tool_transport_unsupported"
	| "server_tool_adapter_unavailable"
export type WebSearchUnavailableReason = WebToolUnavailableReason

/**
 * Routes of every web tool for one request. One Web Tools mode governs both tools,
 * but each resolves against its own model declaration, profile switch, and adapter,
 * so a model may host search while fetching locally, or the reverse.
 */
export interface WebSearchRoutingPlan {
	readonly mode: WebToolsMode
	/** Route of Web Search. */
	readonly route: WebSearchRoute
	/** Route of Web Fetch. While hosted, the local web_fetch tool is withheld. */
	readonly webFetchRoute: WebToolRoute
	readonly serverToolPlan: ServerToolPlan
	readonly localToolEnabled: boolean
	readonly localFallbackAvailable: boolean
	readonly serverTools: readonly ServerTool[]
	readonly unavailableReason?: WebSearchUnavailableReason
	readonly webFetchUnavailableReason?: WebToolUnavailableReason
}

export interface WebSearchRoutingInput {
	readonly enabled: boolean
	readonly mode?: WebToolsMode
	readonly modelInfo: Pick<ModelInfo, "capabilities"> | undefined
	/**
	 * Hosted tools the profile switched off. Absent means the profile follows the
	 * model declaration, which is the state every profile starts in.
	 */
	readonly disabledServerTools?: readonly ServerTool[]
	readonly selectedApiFormat: ApiFormat | undefined
	readonly localAvailable: boolean
	/** Whether the handler can carry hosted Web Search. */
	readonly remoteAdapterAvailable: boolean
	/** Whether the handler can carry hosted Web Fetch. Absent means it cannot. */
	readonly remoteWebFetchAdapterAvailable?: boolean
}

export type HostedImageGenerationRoute = "disabled" | "hosted" | "unavailable"

export type HostedImageGenerationUnavailableReason =
	| "server_tool_not_declared"
	| "server_tool_transport_unsupported"
	| "server_tool_adapter_unavailable"

export interface HostedImageGenerationPlan {
	readonly route: HostedImageGenerationRoute
	readonly serverToolPlan: ServerToolPlan
	readonly serverTools: readonly ServerTool[]
	readonly unavailableReason?: HostedImageGenerationUnavailableReason
}

export interface HostedImageGenerationInput {
	readonly enabled: boolean
	readonly source?: ImageGenerationSource
	readonly modelInfo: Pick<ModelInfo, "capabilities"> | undefined
	readonly selectedApiFormat: ApiFormat | undefined
	readonly remoteAdapterAvailable: boolean
}

/**
 * Resolve provider-hosted tools from the model declaration, the profile's switches,
 * and the selected wire protocol.
 *
 * The declaration and the switches are deliberately separate inputs: the model
 * states what it can do, the profile states what the user turned off. Folding the
 * switch back into the declaration would make "turned off" and "not supported"
 * indistinguishable, which silently strips a hosted-capable model of its route.
 */
export function resolveServerToolPlan(
	modelInfo: Pick<ModelInfo, "capabilities"> | undefined,
	selectedApiFormat: ApiFormat | undefined,
	disabledServerTools?: readonly ServerTool[],
): ServerToolPlan {
	const declared: ServerTool[] = []
	const unrecognized: number[] = []
	const seen = new Set<number>()

	for (const numericValue of modelInfo?.capabilities?.tools ?? []) {
		if (!Number.isInteger(numericValue) || numericValue === ServerTool.SERVER_TOOL_UNSPECIFIED || seen.has(numericValue)) {
			continue
		}
		seen.add(numericValue)
		if (KNOWN_SERVER_TOOLS.has(numericValue as ServerTool)) {
			declared.push(numericValue as ServerTool)
		} else {
			unrecognized.push(numericValue)
		}
	}

	declared.sort((left, right) => left - right)
	unrecognized.sort((left, right) => left - right)
	const supported = selectedApiFormat === undefined ? undefined : SUPPORTED_TOOLS_BY_API_FORMAT[selectedApiFormat]
	const disabled = declared.filter((tool) => disabledServerTools?.includes(tool) === true)
	const enabled = declared.filter((tool) => disabledServerTools?.includes(tool) !== true)
	const active = enabled.filter((tool) => supported?.has(tool) === true)
	const unsupported = enabled.filter((tool) => supported?.has(tool) !== true)

	return Object.freeze({
		...(selectedApiFormat === undefined ? {} : { apiFormat: selectedApiFormat }),
		declared: Object.freeze(declared),
		disabled: Object.freeze(disabled),
		active: Object.freeze(active),
		unsupported: Object.freeze(unsupported),
		unrecognized: Object.freeze(unrecognized),
	})
}

/** Check one active hosted capability without coupling callers to provider or model identifiers. */
export function hasActiveServerTool(plan: ServerToolPlan, tool: ServerTool): boolean {
	return plan.active.includes(tool)
}

/** Remove every provider-hosted web tool from an internal request while preserving model metadata. */
export function disableWebSearchRoutingPlan(plan: WebSearchRoutingPlan): WebSearchRoutingPlan {
	return Object.freeze({
		mode: plan.mode,
		route: "disabled" as const,
		webFetchRoute: "disabled" as const,
		serverToolPlan: plan.serverToolPlan,
		localToolEnabled: false,
		localFallbackAvailable: false,
		serverTools: Object.freeze([] as ServerTool[]),
	})
}

/**
 * Withdraw Web Search from a plan whose caller may not use it, such as a subagent
 * whose tool allowlist omits web_search. The sandbox rides on hosted search and is
 * withdrawn with it; the fetch route is left untouched.
 */
export function disableWebSearchRoute(plan: WebSearchRoutingPlan): WebSearchRoutingPlan {
	if (plan.route === "disabled") return plan
	const { unavailableReason: _dropped, ...rest } = plan
	return Object.freeze({
		...rest,
		route: "disabled" as const,
		localToolEnabled: false,
		localFallbackAvailable: false,
		// Every hosted tool except Web Fetch follows the search route.
		serverTools: Object.freeze(plan.serverTools.filter((tool) => tool === ServerTool.WEB_FETCH)),
	})
}

/**
 * Withdraw Web Fetch from a plan whose caller may not use it, such as a subagent
 * whose tool allowlist omits web_fetch. The search route is left untouched.
 */
export function disableWebFetchRoute(plan: WebSearchRoutingPlan): WebSearchRoutingPlan {
	if (plan.webFetchRoute === "disabled") return plan
	const { webFetchUnavailableReason: _dropped, ...rest } = plan
	return Object.freeze({
		...rest,
		webFetchRoute: "disabled" as const,
		serverTools: Object.freeze(plan.serverTools.filter((tool) => tool !== ServerTool.WEB_FETCH)),
	})
}

type HostedWebTool = ServerTool.WEB_SEARCH | ServerTool.WEB_FETCH

interface WebToolRouteResolution {
	readonly route: WebToolRoute
	readonly unavailableReason?: WebToolUnavailableReason
}

const DISABLED_WEB_TOOL: WebToolRouteResolution = Object.freeze({ route: "disabled" })

/** Name the first reason a web tool cannot be hosted, or nothing when it can. */
function hostedWebToolBlocker(
	plan: ServerToolPlan,
	tool: HostedWebTool,
	adapterAvailable: boolean,
): WebToolUnavailableReason | undefined {
	if (!plan.declared.includes(tool)) return "server_tool_not_declared"
	if (plan.disabled.includes(tool)) return "server_tool_disabled_by_profile"
	if (!plan.active.includes(tool)) return "server_tool_transport_unsupported"
	if (!adapterAvailable) return "server_tool_adapter_unavailable"
	return undefined
}

/**
 * Resolve one web tool under an enabled Web Tools mode. Auto prefers the hosted tool
 * and falls back to the local one; the forced modes never fall back.
 */
function resolveWebToolRoute(
	mode: WebToolsMode,
	plan: ServerToolPlan,
	tool: HostedWebTool,
	localAvailable: boolean,
	adapterAvailable: boolean,
): WebToolRouteResolution {
	if (mode === WebToolsMode.WEB_TOOLS_MODE_FORCE_LOCAL) {
		return localAvailable ? { route: "local" } : { route: "unavailable", unavailableReason: "local_web_search_unavailable" }
	}
	const blocker = hostedWebToolBlocker(plan, tool, adapterAvailable)
	if (blocker === undefined) return { route: "hosted" }
	if (mode === WebToolsMode.WEB_TOOLS_MODE_FORCE_REMOTE || !localAvailable) {
		return { route: "unavailable", unavailableReason: blocker }
	}
	return { route: "local" }
}

/**
 * Collect the provider-hosted tools a request declares. The sandbox is a capability of
 * its own: it rides on hosted search but is never routed through it, so a search never
 * spends the sandbox's call budget.
 */
function collectHostedServerTools(plan: ServerToolPlan, search: WebToolRoute, fetch: WebToolRoute): readonly ServerTool[] {
	const tools: ServerTool[] = []
	if (search === "hosted") {
		tools.push(ServerTool.WEB_SEARCH)
		if (plan.active.includes(ServerTool.CODE_EXECUTION)) tools.push(ServerTool.CODE_EXECUTION)
	}
	if (fetch === "hosted") tools.push(ServerTool.WEB_FETCH)
	return Object.freeze(tools)
}

function createWebSearchRoutingPlan(
	mode: WebToolsMode,
	serverToolPlan: ServerToolPlan,
	search: WebToolRouteResolution,
	fetch: WebToolRouteResolution,
	localFallbackAvailable: boolean,
): WebSearchRoutingPlan {
	return Object.freeze({
		mode,
		route: search.route,
		webFetchRoute: fetch.route,
		serverToolPlan,
		localToolEnabled: search.route === "local",
		localFallbackAvailable,
		serverTools: collectHostedServerTools(serverToolPlan, search.route, fetch.route),
		...(search.unavailableReason === undefined ? {} : { unavailableReason: search.unavailableReason }),
		...(fetch.unavailableReason === undefined ? {} : { webFetchUnavailableReason: fetch.unavailableReason }),
	})
}

/** Resolve exactly one execution route per web tool for the current request. */
export function resolveWebSearchRoutingPlan(input: WebSearchRoutingInput): WebSearchRoutingPlan {
	const mode = input.mode ?? WebToolsMode.WEB_TOOLS_MODE_AUTO
	const serverToolPlan = resolveServerToolPlan(input.modelInfo, input.selectedApiFormat, input.disabledServerTools)

	if (!input.enabled || mode === WebToolsMode.WEB_TOOLS_MODE_FORCE_OFF) {
		return createWebSearchRoutingPlan(mode, serverToolPlan, DISABLED_WEB_TOOL, DISABLED_WEB_TOOL, false)
	}

	const search = resolveWebToolRoute(
		mode,
		serverToolPlan,
		ServerTool.WEB_SEARCH,
		input.localAvailable,
		input.remoteAdapterAvailable,
	)
	const fetch = resolveWebToolRoute(
		mode,
		serverToolPlan,
		ServerTool.WEB_FETCH,
		input.localAvailable,
		input.remoteWebFetchAdapterAvailable === true,
	)
	// Only Auto may fall back from a hosted search to the local executor.
	const localFallbackAvailable = mode !== WebToolsMode.WEB_TOOLS_MODE_FORCE_REMOTE && input.localAvailable
	return createWebSearchRoutingPlan(mode, serverToolPlan, search, fetch, localFallbackAvailable)
}

/**
 * Hosted image generation is coordinated by the ordinary generate_image tool.
 * Main conversation requests never project the image server tool directly.
 */
export function resolveHostedImageGenerationPlan(input: HostedImageGenerationInput): HostedImageGenerationPlan {
	return Object.freeze({
		route: "disabled",
		serverToolPlan: resolveServerToolPlan(input.modelInfo, input.selectedApiFormat),
		serverTools: Object.freeze([]),
	})
}

/**
 * Whether one provider-hosted tool is routed for this request.
 *
 * Web Fetch owns its own route; Web Search and the code execution it drives
 * follow the search route. Declaration, stream admission, and approval all use
 * this one predicate so a tool can never be declared yet dropped, or run unapproved.
 */
export function isHostedToolRouted(plan: WebSearchRoutingPlan, tool: ServerTool): boolean {
	if (!plan.serverTools.includes(tool)) return false
	return tool === ServerTool.WEB_FETCH ? plan.webFetchRoute === "hosted" : plan.route === "hosted"
}

/** Whether any provider-hosted web tool is routed for this request. */
export function hasHostedWebRoute(plan: WebSearchRoutingPlan): boolean {
	return plan.serverTools.some((tool) => isHostedToolRouted(plan, tool))
}

/** List the hosted tools a plan may declare, honoring the route each one belongs to. */
function routedServerTools(plan: WebSearchRoutingPlan): ReadonlySet<ServerTool> {
	return new Set(plan.serverTools.filter((tool) => isHostedToolRouted(plan, tool)))
}

const DIRECT_CALLER_ONLY = Object.freeze(["direct"] as const)

/** Project active hosted capabilities into their protocol-native request shape. */
export function projectServerTools(plan: WebSearchRoutingPlan): ServerToolProjection {
	const hosted = routedServerTools(plan)
	const declarations: ServerToolDeclaration[] = []

	switch (plan.serverToolPlan.apiFormat) {
		case ApiFormat.OPENAI_RESPONSES:
		case ApiFormat.OPENAI_RESPONSES_WEBSOCKET_MODE:
			if (hosted.has(ServerTool.WEB_SEARCH)) declarations.push({ type: "web_search" })
			break
		case ApiFormat.ANTHROPIC_CHAT:
			// `direct` names the model itself: every tool is invoked by the model, and none
			// is reachable from inside the sandbox, which keeps dynamic filtering off.
			if (hosted.has(ServerTool.WEB_SEARCH)) {
				declarations.push({ type: "web_search_20260318", name: "web_search", allowed_callers: DIRECT_CALLER_ONLY })
			}
			if (hosted.has(ServerTool.CODE_EXECUTION)) {
				declarations.push({
					type: "code_execution_20260120",
					name: "code_execution",
					allowed_callers: DIRECT_CALLER_ONLY,
				})
			}
			if (hosted.has(ServerTool.WEB_FETCH)) {
				declarations.push({ type: "web_fetch_20260318", name: "web_fetch", allowed_callers: DIRECT_CALLER_ONLY })
			}
			break
	}
	return Object.freeze({ declarations: Object.freeze(declarations) })
}
