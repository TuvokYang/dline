import type { SemanticInputDocument } from "@shared/input-semantics/document"
import { Logger } from "@shared/services/Logger"
import type { InteractionOutcome } from "../interaction/InteractionProtocol"
import { createResumeSubmissionContext } from "../resume/ResumeProvenance"
import type { TaskInput } from "../shell/TaskShell"

/** One answered dialog that no receiver was waiting for. */
export interface UnownedDialogResolution {
	readonly interactionId: string
	/** The kernel's dialog kind, which says what the continuation is resuming from. */
	readonly kind: string
	readonly outcome: InteractionOutcome
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

	continue(resolution: UnownedDialogResolution): Promise<UnownedDialogOutcome>
}

/** The submission path a continuation uses to put the task back to work. */
export interface TaskResumptionPort {
	materialize(input: {
		readonly text?: string
		readonly images?: readonly string[]
		readonly files?: readonly string[]
		readonly context?: string
		readonly semanticInput?: SemanticInputDocument
	}): Promise<TaskInput>
	submit(input: TaskInput): Promise<unknown>
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
	constructor(private readonly resumption: TaskResumptionPort) {}

	accepts(resolution: UnownedDialogResolution): boolean {
		return !TASK_ENDING_ACTIONS.has(resolution.outcome.actionId)
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
		const context = createResumeSubmissionContext(resolution.kind)
		try {
			const input = await this.resumption.materialize({
				text: draft?.text,
				images: draft?.images,
				files: draft?.files,
				...(context === undefined ? {} : { context }),
				...(draft?.semanticInput === undefined ? {} : { semanticInput: draft.semanticInput }),
			})
			await this.resumption.submit(input)
			return "continued"
		} catch (error) {
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
