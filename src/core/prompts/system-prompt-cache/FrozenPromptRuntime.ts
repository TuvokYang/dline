import type { WebSearchRoute, WebSearchRoutingPlan, WebToolRoute } from "@core/api/server-tools"
import type { SystemPromptContext } from "@core/prompts/system-prompt"
import type { FrozenPromptRuntime, FrozenSystemPromptCache } from "@core/storage/task-context-types"
import { ServerTool } from "@shared/proto/dline/models/metadata"
import { WebToolsMode } from "@shared/proto/dline/provider/common"
import { createTaskCapabilityToggles, emptyTaskCapabilityToggles } from "@shared/TaskCapabilityToggles"

export interface ResolvedPromptRuntime
	extends Omit<FrozenPromptRuntime, "parallelToolsEnabled" | "webToolsMode" | "webSearchRoute" | "serverTools"> {
	readonly parallelToolsEnabled: boolean
	readonly webSearchRoutingPlan: WebSearchRoutingPlan
}

function resolveBrowserViewport(
	frozen: FrozenSystemPromptCache,
	context: SystemPromptContext,
): Readonly<{ width: number; height: number }> {
	if (frozen.runtime) return frozen.runtime.browserViewport
	const serialized = frozen.freshnessBaseline?.browserViewport
	const match = serialized?.match(/^(\d+)x(\d+)$/)
	if (match) return { width: Number(match[1]), height: Number(match[2]) }
	return {
		width: context.browserSettings?.viewport.width ?? 0,
		height: context.browserSettings?.viewport.height ?? 0,
	}
}

/**
 * Whether a snapshot was frozen before Web Fetch had a route of its own.
 *
 * Every snapshot written since records its fetch route in the freshness baseline.
 * Earlier prompts exposed the local web_fetch tool whenever web tools were on,
 * whatever the Web Tools mode, so their fetch route must not be re-derived from it.
 */
function predatesWebFetchRoute(frozen: FrozenSystemPromptCache): boolean {
	return typeof frozen.freshnessBaseline?.webFetchRoute !== "string"
}

/**
 * Recover the Web Fetch route a frozen snapshot was built with.
 *
 * The snapshot records the search route and the hosted tools, and one mode governs
 * both tools, so fetch needs no field of its own: it is hosted exactly when the frozen
 * hosted tools include it, and otherwise local wherever the local executor was
 * reachable. Snapshots written before hosted fetch existed keep fetching locally,
 * matching the local web_fetch tool frozen into their prompt.
 */
function resolveFrozenWebFetchRoute(
	searchRoute: WebSearchRoute,
	mode: WebToolsMode,
	serverTools: readonly ServerTool[],
	localFallbackAvailable: boolean,
	legacySnapshot: boolean,
): WebToolRoute {
	if (searchRoute === "disabled") return "disabled"
	if (serverTools.includes(ServerTool.WEB_FETCH)) return "hosted"
	if (legacySnapshot) return "local"
	if (mode === WebToolsMode.WEB_TOOLS_MODE_FORCE_REMOTE) return "unavailable"
	const localAvailable = searchRoute === "local" || (searchRoute === "hosted" && localFallbackAvailable)
	return localAvailable ? "local" : "unavailable"
}

/** Resolve the execution contract that belongs to one frozen prompt/tool snapshot. */
export function resolveFrozenPromptRuntime(frozen: FrozenSystemPromptCache, context: SystemPromptContext): ResolvedPromptRuntime {
	const currentPlan = context.webSearchRoutingPlan
	if (!currentPlan) throw new Error("System prompt context is missing its Web Search routing plan")

	const runtime = frozen.runtime
	const builder = frozen.promptBuilder
	const webToolsEnabled = runtime?.webToolsEnabled ?? builder?.webToolsEnabled ?? context.clineWebToolsEnabled === true
	const route = webToolsEnabled ? (runtime?.webSearchRoute ?? builder?.webSearchRoute ?? currentPlan.route) : "disabled"
	const mode = runtime?.webToolsMode ?? builder?.webToolsMode ?? currentPlan.mode
	const localFallbackAvailable =
		route === "hosted"
			? (runtime?.webSearchLocalFallbackAvailable ??
				builder?.webSearchLocalFallbackAvailable ??
				currentPlan.localFallbackAvailable)
			: false
	const frozenServerTools =
		route === "disabled" ? [] : (runtime?.serverTools ?? builder?.serverTools ?? currentPlan.serverTools)
	const webFetchRoute = resolveFrozenWebFetchRoute(
		route,
		mode,
		frozenServerTools,
		localFallbackAvailable,
		predatesWebFetchRoute(frozen),
	)
	// Each hosted tool survives only while its own route is still hosted.
	const serverTools = frozenServerTools.filter((tool) =>
		tool === ServerTool.WEB_FETCH ? webFetchRoute === "hosted" : route === "hosted",
	)
	const browserEnabled =
		runtime?.browserEnabled ??
		frozen.freshnessBaseline?.browserEnabled ??
		(context.supportsBrowserUse === true && context.browserSettings?.disableToolUse !== true)

	return {
		parallelToolsEnabled:
			runtime?.parallelToolsEnabled ??
			frozen.freshnessBaseline?.parallelToolsEnabled ??
			context.enableParallelToolCalling === true,
		webToolsEnabled,
		webSearchLocalFallbackAvailable: localFallbackAvailable,
		webSearchRoutingPlan: Object.freeze({
			...currentPlan,
			mode,
			route,
			webFetchRoute,
			localToolEnabled: route === "local",
			localFallbackAvailable,
			serverTools: Object.freeze([...serverTools]),
			...(route === "unavailable" && currentPlan.unavailableReason
				? { unavailableReason: currentPlan.unavailableReason }
				: { unavailableReason: undefined }),
			...(webFetchRoute === "unavailable" && currentPlan.webFetchUnavailableReason
				? { webFetchUnavailableReason: currentPlan.webFetchUnavailableReason }
				: { webFetchUnavailableReason: undefined }),
		}),
		focusChainEnabled:
			runtime?.focusChainEnabled ?? builder?.focusChainEnabled ?? context.focusChainSettings?.enabled === true,
		subagentsEnabled:
			runtime?.subagentsEnabled ??
			builder?.subagentsEnabled ??
			(context.promptProfile === "standard" && context.subagentsEnabled === true),
		capabilityToggles: createTaskCapabilityToggles(
			runtime?.capabilityToggles ?? context.taskCapabilityToggles ?? emptyTaskCapabilityToggles(),
		),
		browserEnabled,
		browserViewport: browserEnabled ? resolveBrowserViewport(frozen, context) : { width: 0, height: 0 },
	}
}
