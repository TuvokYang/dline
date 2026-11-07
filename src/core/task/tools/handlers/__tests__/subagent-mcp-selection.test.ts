import type { ToolUse } from "@core/assistant-message"
import { McpHub } from "@services/mcp/McpHub"
import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import type { McpServer } from "@shared/mcp"
import { createTaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import { DlineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import { prepareRegisteredToolAdmission } from "../../../executors/tool/ToolAdmissionRegistry"
import type { SubagentCapabilitySelection } from "../../subagent/SubagentCapabilitySelection"
import type { TaskConfig } from "../../types/TaskConfig"
import { AccessMcpResourceHandler } from "../AccessMcpResourceHandler"
import { UseMcpToolHandler } from "../UseMcpToolHandler"

vi.mock("@core/api", () => ({ resolveProvider: () => "openai" }))
vi.mock("@/services/telemetry", () => ({ telemetryService: { captureToolUsage: vi.fn() } }))

const SERVER = "documents@workspace-a"
const URI = "repo://policy"

function server(overrides: Partial<McpServer> = {}): McpServer {
    return {
        name: SERVER,
        displayName: "Documents",
        source: "workspace",
        config: "{}",
        status: "connected",
        uid: "connection-a",
        tools: [{ name: "lookup", inputSchema: { type: "object" } }],
        resources: [{ uri: URI, name: "Policy" }],
        ...overrides,
    }
}

function configFor(selected = server(), live = server()): TaskConfig {
    const toggles = createTaskCapabilityToggles({ mcpServers: { [SERVER]: true } })
    const selection: SubagentCapabilitySelection = {
        skills: [],
        workflows: [],
        remoteSkillEntries: [],
        mcpServers: [selected],
        capabilities: { mcp: [], skills: [], workflows: [], subagents: [] },
        capabilityToggles: toggles,
        ruleInstructions: {},
    }
    return {
        taskId: "task-is-not-the-owner",
        ulid: "incarnation-is-not-the-owner",
        cwd: "/workspace-a",
        isSubagentExecution: true,
        capabilityToggles: createTaskCapabilityToggles(toggles),
        subagentCapabilitySelection: selection,
        getMcpServersForOwner: vi.fn(() => [live]),
        taskState: { consecutiveMistakeCount: 0 },
        api: { getModel: () => ({ id: "model", info: { capabilities: { supportsImages: false } } }) },
        services: {
            stateManager: {
                getApiConfiguration: () => ({}),
                getGlobalSettingsKey: (key: string) => (key === "mode" ? "act" : false),
            },
            mcpHub: {
                getServers: vi.fn(() => [server({ name: "documents@workspace-b" })]),
                getPendingNotifications: () => [],
                callTool: vi.fn(async () => ({ content: [{ type: "text", text: "TOOL_RESULT" }] })),
                readResource: vi.fn(async () => ({ contents: [{ uri: URI, text: "RESOURCE_RESULT" }] })),
            },
        },
        callbacks: { say: vi.fn(async () => undefined), sayAndCreateMissingParamError: vi.fn(), ask: vi.fn() },
    } as unknown as TaskConfig
}

let toolBlockSeq = 0

function toolBlock(serverName = SERVER, toolName = "lookup"): ToolUse {
    const seq = ++toolBlockSeq
    return {
        type: "tool_use",
        name: DlineDefaultTool.MCP_USE,
        ts: 1,
        partial: false,
        function_id: `mcp-use-${seq}`,
        dline_tid: `mcp-use-trace-${seq}`,
        params: { server_name: serverName, tool_name: toolName, arguments: '{"id":"record-1"}' },
    }
}

function resourceBlock(uri = URI, serverName = SERVER): ToolUse {
    const seq = ++toolBlockSeq
    return {
        type: "tool_use",
        name: DlineDefaultTool.MCP_ACCESS,
        ts: 2,
        partial: false,
        function_id: `mcp-access-${seq}`,
        dline_tid: `mcp-access-trace-${seq}`,
        params: { server_name: serverName, uri },
    }
}

describe("subagent MCP exact frozen selection", () => {
    it("executes selected tool and URI through the original Hub signatures, not an invented owner argument", async () => {
        const config = configFor()

        expect(await new UseMcpToolHandler().execute(config, toolBlock())).toBe("TOOL_RESULT")
        expect(await new AccessMcpResourceHandler().execute(config, resourceBlock())).toBe("RESOURCE_RESULT")
        expect(config.services.mcpHub.callTool).toHaveBeenCalledExactlyOnceWith(SERVER, "lookup", { id: "record-1" }, config.ulid)
        expect(config.services.mcpHub.readResource).toHaveBeenCalledExactlyOnceWith(SERVER, URI)
        expect(config.services.mcpHub.getServers).not.toHaveBeenCalled()
        expect(config.callbacks.ask).not.toHaveBeenCalled()
    })

    it.each([
        "look",
        "Lookup",
        "lookup.extra",
        "unselected",
    ])("rejects guessed tool %s even on a selected server", async (name) => {
        const config = configFor(server(), server({ tools: [{ name: "lookup" }, { name }] }))
        const result = await new UseMcpToolHandler().execute(config, toolBlock(SERVER, name))
        expect(result).toMatchObject({ failure: { stage: "authorization" } })
        expect(config.services.mcpHub.callTool).not.toHaveBeenCalled()
    })

    it.each([
        `${URI}/`,
        `${URI}#section`,
        `${URI}?v=1`,
        "repo://{name}",
        "repo://private",
    ])("rejects non-exact selected URI %s", async (uri) => {
        const config = configFor(
            server(),
            server({
                resources: [
                    { uri: URI, name: "Policy" },
                    { uri, name: "Other" },
                ],
            }),
        )
        await new AccessMcpResourceHandler().execute(config, resourceBlock(uri))
        expect(config.services.mcpHub.readResource).not.toHaveBeenCalled()
        expect(config.taskState.consecutiveMistakeCount).toBe(1)
    })

    it.each([
        "Documents",
        "documents@workspace-b",
    ])("does not match display names or another owner's server: %s", async (name) => {
        const config = configFor()
        await new UseMcpToolHandler().execute(config, toolBlock(name))
        await new AccessMcpResourceHandler().execute(config, resourceBlock(URI, name))
        expect(config.services.mcpHub.callTool).not.toHaveBeenCalled()
        expect(config.services.mcpHub.readResource).not.toHaveBeenCalled()
    })

    it.each([
        { disabled: true },
        { status: "connecting" },
        { status: "disconnected" },
        { uid: "replacement-connection" },
        { tools: [], resources: [] },
    ] satisfies Partial<McpServer>[])("requires the selected owner target to remain available: %j", async (changes) => {
        const config = configFor(server(), server(changes))
        await new UseMcpToolHandler().execute(config, toolBlock())
        await new AccessMcpResourceHandler().execute(config, resourceBlock())
        expect(config.services.mcpHub.callTool).not.toHaveBeenCalled()
        expect(config.services.mcpHub.readResource).not.toHaveBeenCalled()
    })

    it("refuses missing selection or owner getter instead of inheriting parent/server-wide authority", async () => {
        const noSelection = { ...configFor(), subagentCapabilitySelection: undefined }
        const noOwner = { ...configFor(), getMcpServersForOwner: undefined }
        const sibling = {
            ...configFor(),
            subagentCapabilitySelection: { ...configFor().subagentCapabilitySelection!, mcpServers: [] },
        }
        for (const config of [noSelection, noOwner, sibling]) {
            await new UseMcpToolHandler().execute(config, toolBlock())
            await new AccessMcpResourceHandler().execute(config, resourceBlock())
            expect(config.services.mcpHub.callTool).not.toHaveBeenCalled()
            expect(config.services.mcpHub.readResource).not.toHaveBeenCalled()
            expect(config.services.mcpHub.getServers).not.toHaveBeenCalled()
        }
    })

    it("rechecks owner visibility immediately before the effect after asynchronous presentation/hooks", async () => {
        for (const kind of ["tool", "resource"] as const) {
            const config = configFor()
            vi.mocked(config.callbacks.say).mockImplementation(async (type) => {
                if (type === "mcp_server_request_started") config.getMcpServersForOwner = () => []
                return undefined
            })
            if (kind === "tool") await new UseMcpToolHandler().execute(config, toolBlock())
            else await new AccessMcpResourceHandler().execute(config, resourceBlock())
            expect(config.services.mcpHub.callTool).not.toHaveBeenCalled()
            expect(config.services.mcpHub.readResource).not.toHaveBeenCalled()
        }
    })

    it("uses the captured Controller owner rather than taskId, ulid or cwd with real Hub owner filtering", async () => {
        const owner = "a9f9aa30-eef5-4d30-bf30-85ffdca261f7"
        const config = configFor()
        const hub = Object.create(McpHub.prototype) as McpHub
        const own = server()
        const foreign = server({ name: "documents@workspace-b" })
        Object.assign(hub, {
            connections: [{ server: own }, { server: foreign }],
            workspaceMcpRegistry: { getDescriptorsForOwner: (id: string) => (id === owner ? [{ internalName: SERVER }] : []) },
        })
        config.getMcpServersForOwner = () => hub.getServersForOwner(owner)
        expect(await new UseMcpToolHandler().execute(config, toolBlock())).toBe("TOOL_RESULT")
        config.getMcpServersForOwner = () => hub.getServersForOwner(config.ulid)
        await new UseMcpToolHandler().execute(config, toolBlock())
        expect(config.services.mcpHub.callTool).toHaveBeenCalledTimes(1)
    })

    it("does not turn selected capabilities into approval authority", () => {
        const config = configFor()
        const handler = new UseMcpToolHandler()
        const block = toolBlock()
        const admission = prepareRegisteredToolAdmission({
            canonicalToolName: DlineDefaultTool.MCP_USE,
            block,
            description: handler.getDescription(block),
            snapshot: {
                taskId: config.taskId,
                cwd: config.cwd,
                workspaceRoots: [config.cwd],
                blanket: {},
                settings: { ...DEFAULT_AUTO_APPROVAL_SETTINGS, ceilings: { mcp: "manual_only" } },
            },
            presentation: handler.getApprovalPresentation(block, false),
            run: () => handler.execute(config, block),
        })
        expect(admission.outcome).toBe("admitted")
        if (admission.outcome !== "admitted") throw new Error("MCP admission unexpectedly rejected")
        expect(admission.decision.kind).toBe("manual")
        expect(admission.presentation).toBeDefined()
        expect(JSON.parse(admission.presentation!.body)).toMatchObject({
            type: "use_mcp_tool",
            serverName: SERVER,
            toolName: "lookup",
        })
        expect(config.services.mcpHub.callTool).not.toHaveBeenCalled()
    })

    it("preserves main-task server-wide behavior without a child selection", async () => {
        const config = {
            ...configFor(),
            isSubagentExecution: false,
            subagentCapabilitySelection: undefined,
            getMcpServersForOwner: undefined,
        }
        expect(await new UseMcpToolHandler().execute(config, toolBlock(SERVER, "legacy-tool"))).toBe("TOOL_RESULT")
        expect(await new AccessMcpResourceHandler().execute(config, resourceBlock("repo://legacy"))).toBe("RESOURCE_RESULT")
        expect(config.services.mcpHub.callTool).toHaveBeenCalledExactlyOnceWith(
            SERVER,
            "legacy-tool",
            { id: "record-1" },
            config.ulid,
        )
        expect(config.services.mcpHub.readResource).toHaveBeenCalledExactlyOnceWith(SERVER, "repo://legacy")
    })
})
