import { getPrompt } from "@core/prompts/i18n"
import type { SemanticInputDocument } from "@shared/input-semantics/document"
import { Logger } from "@shared/services/Logger"
import type { InteractionOutcome } from "../interaction/InteractionProtocol"
import type { QueuedInputResponse } from "../kernel"
import { createResumeSubmissionContext } from "../resume/ResumeProvenance"
import type { EventSubmissionResult } from "../runtime"
import type { TaskInput } from "../shell/TaskShell"

/** One answered dialog that no receiver was waiting for. */
export interface UnownedDialogResolution {
    readonly interactionId: string
    /** The kernel's dialog kind, which says what the continuation is resuming from. */
    readonly kind: string
    readonly outcome: InteractionOutcome
    /** A consumed retained batch may only continue as its original tool result. */
    readonly queuedInput?: QueuedInputResponse
    /** Fences async preparation and resumption against a newer session generation. */
    readonly isCurrent?: () => boolean
}

/**
 * Whether the continuation took responsibility for the answer.
 *
 * The caller retires the interaction only on `continued`, because retiring
 * tells the kernel the answer reached whoever had to act on it. Reporting
 * `declined` or `failed` as success left the task with no dialog and no work
 * in flight, which is indistinguishable from a task that simply stopped.
 */
export type UnownedDialogOutcome = "continued" | "declined" | "failed"

/**
 * Decides what a task does when a dialog it never opened is answered.
 *
 * Most dialogs belong to a receiver: a tool calls `open` and awaits the
 * outcome, so resolving means handing the answer back. The kernel also
 * synthesizes dialogs nobody awaits — the recovery request of an interrupted
 * task, an arrival wakeup, the retry offered after a failed round. Those
 * answers have no waiter, so the task itself has to decide how to carry on.
 *
 * Declared as a port because that decision is host policy, not interaction
 * plumbing: an interactive session resumes by submitting what the user typed,
 * while an automated reviewer or approver resumes without any draft at all.
 */
export interface UnownedDialogContinuationPort {
    /**
     * Whether this continuation will act on the answer.
     *
     * Asked before the interaction is retired, because retiring is what frees
     * the dialog slot for the round the continuation is about to open. Deciding
     * afterwards would leave the answered dialog in place while that round
     * starts, which reorders the task's own events around it.
     */
    accepts(resolution: UnownedDialogResolution): boolean

    /** Make the answer durable before its owner releases the dialog slot. */
    prepare?(resolution: UnownedDialogResolution): Promise<boolean>
    continue(resolution: UnownedDialogResolution): Promise<UnownedDialogOutcome>
}

/** One submission a continuation hands to the task. */
export interface ResumptionInput {
    readonly text?: string
    readonly images?: readonly string[]
    readonly files?: readonly string[]
    readonly context?: string
    readonly semanticInput?: SemanticInputDocument
}

/** The submission path a continuation uses to put the task back to work. */
export interface TaskResumptionPort {
    /** Materialize an input the continuation composes itself, such as the empty submission that resumes a round. */
    materialize(input: ResumptionInput): Promise<TaskInput>
    /**
     * Materialize the user's answer to a dialog.
     *
     * The answer was durable before the continuation ran, so its document keeps
     * the catalog revision it was accepted under; see `TaskInputMaterializer.materializeAnswer`.
     */
    materializeAnswer(input: ResumptionInput): Promise<TaskInput>
    /**
     * Resolves `rejected` when the runtime refuses the input, for example after a
     * phase change or with intake at capacity. That refusal is an expected answer,
     * not a thrown failure, so callers must inspect it.
     */
    submit(input: TaskInput): Promise<EventSubmissionResult>
}

/**
 * The submission a dialog draft is admitted as.
 *
 * A structured draft's flat lists and text only project its resources for
 * receivers that read no structure ("look[shot.png]"). Admitting the document
 * again restores them, and admission requires a structured submission's text
 * to be its document's own, so the document is the one authority for both.
 */
export function dialogAnswerOf(draft: InteractionOutcome["draft"]): ResumptionInput {
    return draft?.semanticInput === undefined
        ? { text: draft?.text, images: draft?.images, files: draft?.files }
        : { text: draft.semanticInput.rawText, semanticInput: draft.semanticInput }
}

