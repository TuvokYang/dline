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

/**
 * Most composable commands one submission may run. Each one adds instructions
 * to the same turn, so beyond this the turn is more likely a paste than intent.
 */
export const MAX_SEMANTIC_COMMAND_INVOCATIONS = 8

/** Why a recognized command was left out of the plan; admission reports it on the node. */
export type SemanticCommandRejection = "duplicate_invocation" | "invocation_limit"

export interface RejectedSemanticCommand {
    readonly entityId: string
    readonly commandId: string
    readonly reason: SemanticCommandRejection
}

export interface SemanticCommandPlan {
    /** Composable commands in document order, executed before the barrier. */
    readonly invocations: readonly SemanticCommandInvocation[]
    /** The lifecycle command that closes the command sequence, when the user placed one. */
    readonly barrier?: SemanticCommandInvocation
    /** Ordered nodes after the barrier; they are content for the barrier, never new commands. */
    readonly premessage: readonly SemanticInputNode[]
    /**
     * Recognized commands that will not run. They must fail closed with a
     * diagnostic on their node, never disappear silently.
     */
    readonly rejected: readonly RejectedSemanticCommand[]
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
 * start a new invocation even when it looks like a command. A command runs at
 * most once per submission, and at most {@link MAX_SEMANTIC_COMMAND_INVOCATIONS}
 * composable commands run; the rest are rejected rather than dropped.
 */
export function planSemanticCommands(document: SemanticInputDocument): SemanticCommandPlan {
    const invocations: SemanticCommandInvocation[] = []
    const premessage: SemanticInputNode[] = []
    const rejected: RejectedSemanticCommand[] = []
    const invoked = new Set<string>()
    let barrier: SemanticCommandInvocation | undefined

    for (const node of document.nodes) {
        if (barrier) {
            premessage.push(node)
            continue
        }

        if (!isSlashCommandNode(node) || !isActiveEntity(node)) continue

        if (invoked.has(node.commandId)) {
            rejected.push({ entityId: node.entityId, commandId: node.commandId, reason: "duplicate_invocation" })
            continue
        }

        if (node.compositionMode === "lifecycle_barrier") {
            barrier = invocationOf(node)
            continue
        }

        if (invocations.length >= MAX_SEMANTIC_COMMAND_INVOCATIONS) {
            rejected.push({ entityId: node.entityId, commandId: node.commandId, reason: "invocation_limit" })
            continue
        }

        invoked.add(node.commandId)
        invocations.push(invocationOf(node))
    }

    return barrier ? { invocations, barrier, premessage, rejected } : { invocations, premessage, rejected }
}
