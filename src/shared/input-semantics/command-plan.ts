import {
    isActiveEntity,
    isSlashCommandNode,
    type SemanticInputDocument,
    type SemanticInputNode,
    type SlashCommandInputNode,
    type SlashCommandNamespace,
} from "./document"

export interface SemanticCommandInvocation {
    readonly entityId: string
    readonly commandId: string
    readonly canonicalName: string
    readonly namespace: SlashCommandNamespace
    /** Exactly what the user typed, so expansion never reconstructs the trigger. */
    readonly sourceText: string
}

export interface SemanticCommandPlan {
    /** Composable commands in document order, executed before the barrier. */
    readonly invocations: readonly SemanticCommandInvocation[]
    /** The lifecycle command that closes the command sequence, when the user placed one. */
    readonly barrier?: SemanticCommandInvocation
    /** Ordered nodes after the barrier; they are content for the barrier, never new commands. */
    readonly premessage: readonly SemanticInputNode[]
}

function invocationOf(node: SlashCommandInputNode): SemanticCommandInvocation {
    return {
        entityId: node.entityId,
        commandId: node.commandId,
        canonicalName: node.canonicalName,
        namespace: node.namespace,
        sourceText: node.sourceText,
    }
}

/**
 * Derive the command plan from the ordered document.
 *
 * The plan reads only what the user already confirmed: a command node that is
 * not `recognized` stays content, and nothing after a lifecycle barrier can
 * start a new invocation even when it looks like a command.
 */
export function planSemanticCommands(document: SemanticInputDocument): SemanticCommandPlan {
    const invocations: SemanticCommandInvocation[] = []
    const premessage: SemanticInputNode[] = []
    let barrier: SemanticCommandInvocation | undefined

    for (const node of document.nodes) {
        if (barrier) {
            premessage.push(node)
            continue
        }

        if (!isSlashCommandNode(node) || !isActiveEntity(node)) continue

        if (node.compositionMode === "lifecycle_barrier") {
            barrier = invocationOf(node)
            continue
        }

        invocations.push(invocationOf(node))
    }

    return barrier ? { invocations, barrier, premessage } : { invocations, premessage }
}
