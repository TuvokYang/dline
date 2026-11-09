import { strict as assert } from "node:assert"
import * as coreApi from "@core/api"
import { PromptProfile } from "@core/prompts/profiles/types"
import * as systemPromptFacade from "@core/prompts/system-prompt"
import type { SystemPromptContext } from "@core/prompts/system-prompt/context"
import type { TaskConfig } from "@core/task/tools/types/TaskConfig"
import type { GlobalInstructionsFile } from "@shared/remote-config/schema"
import { afterEach, beforeEach, vi } from "vitest"
import { HostProvider } from "@/hosts/host-provider"
import { ApiFormat, ServerTool } from "@/shared/proto/dline/models/metadata"
import { createTaskCapabilityToggles } from "@/shared/TaskCapabilityToggles"
import { DlineDefaultTool } from "@/shared/tools"
import { ListFilesToolHandler } from "../../handlers/ListFilesToolHandler"
import { DefaultToolHandlerState } from "../../state/ToolHandlerState"

/** A subagent semantic request is labelled by its role and a per-request unique identity. */
export const SUBAGENT_REQUEST_ID = /^subagent:[0-9a-f-]{36}$/u

export function initializeHostProvider() {
    HostProvider.reset()
    HostProvider.initialize(
        () => ({}) as never,
        () => ({}) as never,
        () => ({}) as never,
        () => ({}) as never,
        {
            workspaceClient: {},
            envClient: { getHostVersion: async () => ({ platform: "test" }) },
            windowClient: {},
            diffClient: {},
        } as never,
        () => undefined,
        async () => "",
        async () => "",
        "",
        "",
    )
}

export type TestContentBlock = {
    type: string
    text?: string
    function_id?: string
    dline_tid?: string
    [key: string]: unknown
}

export type TestConversationMessage = { role: string; content: TestContentBlock[] }

export type TaskConfigOptions = {
    clineWebToolsEnabled?: boolean
    globalSkillsToggles?: Record<string, boolean>
    useAutoCondense?: boolean
    autoCondenseTriggerPercent?: number
    autoCondenseMinReserveTokens?: number
    autoCondenseMaxReserveTokens?: number
    autoCondenseMaxContextTokens?: number
    webToolsEnabled?: boolean
    contextWindow?: number
    remoteSkillsToggles?: Record<string, boolean>
    localSkillsToggles?: Record<string, boolean>
    remoteGlobalSkills?: GlobalInstructionsFile[]
    taskGlobalSkillsToggles?: Record<string, boolean>
    taskLocalSkillsToggles?: Record<string, boolean>
    taskRemoteSkillsToggles?: Record<string, boolean>
}

export function createTaskConfig(nativeToolCallEnabled: boolean, options: TaskConfigOptions = {}): TaskConfig {
    const globalSettings: Record<string, unknown> = {
        mode: "act",
        clineWebToolsEnabled: options.clineWebToolsEnabled,
        globalSkillsToggles: options.globalSkillsToggles,
        useAutoCondense: options.useAutoCondense,
        autoCondenseTriggerPercent: options.autoCondenseTriggerPercent,
        autoCondenseMinReserveTokens: options.autoCondenseMinReserveTokens,
        autoCondenseMaxReserveTokens: options.autoCondenseMaxReserveTokens,
        autoCondenseMaxContextTokens: options.autoCondenseMaxContextTokens,
    }
    const apiConfiguration = {
        actModeProfile: "anthropic",
        planModeProfile: "anthropic",
    }
    return {
        taskId: "task-1",
        ulid: "ulid-1",
        cwd: "/tmp",
        mode: "act",
        strictPlanModeEnabled: false,
        yoloModeToggled: false,
        doubleCheckCompletionEnabled: false,
        vscodeTerminalExecutionMode: "backgroundExec",
        enableParallelToolCalling: false,
        isSubagentExecution: false,
        webToolsEnabled: options.webToolsEnabled,
        context: {},
        taskState: new DefaultToolHandlerState(),
        messageState: {},
        api: {
            getModel: () => ({
                id: "anthropic/claude-sonnet-4.5",
                info: {
                    contextWindow: options.contextWindow ?? 200_000,
                    apiFormats: [ApiFormat.ANTHROPIC_CHAT],
                    supportsPromptCache: true,
                    capabilities: {
                        contextWindow: options.contextWindow ?? 200_000,
                        supportsImages: false,
                        supportsPromptCache: true,
                    },
                },
            }),
            createMessage: vi.fn().mockImplementation(async function* () {}),
        },
        // No MCP server is owned by these broad Runner regression fixtures. Capability
        // execution/owner tests supply real servers in their dedicated suite.
        getMcpServersForOwner: () => [],
        services: {
            mcpHub: {
                getServers: () => [],
                getServersForOwner: () => [],
                getAllServersForOwner: () => [],
            },
            stateManager: {
                getGlobalSettingsKey: (key: string) => globalSettings[key],
                getGlobalStateKey: (key: string) =>
                    key === "nativeToolCallEnabled"
                        ? nativeToolCallEnabled
                        : key === "remoteSkillsToggles"
                          ? options.remoteSkillsToggles
                          : undefined,
                getWorkspaceStateKey: (key: string) => (key === "localSkillsToggles" ? options.localSkillsToggles : undefined),
                getRemoteConfigSettings: () => ({
                    remoteGlobalSkills: options.remoteGlobalSkills ?? [],
                }),
                getApiConfiguration: () => apiConfiguration,
                getApiConfigurationForTask: (taskId?: string) => {
                    assert.equal(taskId, "task-1")
                    return apiConfiguration
                },
            },
            imageGenerationService: {
                hasAvailableProfile: vi.fn(() => false),
                withProfileResolver: vi.fn(() => ({ hasAvailableProfile: vi.fn(() => false) })),
            },
        },
        browserSettings: {},
        focusChainSettings: {},
        capabilityToggles: createTaskCapabilityToggles({
            globalSkillsToggles: options.taskGlobalSkillsToggles ?? options.globalSkillsToggles,
            localSkillsToggles: options.taskLocalSkillsToggles ?? options.localSkillsToggles,
            remoteSkillsToggles: options.taskRemoteSkillsToggles ?? options.remoteSkillsToggles,
        }),
        autoApprovalSettings: {
            enableNotifications: false,
            actions: { executeSafeCommands: false, executeAllCommands: false },
        },
        autoApprover: {
            shouldAutoApproveTool: vi.fn().mockReturnValue([false, false]),
        },
        callbacks: {
            say: vi.fn().mockResolvedValue(undefined),
            ask: vi.fn().mockResolvedValue({ response: "yesButtonClicked" }),
            saveCheckpoint: vi.fn().mockResolvedValue(undefined),
            sayAndCreateMissingParamError: vi.fn().mockResolvedValue("missing"),
            removeLastPartialMessageIfExistsWithType: vi.fn().mockResolvedValue(undefined),
            executeCommandTool: vi
                .fn()
                .mockResolvedValue({ userRejected: false, result: "ok", completed: true, exitCode: 0, signal: null }),
            cancelRunningCommandTool: vi.fn().mockResolvedValue(false),
            doesLatestTaskCompletionHaveNewChanges: vi.fn().mockResolvedValue(false),
            updateFCListFromToolResponse: vi.fn().mockResolvedValue(undefined),
            shouldAutoApproveTool: vi.fn().mockReturnValue([true, true]),
            shouldAutoApproveToolWithPath: vi.fn().mockResolvedValue(false),
            postStateToWebview: vi.fn().mockResolvedValue(undefined),
            reinitExistingTaskFromId: vi.fn().mockResolvedValue(undefined),
            cancelTask: vi.fn().mockResolvedValue(undefined),
            updateTaskHistory: vi.fn().mockResolvedValue([]),
            applyLatestBrowserSettings: vi.fn().mockResolvedValue(undefined),
            switchToActMode: vi.fn().mockResolvedValue(false),
            setActiveHookExecution: vi.fn().mockResolvedValue(undefined),
            clearActiveHookExecution: vi.fn().mockResolvedValue(undefined),
            getActiveHookExecution: vi.fn().mockResolvedValue(undefined),
            runUserPromptSubmitHook: vi.fn().mockResolvedValue({}),
        },
        coordinator: {
            getHandler: vi.fn().mockImplementation((toolName: DlineDefaultTool) => {
                if (toolName === DlineDefaultTool.LIST_FILES)
                    return {
                        execute: vi.fn().mockResolvedValue("ok"),
                        getDescription: vi.fn().mockReturnValue("list_files"),
                    }
                return undefined
            }),
        },
    } as unknown as TaskConfig
}

