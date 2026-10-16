import path from "node:path"
import type { StateManager } from "@core/storage/StateManager"
import { createTaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import { describe, expect, it, vi } from "vitest"
import type { CapabilitySourceSnapshot } from "./CapabilitiesAggregator"
import { projectTaskCapabilityView } from "./TaskCapabilityView"

function sources(): CapabilitySourceSnapshot {
    const globalSkill = path.resolve("global/skills/global/SKILL.md")
    const localSkill = path.resolve("workspace/.agents/skills/local/SKILL.md")
    const globalWorkflow = path.resolve("global/workflows/global.md")
    const localWorkflow = path.resolve("workspace/.agents/workflows/local.md")
    const globalSubagent = path.resolve("global/subagents/reviewer.yml")
    const localSubagent = path.resolve("workspace/.agents/subagents/reviewer.yml")
    return {
        skills: [
            {
                skill: { name: "remote", description: "Remote", path: "remote:remote", source: "global" },
                entry: { name: "remote", description: "Remote", contentHash: "remote" },
            },
            {
                skill: { name: "global", description: "Global", path: globalSkill, source: "global" },
                entry: { name: "global", description: "Global", contentHash: "global" },
            },
            {
                skill: { name: "local", description: "Local", path: localSkill, source: "project" },
                entry: { name: "local", description: "Local", contentHash: "local" },
            },
        ],
        workflows: [
            { source: "global", path: globalWorkflow, entry: { name: "global", description: "Global" } },
            { source: "project", path: localWorkflow, entry: { name: "local", description: "Local" } },
            {
                source: "remote",
                path: "remote:remote",
                remoteName: "remote",
                alwaysEnabled: false,
                entry: { name: "remote", description: "Remote" },
            },
        ],
        subagents: [
            { source: "global", path: globalSubagent, entry: { name: "reviewer", description: "Global" } },
            { source: "project", path: localSubagent, entry: { name: "reviewer", description: "Local" } },
            { source: "builtin", entry: { name: "default", description: "Default" } },
        ],
    }
}

describe("projectTaskCapabilityView", () => {
    it("projects shared sources through scope precedence without filesystem discovery", () => {
        const snapshot = sources()
        const localSkill = snapshot.skills.find((source) => source.skill.name === "local")?.skill.path
        if (!localSkill) throw new Error("local skill fixture missing")
        const currentTaskToggles = createTaskCapabilityToggles({ localSkillsToggles: { [localSkill]: true } })
        const stateManager = {
            hasNormalizedCapabilityKeys: true,
            getScopedCapabilityToggles: vi.fn((scope: string, key: string) => {
                if (scope === "workspace" && key === "workspaceSkillsToggles") return { [localSkill]: false }
                return {}
            }),
            getGlobalStateKey: vi.fn((key: string) => {
                if (key === "remoteSkillsToggles" || key === "remoteWorkflowToggles") return { remote: false }
                return undefined
            }),
        } as unknown as StateManager

        const view = projectTaskCapabilityView({
            sources: snapshot,
            stateManager,
            currentTaskToggles,
            rules: {
                globalClineRulesToggles: {},
                localClineRulesToggles: {},
                localCursorRulesToggles: {},
                localWindsurfRulesToggles: {},
                localAgentsRulesToggles: {},
            },
            remoteSkillEntries: [
                {
                    name: "remote",
                    alwaysEnabled: false,
                    contents: "---\nname: remote\ndescription: Remote\n---\nRemote instructions",
                },
            ],
            remoteRuleEntries: [],
            remoteWorkflowEntries: [{ name: "remote", alwaysEnabled: false, contents: "Remote workflow" }],
            mcpServers: [
                { name: "enabled", disabled: false },
                { name: "disabled", disabled: true },
            ],
        })

        expect(view.taskCapabilityToggles.localSkillsToggles[localSkill]).toBe(true)
        expect(view.taskCapabilityToggles.remoteSkillsToggles.remote).toBe(false)
        expect(view.taskCapabilityToggles.remoteWorkflowToggles.remote).toBe(false)
        expect(view.taskCapabilityToggles.globalSubagentsToggles).toEqual({})
        expect(Object.keys(view.taskCapabilityToggles.localSubagentsToggles)).toHaveLength(1)
        expect(view.taskCapabilityToggles.mcpServers).toEqual({ disabled: false, enabled: true })
        expect(view.availableSkills.map((skill) => skill.name)).toEqual(["global", "local"])
        expect(view.counts).toEqual({ workflows: 2, skills: 2, availableSkills: 2, subagents: 1 })
    })
})
