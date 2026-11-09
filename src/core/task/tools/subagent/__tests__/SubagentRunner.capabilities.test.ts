import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import * as coreApi from "@core/api"
import type { ToolUse } from "@core/assistant-message"
import * as profileStore from "@core/controller/file/getApiProfiles"
import { deferred } from "@core/task/runtime/deferred"
import { McpHub } from "@services/mcp/McpHub"
import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { DEFAULT_BROWSER_SETTINGS } from "@shared/BrowserSettings"
import type { McpServer } from "@shared/mcp"
import type { ClineStorageMessage } from "@shared/messages"
import { ApiFormat } from "@shared/proto/dline/models/metadata"
import type { GlobalInstructionsFile } from "@shared/remote-config/schema"
import { emptyTaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import { DlineDefaultTool } from "@shared/tools"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { TaskActivityStore } from "../../../activity/TaskActivityStore"
import { LoadCapabilityHandler } from "../../handlers/LoadCapabilityHandler"
import { restoreSubagentActivityRetry, UseSubagentsToolHandler, UseSubagentToolHandler } from "../../handlers/SubagentToolHandler"
import { DefaultToolHandlerState } from "../../state/ToolHandlerState"
import type { TaskConfig } from "../../types/TaskConfig"
import type { AgentBaseConfig } from "../AgentConfigLoader"
import type { SubagentCapabilityConfig } from "../SubagentBuilder"
import * as compaction from "../SubagentContextCompaction"
import { SubagentRunner } from "../SubagentRunner"

vi.mock("@/config", () => ({
    ClineEndpoint: {
        isSelfHosted: () => false,
        init: () => {},
        config: {
            environment: "production",
            appBaseUrl: "https://app.dline.cc",
            apiBaseUrl: "https://api.dline.cc",
            mcpBaseUrl: "https://mcp.cline.bot",
        },
    },
    ClineEnv: { config: () => ({}), setEnvironment: () => {}, getEnvironment: () => "production" },
    ClineConfigurationError: class extends Error {},
    Environment: { production: "production" },
}))

type Reply = { type: "tool_calls"; function_id: string; tool_call: { function: { name: string; arguments: string } } }
interface Request {
    system: string
    messages: ClineStorageMessage[]
    tools: unknown
}

function call(name: DlineDefaultTool, params: Record<string, unknown>, id: string = name): Reply {
    return { type: "tool_calls", function_id: id, tool_call: { function: { name, arguments: JSON.stringify(params) } } }
}

function remoteSkill(name: string, marker: string): GlobalInstructionsFile {
    return { name, alwaysEnabled: false, contents: `---\nname: ${name}\ndescription: ${marker}_CATALOG\n---\n${marker}_BODY` }
}

function remoteWorkflow(name: string, marker: string): GlobalInstructionsFile {
    return { name, alwaysEnabled: false, contents: `---\ndescription: ${marker}_CATALOG\n---\n${marker}_PROCEDURE` }
}

function agent(overrides: Partial<AgentBaseConfig> = {}): AgentBaseConfig {
    return {
        name: "reviewer",
        description: "Review the delegated change",
        systemPrompt: "CHILD_CUSTOM_INSTRUCTION",
        tools: [DlineDefaultTool.LOAD_SKILL, DlineDefaultTool.LOAD_WORKFLOW],
        ...overrides,
    }
}

function requestToolNames(request: Request): string[] {
    return ((request.tools ?? []) as Array<{ name?: string; function?: { name: string } }>).map(
        (tool) => tool.function?.name ?? tool.name ?? "",
    )
}

describe("SubagentRunner independent capability wiring", () => {
    let temp: string
    let config: TaskConfig
    let requests: Request[]
    let replies: Reply[][]
    let effects: Array<(() => Promise<void>) | undefined>
    let createMessage: ReturnType<typeof vi.fn>
    let contextWindow: number
    let settings: Record<string, unknown>
    let remote: {
        remoteGlobalSkills: GlobalInstructionsFile[]
        remoteGlobalWorkflows: GlobalInstructionsFile[]
        remoteGlobalRules: GlobalInstructionsFile[]
    }
    let liveServers: McpServer[]

    async function put(relative: string, text: string): Promise<string> {
        const file = path.join(config.cwd, relative)
        await fs.mkdir(path.dirname(file), { recursive: true })
        await fs.writeFile(file, text, "utf8")
        return file
    }

    beforeEach(async () => {
        temp = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-run-capabilities-"))
        const cwd = path.join(temp, "workspace")
        const docs = path.join(temp, "documents")
        await fs.mkdir(cwd, { recursive: true })
        await fs.mkdir(docs, { recursive: true })
        vi.stubEnv("DLINE_DOCS_DIR", docs)
        contextWindow = 200_000
        requests = []
        replies = []
        effects = []
        settings = { mode: "act", subagentsEnabled: true, maxParallelSubagents: 2, clineWebToolsEnabled: false }
        remote = {
            remoteGlobalSkills: [remoteSkill("child-skill", "CHILD_SKILL"), remoteSkill("parent-skill", "PARENT_SKILL")],
            remoteGlobalWorkflows: [remoteWorkflow("child-flow", "CHILD_FLOW"), remoteWorkflow("parent-flow", "PARENT_FLOW")],
            remoteGlobalRules: [],
        }
        liveServers = []
        createMessage = vi.fn(async function* (system: string, messages: ClineStorageMessage[], tools: unknown) {
            const index = requests.length
            requests.push({ system, messages: structuredClone(messages), tools: structuredClone(tools) })
            await effects[index]?.()
            for (const reply of replies[index] ?? [call(DlineDefaultTool.ATTEMPT, { result: "COMPLETE" }, `finish-${index}`)])
                yield reply
        })
        const api = {
            getProviderId: () => "anthropic",
            getModel: () => ({
                id: "capability-test-model",
                info: {
                    id: "capability-test-model",
                    apiFormats: [ApiFormat.ANTHROPIC_CHAT],
                    capabilities: { contextWindow, supportsTools: true, supportsImages: false, supportsPromptCache: true },
                },
            }),
            createMessage,
            abort: vi.fn(),
        }
        vi.spyOn(coreApi, "buildApiHandler").mockReturnValue(api as never)
        vi.spyOn(profileStore, "readApiProfiles").mockReturnValue([])
        const hub = Object.create(McpHub.prototype) as McpHub
        Object.assign(hub, {
            connections: [],
            workspaceMcpRegistry: {
                getDescriptorsForOwner: (owner: string) =>
                    owner === "controller-owner-uuid" ? liveServers.map((server) => ({ internalName: server.name })) : [],
            },
            getServers: vi.fn(() => {
                throw new Error("Unscoped MCP reads are forbidden")
            }),
            getPendingNotifications: () => [],
            callTool: vi.fn(async () => ({ content: [{ type: "text", text: "MCP_TOOL_RESULT" }] })),
            readResource: vi.fn(async () => ({ contents: [{ uri: "repo://policy", text: "MCP_RESOURCE_RESULT" }] })),
        })
        const imageGenerationService = { hasAvailableProfile: () => false, withProfileResolver: () => imageGenerationService }
        config = {
            taskId: "parent-task",
            ulid: "parent-incarnation",
            cwd,
            mode: "act",
            isSubagentExecution: false,
            subagentsEnabled: true,
            webToolsEnabled: false,
            yoloModeToggled: false,
            capabilityToggles: emptyTaskCapabilityToggles(),
            getMcpServersForOwner: () => hub.getServersForOwner("controller-owner-uuid"),
            taskState: new DefaultToolHandlerState(),
            messageState: { clineMessages: [{ type: "say", say: "task", text: "PARENT_SYSTEM_SECRET src/parent.ts" }] },
            api,
            browserSettings: structuredClone(DEFAULT_BROWSER_SETTINGS),
            focusChainSettings: { enabled: false },
            autoApprovalSettings: structuredClone(DEFAULT_AUTO_APPROVAL_SETTINGS),
            services: {
                mcpHub: hub,
                imageGenerationService,
                stateManager: {
                    getRemoteConfigSettings: () => remote,
                    getGlobalSettingsKey: (key: string) => settings[key],
                    getCanonicalSettingsKey: () => false,
                    getGlobalStateKey: (key: string) => key === "nativeToolCallEnabled",
                    getApiConfigurationForTask: () => ({ actModeProfile: "parent-profile" }),
                    getApiConfiguration: () => ({ actModeProfile: "parent-profile" }),
                },
            },
            callbacks: {
                say: vi.fn(async () => undefined),
                ask: vi.fn(),
                sayUserReply: vi.fn(),
                cancelRunningCommandTool: vi.fn(async () => false),
                postStateToWebview: vi.fn(async () => {}),
            },
        } as unknown as TaskConfig
    })

    afterEach(async () => {
        vi.restoreAllMocks()
        vi.unstubAllEnvs()
        await fs.rm(temp, { recursive: true, force: true })
    })

    it("uses child Rules/catalog/load results while parent false and parent-only selections remain isolated", async () => {
        const childRule = await put(".agents/rules/child.md", "CHILD_RULE_BODY")
        const parentRule = await put(".agents/rules/parent.md", "PARENT_RULE_BODY")
        config.capabilityToggles.localClineRulesToggles = { [childRule]: false, [parentRule]: true }
        config.capabilityToggles.remoteSkillsToggles = { "child-skill": false, "parent-skill": true }
        config.capabilityToggles.remoteWorkflowToggles = { "child-flow": false, "parent-flow": true }
        const parentBefore = structuredClone(config.capabilityToggles)
        replies.push([
            call(DlineDefaultTool.LOAD_SKILL, { name: "child-skill" }),
            call(DlineDefaultTool.LOAD_WORKFLOW, { name: "child-flow" }),
        ])
        const execute = vi.spyOn(LoadCapabilityHandler.prototype, "execute")
        const result = await new SubagentRunner(
            config,
            "reviewer",
            agent({
                rules: [{ scope: "workspace", path: "child.md" }],
                skills: ["child-skill"],
                workflows: ["child-flow"],
            }),
            { taskText: "Inspect docs/guide.md" },
        ).run("Inspect docs/guide.md", () => {})

        expect(result).toMatchObject({ status: "completed", result: "COMPLETE" })
        expect(requests).toHaveLength(2)
        expect(requests[0].system).toContain("CHILD_RULE_BODY")
        expect(requests[0].system).toContain("CHILD_SKILL_CATALOG")
        expect(requests[0].system).toContain("CHILD_FLOW_CATALOG")
        expect(requests[0].system).not.toMatch(/PARENT_RULE_BODY|PARENT_SKILL_CATALOG|PARENT_FLOW_CATALOG|PARENT_SYSTEM_SECRET/)
        expect(requests[0].system).not.toContain("CHILD_SKILL_BODY")
        expect(JSON.stringify(requests[1].messages)).toContain("CHILD_SKILL_BODY")
        expect(JSON.stringify(requests[1].messages)).toContain("CHILD_FLOW_PROCEDURE")
        const first = execute.mock.calls[0][0]
        const second = execute.mock.calls[1][0]
        expect(first.subagentCapabilitySelection).toBe(second.subagentCapabilitySelection)
        expect(first.capabilityToggles).not.toBe(second.capabilityToggles)
        for (const key of Object.keys(config.capabilityToggles) as Array<keyof TaskConfig["capabilityToggles"]>) {
            expect(first.capabilityToggles[key]).not.toBe(second.capabilityToggles[key])
            expect(first.capabilityToggles[key]).not.toBe(config.capabilityToggles[key])
        }
        expect(first.capabilityToggles.remoteSkillsToggles["child-skill"]).toBe(true)
        expect(first.capabilityToggles.remoteSkillsToggles["parent-skill"]).toBe(false)
        expect(config.capabilityToggles).toEqual(parentBefore)
    })

    it("does not restore parent or sibling authority when unselected names are guessed", async () => {
        config.capabilityToggles.remoteSkillsToggles["parent-skill"] = true
        config.capabilityToggles.remoteWorkflowToggles["parent-flow"] = true
        replies.push([
            call(DlineDefaultTool.LOAD_SKILL, { name: "parent-skill" }),
            call(DlineDefaultTool.LOAD_WORKFLOW, { name: "parent-flow" }),
        ])
        const result = await new SubagentRunner(config, "reviewer", agent()).run("Review", () => {})
        expect(result.status, result.error).toBe("completed")
        expect(requests[0].system).not.toMatch(/PARENT_SKILL_CATALOG|PARENT_FLOW_CATALOG/)
        expect(JSON.stringify(requests[1].messages)).not.toMatch(/PARENT_SKILL_BODY|PARENT_FLOW_PROCEDURE/)
        expect(JSON.stringify(requests[1].messages)).toMatch(/Unknown or disabled/)

        const sibling = await new SubagentRunner(config, "reviewer", agent({ skills: ["parent-skill"] })).run("Review", () => {})
        expect(sibling.status, sibling.error).toBe("completed")
        expect(requests[2].system).toContain("PARENT_SKILL_CATALOG")
        expect(requests[2].system).not.toContain("CHILD_SKILL_CATALOG")
    })

    it.each([
        200_000, 16_000,
    ])("injects Rules without loaders and evaluates conditions from original task only at W=%i", async (window) => {
        contextWindow = window
        await put(".agents/rules/common.md", "ALWAYS_CHILD_RULE")
        await put(".agents/rules/scoped.md", "---\npaths: [src/**]\n---\nSRC_CHILD_RULE")
        const configured = agent({
            tools: [DlineDefaultTool.ATTEMPT],
            rules: [
                { scope: "workspace", path: "common.md" },
                { scope: "workspace", path: "scoped.md" },
            ],
        })
        const prompt = "<task>Inspect docs/guide.md</task>\n<context>Parent was editing src/parent.ts</context>"
        expect(
            (
                await new SubagentRunner(config, "reviewer", configured, { taskText: "Inspect docs/guide.md" }).run(
                    prompt,
                    () => {},
                )
            ).status,
        ).toBe("completed")
        expect(requests[0].system).toContain("ALWAYS_CHILD_RULE")
        expect(requests[0].system).not.toContain("SRC_CHILD_RULE")
        expect(requestToolNames(requests[0])).toEqual([DlineDefaultTool.ATTEMPT])
        expect(
            (await new SubagentRunner(config, "reviewer", configured, { taskText: "Inspect src/child.ts" }).run(prompt, () => {}))
                .status,
        ).toBe("completed")
        expect(requests[1].system).toContain("SRC_CHILD_RULE")
    })

    it.each([200_000, 16_000])("does not execute guessed loaders omitted by Tools or Lite at W=%i", async (window) => {
        contextWindow = window
        const execute = vi.spyOn(LoadCapabilityHandler.prototype, "execute")
        replies.push([
            call(DlineDefaultTool.LOAD_SKILL, { name: "child-skill" }),
            call(DlineDefaultTool.LOAD_WORKFLOW, { name: "child-flow" }),
            call(DlineDefaultTool.LOAD_MCP, { name: "documents@workspace-a.lookup" }),
        ])
        const configured = agent({
            tools:
                window === 16_000
                    ? [DlineDefaultTool.LOAD_SKILL, DlineDefaultTool.LOAD_WORKFLOW, DlineDefaultTool.LOAD_MCP]
                    : [DlineDefaultTool.ATTEMPT],
            skills: ["child-skill"],
            workflows: ["child-flow"],
        })
        expect((await new SubagentRunner(config, "reviewer", configured).run("Review", () => {})).status).toBe("completed")
        expect(execute).not.toHaveBeenCalled()
        expect(requestToolNames(requests[0])).toEqual([DlineDefaultTool.ATTEMPT])
        expect(requests[0].system).not.toMatch(/CHILD_SKILL_CATALOG|CHILD_FLOW_CATALOG/)
        expect(JSON.stringify(requests[1].messages)).not.toMatch(/CHILD_SKILL_BODY|CHILD_FLOW_PROCEDURE/)
    })

    it("keeps default capabilities empty without YAML even when the parent selected them", async () => {
        config.capabilityToggles.remoteSkillsToggles["child-skill"] = true
        config.capabilityToggles.remoteWorkflowToggles["child-flow"] = true
        expect((await new SubagentRunner(config, "default").run("Review", () => {})).status).toBe("completed")
        expect(requests[0].system).not.toMatch(/CHILD_SKILL_CATALOG|CHILD_FLOW_CATALOG/)
        expect(requestToolNames(requests[0])).not.toContain(DlineDefaultTool.LOAD_SKILL)
    })

    it("does not treat a direct caller's composed prompt as original rule-condition evidence", async () => {
        await put(".agents/rules/scoped.md", "---\npaths: [src/**]\n---\nSCOPED_DIRECT_RULE")
        const configured = agent({ rules: [{ scope: "workspace", path: "scoped.md" }], tools: [DlineDefaultTool.ATTEMPT] })
        expect(
            (await new SubagentRunner(config, "reviewer", configured).run("<context>src/parent.ts</context>", () => {})).status,
        ).toBe("completed")
        expect(requests[0].system).not.toContain("SCOPED_DIRECT_RULE")
    })

    it("fails a missing selected Rule before any provider request, while a sibling can still run", async () => {
        const failed = await new SubagentRunner(
            config,
            "reviewer",
            agent({ rules: [{ scope: "workspace", path: "missing.md" }] }),
        ).run("Review", () => {})
        expect(failed.status, failed.error).toBe("failed")
        expect(failed.error).toMatch(/missing.md/)
        expect(createMessage).not.toHaveBeenCalled()
        expect((await new SubagentRunner(config, "reviewer", agent()).run("Review", () => {})).status).toBe("completed")
    })

    it("rereads capability intent once per run/Retry and does not hot-refresh the active run", async () => {
        let current: SubagentCapabilityConfig = { skills: ["child-skill"] }
        const reload = vi.fn(async () => current)
        replies.push(
            [call(DlineDefaultTool.LOAD_SKILL, { name: "child-skill" })],
            [call(DlineDefaultTool.ATTEMPT, { result: "FIRST" })],
            [call(DlineDefaultTool.LOAD_SKILL, { name: "parent-skill" })],
        )
        effects[0] = async () => {
            current = { skills: ["parent-skill"] }
        }
        const runner = new SubagentRunner(config, "reviewer", agent(), { taskText: "Review", reloadCapabilityConfig: reload })
        expect((await runner.run("Review", () => {})).result).toBe("FIRST")
        expect((await runner.run("Review", () => {})).result).toBe("COMPLETE")
        expect(reload).toHaveBeenCalledTimes(2)
        expect(requests[0].system).toContain("CHILD_SKILL_CATALOG")
        expect(requests[0].system).not.toContain("PARENT_SKILL_CATALOG")
        expect(JSON.stringify(requests[1].messages)).toContain("CHILD_SKILL_BODY")
        expect(requests[2].system).toContain("PARENT_SKILL_CATALOG")
        expect(requests[2].system).not.toContain("CHILD_SKILL_CATALOG")
        expect(JSON.stringify(requests[3].messages)).toContain("PARENT_SKILL_BODY")
    })

    it("handles capability-config reread failures inside the run boundary without sending a provider request", async () => {
        const runner = new SubagentRunner(config, "reviewer", agent(), {
            reloadCapabilityConfig: async () => {
                throw new Error("YAML_READ_FAILED")
            },
        })
        expect(await runner.run("Review", () => {})).toMatchObject({ status: "failed", error: "YAML_READ_FAILED" })
        expect(createMessage).not.toHaveBeenCalled()
    })

    it("cancels capability preparation without sending a provider request", async () => {
        const entered = deferred<void>()
        const release = deferred<void>()
        const reload = vi.fn(async () => {
            entered.resolve()
            await release.promise
            return { skills: ["child-skill"] }
        })
        const runner = new SubagentRunner(config, "reviewer", agent(), { reloadCapabilityConfig: reload })
        const running = runner.run("Review", () => {})
        await entered.promise
        await runner.abort()
        release.resolve()
        expect(await running).toMatchObject({ status: "cancelled", retryable: true })
        expect(createMessage).not.toHaveBeenCalled()
        expect(reload).toHaveBeenCalledTimes(1)
        expect(await runner.whenAbandonedWorkSettled()).toBe(true)
    })

    it("keeps the selected prompt/tool frame when Finish arrives during capability preparation", async () => {
        const entered = deferred<void>()
        const release = deferred<void>()
        const reload = vi.fn(async () => {
            entered.resolve()
            await release.promise
            return { skills: ["child-skill"] }
        })
        const runner = new SubagentRunner(config, "reviewer", agent(), { reloadCapabilityConfig: reload })
        const running = runner.run("Review", () => {})
        await entered.promise
        expect(await runner.requestFinish("user")).toBe(true)
        release.resolve()
        expect((await running).status).toBe("completed")
        expect(reload).toHaveBeenCalledTimes(1)
        expect(requests).toHaveLength(1)
        expect(requests[0].system).toContain("CHILD_SKILL_CATALOG")
        expect(requestToolNames(requests[0])).toContain(DlineDefaultTool.LOAD_SKILL)
    })

    it("keeps the same system, tools and selected loader bodies through automatic compaction", async () => {
        settings.useAutoCondense = true
        let current: SubagentCapabilityConfig = { skills: ["child-skill"], workflows: ["child-flow"] }
        const reload = vi.fn(async () => current)
        replies.push(
            [call(DlineDefaultTool.LOAD_WORKFLOW, { name: "child-flow" })],
            [call(DlineDefaultTool.LOAD_SKILL, { name: "child-skill" })],
        )
        vi.spyOn(compaction, "estimateSubagentContext").mockImplementation(() => (requests.length === 1 ? 190_000 : 0))
        const compact = vi.spyOn(compaction, "compactSubagentConversation").mockImplementation(async () => {
            current = { skills: ["parent-skill"], workflows: ["parent-flow"] }
            remote.remoteGlobalSkills = [remoteSkill("child-skill", "CHANGED_LIVE_SKILL")]
            return [{ role: "user", content: [{ type: "text", text: "COMPACTED_HISTORY" }] }]
        })
        const runner = new SubagentRunner(config, "reviewer", agent(), { reloadCapabilityConfig: reload })
        expect((await runner.run("Review", () => {})).status).toBe("completed")
        expect(compact).toHaveBeenCalledTimes(1)
        expect(reload).toHaveBeenCalledTimes(1)
        for (const request of requests.slice(1)) {
            expect(request.system).toBe(requests[0].system)
            expect(request.tools).toEqual(requests[0].tools)
        }
        expect(JSON.stringify(requests[2].messages)).toContain("CHILD_SKILL_BODY")
        expect(JSON.stringify(requests[2].messages)).not.toContain("CHANGED_LIVE_SKILL_BODY")
    })

    it("projects selected owner MCP tools/resources on demand and calls the original Hub", async () => {
        liveServers = [
            {
                name: "documents@workspace-a",
                source: "workspace",
                status: "connected",
                config: '{"secret":"NO_CONFIG_LEAK"}',
                tools: [
                    { name: "lookup", description: "SELECTED_MCP_TOOL" },
                    { name: "private", description: "PRIVATE_MCP_TOOL" },
                ],
                resources: [
                    { uri: "repo://policy", name: "Policy", description: "SELECTED_MCP_RESOURCE" },
                    { uri: "repo://private", name: "PRIVATE_MCP_RESOURCE" },
                ],
            },
        ]
        config.services.mcpHub.connections = liveServers.map((server) => ({
            server,
        })) as typeof config.services.mcpHub.connections
        config.capabilityToggles.mcpServers["documents@workspace-a"] = false
        replies.push(
            [call(DlineDefaultTool.LOAD_MCP, { name: "documents@workspace-a.lookup" })],
            [
                call(DlineDefaultTool.MCP_USE, { server_name: "documents@workspace-a", tool_name: "lookup", arguments: "{}" }),
                call(DlineDefaultTool.MCP_ACCESS, { server_name: "documents@workspace-a", uri: "repo://policy" }),
            ],
        )
        const configured = agent({
            tools: [DlineDefaultTool.LOAD_MCP, DlineDefaultTool.MCP_USE, DlineDefaultTool.MCP_ACCESS],
            mcp: [{ server: "documents@workspace-a", tools: ["lookup"], resources: ["repo://policy"] }],
        })
        expect((await new SubagentRunner(config, "reviewer", configured).run("Review", () => {})).status).toBe("completed")
        expect(requests[0].system).toContain("SELECTED_MCP_TOOL")
        expect(requests[0].system).toContain("repo://policy")
        expect(requests[0].system).not.toMatch(/PRIVATE_MCP_TOOL|PRIVATE_MCP_RESOURCE|NO_CONFIG_LEAK/)
        expect(requestToolNames(requests[0])).toContain(DlineDefaultTool.LOAD_MCP)
        expect(requestToolNames(requests[0])).not.toContain("lookup")
        expect(config.services.mcpHub.callTool).toHaveBeenCalledExactlyOnceWith(
            "documents@workspace-a",
            "lookup",
            {},
            config.ulid,
        )
        expect(config.services.mcpHub.readResource).toHaveBeenCalledExactlyOnceWith("documents@workspace-a", "repo://policy")
    })

    it("rereads capabilities on restored explicit Retry and evaluates only retryRecipe.task", async () => {
        await put(".agents/rules/scoped.md", "---\npaths: [src/**]\n---\nSCOPED_RETRY_RULE")
        const yamlPath = await put(
            ".agents/subagents/reviewer.yml",
            "---\nname: reviewer\ndescription: Review changes\ntools: [load_skill]\nrules: [{scope: workspace, path: scoped.md}]\nskills: [child-skill]\n---\nReview carefully.",
        )
        const activities = new TaskActivityStore(config.taskId)
        config.activityStore = activities
        activities.create({
            activityId: "restored-review",
            kind: "subagent",
            executionMode: "background",
            title: "reviewer",
            retryRecipe: {
                kind: "subagent",
                schemaVersion: 1,
                subagentName: "reviewer",
                task: "Inspect docs/guide.md",
                prompt: "<task>Inspect docs/guide.md</task><context>Parent edits src/parent.ts</context>",
                timeoutSeconds: 30,
                retryable: true,
            },
        })
        activities.update("restored-review", { status: "failed", error: "PREVIOUS_FAILURE" })
        try {
            expect(await restoreSubagentActivityRetry(config, "restored-review")).toBe(true)
            await fs.writeFile(
                yamlPath,
                "---\nname: reviewer\ndescription: Review changes\ntools: [load_skill]\nrules: [{scope: workspace, path: scoped.md}]\nskills: [parent-skill]\n---\nReview carefully.",
            )
            replies.push([call(DlineDefaultTool.LOAD_SKILL, { name: "parent-skill" })])
            expect(await activities.retry(["restored-review"])).toEqual(["restored-review"])
            await vi.waitFor(() => expect(activities.get("restored-review")?.status).toBe("completed"))
            expect(activities.get("restored-review")?.currentAttempt).toBe(2)
            expect(requests[0].system).toContain("PARENT_SKILL_CATALOG")
            expect(requests[0].system).not.toMatch(/CHILD_SKILL_CATALOG|SCOPED_RETRY_RULE/)
            expect(JSON.stringify(requests[1].messages)).toContain("PARENT_SKILL_BODY")
        } finally {
            activities.dispose()
        }
    })

    it.each([
        "single",
        "batch",
    ])("binds original task and resolved YAML rereads in real %s handler input/output", async (kind) => {
        await put(".agents/rules/scoped.md", "---\npaths: [src/**]\n---\nSCOPED_HANDLER_RULE")
        await put(".agents/rules/new.md", "REREAD_HANDLER_RULE")
        const yamlPath = await put(
            ".agents/subagents/reviewer.yml",
            "---\nname: reviewer\ndescription: Review changes\ntools: [attempt_completion]\nrules: [{scope: workspace, path: scoped.md}]\n---\nReview carefully.",
        )
        const params = { agent_name: "reviewer", task: "Inspect docs/guide.md", context: "Parent edits src/parent.ts" }
        const block = {
            type: "tool_use",
            name: kind === "single" ? DlineDefaultTool.USE_SUBAGENT : DlineDefaultTool.USE_SUBAGENTS,
            params: kind === "single" ? params : { subagents: JSON.stringify([params]) },
            ts: 1,
            partial: false,
        } as ToolUse
        const handler = kind === "single" ? new UseSubagentToolHandler() : new UseSubagentsToolHandler()
        expect((await handler.prepare(config, block)).outcome).toBe("prepared")
        // Editing after prepare proves run startup rereads the same resolved file.
        await fs.writeFile(
            yamlPath,
            "---\nname: reviewer\ndescription: Review changes\ntools: [attempt_completion]\nrules: [{scope: workspace, path: scoped.md}, {scope: workspace, path: new.md}]\n---\nReview carefully.",
        )
        const response = await handler.execute(config, block)
        expect(String(response)).toContain("COMPLETE")
        expect(requests[0].system).not.toContain("SCOPED_HANDLER_RULE")
        expect(requests[0].system).toContain("REREAD_HANDLER_RULE")
        expect(requests[0].system).not.toContain("CHILD_SKILL_CATALOG")
        expect(JSON.stringify(requests[0].messages)).toContain("src/parent.ts")
    })
})
