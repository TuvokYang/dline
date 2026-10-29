import { createTaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import { describe, expect, it, vi } from "vitest"
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