/** Stubs the stable profile facade used by subagent tests. */
export function stubSystemPrompt(
    native: boolean,
    inspectContext?: (context: SystemPromptContext) => void,
    nativeToolNames: readonly string[] = [DlineDefaultTool.LIST_FILES],
): ReturnType<typeof vi.spyOn> {
    return vi.spyOn(systemPromptFacade, "getSystemPrompt").mockImplementation(async (context) => {
        inspectContext?.(context)
        return {
            systemPrompt: "system prompt",
            tools: native
                ? nativeToolNames.map((name) => ({ type: "function", function: { name, description: name } }))
                : undefined,
            profile: PromptProfile.Standard,
            warnings: [],
        }
    })
}

export function stubApiHandler(
    createMessage: ReturnType<typeof vi.fn>,
    contextWindow = 200_000,
    hostedWebSearch = false,
    abort = vi.fn(),
    currency = "USD",
) {
    vi.spyOn(coreApi, "buildApiHandler").mockReturnValue({
        abort,
        getProviderId: () => "anthropic",
        supportsServerTool: (tool: ServerTool) => hostedWebSearch && tool === ServerTool.WEB_SEARCH,
        getModel: () => ({
            id: "anthropic/claude-sonnet-4.5",
            info: {
                contextWindow,
                pricing: { currency },
                apiFormats: [ApiFormat.ANTHROPIC_CHAT],
                supportsPromptCache: true,
                capabilities: {
                    contextWindow,
                    supportsImages: false,
                    supportsPromptCache: true,
                    supportsTools: true,
                    tools: hostedWebSearch ? [ServerTool.WEB_SEARCH] : [],
                },
            },
        }),
        createMessage,
    } as never)
}

/** Finish converges by reminder, never by swapping the system or narrowing native tools. */
export function assertFinishTurnReusesRequestShape(createMessage: ReturnType<typeof vi.fn>, expectedTools: readonly string[]) {
    const [firstPrompt, , firstTools] = createMessage.mock.calls[0] as [string, unknown, Array<{ function: { name: string } }>]
    assert.deepEqual(
        firstTools.map((tool) => tool.function.name),
        expectedTools,
    )
    for (const [systemPrompt, , tools] of createMessage.mock.calls.slice(1)) {
        assert.equal(systemPrompt, firstPrompt)
        assert.deepEqual(tools, firstTools)
    }
}

/** Register per-suite setup explicitly so importing fixtures never installs hidden hooks. */
export function useSubagentRunnerTestLifecycle() {
    beforeEach(() => {
        vi.spyOn(ListFilesToolHandler.prototype, "execute").mockResolvedValue("ok")
    })
    afterEach(() => {
        HostProvider.reset()
        vi.restoreAllMocks()
    })
}
