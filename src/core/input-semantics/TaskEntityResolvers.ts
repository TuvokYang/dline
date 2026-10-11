import { type MentionResolutionEnvironment, resolveMention } from "@core/mentions"
import { expandSlashCommand, type SlashCommandExpansionContext, slashCommandTargetOf } from "@core/slash-commands"
import type { InputSemanticDescriptor } from "@shared/input-semantics/catalog"
import type { MentionInputNode } from "@shared/input-semantics/document"
import type {
    SemanticCommandExpanderPort,
    SemanticCommandExpansion,
    SemanticMentionResolverPort,
} from "./SemanticInputAdmissionService"

export type MentionResolutionContext = MentionResolutionEnvironment

/**
 * Resolves one already chosen mention from its typed identity.
 *
 * The kind, reference and workspace come from the node; its source text is
 * never read, so resolution cannot discover a second mention the user did not
 * confirm, nor reinterpret the one they did.
 */
export class TaskMentionResolver implements SemanticMentionResolverPort {
    constructor(private readonly context: () => MentionResolutionContext) {}

    resolve(node: MentionInputNode): Promise<string> {
        return resolveMention(
            {
                kind: node.mentionKind,
                ref: node.canonicalRef,
                ...(node.workspaceHint === undefined ? {} : { workspaceHint: node.workspaceHint }),
            },
            this.context(),
        )
    }
}

export type CommandExpansionContext = SlashCommandExpansionContext

/**
 * Expands one already chosen command from the catalog descriptor it names.
 *
 * The descriptor identity decides what runs; the trigger the user typed is not
 * read again. A command whose capability has gone away since the catalog was
 * published expands to nothing, and admission refuses the submission for it.
 */
export class TaskCommandExpander implements SemanticCommandExpanderPort {
    constructor(private readonly context: () => CommandExpansionContext) {}

    async expand(descriptor: InputSemanticDescriptor): Promise<SemanticCommandExpansion | undefined> {
        const target = slashCommandTargetOf(descriptor)
        if (!target) return undefined
        const expansion = await expandSlashCommand(target, this.context())
        return expansion && { text: expansion.text, explicitInstructions: expansion.explicitInstructions }
    }
}
