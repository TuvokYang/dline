/** Feedback the user typed while approving or rejecting one tool block. */
export interface ToolApprovalFeedback {
    readonly text?: string
    readonly images?: readonly string[]
    readonly files?: readonly string[]
}

/**
 * Carries approval feedback from the response boundary to the tool block it belongs to.
 *
 * The approval dialog is planned by the turn, so the text the user typed while
 * approving arrives through the interaction response rather than through the
 * intake box. Without an explicit owner it has no route into the next provider
 * request at all, and a workflow that answers "approve, but read it this way"
 * silently loses the instruction.
 *
 * Keyed by `blockId` (`dline_tid`) so concurrent approvals cannot absorb each
 * other's feedback, and taken exactly once so a replayed or duplicated response
 * cannot repeat it in a later turn.
 */
export interface ToolApprovalFeedbackLedger {
    record(blockId: string, feedback: ToolApprovalFeedback): void
    take(blockId: string): ToolApprovalFeedback | undefined
    clear(): void
}

/** Whether the user actually contributed something worth sending. */
export function hasApprovalFeedback(feedback: ToolApprovalFeedback): boolean {
    return Boolean(feedback.text?.trim() || feedback.images?.length || feedback.files?.length)
}

/** Task-scoped in-memory ledger; feedback lives only until its block reports a result. */
export class InMemoryToolApprovalFeedbackLedger implements ToolApprovalFeedbackLedger {
    private readonly entries = new Map<string, ToolApprovalFeedback>()

    record(blockId: string, feedback: ToolApprovalFeedback): void {
        if (!hasApprovalFeedback(feedback)) return
        this.entries.set(blockId, feedback)
    }

    take(blockId: string): ToolApprovalFeedback | undefined {
        const entry = this.entries.get(blockId)
        this.entries.delete(blockId)
        return entry
    }

    clear(): void {
        this.entries.clear()
    }
}
