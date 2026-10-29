import { DlineDefaultTool } from "@shared/tools"
import type { ConversationViewEntry } from "../executors/provider/service/JournalConversationView"
import type { ExplicitInstructionDeclaration } from "../explicit-instructions/types"
import type { JournalWatermark, TaskState } from "../kernel"
import type { TaskPayloadStore } from "../stores"
import { decodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { ProviderFinalEnvelope, ToolInvocationEnvelope } from "../stores/payload/TaskPayloadEnvelopes"
import { approvalInteractionId } from "../tools/approval-interaction"

const PROVIDER_FINAL_OPERATION_PREFIX = "provider.final:"
const PROVIDER_REPLY_KINDS: ReadonlySet<string> = new Set(["provider_final", "provider_interrupted"])

type TurnBlock = TaskState["turn"]["blocks"][number]

/** The durable request a New Task approval restored after a restart was planned from. */
export interface RestoredNewTaskApproval {
    readonly turnId: string
    /** The conversation the request was sent with: everything before its reply. */
    readonly through: JournalWatermark
}

/**
 * Locate the request behind the one New Task approval a restarted task still awaits.
 *
 * Turn authority lives in memory, so a restart loses the grant the approved call
 * needs. Re-granting it is only safe when the durable evidence names exactly one
 * awaiting `new_task` call, the kernel approval that owns it, and the single
 * reply of the same turn that planned it. Anything else stays closed and the
 * call is denied as it would be without the evidence.
 */
export async function locateRestoredNewTaskApproval(
    state: Readonly<TaskState>,
    entries: readonly ConversationViewEntry[],
    payloads: TaskPayloadStore,
): Promise<RestoredNewTaskApproval | undefined> {
    const turnId = state.turn.turnId
    if (turnId === undefined) return undefined
    const block = await soleAwaitingNewTaskBlock(state, payloads)
    if (!block || !ownsKernelApproval(state, turnId, block)) return undefined
    const replies = entries.filter(
        (item) =>
            item.kind === "provider_final" &&
            item.entry.causation?.turnId === turnId &&
            item.entry.operationId.startsWith(PROVIDER_FINAL_OPERATION_PREFIX),
    )
    if (replies.length !== 1) return undefined
    const reply = replies[0].entry
    const final = decodeTaskPayload<ProviderFinalEnvelope>(await payloads.read(reply.payloadRef))
    if (final.kind !== "provider_final") return undefined
    const planned = final.turnPlan.blocks.some(
        (plan) => plan.blockId === block.blockId && plan.invocationRef === block.invocationRef,
    )
    if (!planned) return undefined
    return { turnId, through: { seq: reply.watermark.seq - 1 } }
}

/**
 * Declarations the restored request's admitted inputs carried.
 *
 * The provider draft that listed them is not indexed, so they are read from the
 * journal instead: user inputs composed into this turn, and the terminal
 * manifests written after the previous reply, whose feedback inputs carry the
 * authority of commands typed as an answer to a tool.
 */
export function admittedDeclarationsOf(
    entries: readonly ConversationViewEntry[],
    turnId: string,
): readonly ExplicitInstructionDeclaration[] {
    const previousReply = entries.reduce(
        (latest, item) => (PROVIDER_REPLY_KINDS.has(item.kind) ? Math.max(latest, item.entry.watermark.seq) : latest),
        0,
    )
    return entries.flatMap((item) => {
        const admitted =
            (item.kind === "user_input" && item.entry.causation?.turnId === turnId) ||
            (item.kind === "tool_terminal_manifest" && item.entry.watermark.seq > previousReply)
        return admitted ? [...(item.explicitInstructions ?? [])] : []
    })
}

/** The single awaiting block whose durable invocation is a `new_task` call, if exactly one exists. */
async function soleAwaitingNewTaskBlock(state: Readonly<TaskState>, payloads: TaskPayloadStore): Promise<TurnBlock | undefined> {
    const awaiting = state.turn.blocks.filter((block) => block.phase === "awaiting_approval")
    if (awaiting.length === 0) return undefined
    const newTaskBlocks: TurnBlock[] = []
    for (const block of awaiting) {
        const invocation = decodeTaskPayload<ToolInvocationEnvelope>(await payloads.read(block.invocationRef))
        if (invocation.kind !== "tool_invocation" || invocation.toolName !== DlineDefaultTool.NEW_TASK) continue
        if (invocation.dlineTid !== block.blockId) return undefined
        newTaskBlocks.push(block)
    }
    return newTaskBlocks.length === 1 ? newTaskBlocks[0] : undefined
}

/** Whether the kernel approval of this turn, and nothing else, owns the block. */
function ownsKernelApproval(state: Readonly<TaskState>, turnId: string, block: TurnBlock): boolean {
    const approval = state.dialog.approvalsByBlock[block.blockId]
    return (
        approval?.kind === "tool_approval" &&
        approval.turnId === turnId &&
        approval.blockId === block.blockId &&
        approval.interactionId === approvalInteractionId(block.blockId)
    )
}
