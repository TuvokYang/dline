import type { ComposePort, ComposeRoundInput, ComposeRoundResult } from "./ComposeCommandExecutor"
import type { RetainedInputPresentationCommit } from "./RetainedInputPresentationPort"

/**
 * The tool state that decides whether a call follows directly on the previous one.
 *
 * Guards such as the consecutive working_respond block and repeated-call detection compare a
 * call with the one before it. That comparison only holds while the model's own tool results
 * are all that happened in between.
 */
export interface ToolSequencePort {
    /** Forget the previous call so the next one starts a new sequence. */
    interrupt(): void
}

/**
 * Whether a round carries something other than the model's own completed tool results.
 *
 * User input admitted to the round, a queued reply to a dialog, and calls that were refused,
 * cancelled, skipped or failed all come between the previous call and the next one.
 */
export function roundInterruptsToolSequence(input: ComposeRoundInput): boolean {
    if (input.admittedEntryIds.length > 0 || input.queueDelivery !== undefined || input.respondedQueue !== undefined) {
        return true
    }
    return input.toolTerminals?.blocks.some((block) => block.phase !== "completed") ?? false
}

/**
 * Composes rounds through another port and interrupts the tool sequence when a round carries
 * user input or an unfinished call, before the model can answer that round.
 */
export class ToolSequenceBoundaryCompose implements ComposePort {
    constructor(
        private readonly inner: Required<ComposePort>,
        private readonly sequence: ToolSequencePort,
    ) {}

    compose(input: ComposeRoundInput): Promise<ComposeRoundResult> {
        if (roundInterruptsToolSequence(input)) this.sequence.interrupt()
        return this.inner.compose(input)
    }

    preparePresentation(input: ComposeRoundInput): Promise<RetainedInputPresentationCommit | undefined> {
        return this.inner.preparePresentation(input)
    }

    rollbackRetainedQueue(input: ComposeRoundInput): Promise<"released" | "uncertain"> {
        return this.inner.rollbackRetainedQueue(input)
    }
}
