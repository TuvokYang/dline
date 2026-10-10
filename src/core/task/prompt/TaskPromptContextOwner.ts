import path from "node:path"
import type { ApiProviderInfo } from "@core/api"
import type { WebSearchRoutingPlan } from "@core/api/server-tools"
import { getGlobalClineRules, getLocalClineRules } from "@core/context/instructions/user-instructions/agent-rules"
import {
    getLocalAgentsRules,
    getLocalCursorRules,
    getLocalWindsurfRules,
} from "@core/context/instructions/user-instructions/external-rules"
import { RuleContextBuilder } from "@core/context/instructions/user-instructions/RuleContextBuilder"
import { discoverAvailableSkills } from "@core/context/instructions/user-instructions/skills"
import type { IgnoreController } from "@core/ignore/IgnoreController"
import { resolveAvailableImageModelId } from "@core/image-generation/runtime"
import { formatResponse } from "@core/prompts/responses"
import type { SystemPromptContext } from "@core/prompts/system-prompt"
import { ensureRulesDirectoryExists } from "@core/storage/disk"
import type { StateManager } from "@core/storage/StateManager"
import { isMultiRootEnabled } from "@core/workspace/multi-root-utils"
import type { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import { DEFAULT_LANGUAGE_SETTINGS, getLanguageKey, type LanguageDisplay } from "@shared/Languages"
import { resolvePromptProfile } from "@shared/resolve-prompt-profile"
import type { Mode } from "@shared/storage/types"
import {
    createTaskCapabilityToggles,
    reconcileTaskCapabilityToggles,
    serializeTaskCapabilityToggles,
    type TaskCapabilityToggles,
} from "@shared/TaskCapabilityToggles"
import { DEFAULT_TERMINAL_COMMAND_TIMEOUT_SECONDS } from "@shared/terminal-settings"
import { ClineDefaultTool } from "@shared/tools"
import { recordPerfPhase } from "@/services/telemetry/instrumentation/duration-recorder"
import { PerfDomain } from "@/services/telemetry/instrumentation/perf-domains"
import { ClineClient } from "@/shared/cline"
import { Logger } from "@/shared/services/Logger"
import type { TaskPromptContextHost } from "../composition/TaskSessionPorts"
import type { MessageStateHandler } from "../message-state"
import type { TaskStateManager } from "../TaskStateManager"

interface PromptContextIdentity {
    readonly taskId: string
    readonly cwd: string
}

interface PromptContextWorkspace {
    readonly ignoreController: IgnoreController
    readonly manager?: WorkspaceRootManager
    readonly getPrimaryWorkspaceName: () => string
}

interface PromptContextRuntime {
    readonly getMode: () => Mode
    readonly getTaskCapabilityToggles: () => TaskCapabilityToggles
    readonly shouldUseNativeToolCalls: (providerInfo: Readonly<ApiProviderInfo>) => boolean
    readonly resolveParallelToolCallingEnabled: (providerInfo: Readonly<ApiProviderInfo>) => boolean
    readonly getParentTaskId: () => Promise<string | undefined>
}

export interface TaskPromptContextOwnerOptions {
    readonly identity: PromptContextIdentity
    readonly host: TaskPromptContextHost
    readonly stateManager: StateManager
    readonly taskStateManager: TaskStateManager
    readonly getMessageStateHandler: () => MessageStateHandler
    readonly workspace: PromptContextWorkspace
    readonly runtime: PromptContextRuntime
    readonly terminalExecutionMode: SystemPromptContext["terminalExecutionMode"]
}

/** Builds the mutable capability snapshot and immutable SystemPromptContext for one Task request. */
export class TaskPromptContextOwner {
    constructor(private readonly options: TaskPromptContextOwnerOptions) {}

    async build(
        providerInfo: Readonly<ApiProviderInfo>,
        webToolsEnabled: boolean,
        webSearchRoutingPlan: WebSearchRoutingPlan,
    ): Promise<SystemPromptContext> {
        const startedAt = performance.now()
        let stageStartedAt = startedAt
        const host = await this.options.host.getHostVersion()
        const hostMs = Math.round(performance.now() - stageStartedAt)
        const ide = host?.platform || "Unknown"
        const isCliEnvironment = host.clineType === ClineClient.Cli
        const browserSettings = this.options.stateManager.getGlobalSettingsKey("browserSettings")
        const disableBrowserTool = browserSettings.disableToolUse ?? false
        const modelSupportsBrowserUse =
            providerInfo.model.info.capabilities?.supportsBrowserAction ??
            providerInfo.model.info.capabilities?.supportsImages ??
            false
        const supportsBrowserUse = modelSupportsBrowserUse && !disableBrowserTool
        const preferredLanguageRaw = this.options.stateManager.getGlobalSettingsKey("preferredLanguage")
        const preferredLanguage = getLanguageKey(preferredLanguageRaw as LanguageDisplay)
        const preferredLanguageInstructions =
            preferredLanguage && preferredLanguage !== DEFAULT_LANGUAGE_SETTINGS
                ? `# Preferred Language\n\nSpeak in ${preferredLanguage}.`
                : ""

        stageStartedAt = performance.now()
        const { globalToggles, localToggles } = await this.options.host.refreshClineRules(this.options.identity.cwd)
        const dlineRulesDiscoveryMs = Math.round(performance.now() - stageStartedAt)
        stageStartedAt = performance.now()
        const { windsurfLocalToggles, cursorLocalToggles, agentsLocalToggles } = await this.options.host.refreshExternalRules(
            this.options.identity.cwd,
        )
        const externalRulesDiscoveryMs = Math.round(performance.now() - stageStartedAt)
        stageStartedAt = performance.now()
        const { globalWorkflowToggles, localWorkflowToggles } = await this.options.host.refreshWorkflows(
            this.options.identity.cwd,
        )
        const workflowsDiscoveryMs = Math.round(performance.now() - stageStartedAt)
        stageStartedAt = performance.now()
        const refreshedSkills = await this.options.host.refreshSkills()
        const skillsRefreshMs = Math.round(performance.now() - stageStartedAt)
        stageStartedAt = performance.now()
        const refreshedSubagents = await this.options.host.refreshSubagents()
        const subagentsRefreshMs = Math.round(performance.now() - stageStartedAt)
        const remoteConfigSettings = this.options.stateManager.getRemoteConfigSettings()
        const remoteRulesToggles = this.options.stateManager.getGlobalStateKey("remoteRulesToggles") ?? {}
        const remoteWorkflowToggles = this.options.stateManager.getGlobalStateKey("remoteWorkflowToggles") ?? {}
        const currentTaskToggles = this.options.runtime.getTaskCapabilityToggles()
        const discoveredTaskToggles = createTaskCapabilityToggles({
            globalClineRulesToggles: globalToggles,
            localClineRulesToggles: localToggles,
            localCursorRulesToggles: cursorLocalToggles,
            localWindsurfRulesToggles: windsurfLocalToggles,
            localAgentsRulesToggles: agentsLocalToggles,
            globalWorkflowToggles,
            localWorkflowToggles,
            globalSkillsToggles: Object.fromEntries(
                refreshedSkills.globalSkills
                    .filter((skill) => !skill.path.startsWith("remote:"))
                    .map((skill) => [skill.path, skill.enabled]),
            ),
            localSkillsToggles: Object.fromEntries(refreshedSkills.localSkills.map((skill) => [skill.path, skill.enabled])),
            remoteSkillsToggles: Object.fromEntries(
                refreshedSkills.globalSkills
                    .filter((skill) => skill.path.startsWith("remote:"))
                    .map((skill) => [skill.name, skill.enabled]),
            ),
            remoteRulesToggles: Object.fromEntries(
                (remoteConfigSettings.remoteGlobalRules ?? []).map((rule) => [
                    rule.name,
                    rule.alwaysEnabled || remoteRulesToggles[rule.name] !== false,
                ]),
            ),
            remoteWorkflowToggles: Object.fromEntries(
                (remoteConfigSettings.remoteGlobalWorkflows ?? []).map((workflow) => [
                    workflow.name,
                    workflow.alwaysEnabled || remoteWorkflowToggles[workflow.name] !== false,
                ]),
            ),
            globalSubagentsToggles: Object.fromEntries(
                refreshedSubagents.globalSubagents.map((agent) => [agent.path, agent.enabled]),
            ),
            localSubagentsToggles: Object.fromEntries(
                refreshedSubagents.localSubagents.map((agent) => [agent.path, agent.enabled]),
            ),
            mcpServers: Object.fromEntries(
                this.options.host.getMcpServers().map((server) => [server.name, server.disabled !== true]),
            ),
        })
        const taskCapabilityToggles = reconcileTaskCapabilityToggles(currentTaskToggles, discoveredTaskToggles)
        const serializedTaskToggles = serializeTaskCapabilityToggles(taskCapabilityToggles)
        if (serializedTaskToggles !== this.options.taskStateManager.taskCapabilityToggles) {
            this.options.taskStateManager.setTaskCapabilityToggles(serializedTaskToggles)
        }

        stageStartedAt = performance.now()
        const evaluationContext = await RuleContextBuilder.buildEvaluationContext({
            cwd: this.options.identity.cwd,
            messageStateHandler: this.options.getMessageStateHandler(),
            workspaceManager: this.options.workspace.manager,
        })
        const evaluationContextMs = Math.round(performance.now() - stageStartedAt)

        stageStartedAt = performance.now()
        const globalClineRulesFilePath = await ensureRulesDirectoryExists()
        const globalRules = await getGlobalClineRules(globalClineRulesFilePath, taskCapabilityToggles.globalClineRulesToggles, {
            evaluationContext,
            remoteToggles: taskCapabilityToggles.remoteRulesToggles,
        })
        const globalRulesLoadMs = Math.round(performance.now() - stageStartedAt)
        let globalClineRulesFileInstructions = globalRules.instructions
        if (this.options.stateManager.getGlobalSettingsKey("lazyTeammateModeEnabled")) {
            const { LAZY_TEAMMATE_RULES } = await import("@/core/context/instructions/lazy-teammate-rules")
            globalClineRulesFileInstructions = globalClineRulesFileInstructions
                ? `${globalClineRulesFileInstructions}\n\n${LAZY_TEAMMATE_RULES}`
                : LAZY_TEAMMATE_RULES
        }

        const workspaceName = this.options.workspace.getPrimaryWorkspaceName()
        stageStartedAt = performance.now()
        const localRules = await getLocalClineRules(
            this.options.identity.cwd,
            taskCapabilityToggles.localClineRulesToggles,
            workspaceName,
            { evaluationContext },
        )
        const localClineRulesFileInstructions = localRules.instructions
        const [localCursorRulesFileInstructions, localCursorRulesDirInstructions] = await getLocalCursorRules(
            this.options.identity.cwd,
            taskCapabilityToggles.localCursorRulesToggles,
        )
        const localWindsurfRulesFileInstructions = await getLocalWindsurfRules(
            this.options.identity.cwd,
            taskCapabilityToggles.localWindsurfRulesToggles,
        )
        const localAgentsRulesFileInstructions = await getLocalAgentsRules(
            this.options.identity.cwd,
            taskCapabilityToggles.localAgentsRulesToggles,
        )
        const localRulesLoadMs = Math.round(performance.now() - stageStartedAt)

        const agentIgnoreContent = this.options.workspace.ignoreController.getIgnoreContent("read")
        const clineIgnoreInstructions = agentIgnoreContent
            ? formatResponse.clineIgnoreInstructions(agentIgnoreContent)
            : undefined

        let workspaceRoots: Array<{ path: string; name: string; vcs?: string }> | undefined
        const multiRootEnabled = isMultiRootEnabled(this.options.stateManager)
        if (multiRootEnabled && this.options.workspace.manager) {
            workspaceRoots = this.options.workspace.manager.getRoots().map((root) => ({
                path: root.path,
                name: root.name || path.basename(root.path),
                vcs: root.vcs as string | undefined,
            }))
        }

        const remoteSkillEntries = this.options.stateManager.getRemoteConfigSettings().remoteGlobalSkills || []
        const capabilityToggleState = {
            remoteSkillEntries,
            globalSkillsToggles: taskCapabilityToggles.globalSkillsToggles,
            localSkillsToggles: taskCapabilityToggles.localSkillsToggles,
            remoteSkillsToggles: taskCapabilityToggles.remoteSkillsToggles,
            workflowToggles: taskCapabilityToggles.localWorkflowToggles,
            globalWorkflowToggles: taskCapabilityToggles.globalWorkflowToggles,
            remoteWorkflowEntries: remoteConfigSettings.remoteGlobalWorkflows ?? [],
            remoteWorkflowToggles: taskCapabilityToggles.remoteWorkflowToggles,
            subagentToggles: taskCapabilityToggles.localSubagentsToggles,
            globalSubagentToggles: taskCapabilityToggles.globalSubagentsToggles,
        }
        stageStartedAt = performance.now()
        const availableSkills = await discoverAvailableSkills(this.options.identity.cwd, capabilityToggleState)
        const duplicateSkillsDiscoveryMs = Math.round(performance.now() - stageStartedAt)
        this.recordPerformance({
            startedAt,
            hostMs,
            dlineRulesDiscoveryMs,
            externalRulesDiscoveryMs,
            workflowsDiscoveryMs,
            skillsRefreshMs,
            subagentsRefreshMs,
            evaluationContextMs,
            globalRulesLoadMs,
            localRulesLoadMs,
            duplicateSkillsDiscoveryMs,
            rules: Object.keys(globalToggles).length + Object.keys(localToggles).length,
            workflows: Object.keys(globalWorkflowToggles).length + Object.keys(localWorkflowToggles).length,
            skills: refreshedSkills.globalSkills.length + refreshedSkills.localSkills.length,
            availableSkills: availableSkills.length,
            subagents: refreshedSubagents.globalSubagents.length + refreshedSubagents.localSubagents.length,
        })

        const disableTools: ClineDefaultTool[] = []
        if (providerInfo.mode === "plan") disableTools.push(ClineDefaultTool.ACT_MODE)
        if (await this.options.runtime.getParentTaskId()) disableTools.push(ClineDefaultTool.SPAWN_TASK)

        const boundImageModelId = resolveAvailableImageModelId(this.options.stateManager, {
            taskId: this.options.identity.taskId,
            getCurrentMode: this.options.runtime.getMode,
        })

        return {
            taskId: this.options.identity.taskId,
            promptProfile: resolvePromptProfile({
                modelId: providerInfo.model.id,
                contextWindow: providerInfo.model.info.capabilities?.contextWindow,
            }),
            cwd: this.options.identity.cwd,
            ide,
            providerInfo,
            supportsBrowserUse,
            mcpHub:
                this.options.stateManager.getGlobalSettingsKey("mcpEnabled") === true
                    ? {
                          getServers: () =>
                              this.options.host
                                  .getTaskMcpServers()
                                  .filter((server) => taskCapabilityToggles.mcpServers[server.name] === true),
                      }
                    : undefined,
            skills: availableSkills,
            focusChainSettings: this.options.stateManager.getGlobalSettingsKey("focusChainSettings"),
            globalClineRulesFileInstructions,
            localClineRulesFileInstructions,
            localCursorRulesFileInstructions,
            localCursorRulesDirInstructions,
            localWindsurfRulesFileInstructions,
            localAgentsRulesFileInstructions,
            clineIgnoreInstructions,
            preferredLanguageInstructions,
            browserSettings: this.options.stateManager.getGlobalSettingsKey("browserSettings"),
            yoloModeToggled: this.options.stateManager.getGlobalSettingsKey("yoloModeToggled"),
            subagentsEnabled: this.options.stateManager.getGlobalSettingsKey("subagentsEnabled"),
            clineWebToolsEnabled: webToolsEnabled,
            webSearchRoutingPlan,
            imageGenerationAvailable: boundImageModelId !== undefined,
            imageModelId: boundImageModelId,
            isMultiRootEnabled: multiRootEnabled,
            workspaceRoots,
            isSubagentRun: false,
            isCliEnvironment,
            enableNativeToolCalls: this.options.runtime.shouldUseNativeToolCalls(providerInfo),
            enableParallelToolCalling: this.options.runtime.resolveParallelToolCallingEnabled(providerInfo),
            terminalExecutionMode: this.options.terminalExecutionMode,
            defaultTerminalProfile: this.options.stateManager.getGlobalSettingsKey("defaultTerminalProfile") ?? "default",
            terminalCommandTimeoutSeconds:
                this.options.stateManager.getGlobalSettingsKey("terminalCommandTimeoutSeconds") ??
                DEFAULT_TERMINAL_COMMAND_TIMEOUT_SECONDS,
            disableTools,
            capabilityToggleState,
            taskCapabilityToggles,
        }
    }

    private recordPerformance(input: {
        readonly startedAt: number
        readonly hostMs: number
        readonly dlineRulesDiscoveryMs: number
        readonly externalRulesDiscoveryMs: number
        readonly workflowsDiscoveryMs: number
        readonly skillsRefreshMs: number
        readonly subagentsRefreshMs: number
        readonly evaluationContextMs: number
        readonly globalRulesLoadMs: number
        readonly localRulesLoadMs: number
        readonly duplicateSkillsDiscoveryMs: number
        readonly rules: number
        readonly workflows: number
        readonly skills: number
        readonly availableSkills: number
        readonly subagents: number
    }): void {
        const phases = {
            hostMs: input.hostMs,
            dlineRulesDiscoveryMs: input.dlineRulesDiscoveryMs,
            externalRulesDiscoveryMs: input.externalRulesDiscoveryMs,
            workflowsDiscoveryMs: input.workflowsDiscoveryMs,
            skillsRefreshMs: input.skillsRefreshMs,
            subagentsRefreshMs: input.subagentsRefreshMs,
            evaluationContextMs: input.evaluationContextMs,
            globalRulesLoadMs: input.globalRulesLoadMs,
            localRulesLoadMs: input.localRulesLoadMs,
            duplicateSkillsDiscoveryMs: input.duplicateSkillsDiscoveryMs,
            rules: input.rules,
            workflows: input.workflows,
            skills: input.skills,
            availableSkills: input.availableSkills,
            subagents: input.subagents,
        }
        recordPerfPhase(PerfDomain.PromptBuild, "capability_context", performance.now() - input.startedAt, phases, {
            taskId: this.options.identity.taskId,
        })
        if (Logger.isDebugEnabled()) {
            Logger.debug(
                `[PromptBuildPerf] phase=capability_context taskId=${this.options.identity.taskId} hostMs=${input.hostMs} dlineRulesDiscoveryMs=${input.dlineRulesDiscoveryMs} externalRulesDiscoveryMs=${input.externalRulesDiscoveryMs} workflowsDiscoveryMs=${input.workflowsDiscoveryMs} skillsRefreshMs=${input.skillsRefreshMs} subagentsRefreshMs=${input.subagentsRefreshMs} evaluationContextMs=${input.evaluationContextMs} globalRulesLoadMs=${input.globalRulesLoadMs} localRulesLoadMs=${input.localRulesLoadMs} duplicateSkillsDiscoveryMs=${input.duplicateSkillsDiscoveryMs} totalMs=${Math.round(performance.now() - input.startedAt)} rules=${input.rules} workflows=${input.workflows} skills=${input.skills} availableSkills=${input.availableSkills} subagents=${input.subagents}`,
            )
        }
    }
}
