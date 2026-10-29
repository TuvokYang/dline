import { renderCapabilitiesSection } from "@core/prompts/capabilities/CapabilitiesSection"
import { PromptProfile } from "@core/prompts/profiles/types"
import type { SystemPromptContext } from "@core/prompts/system-prompt"
import type { TaskContextCache } from "@core/storage/task-context-types"
import { ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"
import { createTaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import type { ClineTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import { HOSTED_WEB_SEARCH_ROUTING_PLAN, LOCAL_WEB_SEARCH_ROUTING_PLAN } from "../../__tests__/web-search-routing-fixtures"
import { hashPromptContent } from "../hash"
import { buildPromptFreshnessBaseline } from "../PromptFreshnessProjection"
import { SYSTEM_PROMPT_CONTRACT_VERSION, SystemPromptCacheService } from "../SystemPromptCacheService"

const EMPTY_CAPABILITIES = {
    mcp: [],
    skills: [],
    workflows: [],
    subagents: [],
}

const EMPTY_CAPABILITIES_HASH = hashPromptContent(renderCapabilitiesSection(EMPTY_CAPABILITIES))

const testPromptBuilderInfo = {
    contractVersion: SYSTEM_PROMPT_CONTRACT_VERSION,
    providerId: "test-provider",
    modelId: "test-model",
    profile: "standard" as const,
    nativeTools: false,
    focusChainEnabled: false,
    subagentsEnabled: false,
    apiFormat: LOCAL_WEB_SEARCH_ROUTING_PLAN.serverToolPlan.apiFormat,
    serverTools: LOCAL_WEB_SEARCH_ROUTING_PLAN.serverTools,
    webToolsEnabled: true,
    webSearchRoute: LOCAL_WEB_SEARCH_ROUTING_PLAN.route,
    webToolsMode: LOCAL_WEB_SEARCH_ROUTING_PLAN.mode,
    webSearchLocalFallbackAvailable: LOCAL_WEB_SEARCH_ROUTING_PLAN.localFallbackAvailable,
}

const promptContext = {
    taskId: "task-1",
    promptProfile: PromptProfile.Standard,
    cwd: "e:/workspace/project",
    ide: "vscode",
    providerInfo: {
        providerId: "test-provider",
        model: {
            id: "test-model",
            info: {},
        },
    },
    enableNativeToolCalls: false,
    clineWebToolsEnabled: true,
    webSearchRoutingPlan: LOCAL_WEB_SEARCH_ROUTING_PLAN,
} as SystemPromptContext

/**
 * Create an empty task context fixture.
 *
 * @param taskId Task identifier for the fixture.
 * @returns Empty task context cache.
 */
function buildTool(name: string): ClineTool {
    return {
        type: "function",
        function: {
            name,
            description: `${name} description`,
            strict: false,
            parameters: { type: "object", properties: {}, required: [], additionalProperties: false },
        },
    }
}

function emptyContext(taskId: string): TaskContextCache {
    return {
        schemaVersion: 1,
        taskId,
        createdAt: 1,
        updatedAt: 1,
    }
}

describe("SystemPromptCacheService", () => {
    it("creates and persists a task_start frozen prompt with capabilities", async () => {
        let saved: TaskContextCache | undefined
        const service = new SystemPromptCacheService({
            taskId: "task-1",
            deps: {
                getContext: async () => emptyContext("task-1"),
                saveContext: async (_taskId, context) => {
                    saved = context
                },
                collectCapabilities: async () => ({
                    mcp: [{ name: "mcp.tool", description: "Tool" }],
                    skills: [],
                    workflows: [],
                    subagents: [],
                }),
                buildSystemPrompt: async (context) => ({ systemPrompt: `base\n\n${context.capabilitiesSection}` }),
                getPromptBuilderInfo: () => testPromptBuilderInfo,
                now: () => 10,
            },
        })

        const result = await service.getOrCreate({ promptContext })

        expect(result.text).toContain("# Capabilities")
        expect(result.text).toContain("mcp.tool")
        expect(result.refreshReason).toBe("task_start")
        expect(result.tools).toBeNull()
        expect(result.freshnessBaseline).toBeDefined()
        expect(result.runtime).toMatchObject({
            webToolsEnabled: true,
            webSearchRoute: "local",
            focusChainEnabled: false,
            subagentsEnabled: false,
            browserEnabled: false,
        })
        expect(result.runtime?.capabilityToggles).toEqual(expect.objectContaining({ mcpServers: {} }))
        expect(saved?.systemPrompt?.frozen?.text).toBe(result.text)
        expect(saved?.systemPrompt?.frozen?.tools).toBeNull()
        expect(service.getPromptFreshness()).toMatchObject({ status: "fresh", changes: [], frozenAt: 10 })
    })

    it("projects MCP enablement out of runtime when the global MCP gate is closed", async () => {
        const taskCapabilityToggles = createTaskCapabilityToggles({ mcpServers: { "frozen-server": true } })
        const build = async (taskId: string, mcpHub: SystemPromptContext["mcpHub"]) => {
            const service = new SystemPromptCacheService({
                taskId,
                deps: {
                    getContext: async () => emptyContext(taskId),
                    saveContext: async () => undefined,
                    collectCapabilities: async () => EMPTY_CAPABILITIES,
                    buildSystemPrompt: async () => ({ systemPrompt: "prompt" }),
                    getPromptBuilderInfo: () => testPromptBuilderInfo,
                    now: () => 10,
                },
            })
            return service.getOrCreate({
                promptContext: { ...promptContext, taskId, taskCapabilityToggles, mcpHub },
            })
        }

        const disabled = await build("task-mcp-disabled", undefined)
        const enabled = await build("task-mcp-enabled", { getServers: () => [] })

        expect(disabled.runtime?.capabilityToggles.mcpServers).toEqual({})
        expect(enabled.runtime?.capabilityToggles.mcpServers).toEqual({ "frozen-server": true })
        expect(taskCapabilityToggles.mcpServers).toEqual({ "frozen-server": true })
    })

    it("rebuilds provider-shaped tools when the active provider changes", async () => {
        const openAiTools: readonly ClineTool[] = [buildTool("read_file")]
        const anthropicTools: readonly ClineTool[] = [
            {
                name: "read_file",
                description: "read_file description",
                input_schema: { type: "object", properties: {}, required: [], additionalProperties: false },
            },
        ]
        let current: TaskContextCache = {
            ...emptyContext("task-1"),
            systemPrompt: {
                frozen: {
                    text: "openai native prompt",
                    tools: openAiTools,
                    capabilitiesHash: EMPTY_CAPABILITIES_HASH,
                    createdAt: 1,
                    refreshedAt: 1,
                    refreshReason: "task_start" as const,
                    promptBuilder: {
                        ...testPromptBuilderInfo,
                        providerId: "openai",
                        modelId: "gpt-5.6-sol",
                        nativeTools: true,
                    },
                },
            },
        }
        let buildCount = 0
        const service = new SystemPromptCacheService({
            taskId: "task-1",
            deps: {
                getContext: async () => current,
                saveContext: async (_taskId, context) => {
                    current = context
                },
                collectCapabilities: async () => EMPTY_CAPABILITIES,
                buildSystemPrompt: async () => {
                    buildCount += 1
                    return { systemPrompt: "anthropic native prompt", tools: anthropicTools }
                },
                now: () => 2,
            },
        })
        const anthropicContext: SystemPromptContext = {
            ...promptContext,
            providerInfo: {
                providerId: "anthropic",
                model: { id: "deepseek-v4-pro", info: { id: "deepseek-v4-pro" } },
                mode: "act",
            },
            enableNativeToolCalls: true,
        }

        const result = await service.getOrCreate({ promptContext: anthropicContext })

        expect(buildCount).toBe(1)
        expect(result.text).toBe("anthropic native prompt")
        expect(result.promptBuilder).toEqual({
            ...testPromptBuilderInfo,
            providerId: "anthropic",
            modelId: "deepseek-v4-pro",
            nativeTools: true,
        })
        expect(service.getLastTools()).toEqual(anthropicTools)
        expect(service.getLastTools()).not.toEqual(openAiTools)
    })

    it("restores exact persisted native tools without rescanning capabilities on later rounds", async () => {
        const tools: readonly ClineTool[] = [buildTool("read_file")]
        const collectCapabilities = vi.fn(async () => EMPTY_CAPABILITIES)
        const cached = {
            ...emptyContext("task-1"),
            systemPrompt: {
                frozen: {
                    text: "old prompt # Capabilities old",
                    tools,
                    capabilitiesHash: EMPTY_CAPABILITIES_HASH,
                    createdAt: 1,
                    refreshedAt: 1,
                    refreshReason: "task_start" as const,
                    promptBuilder: {
                        ...testPromptBuilderInfo,
                        nativeTools: true,
                    },
                },
            },
        }
        const service = new SystemPromptCacheService({
            taskId: "task-1",
            deps: {
                getContext: async () => cached,
                saveContext: async () => undefined,
                collectCapabilities,
                buildSystemPrompt: async () => {
                    throw new Error("frozen tools must not be rebuilt")
                },
            },
        })

        const input = { promptContext: { ...promptContext, enableNativeToolCalls: true } }
        const result = await service.getOrCreate(input)
        await service.getOrCreate(input)
        await service.getOrCreate(input)

        expect(result.text).toBe("old prompt # Capabilities old")
        expect(service.getLastTools()).toEqual(tools)
        expect(collectCapabilities).toHaveBeenCalledTimes(1)
    })

    it("rebuilds a frozen prompt written before prompt contract versioning", async () => {
        const { contractVersion: _legacyVersion, ...legacyBuilder } = testPromptBuilderInfo
        const cached: TaskContextCache = {
            ...emptyContext("task-1"),
            systemPrompt: {
                frozen: {
                    text: "legacy prompt",
                    tools: null,
                    capabilitiesHash: EMPTY_CAPABILITIES_HASH,
                    createdAt: 1,
                    refreshedAt: 1,
                    refreshReason: "task_start",
                    promptBuilder: legacyBuilder,
                },
            },
        }
        let buildCount = 0
        const service = new SystemPromptCacheService({
            taskId: "task-1",
            deps: {
                getContext: async () => cached,
                saveContext: async () => undefined,
                collectCapabilities: async () => EMPTY_CAPABILITIES,
                buildSystemPrompt: async () => {
                    buildCount += 1
                    return { systemPrompt: "current prompt" }
                },
            },
        })

        const result = await service.getOrCreate({ promptContext })

        expect(buildCount).toBe(1)
        expect(result.text).toBe("current prompt")
        expect(result.promptBuilder.contractVersion).toBe(SYSTEM_PROMPT_CONTRACT_VERSION)
    })

    it("rebuilds a frozen prompt from the previous prompt contract version", async () => {
        const cached: TaskContextCache = {
            ...emptyContext("task-1"),
            systemPrompt: {
                frozen: {
                    text: "version-4 prompt with stale capability guidance",
                    tools: null,
                    capabilitiesHash: EMPTY_CAPABILITIES_HASH,
                    createdAt: 1,
                    refreshedAt: 1,
                    refreshReason: "task_start",
                    promptBuilder: { ...testPromptBuilderInfo, contractVersion: SYSTEM_PROMPT_CONTRACT_VERSION - 1 },
                },
            },
        }
        let buildCount = 0
        const service = new SystemPromptCacheService({
            taskId: "task-1",
            deps: {
                getContext: async () => cached,
                saveContext: async () => undefined,
                collectCapabilities: async () => EMPTY_CAPABILITIES,
                buildSystemPrompt: async () => {
                    buildCount += 1
                    return { systemPrompt: "current contract prompt" }
                },
            },
        })

        const result = await service.getOrCreate({ promptContext })

        expect(buildCount).toBe(1)
        expect(result.text).toBe("current contract prompt")
        expect(result.refreshReason).toBe("capability_change")
        expect(result.promptBuilder.contractVersion).toBe(SYSTEM_PROMPT_CONTRACT_VERSION)
    })

    it("rebuilds the frozen pair when the prompt profile or native transport changes", async () => {
        const frozenTools: readonly ClineTool[] = [buildTool("frozen_browser_tool")]
        const cached = {
            ...emptyContext("task-1"),
            systemPrompt: {
                frozen: {
                    text: "frozen native prompt",
                    tools: frozenTools,
                    capabilitiesHash: EMPTY_CAPABILITIES_HASH,
                    createdAt: 1,
                    refreshedAt: 1,
                    refreshReason: "task_start" as const,
                    promptBuilder: {
                        ...testPromptBuilderInfo,
                        nativeTools: true,
                    },
                },
            },
        }
        let buildCount = 0
        const service = new SystemPromptCacheService({
            taskId: "task-1",
            deps: {
                getContext: async () => cached,
                saveContext: async () => undefined,
                collectCapabilities: async () => EMPTY_CAPABILITIES,
                buildSystemPrompt: async () => {
                    buildCount += 1
                    return { systemPrompt: "current xml prompt" }
                },
            },
        })
        const currentContext: SystemPromptContext = {
            ...promptContext,
            promptProfile: PromptProfile.Lite,
            enableNativeToolCalls: false,
            disableTools: [],
            supportsBrowserUse: false,
        }

        const result = await service.getOrCreate({ promptContext: currentContext })

        expect(result.text).toBe("current xml prompt")
        expect(service.getLastTools()).toBeUndefined()
        expect(buildCount).toBe(1)
    })

    it("keeps the frozen pair when the Standard subagents setting changes", async () => {
        const disabledContext: SystemPromptContext = { ...promptContext, enableNativeToolCalls: true, subagentsEnabled: false }
        const enabledContext: SystemPromptContext = { ...disabledContext, subagentsEnabled: true }
        const cached = {
            ...emptyContext("task-1"),
            systemPrompt: {
                frozen: {
                    text: "subagents-disabled prompt",
                    tools: [buildTool("spawn_task")],
                    capabilitiesHash: EMPTY_CAPABILITIES_HASH,
                    freshnessBaseline: buildPromptFreshnessBaseline(disabledContext, EMPTY_CAPABILITIES),
                    createdAt: 1,
                    refreshedAt: 1,
                    refreshReason: "task_start" as const,
                    promptBuilder: { ...testPromptBuilderInfo, nativeTools: true, subagentsEnabled: false },
                },
            },
        }
        let buildCount = 0
        const service = new SystemPromptCacheService({
            taskId: "task-1",
            deps: {
                getContext: async () => cached,
                saveContext: async () => undefined,
                collectCapabilities: async () => EMPTY_CAPABILITIES,
                buildSystemPrompt: async () => {
                    buildCount += 1
                    return { systemPrompt: "must not build" }
                },
            },
        })

        const result = await service.getOrCreate({ promptContext: enabledContext })

        expect(result.text).toBe("subagents-disabled prompt")
        expect(buildCount).toBe(0)
        expect(service.getPromptFreshness().changes).toEqual([{ kind: "subagents", summary: "Subagents changed" }])
    })

    it("keeps the frozen pair when focus-chain injection changes", async () => {
        const disabledContext: SystemPromptContext = {
            ...promptContext,
            focusChainSettings: { enabled: false, remindClineInterval: 6 },
        }
        const enabledContext: SystemPromptContext = {
            ...promptContext,
            focusChainSettings: { enabled: true, remindClineInterval: 6 },
        }
        const cached = {
            ...emptyContext("task-1"),
            systemPrompt: {
                frozen: {
                    text: "no-focus prompt",
                    tools: null,
                    capabilitiesHash: EMPTY_CAPABILITIES_HASH,
                    freshnessBaseline: buildPromptFreshnessBaseline(disabledContext, EMPTY_CAPABILITIES),
                    createdAt: 1,
                    refreshedAt: 1,
                    refreshReason: "task_start" as const,
                    promptBuilder: { ...testPromptBuilderInfo, focusChainEnabled: false },
                },
            },
        }
        let buildCount = 0
        const service = new SystemPromptCacheService({
            taskId: "task-1",
            deps: {
                getContext: async () => cached,
                saveContext: async () => undefined,
                collectCapabilities: async () => EMPTY_CAPABILITIES,
                buildSystemPrompt: async () => {
                    buildCount += 1
                    return { systemPrompt: "must not build" }
                },
            },
        })

        const result = await service.getOrCreate({ promptContext: enabledContext })

        expect(result.text).toBe("no-focus prompt")
        expect(buildCount).toBe(0)
        expect(service.getPromptFreshness().changes).toEqual([{ kind: "focus_chain", summary: "Focus Chain changed" }])
    })

    it("rebuilds the frozen pair when the request routing plan changes the active server-tool projection", async () => {
        const cached = {
            ...emptyContext("task-1"),
            systemPrompt: {
                frozen: {
                    text: "chat prompt without hosted tools",
                    tools: null,
                    capabilitiesHash: EMPTY_CAPABILITIES_HASH,
                    createdAt: 1,
                    refreshedAt: 1,
                    refreshReason: "task_start" as const,
                    promptBuilder: {
                        ...testPromptBuilderInfo,
                        apiFormat: ApiFormat.OPENAI_CHAT,
                        serverTools: [],
                    },
                },
            },
        }
        let buildCount = 0
        const service = new SystemPromptCacheService({
            taskId: "task-1",
            deps: {
                getContext: async () => cached,
                saveContext: async () => undefined,
                collectCapabilities: async () => EMPTY_CAPABILITIES,
                buildSystemPrompt: async () => {
                    buildCount += 1
                    return { systemPrompt: "responses prompt with hosted web search" }
                },
            },
        })
        const result = await service.getOrCreate({
            promptContext: {
                ...promptContext,
                webSearchRoutingPlan: HOSTED_WEB_SEARCH_ROUTING_PLAN,
            },
        })

        expect(result.text).toBe("responses prompt with hosted web search")
        expect(result.promptBuilder.apiFormat).toBe(ApiFormat.OPENAI_RESPONSES)
        expect(result.promptBuilder.serverTools).toEqual([ServerTool.WEB_SEARCH])
        expect(buildCount).toBe(1)
    })

    it.each([
        [
            "global Web Tools setting",
            {
                ...promptContext,
                clineWebToolsEnabled: false,
                webSearchRoutingPlan: { ...LOCAL_WEB_SEARCH_ROUTING_PLAN, route: "disabled" as const },
            },
        ],
        [
            "effective route",
            { ...promptContext, webSearchRoutingPlan: { ...LOCAL_WEB_SEARCH_ROUTING_PLAN, route: "disabled" as const } },
        ],
    ] as const)("keeps the frozen pair when the cached %s differs from the request projection", async (_label, frozenContext) => {
        const cached: TaskContextCache = {
            ...emptyContext("task-1"),
            systemPrompt: {
                frozen: {
                    text: "stale web projection",
                    tools: null,
                    capabilitiesHash: EMPTY_CAPABILITIES_HASH,
                    freshnessBaseline: buildPromptFreshnessBaseline(frozenContext as SystemPromptContext, EMPTY_CAPABILITIES),
                    createdAt: 1,
                    refreshedAt: 1,
                    refreshReason: "task_start",
                    promptBuilder: testPromptBuilderInfo,
                },
            },
        }
        let buildCount = 0
        const service = new SystemPromptCacheService({
            taskId: "task-1",
            deps: {
                getContext: async () => cached,
                saveContext: async () => undefined,
                collectCapabilities: async () => EMPTY_CAPABILITIES,
                buildSystemPrompt: async () => {
                    buildCount += 1
                    return { systemPrompt: "must not build" }
                },
            },
        })

        const result = await service.getOrCreate({ promptContext })

        expect(result.text).toBe("stale web projection")
        expect(buildCount).toBe(0)
        expect(service.getPromptFreshness().changes).toEqual([{ kind: "web_tools", summary: "Web tools changed" }])
    })

    it("does not derive a cache projection from changed model metadata", async () => {
        const cached: TaskContextCache = {
            ...emptyContext("task-1"),
            systemPrompt: {
                frozen: {
                    text: "request-plan prompt",
                    tools: null,
                    capabilitiesHash: EMPTY_CAPABILITIES_HASH,
                    createdAt: 1,
                    refreshedAt: 1,
                    refreshReason: "task_start",
                    promptBuilder: testPromptBuilderInfo,
                },
            },
        }
        const service = new SystemPromptCacheService({
            taskId: "task-1",
            deps: {
                getContext: async () => cached,
                saveContext: async () => undefined,
                collectCapabilities: async () => EMPTY_CAPABILITIES,
                buildSystemPrompt: async () => {
                    throw new Error("model metadata must not replace the request routing plan")
                },
            },
        })
        const metadataChangedContext: SystemPromptContext = {
            ...promptContext,
            providerInfo: {
                ...promptContext.providerInfo,
                model: {
                    ...promptContext.providerInfo.model,
                    info: {
                        id: promptContext.providerInfo.model.id,
                        apiFormats: [ApiFormat.OPENAI_RESPONSES],
                        capabilities: { tools: [ServerTool.WEB_SEARCH] },
                    },
                },
            },
        }

        const result = await service.getOrCreate({ promptContext: metadataChangedContext })

        expect(result.text).toBe("request-plan prompt")
    })

    it("persists the exact tools produced by the same frozen prompt build", async () => {
        let saved: TaskContextCache | undefined
        const builtTools: readonly ClineTool[] = [buildTool("frozen_exact_tool")]
        const service = new SystemPromptCacheService({
            taskId: "task-1",
            deps: {
                getContext: async () => emptyContext("task-1"),
                saveContext: async (_taskId, context) => {
                    saved = context
                },
                collectCapabilities: async () => ({ mcp: [], skills: [], workflows: [], subagents: [] }),
                buildSystemPrompt: async () => ({ systemPrompt: "frozen exact prompt", tools: builtTools }),
                getPromptBuilderInfo: () => ({ ...testPromptBuilderInfo, nativeTools: true }),
                now: () => 15,
            },
        })

        const result = await service.refresh({ promptContext, reason: "manual" })

        expect(result.tools).toEqual(builtTools)
        expect(saved?.systemPrompt?.frozen?.tools).toEqual(builtTools)
    })

    it("persists the prompt composition measured by the same build", async () => {
        let saved: TaskContextCache | undefined
        const composition = {
            totalBytes: 19,
            userRulesBytes: 4,
            skillsBytes: 3,
            workflowsBytes: 2,
            toolDefinitionsBytes: 0,
            mcpBytes: 1,
        }
        const service = new SystemPromptCacheService({
            taskId: "task-1",
            deps: {
                getContext: async () => emptyContext("task-1"),
                saveContext: async (_taskId, context) => {
                    saved = context
                },
                collectCapabilities: async () => ({ mcp: [], skills: [], workflows: [], subagents: [] }),
                buildSystemPrompt: async () => ({ systemPrompt: "frozen exact prompt", composition }),
                getPromptBuilderInfo: () => testPromptBuilderInfo,
                now: () => 15,
            },
        })

        const result = await service.refresh({ promptContext, reason: "manual" })

        expect(result.composition).toEqual(composition)
        expect(saved?.systemPrompt?.frozen?.composition).toEqual(composition)
    })

    it("rebuilds and saves one complete same-build pair after storage rejects an invalid cache", async () => {
        let saved: TaskContextCache | undefined
        const rebuiltTools: readonly ClineTool[] = [buildTool("rebuilt_exact_tool")]
        const service = new SystemPromptCacheService({
            taskId: "task-1",
            deps: {
                getContext: async () => emptyContext("task-1"),
                saveContext: async (_taskId, context) => {
                    saved = context
                },
                collectCapabilities: async () => ({ mcp: [], skills: [], workflows: [], subagents: [] }),
                buildSystemPrompt: async () => ({
                    systemPrompt: "rebuilt exact prompt",
                    tools: rebuiltTools,
                }),
                getPromptBuilderInfo: () => ({ ...testPromptBuilderInfo, nativeTools: true }),
                now: () => 16,
            },
        })

        const result = await service.getOrCreate({ promptContext })

        expect(result).toEqual(saved?.systemPrompt?.frozen)
        expect(result.text).toBe("rebuilt exact prompt")
        expect(result.tools).toEqual(rebuiltTools)
        expect(service.getLastTools()).toEqual(rebuiltTools)
    })

    it("keeps the frozen prompt until an explicit refresh and reports Rules changes as stale", async () => {
        const frozenContext: SystemPromptContext = { ...promptContext, localClineRulesFileInstructions: "RULES_V1" }
        const currentContext: SystemPromptContext = { ...promptContext, localClineRulesFileInstructions: "RULES_V2" }
        const cached: TaskContextCache = {
            ...emptyContext("task-1"),
            systemPrompt: {
                frozen: {
                    text: "frozen prompt RULES_V1",
                    tools: null,
                    capabilitiesHash: EMPTY_CAPABILITIES_HASH,
                    freshnessBaseline: buildPromptFreshnessBaseline(frozenContext, EMPTY_CAPABILITIES),
                    createdAt: 1,
                    refreshedAt: 1,
                    refreshReason: "task_start",
                    promptBuilder: testPromptBuilderInfo,
                },
            },
        }
        let saved: TaskContextCache | undefined
        const service = new SystemPromptCacheService({
            taskId: "task-1",
            deps: {
                getContext: async () => saved ?? cached,
                saveContext: async (_taskId, context) => {
                    saved = context
                },
                collectCapabilities: async () => EMPTY_CAPABILITIES,
                buildSystemPrompt: async (context) => ({ systemPrompt: `refreshed ${context.localClineRulesFileInstructions}` }),
                getPromptBuilderInfo: () => testPromptBuilderInfo,
                now: () => 20,
            },
        })

        const frozen = await service.getOrCreate({ promptContext: currentContext })

        expect(frozen.text).toBe("frozen prompt RULES_V1")
        expect(saved).toBeUndefined()
        expect(service.getPromptFreshness()).toMatchObject({
            status: "stale",
            changes: [{ kind: "rules", summary: "Rules changed" }],
        })

        const refreshed = await service.refresh({ promptContext: currentContext, reason: "manual" })
        expect(refreshed.text).toBe("refreshed RULES_V2")
        expect(service.getPromptFreshness().status).toBe("fresh")
    })

    it("serializes a delayed freshness evaluation behind a newer manual refresh", async () => {
        const oldContext: SystemPromptContext = { ...promptContext, localClineRulesFileInstructions: "RULES_V1" }
        const newContext: SystemPromptContext = { ...promptContext, localClineRulesFileInstructions: "RULES_V2" }
        let context: TaskContextCache = {
            ...emptyContext("task-1"),
            systemPrompt: {
                frozen: {
                    text: "frozen RULES_V1",
                    tools: null,
                    capabilitiesHash: EMPTY_CAPABILITIES_HASH,
                    freshnessBaseline: buildPromptFreshnessBaseline(oldContext, EMPTY_CAPABILITIES),
                    createdAt: 1,
                    refreshedAt: 1,
                    refreshReason: "task_start",
                    promptBuilder: testPromptBuilderInfo,
                },
            },
        }
        let releaseCollection: (() => void) | undefined
        let collectCount = 0
        let buildCount = 0
        const blocked = new Promise<void>((resolve) => {
            releaseCollection = resolve
        })
        const service = new SystemPromptCacheService({
            taskId: "task-1",
            deps: {
                getContext: async () => context,
                saveContext: async (_taskId, next) => {
                    context = next
                },
                collectCapabilities: async () => {
                    collectCount += 1
                    if (collectCount === 1) await blocked
                    return EMPTY_CAPABILITIES
                },
                buildSystemPrompt: async (current) => {
                    buildCount += 1
                    return { systemPrompt: `refreshed ${current.localClineRulesFileInstructions}` }
                },
                getPromptBuilderInfo: () => testPromptBuilderInfo,
                now: () => 30,
            },
        })

        const reevaluation = service.reevaluateFreshness({ promptContext: newContext })
        await Promise.resolve()
        const refresh = service.refresh({ promptContext: newContext, reason: "manual" })
        await Promise.resolve()
        expect(buildCount).toBe(0)
        releaseCollection?.()
        await Promise.all([reevaluation, refresh])

        expect(context.systemPrompt?.frozen?.text).toBe("refreshed RULES_V2")
        expect(service.getPromptFreshness().status).toBe("fresh")
    })

    it("keeps the frozen prompt until an explicit refresh and reports visible capability changes as stale", async () => {
        const enabledContext: SystemPromptContext = { ...promptContext, subagentsEnabled: true }
        const cached = {
            ...emptyContext("task-1"),
            systemPrompt: {
                frozen: {
                    text: "old prompt # Capabilities old",
                    tools: null,
                    capabilitiesHash: "sha256:old",
                    freshnessBaseline: buildPromptFreshnessBaseline(enabledContext, EMPTY_CAPABILITIES),
                    createdAt: 1,
                    refreshedAt: 1,
                    refreshReason: "task_start" as const,
                    promptBuilder: {
                        ...testPromptBuilderInfo,
                    },
                },
            },
        }
        let saveCount = 0
        const service = new SystemPromptCacheService({
            taskId: "task-1",
            deps: {
                getContext: async () => cached,
                saveContext: async () => {
                    saveCount += 1
                },
                collectCapabilities: async () => ({
                    mcp: [],
                    skills: [],
                    workflows: [],
                    subagents: [{ name: "reviewer", description: "Review code" }],
                }),
                buildSystemPrompt: async (context) => ({ systemPrompt: `new ${context.capabilitiesSection}` }),
                getPromptBuilderInfo: () => testPromptBuilderInfo,
            },
        })

        const result = await service.getOrCreate({ promptContext: enabledContext })

        expect(result.text).toBe("old prompt # Capabilities old")
        expect(result.refreshReason).toBe("task_start")
        expect(saveCount).toBe(0)
        expect(service.getPromptFreshness()).toMatchObject({
            status: "stale",
            changes: [{ kind: "subagents", summary: "Subagents changed" }],
            frozenAt: 1,
        })
    })

    it("re-evaluates a Settings change without rebuilding or persisting the frozen pair", async () => {
        const disabledContext: SystemPromptContext = { ...promptContext, subagentsEnabled: false }
        const cached: TaskContextCache = {
            ...emptyContext("task-1"),
            systemPrompt: {
                frozen: {
                    text: "subagents-disabled prompt",
                    tools: null,
                    capabilitiesHash: EMPTY_CAPABILITIES_HASH,
                    freshnessBaseline: buildPromptFreshnessBaseline(disabledContext, EMPTY_CAPABILITIES),
                    createdAt: 1,
                    refreshedAt: 1,
                    refreshReason: "task_start",
                    promptBuilder: testPromptBuilderInfo,
                },
            },
        }
        let saveCount = 0
        let buildCount = 0
        const service = new SystemPromptCacheService({
            taskId: "task-1",
            deps: {
                getContext: async () => cached,
                saveContext: async () => {
                    saveCount += 1
                },
                collectCapabilities: async () => EMPTY_CAPABILITIES,
                buildSystemPrompt: async () => {
                    buildCount += 1
                    return { systemPrompt: "must not build" }
                },
                now: () => 40,
            },
        })

        const snapshot = await service.reevaluateFreshness({
            promptContext: { ...promptContext, subagentsEnabled: true },
        })

        expect(snapshot).toEqual({
            status: "stale",
            changes: [{ kind: "subagents", summary: "Subagents changed" }],
            checkedAt: 40,
            frozenAt: 1,
        })
        expect(service.getPromptFreshness()).toEqual(snapshot)
        expect(buildCount).toBe(0)
        expect(saveCount).toBe(0)
    })

    it("shares one in-flight rebuild and save across concurrent getOrCreate calls", async () => {
        let buildCount = 0
        let saveCount = 0
        const builtTools: readonly ClineTool[] = [buildTool("single_flight_tool")]
        const service = new SystemPromptCacheService({
            taskId: "task-1",
            deps: {
                getContext: async () => emptyContext("task-1"),
                saveContext: async () => {
                    saveCount += 1
                },
                collectCapabilities: async () => ({ mcp: [], skills: [], workflows: [], subagents: [] }),
                buildSystemPrompt: async () => {
                    buildCount += 1
                    await Promise.resolve()
                    return { systemPrompt: "single-flight prompt", tools: builtTools }
                },
                getPromptBuilderInfo: () => ({ ...testPromptBuilderInfo, nativeTools: true }),
                now: () => 17,
            },
        })

        const [first, second, third] = await Promise.all([
            service.getOrCreate({ promptContext }),
            service.getOrCreate({ promptContext }),
            service.getOrCreate({ promptContext }),
        ])

        expect(first).toBe(second)
        expect(second).toBe(third)
        expect(buildCount).toBe(1)
        expect(saveCount).toBe(1)
    })

    it("rejects a build failure without saving or exposing tools", async () => {
        let saveCount = 0
        const service = new SystemPromptCacheService({
            taskId: "task-1",
            deps: {
                getContext: async () => emptyContext("task-1"),
                saveContext: async () => {
                    saveCount += 1
                },
                collectCapabilities: async () => ({ mcp: [], skills: [], workflows: [], subagents: [] }),
                buildSystemPrompt: async () => {
                    throw new Error("prompt build failed")
                },
            },
        })

        await expect(service.getOrCreate({ promptContext })).rejects.toThrow("prompt build failed")
        expect(saveCount).toBe(0)
        expect(service.getLastTools()).toBeUndefined()
    })

    it("rejects a save failure without exposing the unpersisted tools", async () => {
        const builtTools: readonly ClineTool[] = [buildTool("unpersisted_tool")]
        const service = new SystemPromptCacheService({
            taskId: "task-1",
            deps: {
                getContext: async () => emptyContext("task-1"),
                saveContext: async () => {
                    throw new Error("prompt save failed")
                },
                collectCapabilities: async () => ({ mcp: [], skills: [], workflows: [], subagents: [] }),
                buildSystemPrompt: async () => ({ systemPrompt: "unpersisted prompt", tools: builtTools }),
                getPromptBuilderInfo: () => ({ ...testPromptBuilderInfo, nativeTools: true }),
            },
        })

        await expect(service.getOrCreate({ promptContext })).rejects.toThrow("prompt save failed")
        expect(service.getLastTools()).toBeUndefined()
    })

    it("updates cache on manual refresh", async () => {
        let current = emptyContext("task-1")
        const service = new SystemPromptCacheService({
            taskId: "task-1",
            deps: {
                getContext: async () => current,
                saveContext: async (_taskId, context) => {
                    current = context
                },
                collectCapabilities: async () => ({
                    mcp: [],
                    skills: [{ name: "manual", description: "Manual" }],
                    workflows: [],
                    subagents: [],
                }),
                buildSystemPrompt: async (context) => ({ systemPrompt: `prompt ${context.capabilitiesSection}` }),
                getPromptBuilderInfo: () => testPromptBuilderInfo,
                now: () => 20,
            },
        })

        const result = await service.refresh({ promptContext, reason: "manual" })

        expect(result.refreshReason).toBe("manual")
        expect(result.text).toContain("manual")
        expect(current.systemPrompt?.frozen?.refreshReason).toBe("manual")
    })

    it.each([
        PromptProfile.Standard,
        PromptProfile.Lite,
    ])("projects typed %s input to cache profile metadata", async (promptProfile) => {
        const service = new SystemPromptCacheService({
            taskId: "task-1",
            deps: {
                getContext: async () => emptyContext("task-1"),
                saveContext: async () => undefined,
                collectCapabilities: async () => ({
                    mcp: [],
                    skills: [],
                    workflows: [],
                    subagents: [],
                }),
                buildSystemPrompt: async () => ({ systemPrompt: "profile prompt" }),
                now: () => 25,
            },
        })
        const context: SystemPromptContext = {
            ...promptContext,
            promptProfile,
        }

        const result = await service.refresh({ promptContext: context, reason: "manual" })

        expect(result.promptBuilder.profile).toBe(promptProfile)
    })

    it("updates cache on post compaction refresh", async () => {
        let current = emptyContext("task-1")
        const service = new SystemPromptCacheService({
            taskId: "task-1",
            deps: {
                getContext: async () => current,
                saveContext: async (_taskId, context) => {
                    current = context
                },
                collectCapabilities: async () => ({
                    mcp: [],
                    skills: [],
                    workflows: [],
                    subagents: [{ name: "compact", description: "Compact" }],
                }),
                buildSystemPrompt: async (context) => ({ systemPrompt: `prompt ${context.capabilitiesSection}` }),
                getPromptBuilderInfo: () => testPromptBuilderInfo,
                now: () => 30,
            },
        })

        const result = await service.refresh({
            promptContext: { ...promptContext, subagentsEnabled: true },
            reason: "post_compaction",
        })

        expect(result.refreshReason).toBe("post_compaction")
        expect(result.text).toContain("compact")
        expect(current.systemPrompt?.frozen?.refreshReason).toBe("post_compaction")
    })
})
