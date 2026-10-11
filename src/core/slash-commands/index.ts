import type { ApiProviderInfo } from "@core/api"
import type { ExplicitInstructionDeclaration } from "@core/task/explicit-instructions/types"
import { ClineRulesToggles } from "@shared/cline-rules"
import type { InputSemanticDescriptor } from "@shared/input-semantics/catalog"
import type { CapabilityCommandRef } from "@shared/input-semantics/command-namespace"
import { McpPromptResponse } from "@shared/mcp"
import type { GlobalInstructionsFile } from "@shared/remote-config/schema"
import { resolvePromptProfile } from "@shared/resolve-prompt-profile"
import { pathToCommandName } from "@shared/slashCommands"
import { SLASH_TYPE_DESC } from "@shared/slashContext"
import type { TaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import { ClineDefaultTool } from "@shared/tools"
import fs from "fs/promises"
import { telemetryService } from "@/services/telemetry"
import { Logger } from "@/shared/services/Logger"
import {
    deepPlanningToolResponse,
    explainChangesToolResponse,
    newRuleToolResponse,
    newTaskToolResponse,
    reportBugToolResponse,
} from "../prompts/commands"
import { StateManager } from "../storage/StateManager"
import { mergeScopedToggles, readScopedToggles } from "../storage/settings/capability-toggle-store"

/**
 * Callback type for fetching MCP prompts
 */
export type McpPromptFetcher = (serverName: string, promptName: string) => Promise<McpPromptResponse | null>

type FileBasedWorkflow = {
    fullPath: string
    fileName: string
    isRemote: false
}

type RemoteWorkflow = {
    fullPath: string
    fileName: string
    isRemote: true
    contents: string
}

type Workflow = FileBasedWorkflow | RemoteWorkflow

/** Built-in commands Core expands itself, by the name their instructions are keyed under. */
export type BuiltinCommandName = "newtask" | "smol" | "compact" | "newrule" | "reportbug" | "deep-planning" | "explain-changes"

/**
 * The built-in command each built-in descriptor identity expands to.
 *
 * Keyed by the stable descriptor identity, never by what the user typed, so an
 * alias such as `/smol` and the canonical `/compact` expand identically.
 */
const BUILTIN_COMMAND_BY_DESCRIPTOR: Readonly<Record<string, BuiltinCommandName>> = {
    "command.compact": "compact",
    "command.new_task": "newtask",
    "command.new_rule": "newrule",
    "command.report_bug": "reportbug",
    "command.deep_planning": "deep-planning",
    "command.explain_changes": "explain-changes",
}

/** What a command expands to, named by identity rather than by the text that triggered it. */
export type SlashCommandTarget =
    | { readonly kind: "builtin"; readonly name: BuiltinCommandName }
    | { readonly kind: "capability"; readonly capability: CapabilityCommandRef }

/**
 * The expansion target a catalog descriptor names, when Core can expand it.
 *
 * Discovered descriptors carry their capability reference; built-in ones are
 * matched by identity. A descriptor with neither is not a command Core knows
 * how to expand.
 */
export function slashCommandTargetOf(descriptor: InputSemanticDescriptor): SlashCommandTarget | undefined {
    if (descriptor.kind !== "command") return undefined
    if (descriptor.capability) return { kind: "capability", capability: descriptor.capability }
    const name = BUILTIN_COMMAND_BY_DESCRIPTOR[descriptor.id]
    return name ? { kind: "builtin", name } : undefined
}

export interface SlashCommandExpansion {
    /** Instructions that replace the command in the provider projection. */
    readonly text: string
    readonly needsClinerulesFileCheck: boolean
    /** One-shot tool authority the command grants for its turn. */
    readonly explicitInstructions: readonly ExplicitInstructionDeclaration[]
}

const BUILTIN_EXPLICIT_INSTRUCTIONS: Readonly<Record<string, ExplicitInstructionDeclaration | undefined>> = {
    newtask: { type: "new_task", source: "slash_command", targetTool: ClineDefaultTool.NEW_TASK },
    smol: { type: "summarize_task", source: "manual_compact_command", targetTool: ClineDefaultTool.SUMMARIZE_TASK },
    compact: { type: "summarize_task", source: "manual_compact_command", targetTool: ClineDefaultTool.SUMMARIZE_TASK },
    newrule: { type: "new_rule", source: "slash_command", targetTool: ClineDefaultTool.NEW_RULE },
    reportbug: { type: "report_bug", source: "slash_command", targetTool: ClineDefaultTool.REPORT_BUG },
    "deep-planning": { type: "deep-planning", source: "slash_command", targetTool: ClineDefaultTool.NEW_TASK },
    "explain-changes": {
        type: "explain_changes",
        source: "slash_command",
        targetTool: ClineDefaultTool.GENERATE_EXPLANATION,
    },
}

export interface SlashCommandCapabilityContext {
    cwd: string
    capabilityToggles: TaskCapabilityToggles
    remoteSkills: GlobalInstructionsFile[]
    remoteWorkflows: GlobalInstructionsFile[]
}

export interface SlashCommandExpansionContext {
    readonly localWorkflowToggles: ClineRulesToggles
    readonly globalWorkflowToggles: ClineRulesToggles
    /** Identity used to correlate the expansion with this task incarnation in telemetry. */
    readonly taskIncarnationId: string
    readonly focusChainSettings?: { enabled: boolean }
    readonly enableNativeToolCalls?: boolean
    readonly providerInfo?: Readonly<ApiProviderInfo>
    readonly mcpPromptFetcher?: McpPromptFetcher
    readonly capabilityContext?: SlashCommandCapabilityContext
}

/**
 * Expand one command the user already chose.
 *
 * The command is named by its catalog identity, so nothing here reads user
 * text: a command cannot be discovered, renamed or widened by what surrounds
 * it. Returns `undefined` when the capability behind the command is no longer
 * available - disabled, removed, or unreadable - so admission can refuse the
 * submission instead of sending the trigger as if it had run.
 */
export async function expandSlashCommand(
    target: SlashCommandTarget,
    context: SlashCommandExpansionContext,
): Promise<SlashCommandExpansion | undefined> {
    if (target.kind === "builtin") return expandBuiltinCommand(target.name, context)
    const capability = target.capability
    switch (capability.namespace) {
        case "mcp":
            return expandMcpPrompt(capability.server, capability.prompt, context)
        case "skill":
            return expandSkill(capability.name, context)
        case "workflow":
            return expandWorkflow(capability.name, context)
    }
}

function expandBuiltinCommand(name: BuiltinCommandName, context: SlashCommandExpansionContext): SlashCommandExpansion {
    const promptProfile = resolvePromptProfile({
        modelId: context.providerInfo?.model.id,
        contextWindow: context.providerInfo?.model.info.capabilities?.contextWindow,
    })
    const commandFocusChainSettings = promptProfile === "standard" ? context.focusChainSettings : undefined
    const replacements: Readonly<Record<BuiltinCommandName, () => string>> = {
        newtask: newTaskToolResponse,
        smol: () => "",
        compact: () => "",
        newrule: newRuleToolResponse,
        reportbug: reportBugToolResponse,
        "deep-planning": () =>
            deepPlanningToolResponse(
                promptProfile,
                commandFocusChainSettings,
                context.providerInfo,
                context.enableNativeToolCalls,
            ),
        "explain-changes": explainChangesToolResponse,
    }
    telemetryService.captureSlashCommandUsed(context.taskIncarnationId, name, "builtin")
    const declaration = BUILTIN_EXPLICIT_INSTRUCTIONS[name]
    return {
        text: replacements[name](),
        needsClinerulesFileCheck: name === "newrule",
        explicitInstructions: declaration ? [declaration] : [],
    }
}

async function expandMcpPrompt(
    serverName: string,
    promptName: string,
    context: SlashCommandExpansionContext,
): Promise<SlashCommandExpansion | undefined> {
    const commandName = `mcp:${serverName}:${promptName}`
    if (!context.mcpPromptFetcher) return undefined
    if (context.capabilityContext?.capabilityToggles.mcpServers[serverName] !== true) return undefined
    try {
        const promptResponse = await context.mcpPromptFetcher(serverName, promptName)
        if (!promptResponse) {
            Logger.debug(`MCP prompt not found: ${commandName}`)
            return undefined
        }
        telemetryService.captureSlashCommandUsed(context.taskIncarnationId, commandName, "mcp_prompt")
        return {
            text: `<mcp_prompt server="${serverName}" prompt="${promptName}">\n${formatMcpPromptResponse(promptResponse)}\n</mcp_prompt>\n`,
            needsClinerulesFileCheck: false,
            explicitInstructions: [],
        }
    } catch (error) {
        Logger.error(`Error fetching MCP prompt ${commandName}: ${error}`)
        return undefined
    }
}

async function expandSkill(skillName: string, context: SlashCommandExpansionContext): Promise<SlashCommandExpansion | undefined> {
    const { discoverAvailableSkills, getSkillContent } = await import("@core/context/instructions/user-instructions/skills")
    const capabilityContext = context.capabilityContext
    const stateManager = capabilityContext ? undefined : StateManager.get()
    const remoteSkillEntries = capabilityContext?.remoteSkills ?? stateManager?.getRemoteConfigSettings().remoteGlobalSkills ?? []
    const availableSkills = await discoverAvailableSkills(capabilityContext?.cwd ?? "", {
        remoteSkillEntries,
        globalSkillsToggles:
            capabilityContext?.capabilityToggles.globalSkillsToggles ??
            stateManager?.getGlobalSettingsKey("globalSkillsToggles") ??
            {},
        localSkillsToggles:
            capabilityContext?.capabilityToggles.localSkillsToggles ??
            (stateManager ? mergeScopedToggles(readScopedToggles(stateManager, "skills")) : {}),
        remoteSkillsToggles:
            capabilityContext?.capabilityToggles.remoteSkillsToggles ??
            stateManager?.getGlobalStateKey("remoteSkillsToggles") ??
            {},
    })
    const skillContent = await getSkillContent(skillName, availableSkills, remoteSkillEntries)
    if (!skillContent) return undefined
    telemetryService.captureSlashCommandUsed(context.taskIncarnationId, `skills:${skillName}`, "skill")
    return {
        text: `<explicit_instructions type="skill" name="${skillName}" desc="${SLASH_TYPE_DESC.skill}">\n${skillContent.instructions}\n</explicit_instructions>\n`,
        needsClinerulesFileCheck: false,
        explicitInstructions: [{ type: "skill", source: "skill_injection", metadata: { name: skillName } }],
    }
}

/** Every workflow the task may run, named the way the catalog names them. */
function enabledWorkflows(context: SlashCommandExpansionContext): readonly Workflow[] {
    const fromToggles = (toggles: ClineRulesToggles): Workflow[] =>
        Object.entries(toggles)
            .filter(([_, enabled]) => enabled)
            .map(([filePath]) => ({ fullPath: filePath, fileName: pathToCommandName(filePath), isRemote: false }))

    const capabilityContext = context.capabilityContext
    const stateManager = capabilityContext ? undefined : StateManager.get()
    const remoteWorkflows =
        capabilityContext?.remoteWorkflows ?? stateManager?.getRemoteConfigSettings().remoteGlobalWorkflows ?? []
    const remoteWorkflowToggles =
        capabilityContext?.capabilityToggles.remoteWorkflowToggles ??
        stateManager?.getGlobalStateKey("remoteWorkflowToggles") ??
        {}
    const remote: Workflow[] = remoteWorkflows
        .filter((workflow) => workflow.alwaysEnabled || remoteWorkflowToggles[workflow.name] !== false)
        .map((workflow) => ({ fullPath: "", fileName: workflow.name, isRemote: true, contents: workflow.contents }))

    return [...fromToggles(context.localWorkflowToggles), ...fromToggles(context.globalWorkflowToggles), ...remote]
}

async function expandWorkflow(name: string, context: SlashCommandExpansionContext): Promise<SlashCommandExpansion | undefined> {
    const workflow = enabledWorkflows(context).find((candidate) => candidate.fileName === name)
    if (!workflow) return undefined
    try {
        const content = workflow.isRemote ? workflow.contents.trim() : (await fs.readFile(workflow.fullPath, "utf8")).trim()
        telemetryService.captureSlashCommandUsed(context.taskIncarnationId, `workflow:${name}`, "workflow")
        return {
            text: `<explicit_instructions type="workflow" name="${workflow.fileName}" desc="${SLASH_TYPE_DESC.workflow}">\n${content}\n</explicit_instructions>\n`,
            needsClinerulesFileCheck: false,
            explicitInstructions: [{ type: "workflow", source: "workflow_injection", metadata: { name: workflow.fileName } }],
        }
    } catch (error) {
        // The path is local configuration; name the workflow, not where it lives.
        Logger.error(`Error reading workflow ${name}: ${error instanceof Error ? error.name : "unknown error"}`)
        return undefined
    }
}

/**
 * Formats MCP prompt response messages into a text format for injection
 */
export function formatMcpPromptResponse(response: McpPromptResponse): string {
    const parts: string[] = []

    if (response.description) {
        parts.push(`Description: ${response.description}`)
    }

    for (const message of response.messages) {
        const roleLabel = message.role === "user" ? "User" : "Assistant"

        if (message.content.type === "text") {
            parts.push(`[${roleLabel}]\n${message.content.text}`)
        } else if (message.content.type === "image") {
            parts.push(`[${roleLabel}]\n[Image: ${message.content.mimeType}]`)
        } else if (message.content.type === "audio") {
            parts.push(`[${roleLabel}]\n[Audio: ${message.content.mimeType}]`)
        } else if (message.content.type === "resource") {
            const resource = message.content.resource
            if (resource.text) {
                parts.push(`[${roleLabel}]\n[Resource: ${resource.uri}]\n${resource.text}`)
            } else {
                parts.push(`[${roleLabel}]\n[Resource: ${resource.uri}]`)
            }
        }
    }

    return parts.join("\n\n")
}
