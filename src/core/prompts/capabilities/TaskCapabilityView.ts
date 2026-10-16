import { parseRemoteSkillEntries } from "@core/context/instructions/user-instructions/skills"
import type { StateManager } from "@core/storage/StateManager"
import { resolveCapabilityToggles } from "@core/storage/settings/capability-toggle-store"
import type { ClineRulesToggles } from "@shared/cline-rules"
import type { GlobalInstructionsFile } from "@shared/remote-config/schema"
import type { SkillMetadata } from "@shared/skills"
import {
    createTaskCapabilityToggles,
    reconcileTaskCapabilityToggles,
    type TaskCapabilityToggles,
} from "@shared/TaskCapabilityToggles"
import { type CapabilitySourceSnapshot, type CapabilityToggleState, projectAvailableSkills } from "./CapabilitiesAggregator"

interface RuleToggleProjection {
    readonly globalClineRulesToggles: ClineRulesToggles
    readonly localClineRulesToggles: ClineRulesToggles
    readonly localCursorRulesToggles: ClineRulesToggles
    readonly localWindsurfRulesToggles: ClineRulesToggles
    readonly localAgentsRulesToggles: ClineRulesToggles
}

export interface ProjectTaskCapabilityViewInput {
    readonly sources: CapabilitySourceSnapshot
    readonly stateManager: StateManager
    readonly currentTaskToggles: TaskCapabilityToggles
    readonly rules: RuleToggleProjection
    readonly remoteSkillEntries: GlobalInstructionsFile[]
    readonly remoteRuleEntries: readonly GlobalInstructionsFile[]
    readonly remoteWorkflowEntries: readonly GlobalInstructionsFile[]
    readonly mcpServers: readonly { readonly name: string; readonly disabled?: boolean }[]
}

export interface TaskCapabilityView {
    readonly taskCapabilityToggles: TaskCapabilityToggles
    readonly capabilityToggleState: CapabilityToggleState
    readonly availableSkills: SkillMetadata[]
    readonly counts: {
        readonly workflows: number
        readonly skills: number
        readonly availableSkills: number
        readonly subagents: number
    }
}

function discoveredPaths(paths: readonly (string | undefined)[]): ClineRulesToggles {
    return Object.fromEntries(
        paths.filter((candidate): candidate is string => candidate !== undefined).map((candidate) => [candidate, true]),
    )
}

/** Project one immutable workspace source snapshot through current scope and Task toggles. */
export function projectTaskCapabilityView(input: ProjectTaskCapabilityViewInput): TaskCapabilityView {
    const { sources, stateManager } = input
    const globalWorkflowSources = sources.workflows.filter((source) => source.source === "global")
    const localWorkflowSources = sources.workflows.filter((source) => source.source === "project")
    const globalWorkflowToggles = resolveCapabilityToggles(
        stateManager,
        "workflows",
        discoveredPaths(globalWorkflowSources.map((source) => source.path)),
    )
    const localWorkflowToggles = resolveCapabilityToggles(
        stateManager,
        "workflows",
        discoveredPaths(localWorkflowSources.map((source) => source.path)),
    )

    const globalSkillSources = sources.skills.filter(
        (source) => source.skill.source === "global" && !source.skill.path.startsWith("remote:"),
    )
    const localSkillSources = sources.skills.filter((source) => source.skill.source === "project")
    const globalSkillsToggles = resolveCapabilityToggles(
        stateManager,
        "skills",
        discoveredPaths(globalSkillSources.map((source) => source.skill.path)),
    )
    const localSkillsToggles = resolveCapabilityToggles(
        stateManager,
        "skills",
        discoveredPaths(localSkillSources.map((source) => source.skill.path)),
    )

    const localSubagentSources = sources.subagents.filter((source) => source.source === "project" && source.path !== undefined)
    const localSubagentNames = new Set(localSubagentSources.map((source) => source.entry.name))
    const globalSubagentSources = sources.subagents.filter(
        (source) => source.source === "global" && source.path !== undefined && !localSubagentNames.has(source.entry.name),
    )
    const globalSubagentsToggles = resolveCapabilityToggles(
        stateManager,
        "subagents",
        discoveredPaths(globalSubagentSources.map((source) => source.path)),
    )
    const localSubagentsToggles = resolveCapabilityToggles(
        stateManager,
        "subagents",
        discoveredPaths(localSubagentSources.map((source) => source.path)),
    )

    const remoteSkillsToggles = stateManager.getGlobalStateKey("remoteSkillsToggles") ?? {}
    const remoteRulesToggles = stateManager.getGlobalStateKey("remoteRulesToggles") ?? {}
    const remoteWorkflowToggles = stateManager.getGlobalStateKey("remoteWorkflowToggles") ?? {}
    const discoveredTaskToggles = createTaskCapabilityToggles({
        ...input.rules,
        globalWorkflowToggles,
        localWorkflowToggles,
        globalSkillsToggles,
        localSkillsToggles,
        remoteSkillsToggles: Object.fromEntries(
            parseRemoteSkillEntries(input.remoteSkillEntries).map((skill) => [
                skill.name,
                skill.alwaysEnabled || remoteSkillsToggles[skill.name] !== false,
            ]),
        ),
        remoteRulesToggles: Object.fromEntries(
            input.remoteRuleEntries.map((rule) => [rule.name, rule.alwaysEnabled || remoteRulesToggles[rule.name] !== false]),
        ),
        remoteWorkflowToggles: Object.fromEntries(
            input.remoteWorkflowEntries.map((workflow) => [
                workflow.name,
                workflow.alwaysEnabled || remoteWorkflowToggles[workflow.name] !== false,
            ]),
        ),
        globalSubagentsToggles,
        localSubagentsToggles,
        mcpServers: Object.fromEntries(input.mcpServers.map((server) => [server.name, server.disabled !== true])),
    })
    const taskCapabilityToggles = reconcileTaskCapabilityToggles(input.currentTaskToggles, discoveredTaskToggles)
    const capabilityToggleState: CapabilityToggleState = {
        remoteSkillEntries: input.remoteSkillEntries,
        globalSkillsToggles: taskCapabilityToggles.globalSkillsToggles,
        localSkillsToggles: taskCapabilityToggles.localSkillsToggles,
        remoteSkillsToggles: taskCapabilityToggles.remoteSkillsToggles,
        workflowToggles: taskCapabilityToggles.localWorkflowToggles,
        globalWorkflowToggles: taskCapabilityToggles.globalWorkflowToggles,
        remoteWorkflowEntries: input.remoteWorkflowEntries,
        remoteWorkflowToggles: taskCapabilityToggles.remoteWorkflowToggles,
        subagentToggles: taskCapabilityToggles.localSubagentsToggles,
        globalSubagentToggles: taskCapabilityToggles.globalSubagentsToggles,
    }
    const availableSkills = projectAvailableSkills(sources, capabilityToggleState)

    return {
        taskCapabilityToggles,
        capabilityToggleState,
        availableSkills,
        counts: {
            workflows: globalWorkflowSources.length + localWorkflowSources.length,
            skills: globalSkillSources.length + localSkillSources.length,
            availableSkills: availableSkills.length,
            subagents: globalSubagentSources.length + localSubagentSources.length,
        },
    }
}
