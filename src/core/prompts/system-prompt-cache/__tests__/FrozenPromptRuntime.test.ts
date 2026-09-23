import { PromptProfile } from "@core/prompts/profiles/types"
import type { SystemPromptContext } from "@core/prompts/system-prompt"
import type { FrozenSystemPromptCache } from "@core/storage/task-context-types"
import type { PromptFreshnessBaseline } from "@shared/PromptFreshness"
import { ServerTool } from "@shared/proto/dline/models/metadata"
import { WebToolsMode } from "@shared/proto/dline/provider/common"
import { createTaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import { describe, expect, it } from "vitest"
import { HOSTED_WEB_SEARCH_ROUTING_PLAN, LOCAL_WEB_SEARCH_ROUTING_PLAN } from "../../__tests__/web-search-routing-fixtures"
import { resolveFrozenPromptRuntime } from "../FrozenPromptRuntime"

function buildContext(overrides: Partial<SystemPromptContext> = {}): SystemPromptContext {
	return {
		promptProfile: PromptProfile.Standard,
		providerInfo: {
			providerId: "test-provider",
			model: { id: "test-model", info: { id: "test-model" } },
			mode: "act",
		},
		ide: "vscode",
		clineWebToolsEnabled: false,
		webSearchRoutingPlan: LOCAL_WEB_SEARCH_ROUTING_PLAN,
		focusChainSettings: { enabled: false, remindClineInterval: 6 },
		subagentsEnabled: false,
		taskCapabilityToggles: createTaskCapabilityToggles({ mcpServers: { live: false } }),
		supportsBrowserUse: false,
		browserSettings: { viewport: { width: 320, height: 200 }, disableToolUse: true },
		...overrides,
	}
}

function buildFrozen(overrides: Partial<FrozenSystemPromptCache> = {}): FrozenSystemPromptCache {
	return {
		text: "frozen prompt",
		tools: null,
		capabilitiesHash: "sha256:test",
		createdAt: 1,
		refreshedAt: 1,
		refreshReason: "task_start",
		promptBuilder: {
			contractVersion: 3,
			providerId: "test-provider",
			modelId: "test-model",
			profile: "standard",
			nativeTools: false,
		},
		...overrides,
	}
}

function buildBaseline(overrides: Partial<PromptFreshnessBaseline> = {}): PromptFreshnessBaseline {
	return {
		schemaVersion: 4,
		providerId: "test-provider",
		modelId: "test-model",
		promptProfile: "standard",
		transport: "xml",
		parallelToolsEnabled: false,
		imageGenerationAvailable: false,
		imageModelId: "",
		browserEnabled: false,
		browserViewport: "disabled",
		webToolsEnabled: true,
		webSearchRoute: "hosted",
		webFetchRoute: "unavailable",
		focusChainEnabled: false,
		rulesHash: "sha256:rules",
		subagentsEnabled: false,
		capabilityHashes: {
			mcp: "sha256:mcp",
			skills: "sha256:skills",
			workflows: "sha256:workflows",
			subagents: "sha256:subagents",
		},
		...overrides,
	}
}

/** A Hosted-only runtime whose model hosted Web Search but not Web Fetch. */
const HOSTED_ONLY_SEARCH_RUNTIME = {
	webToolsEnabled: true,
	webToolsMode: WebToolsMode.WEB_TOOLS_MODE_FORCE_REMOTE,
	webSearchRoute: "hosted",
	webSearchLocalFallbackAvailable: false,
	serverTools: [ServerTool.WEB_SEARCH],
	focusChainEnabled: false,
	subagentsEnabled: false,
	capabilityToggles: createTaskCapabilityToggles({}),
	browserEnabled: false,
	browserViewport: { width: 0, height: 0 },
} as const

describe("resolveFrozenPromptRuntime", () => {
	it("uses the complete persisted runtime instead of changed live settings", () => {
		const frozenToggles = createTaskCapabilityToggles({
			localSkillsToggles: { "skill.md": true },
			mcpServers: { frozen: true },
		})
		const runtime = resolveFrozenPromptRuntime(
			buildFrozen({
				runtime: {
					parallelToolsEnabled: true,
					webToolsEnabled: true,
					webToolsMode: HOSTED_WEB_SEARCH_ROUTING_PLAN.mode,
					webSearchRoute: "hosted",
					webSearchLocalFallbackAvailable: true,
					serverTools: [ServerTool.WEB_SEARCH],
					focusChainEnabled: true,
					subagentsEnabled: true,
					capabilityToggles: frozenToggles,
					browserEnabled: true,
					browserViewport: { width: 1280, height: 800 },
				},
			}),
			buildContext(),
		)

		expect(runtime).toMatchObject({
			parallelToolsEnabled: true,
			webToolsEnabled: true,
			webSearchLocalFallbackAvailable: true,
			focusChainEnabled: true,
			subagentsEnabled: true,
			browserEnabled: true,
			browserViewport: { width: 1280, height: 800 },
		})
		expect(runtime.webSearchRoutingPlan).toMatchObject({
			mode: HOSTED_WEB_SEARCH_ROUTING_PLAN.mode,
			route: "hosted",
			localToolEnabled: false,
			localFallbackAvailable: true,
			serverTools: [ServerTool.WEB_SEARCH],
		})
		expect(runtime.capabilityToggles).toEqual(frozenToggles)
	})

	it("recovers older caches from frozen builder metadata and freshness baseline", () => {
		const legacyToggles = createTaskCapabilityToggles({ mcpServers: { legacy: true } })
		const runtime = resolveFrozenPromptRuntime(
			buildFrozen({
				promptBuilder: {
					contractVersion: 3,
					providerId: "test-provider",
					modelId: "test-model",
					profile: "standard",
					nativeTools: false,
					webToolsEnabled: true,
					webToolsMode: HOSTED_WEB_SEARCH_ROUTING_PLAN.mode,
					webSearchRoute: "hosted",
					webSearchLocalFallbackAvailable: true,
					serverTools: [ServerTool.WEB_SEARCH],
					focusChainEnabled: true,
					subagentsEnabled: true,
				},
				freshnessBaseline: {
					schemaVersion: 4,
					providerId: "test-provider",
					modelId: "test-model",
					promptProfile: "standard",
					transport: "xml",
					parallelToolsEnabled: false,
					imageGenerationAvailable: false,
					imageModelId: "",
					browserEnabled: true,
					browserViewport: "900x600",
					webToolsEnabled: true,
					webSearchRoute: "hosted",
					webFetchRoute: "local",
					focusChainEnabled: true,
					rulesHash: "sha256:rules",
					subagentsEnabled: true,
					capabilityHashes: {
						mcp: "sha256:mcp",
						skills: "sha256:skills",
						workflows: "sha256:workflows",
						subagents: "sha256:subagents",
					},
				},
			}),
			buildContext({ taskCapabilityToggles: legacyToggles }),
		)

		expect(runtime.parallelToolsEnabled).toBe(false)
		expect(runtime.webSearchRoutingPlan).toMatchObject({ route: "hosted", serverTools: [ServerTool.WEB_SEARCH] })
		expect(runtime.focusChainEnabled).toBe(true)
		expect(runtime.subagentsEnabled).toBe(true)
		expect(runtime.capabilityToggles).toEqual(legacyToggles)
		expect(runtime.browserEnabled).toBe(true)
		expect(runtime.browserViewport).toEqual({ width: 900, height: 600 })
	})

	it("keeps Web Fetch local for a snapshot frozen before hosted fetch existed", () => {
		// The frozen prompt carries the local web_fetch tool; a model that now declares
		// hosted fetch must not strip it from a task whose snapshot never saw hosted fetch.
		const runtime = resolveFrozenPromptRuntime(
			buildFrozen({
				runtime: {
					webToolsEnabled: true,
					webToolsMode: HOSTED_WEB_SEARCH_ROUTING_PLAN.mode,
					webSearchRoute: "hosted",
					webSearchLocalFallbackAvailable: true,
					serverTools: [ServerTool.WEB_SEARCH],
					focusChainEnabled: false,
					subagentsEnabled: false,
					capabilityToggles: createTaskCapabilityToggles({}),
					browserEnabled: false,
					browserViewport: { width: 0, height: 0 },
				},
			}),
			buildContext({ clineWebToolsEnabled: true }),
		)

		expect(runtime.webSearchRoutingPlan).toMatchObject({
			route: "hosted",
			webFetchRoute: "local",
			serverTools: [ServerTool.WEB_SEARCH],
		})
	})

	it("keeps the local Web Fetch of a Hosted-only snapshot frozen before fetch had its own route", () => {
		// The legacy prompt exposed local web_fetch in every enabled mode. Re-deriving
		// the route from Hosted-only would refuse a tool that prompt still offers.
		const runtime = resolveFrozenPromptRuntime(
			buildFrozen({
				runtime: { ...HOSTED_ONLY_SEARCH_RUNTIME, serverTools: [...HOSTED_ONLY_SEARCH_RUNTIME.serverTools] },
				freshnessBaseline: {
					...buildBaseline(),
					schemaVersion: 3,
					webFetchRoute: undefined,
				} as unknown as PromptFreshnessBaseline,
			}),
			buildContext({ clineWebToolsEnabled: true }),
		)

		expect(runtime.webSearchRoutingPlan).toMatchObject({
			route: "hosted",
			webFetchRoute: "local",
			serverTools: [ServerTool.WEB_SEARCH],
		})
	})

	it("keeps Web Fetch unavailable for a current Hosted-only snapshot without hosted fetch", () => {
		const runtime = resolveFrozenPromptRuntime(
			buildFrozen({
				runtime: { ...HOSTED_ONLY_SEARCH_RUNTIME, serverTools: [...HOSTED_ONLY_SEARCH_RUNTIME.serverTools] },
				freshnessBaseline: buildBaseline({ webFetchRoute: "unavailable" }),
			}),
			buildContext({ clineWebToolsEnabled: true }),
		)

		expect(runtime.webSearchRoutingPlan).toMatchObject({
			route: "hosted",
			webFetchRoute: "unavailable",
			serverTools: [ServerTool.WEB_SEARCH],
		})
	})

	it("recovers a hosted Web Fetch route from the frozen hosted tools", () => {
		const runtime = resolveFrozenPromptRuntime(
			buildFrozen({
				runtime: {
					webToolsEnabled: true,
					webToolsMode: HOSTED_WEB_SEARCH_ROUTING_PLAN.mode,
					webSearchRoute: "hosted",
					webSearchLocalFallbackAvailable: true,
					serverTools: [ServerTool.WEB_SEARCH, ServerTool.WEB_FETCH],
					focusChainEnabled: false,
					subagentsEnabled: false,
					capabilityToggles: createTaskCapabilityToggles({}),
					browserEnabled: false,
					browserViewport: { width: 0, height: 0 },
				},
			}),
			buildContext({ clineWebToolsEnabled: true }),
		)

		expect(runtime.webSearchRoutingPlan).toMatchObject({
			route: "hosted",
			webFetchRoute: "hosted",
			serverTools: [ServerTool.WEB_SEARCH, ServerTool.WEB_FETCH],
		})
	})

	it("keeps a hosted Web Fetch whose search route fell back to local", () => {
		const runtime = resolveFrozenPromptRuntime(
			buildFrozen({
				runtime: {
					webToolsEnabled: true,
					webToolsMode: HOSTED_WEB_SEARCH_ROUTING_PLAN.mode,
					webSearchRoute: "local",
					webSearchLocalFallbackAvailable: false,
					serverTools: [ServerTool.WEB_FETCH],
					focusChainEnabled: false,
					subagentsEnabled: false,
					capabilityToggles: createTaskCapabilityToggles({}),
					browserEnabled: false,
					browserViewport: { width: 0, height: 0 },
				},
			}),
			buildContext({ clineWebToolsEnabled: true }),
		)

		expect(runtime.webSearchRoutingPlan).toMatchObject({
			route: "local",
			webFetchRoute: "hosted",
			serverTools: [ServerTool.WEB_FETCH],
		})
	})

	it("disables both web tools when the frozen snapshot turned Web Tools off", () => {
		const runtime = resolveFrozenPromptRuntime(
			buildFrozen({
				runtime: {
					webToolsEnabled: false,
					webToolsMode: HOSTED_WEB_SEARCH_ROUTING_PLAN.mode,
					webSearchRoute: "hosted",
					webSearchLocalFallbackAvailable: true,
					serverTools: [ServerTool.WEB_SEARCH, ServerTool.WEB_FETCH],
					focusChainEnabled: false,
					subagentsEnabled: false,
					capabilityToggles: createTaskCapabilityToggles({}),
					browserEnabled: false,
					browserViewport: { width: 0, height: 0 },
				},
			}),
			buildContext({ clineWebToolsEnabled: true }),
		)

		expect(runtime.webSearchRoutingPlan).toMatchObject({ route: "disabled", webFetchRoute: "disabled", serverTools: [] })
	})
})
