import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { McpServer } from "@shared/mcp"
import { createTaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import { describe, expect, it, vi } from "vitest"
import type { SubagentCapabilitySelection } from "../subagent/SubagentCapabilitySelection"
import type { TaskConfig } from "../types/TaskConfig"
import { LoadCapabilityService } from "./LoadCapabilityService"

const telemetryMocks = vi.hoisted(() => ({
    captureSkillUsed: vi.fn(),
    safeCapture: vi.fn((capture: () => unknown) => capture()),
}))

vi.mock("@core/api", () => ({ resolveProvider: vi.fn().mockReturnValue("openai") }))
vi.mock("@/services/telemetry", () => ({ telemetryService: telemetryMocks }))

function createConfig(remoteWorkflowEnabled: boolean, remoteSkillEnabled = true): TaskConfig {
    return {
        cwd: "E:/workspace/project",
        ulid: "task-123",
        capabilityToggles: createTaskCapabilityToggles({
            remoteWorkflowToggles: { "review-release": remoteWorkflowEnabled },
            remoteSkillsToggles: { reviewer: remoteSkillEnabled },
        }),
        api: {
            getModel: vi.fn().mockReturnValue({ id: "test-model" }),
        },
        services: {
            mcpHub: {
                getServers: vi.fn().mockReturnValue([]),
            },
            stateManager: {
                getRemoteConfigSettings: vi.fn().mockReturnValue({
                    remoteGlobalWorkflows: [
                        {
                            name: "review-release",
                            contents: "---\ndescription: Review a release\n---\nCheck the release.",
                            alwaysEnabled: false,
                        },
                    ],
                    remoteGlobalSkills: [
                        {
                            name: "reviewer",
                            contents: "---\nname: reviewer\ndescription: Review code\n---\nReview carefully.",
                            alwaysEnabled: false,
                        },
                    ],
                }),
                getGlobalStateKey: vi.fn().mockReturnValue({ "review-release": true }),
                getGlobalSettingsKey: vi.fn((key: string) => (key === "mode" ? "act" : {})),
                getApiConfiguration: vi.fn().mockReturnValue({ actModeProfile: "test-profile" }),
                getWorkspaceStateKey: vi.fn().mockReturnValue({}),
            },
        },
    } as unknown as TaskConfig
}

describe("LoadCapabilityService task capability scope", () => {
    it("does not load a remote workflow disabled in the current task", async () => {
        const payload = await new LoadCapabilityService().load("workflow", "review-release", createConfig(false))

        expect(payload.status).toBe("failed")
        expect(payload.error).toContain("Unknown or disabled workflow")
    })

    it("loads a remote workflow enabled in the current task", async () => {
        const payload = await new LoadCapabilityService().load("workflow", "review-release", createConfig(true))

        expect(payload.status).toBe("completed")
        expect(payload.body).toBe("Check the release.")
    })

    it("does not load a remote skill disabled in the current task", async () => {
        telemetryMocks.captureSkillUsed.mockClear()
        const payload = await new LoadCapabilityService().load("skill", "reviewer", createConfig(true, false))

        expect(payload.status).toBe("failed")
        expect(payload.error).toContain("Unknown or disabled skill")
        expect(telemetryMocks.captureSkillUsed).not.toHaveBeenCalled()
    })

    it("loads remote Skill instructions and records telemetry on the single success path", async () => {
        telemetryMocks.captureSkillUsed.mockClear()
        const payload = await new LoadCapabilityService().load("skill", "reviewer", createConfig(true))

        expect(payload.status).toBe("completed")
        expect(payload.body).toBe("Review carefully.")
        expect(telemetryMocks.captureSkillUsed).toHaveBeenCalledWith({
            ulid: "task-123",
            skillName: "reviewer",
            skillSource: "global",
            skillsAvailableGlobal: 1,
            skillsAvailableProject: 0,
            provider: "openai",
            modelId: "test-model",
        })
    })

    it("does not load an MCP tool disabled in the current task", async () => {
        const config = createConfig(true)
        config.capabilityToggles.mcpServers["shared-server"] = false
        vi.mocked(config.services.mcpHub.getServers).mockReturnValue([
            {
                name: "shared-server",
                status: "connected",
                disabled: false,
                config: "{}",
                tools: [{ name: "lookup", description: "Lookup" }],
                resources: [],
                resourceTemplates: [],
                prompts: [],
            },
        ])

        const payload = await new LoadCapabilityService().load("mcp", "shared-server.lookup", config)

        expect(payload.status).toBe("failed")
        expect(payload.error).toContain("Unknown or unavailable MCP tool")
    })
})

function selectedConfig(overrides: Partial<SubagentCapabilitySelection> = {}): TaskConfig {
    const config = createConfig(false, false)
    const selection: SubagentCapabilitySelection = {
        skills: [{ name: "reviewer", description: "Frozen review", path: "remote:reviewer", source: "global" }],
        remoteSkillEntries: [
            {
                name: "reviewer",
                alwaysEnabled: false,
                contents: "---\nname: reviewer\ndescription: Frozen review\n---\nFROZEN_SKILL_INSTRUCTIONS",
            },
        ],
        workflows: [
            {
                name: "review-release",
                description: "Frozen release",
                path: "remote:review-release",
                source: "remote",
                body: "FROZEN_WORKFLOW_PROCEDURE",
            },
        ],
        mcpServers: [],
        capabilities: { skills: [], workflows: [], mcp: [], subagents: [] },
        capabilityToggles: createTaskCapabilityToggles({}),
        ruleInstructions: {},
        ...overrides,
    }
    return { ...config, isSubagentExecution: true, subagentCapabilitySelection: selection }
}

function selectedServer(): McpServer {
    return {
        name: "docs@owner-a",
        displayName: "Documents",
        config: "{}",
        status: "connected",
        tools: [
            {
                name: "lookup",
                description: "Frozen lookup",
                inputSchema: { type: "object", properties: { id: { type: "string" } } },
            },
        ],
        resources: [{ uri: "repo://policy", name: "Policy" }],
    }
}

describe("LoadCapabilityService frozen child selection", () => {
    it("loads selected skill and workflow bodies independently of parent false toggles and later remote edits", async () => {
        const config = selectedConfig()
        vi.mocked(config.services.stateManager.getRemoteConfigSettings).mockReturnValue({
            remoteGlobalSkills: [{ name: "reviewer", contents: "LIVE_PARENT_SKILL", alwaysEnabled: false }],
            remoteGlobalWorkflows: [{ name: "review-release", contents: "LIVE_PARENT_WORKFLOW", alwaysEnabled: false }],
        } as never)
        const service = new LoadCapabilityService()

        const skill = await service.load("skill", "reviewer", config)
        const workflow = await service.load("workflow", "review-release", config)

        expect(skill).toMatchObject({ status: "completed", source: "remote", body: "FROZEN_SKILL_INSTRUCTIONS" })
        expect(workflow).toMatchObject({ status: "completed", source: "remote", body: "FROZEN_WORKFLOW_PROCEDURE" })
        expect(config.services.stateManager.getRemoteConfigSettings).not.toHaveBeenCalled()
    })

    it("does not grant parent-only or sibling names when guessed", async () => {
        const config = selectedConfig({ skills: [], workflows: [], remoteSkillEntries: [] })
        config.capabilityToggles.remoteSkillsToggles.reviewer = true
        config.capabilityToggles.remoteWorkflowToggles["review-release"] = true
        const service = new LoadCapabilityService()

        expect((await service.load("skill", "reviewer", config)).status).toBe("failed")
        expect((await service.load("workflow", "review-release", config)).status).toBe("failed")
        expect(config.services.stateManager.getRemoteConfigSettings).not.toHaveBeenCalled()
        expect((await service.load("skill", "reviewer", selectedConfig())).body).toBe("FROZEN_SKILL_INSTRUCTIONS")
    })

    it("reads the selected skill path, not a same-name parent or newly discovered replacement", async () => {
        const temp = await fs.mkdtemp(path.join(os.tmpdir(), "child-skill-load-"))
        try {
            const selectedPath = path.join(temp, "selected", "SKILL.md")
            const replacementPath = path.join(temp, ".agents", "skills", "reviewer", "SKILL.md")
            await fs.mkdir(path.dirname(selectedPath), { recursive: true })
            await fs.mkdir(path.dirname(replacementPath), { recursive: true })
            await fs.writeFile(selectedPath, "---\nname: reviewer\ndescription: Selected source\n---\nSELECTED_DISK_SKILL")
            await fs.writeFile(replacementPath, "---\nname: reviewer\ndescription: Replacement source\n---\nWRONG_REPLACEMENT")
            const config = selectedConfig({
                skills: [{ name: "reviewer", description: "Selected source", path: selectedPath, source: "global" }],
                remoteSkillEntries: [],
            })
            config.cwd = temp
            const service = new LoadCapabilityService()

            expect((await service.load("skill", "reviewer", config)).body).toBe("SELECTED_DISK_SKILL")
            await fs.rm(selectedPath)
            const missing = await service.load("skill", "reviewer", config)
            expect(missing.status).toBe("failed")
            expect(missing.body).toBeUndefined()
        } finally {
            await fs.rm(temp, { recursive: true, force: true })
        }
    })

    it("requires exact server.tool and loads frozen metadata only while the selected owner target is live", async () => {
        const server = selectedServer()
        const config = selectedConfig({ mcpServers: [server] })
        config.capabilityToggles.mcpServers[server.name] = true
        const live = structuredClone(server)
        live.tools![0].description = "CHANGED_LIVE_DESCRIPTION"
        live.tools![0].inputSchema = { type: "number" }
        live.tools!.push({ name: "unselected", inputSchema: { type: "boolean" } })
        config.getMcpServersForOwner = vi.fn(() => [live])
        const service = new LoadCapabilityService()

        expect((await service.load("mcp", "lookup", config)).status).toBe("failed")
        expect((await service.load("mcp", `${server.name}.unselected`, config)).status).toBe("failed")
        const payload = await service.load("mcp", `${server.name}.lookup`, config)
        expect(payload.status).toBe("completed")
        expect(payload.details?.find((detail) => detail.label === "Description")?.value).toBe("Frozen lookup")
        expect(payload.details?.find((detail) => detail.label === "Input schema")?.value).toEqual({
            type: "object",
            properties: { id: { type: "string" } },
        })
        live.status = "disconnected"
        expect((await service.load("mcp", `${server.name}.lookup`, config)).status).toBe("failed")
        expect(config.services.mcpHub.getServers).not.toHaveBeenCalled()
    })

    it("refuses missing or foreign owner visibility without falling back to Hub.getServers", async () => {
        const server = selectedServer()
        const config = selectedConfig({ mcpServers: [server] })
        config.capabilityToggles.mcpServers[server.name] = true
        vi.mocked(config.services.mcpHub.getServers).mockReturnValue([server])
        const service = new LoadCapabilityService()

        expect((await service.load("mcp", `${server.name}.lookup`, config)).status).toBe("failed")
        config.getMcpServersForOwner = () => [{ ...server, name: "docs@owner-b" }]
        expect((await service.load("mcp", `${server.name}.lookup`, config)).status).toBe("failed")
        expect(config.services.mcpHub.getServers).not.toHaveBeenCalled()
    })

    it("fails closed for real child execution without a prepared selection", async () => {
        const config = { ...createConfig(true), isSubagentExecution: true }
        const service = new LoadCapabilityService()
        for (const [kind, name] of [
            ["skill", "reviewer"],
            ["workflow", "review-release"],
            ["mcp", "shared-server.lookup"],
        ] as const) {
            const payload = await service.load(kind, name, config)
            expect(payload).toMatchObject({ status: "failed", enabled: false })
        }
        expect(config.services.stateManager.getRemoteConfigSettings).not.toHaveBeenCalled()
        expect(config.services.mcpHub.getServers).not.toHaveBeenCalled()
    })
})
