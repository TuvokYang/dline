import type { BlockId, DialogActionRule, DialogInteraction, TaskState } from "./types"

/**
 * Why a task is offering to resume.
 *
 * This is also the only thing that separates the two offers: a task rebuilt
 * from a snapshot really was restored, while a round stopped inside a live
 * session was not. Naming the reason keeps that fact with the dialog instead
 * of leaving later stages to guess it.
 */
export type RecoveryReason = "interrupted" | "cancelled"

/** One planned recovery dialog, shared by snapshot hydration and live cancellation. */
export interface RecoveryDialogPlan {
    readonly interactionId: string
    readonly turnId: string
    readonly kind: string
    readonly presentationRef: string
    readonly actionRules: readonly DialogActionRule[]
}

/**
 * The interaction kind each reason resumes through.
 *
 * Reusing one kind for both made a cancelled round tell the model its session
 * had been closed and restored, which never happened.
 */
const RECOVERY_KINDS: Readonly<Record<RecoveryReason, string>> = {
    interrupted: "resume",
    cancelled: "cancelled_resume",
}

/**
 * The actions a recovery dialog offers.
 *
 * The kernel cannot read the interaction registry — it stays free of
 * presentation — so these rules are asserted against the registry by test
 * instead, because the surface only renders actions present in both.
 */
export const RECOVERY_ACTION_RULES: readonly DialogActionRule[] = [{ actionId: "resume", payloadPolicy: "draft" }]

export interface RecoveryDialogInput {
    readonly taskId: string
    readonly revision: number
    readonly reason: RecoveryReason
    readonly turnId: string
}

/** Awaiting local tool approvals that remain executable after a process restart. */
export function restorableApprovals(state: Pick<TaskState, "turn" | "dialog">): Readonly<Record<BlockId, DialogInteraction>> {
    const manual = new Set(state.turn.manualApprovalBlockIds)
    const blocks = new Map(state.turn.blocks.map((block) => [block.blockId, block]))
    return Object.fromEntries(
        Object.entries(state.dialog.approvalsByBlock).filter(([blockId, interaction]) => {
            const block = blocks.get(blockId)
            return (
                manual.has(blockId) &&
                block?.phase === "awaiting_approval" &&
                interaction.kind === "tool_approval" &&
                interaction.status !== "failed"
            )
        }),
    )
}

/** Plan the dialog a stopped task offers so the user can put it back to work. */
export function planRecoveryDialog(input: RecoveryDialogInput): RecoveryDialogPlan {
    const kind = RECOVERY_KINDS[input.reason]
    return {
        interactionId: `${input.reason}:${input.taskId}:${input.revision}`,
        turnId: input.turnId,
        kind,
        presentationRef: `${kind}:${input.taskId}:${input.revision}`,
        actionRules: RECOVERY_ACTION_RULES,
    }
}
