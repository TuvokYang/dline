import type { ApiProviderInfo } from "@core/api"
import { type MentionPathAccessPolicy, parseMentions } from "@core/mentions"
import { type McpPromptFetcher, parseSlashCommands, type SlashCommandCapabilityContext } from "@core/slash-commands"
import type { WorkspaceRootManager } from "@core/workspace/WorkspaceRootManager"
import type { ClineRulesToggles } from "@shared/cline-rules"
import type { SemanticCommandInvocation } from "@shared/input-semantics/command-plan"
import type { MentionInputNode } from "@shared/input-semantics/document"
import type { FileContextTracker } from "@/core/context/context-tracking/FileContextTracker"
import type { UrlContentFetcher } from "@/services/browser/UrlContentFetcher"
import type {
    SemanticCommandExpanderPort,
    SemanticCommandExpansion,
    SemanticMentionResolverPort,
} from "./SemanticInputAdmissionService"

export interface MentionResolutionContext {
    readonly cwd: string
    readonly urlContentFetcher: UrlContentFetcher
    readonly fileContextTracker?: FileContextTracker
    readonly workspaceManager?: WorkspaceRootManager
    readonly pathAccessPolicy?: MentionPathAccessPolicy
}

/**
 * Resolves one already chosen mention.
 *
 * Only the node's own source text is passed to the resolver, so resolution can
 * never discover a second mention that the user did not confirm.
 */
export class TaskMentionResolver implements SemanticMentionResolverPort {
    constructor(private readonly context: () => MentionResolutionContext) {}

    async resolve(node: MentionInputNode): Promise<string> {
        const context = this.context()
        return parseMentions(
            node.sourceText,
            context.cwd,
            context.urlContentFetcher,
            context.fileContextTracker,
            context.workspaceManager,
            context.pathAccessPolicy,
        )
    }
}

export interface CommandExpansionContext {
    readonly localWorkflowToggles: ClineRulesToggles
    readonly globalWorkflowToggles: ClineRulesToggles
    /** Identity used to correlate the expansion with this task incarnation. */
    readonly taskIncarnationId: string
    readonly focusChainSettings?: { enabled: boolean }
    readonly enableNativeToolCalls?: boolean
    readonly providerInfo?: Readonly<ApiProviderInfo>
    readonly mcpPromptFetcher?: McpPromptFetcher
    readonly capabilityContext?: SlashCommandCapabilityContext
}

/**
 * Expands one already chosen command.
 *
 * The command's own trigger text is the whole input, marked as trusted user text,
 * so expansion no longer depends on locating a user-content tag inside a larger
 * message. That coupling is what made a visible `/compact` fail to register its
 * authorization while the request was still sent as ordinary prose.
 */
export class TaskCommandExpander implements SemanticCommandExpanderPort {
    constructor(private readonly context: () => CommandExpansionContext) {}

    async expand(invocation: SemanticCommandInvocation): Promise<SemanticCommandExpansion> {
        const context = this.context()
        const parsed = await parseSlashCommands(
            invocation.sourceText,
            context.localWorkflowToggles,
            context.globalWorkflowToggles,
            context.taskIncarnationId,
            context.focusChainSettings,
            context.enableNativeToolCalls,
            context.providerInfo,
            context.mcpPromptFetcher,
            context.capabilityContext,
            { trustedUserText: true },
        )
        return { text: parsed.processedText, explicitInstructions: parsed.explicitInstructions }
    }
}