/**
 * Hands the request a Retry opens to the user instead of an automatic sequence.
 *
 * Retry answers a request that already failed, so the request it opens belongs
 * to the user: a further failure has to come back to them at once rather than
 * start a new countdown beside the failure they just acted on.
 */
export interface ManualRetryTakeoverPort {
    takeOver(): void
    /** The Retry never opened a request, so the next one keeps its automatic sequence. */
    releaseTakeover(): void
}

/**
 * Actions that end the task rather than carry it on.
 *
 * Expressed as the terminal set because that is the closed one: `start_new_task`
 * abandons this task for a fresh one and `stop` ends the run outright, while
 * every other action is the user answering a question the task asked and
 * expecting it to keep going.
 *
 * Listing the resuming actions instead is what caused the defect this replaces.
 * That list held only `resume` and `retry`, so the `reply` that answers a
 * restored completion, followup, plan, Q&A or report was silently treated as
 * "nothing to do" — the interaction was consumed and the typed message was
 * discarded, leaving the task paused with no dialog and a dead composer.
 *
 * The kernel's `continuation` field is deliberately not consulted here: it says
 * which receiver resumes a live dialog, and an unowned dialog has none by
 * definition. `error_retry` proves the two are independent, since it declares
 * no continuation yet must still put the task back to work.
 */
const TASK_ENDING_ACTIONS: ReadonlySet<InteractionOutcome["actionId"]> = new Set(["start_new_task", "stop"])

/**
 * Resume the task by submitting the answer as an ordinary task input.
 *
 * Going through the normal submission path is deliberate: the draft becomes a
 * durable intake entry, admission reviews it exactly once, and the round it
 * opens is the same compose/provider round any other submission produces. That
 * keeps recovery on the automatic execution path instead of a parallel one.
 */
export class ResumeDialogContinuation implements UnownedDialogContinuationPort {
    constructor(
        private readonly resumption: TaskResumptionPort,
        private readonly resetMistakes?: () => void,
        private readonly providerRetry?: ManualRetryTakeoverPort,
    ) {}

    accepts(resolution: UnownedDialogResolution): boolean {
        return !resolution.queuedInput && !TASK_ENDING_ACTIONS.has(resolution.outcome.actionId)
    }

    async continue(resolution: UnownedDialogResolution): Promise<UnownedDialogOutcome> {
        if (!this.accepts(resolution)) return "declined"
        const draft = resolution.outcome.draft
        // An empty draft still resumes: the conversation the task already owns is
        // what the next round is composed from, so the submission only has to
        // exist, not to carry text.
        //
        // Provenance travels as submission context rather than user text. The
        // model has to be told the session was restored, but the chat row must
        // keep showing only what the user typed.
        const processAnyway = resolution.kind === "mistake_limit" && resolution.outcome.actionId === "process_anyway"
        // Process Anyway frames the reply rather than replacing it: the reply is
        // admitted like any submission, so a command in it acts with the
        // authority it grants and history shows what actually ran.
        const context = processAnyway
            ? getPrompt("toolHandlers", "processAnywayContext")
            : createResumeSubmissionContext(resolution.kind)
        const manualRetry = resolution.kind === "error_retry" && resolution.outcome.actionId === "retry"
        const answer = dialogAnswerOf(draft)
        try {
            const input = await this.resumption.materializeAnswer({
                ...answer,
                ...(context === undefined ? {} : { context }),
            })
            if (resolution.isCurrent && !resolution.isCurrent()) return "declined"
            if (processAnyway) this.resetMistakes?.()
            if (manualRetry) this.providerRetry?.takeOver()
            const submitted = await this.resumption.submit(input)
            if (submitted.kind === "rejected") {
                // No round starts from a refused input, so the dialog must stay
                // answerable and the next request keeps its automatic retries.
                if (manualRetry) this.providerRetry?.releaseTakeover()
                Logger.warn(`Runtime refused to resume unowned interaction ${resolution.interactionId}`)
                return "failed"
            }
            return "continued"
        } catch (error) {
            if (manualRetry) this.providerRetry?.releaseTakeover()
            // Reported rather than thrown: the caller has to know the answer was
            // not acted on so it can leave the interaction answerable, and the
            // user already gave an answer that must not surface as a crash.
            Logger.error(
                `Failed to resume unowned interaction ${resolution.interactionId}: ${
                    error instanceof Error ? error.message : error
                }`,
            )
            return "failed"
        }
    }
}
