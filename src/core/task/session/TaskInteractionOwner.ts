import { Logger } from "@shared/services/Logger"
import { InteractionCancellationError } from "../interaction/InteractionCancellationError"
import type { CompleteInteractionRequest, InteractionOutcome, OpenInteractionRequest } from "../interaction/InteractionProtocol"
import { getInteraction } from "../interaction/InteractionRegistry"
import type { DialogActionRule, TaskEvent } from "../kernel"
import type { MessageStateHandler } from "../message-state"
import type { RuntimeDiagnosticSink } from "../runtime"
import type { TaskPayloadStore } from "../stores"
import { encodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { DialogPresentationEnvelope } from "../stores/payload/TaskPayloadEnvelopes"
import type { TaskInteractionPorts } from "../tools/types/TaskConfig"
import type { ActiveTaskSession } from "./ActiveTaskSession"
import type { UnownedDialogContinuationPort, UnownedDialogOutcome, UnownedDialogResolution } from "./UnownedDialogContinuation"

interface PendingInteraction {
	resolve(outcome: InteractionOutcome): void
	reject(error: Error): void
}

interface InteractionRequest {
	readonly turnId: string
	readonly interactionId: string
	readonly kind: OpenInteractionRequest["kind"]
	readonly presentation: string
	readonly existingTs?: number
	readonly completionId?: string
}

function actionRules(kind: OpenInteractionRequest["kind"]): readonly DialogActionRule[] {
	const definition = getInteraction(kind)
	const rules = definition.actions.map((item) => ({ actionId: item.type, payloadPolicy: item.payloadPolicy }))
	const enterAction = definition.input.enterAction
	if (!enterAction || rules.some((rule) => rule.actionId === enterAction)) return rules
	return [...rules, { actionId: enterAction, payloadPolicy: "draft" }]
}

/** Owns causal interaction receivers while the kernel remains the lifecycle authority. */
export class TaskInteractionOwner implements TaskInteractionPorts {
	private session?: ActiveTaskSession
	private readonly pending = new Map<string, PendingInteraction>()
	/** Set while a halt holds the dialog domain; see suspend. */
	private suspendedReason: string | undefined

	constructor(
		private readonly messages: MessageStateHandler,
		private readonly payloads: TaskPayloadStore,
		/** Carries on when an answered dialog has no receiver; see UnownedDialogContinuation. */
		private readonly unownedContinuation?: UnownedDialogContinuationPort,
		/** Reports answers that reached nothing, which are otherwise invisible. */
		private readonly diagnostics?: RuntimeDiagnosticSink,
	) {}

	bind(session: ActiveTaskSession): void {
		if (this.session) throw new Error("Task interaction owner is already bound")
		this.session = session
	}

	open(request: OpenInteractionRequest): Promise<InteractionOutcome> {
		return this.request(request)
	}

	complete(request: CompleteInteractionRequest): Promise<InteractionOutcome> {
		return this.request({ ...request, kind: "completion" })
	}

	async say(request: Parameters<TaskInteractionPorts["say"]>[0]): Promise<void> {
		await this.messages.addToClineMessages({
			ts: request.existingTs ?? Date.now(),
			type: "say",
			say: request.taskSay,
			text: request.presentation,
			images: request.images,
			files: request.files,
		})
	}

	/**
	 * Write the chat row a revealed dialog anchors to, if it has none yet.
	 *
	 * A tool that opens its own dialog writes the row in `request`. An approval
	 * comes from the turn plan and has no such moment, so the dialog executor
	 * calls this at reveal. Writing once keeps the anchor unique, which is what
	 * the surface requires before it will dispatch a response.
	 */
	async anchor(request: { readonly interactionId: string; readonly kind: string; readonly body: string }): Promise<void> {
		if (this.messages.clineMessages.some((message) => message.interactionId === request.interactionId)) return
		const definition = getInteraction(request.kind as OpenInteractionRequest["kind"])
		// The row must sort after everything already written. Wall-clock time is
		// not enough here: an approval is revealed in the same millisecond as the
		// rows around it, and a row that sorts before its own tool output makes
		// the chat collapse the pair into two separate entries.
		const latestTs = this.messages.clineMessages.at(-1)?.ts ?? 0
		await this.messages.addToClineMessages({
			ts: Math.max(Date.now(), latestTs + 1),
			type: "ask",
			ask: definition.taskAsk,
			text: request.body,
			interactionId: request.interactionId,
			partial: false,
		})
	}

	/**
	 * Hand one answer to whatever is responsible for acting on it.
	 *
	 * Two things can be responsible, and which one it is decides when the
	 * interaction may retire. A receiver parked on `open` or `complete` owns the
	 * answer the moment it is delivered. A dialog the kernel synthesized —
	 * recovery, arrival wakeup, round-failure retry, or any dialog restored into
	 * a process whose original receiver is gone — has no receiver at all, so the
	 * task itself has to carry on from it.
	 *
	 * Retiring is what tells the kernel the answer was consumed, and it clears
	 * the dialog. Doing that before knowing whether anything acted on the answer
	 * is what left a reopened task paused with no dialog and a dead composer, so
	 * an unowned answer retires only once the continuation accepts it.
	 */
	resolve(interactionId: string, outcome: InteractionOutcome): void {
		const pending = this.pending.get(interactionId)
		if (pending) {
			this.pending.delete(interactionId)
			pending.resolve(outcome)
			void this.retire(interactionId)
			return
		}
		// Read the kind before retiring: the continuation needs to know what it is
		// resuming from, and retiring clears the dialog from state.
		void this.settleUnowned(interactionId, this.dialogKind(interactionId) ?? "", outcome)
	}

	/**
	 * Fail everyone waiting for an answer, and refuse new waiters until resumed.
	 *
	 * A halt fences the dialog domain, so the response these receivers await can
	 * never arrive. They have to be told, because the tool domain drains by
	 * waiting for its in-flight effects and a turn-ending tool parked on `open`
	 * or `complete` is exactly such an effect. Leaving them waiting made the stop
	 * wait for an answer that the same stop had just made impossible, which
	 * wedged every later lifecycle operation behind an unfinished teardown.
	 *
	 * Refusal lasts for the whole halt rather than this instant. A tool that was
	 * busy elsewhere when the stop arrived asks for its dialog slightly later,
	 * and admitting it then would recreate the same unanswerable wait.
	 */
	suspend(reason: string): void {
		this.suspendedReason = reason
		for (const pending of this.pending.values()) pending.reject(new InteractionCancellationError(reason))
		this.pending.clear()
	}

	/** Accept receivers again: a cancelled task may resume and ask anew. */
	resume(): void {
		this.suspendedReason = undefined
	}

	dispose(reason = "task_disposed"): void {
		this.suspend(reason)
	}

	/**
	 * The kernel's kind for a dialog that is still in state.
	 *
	 * A synthesized dialog lives in `primary` or, when an interrupted task parks
	 * its recovery question, in `interrupted`.
	 */
	private dialogKind(interactionId: string): string | undefined {
		const dialog = this.session?.state().dialog
		return [dialog?.primary, dialog?.interrupted].find((candidate) => candidate?.interactionId === interactionId)?.kind
	}

	/**
	 * Put the task back to work after an answer nobody was waiting for, and
	 * retire the interaction only if that succeeded.
	 *
	 * A declined or failed continuation leaves the dialog in place deliberately.
	 * The user's answer did not reach anything, so the question is still open;
	 * retiring it anyway would record a consumed answer the task never acted on
	 * and remove the only control the user has left.
	 */
	private async settleUnowned(interactionId: string, kind: string, outcome: InteractionOutcome): Promise<void> {
		const resolution = { interactionId, kind, outcome }
		// Retiring is what frees the dialog slot, and the continuation opens its
		// round into that slot. So the decision is taken first and the retire is
		// submitted before the round starts: asking afterwards would let the new
		// round begin while the answered dialog is still the active primary.
		const accepted = this.unownedContinuation?.accepts(resolution) ?? false
		if (accepted) await this.retire(interactionId)
		const continuation = accepted ? await this.carryOn(resolution) : "declined"
		// Recorded for every unowned answer, not only the ones that went nowhere.
		// Whether a restored dialog resumed the task or was left answerable is
		// the difference between a task that continues and one that appears to
		// ignore the user, and nothing else in the log distinguishes them.
		this.diagnostics?.record({
			source: "dialog",
			code: "unowned_dialog_settled",
			message: `Interaction ${interactionId} (${kind}) answered with ${outcome.actionId} was ${continuation}`,
			severity: continuation === "failed" ? "failure" : "observation",
		})
		// The answer reached nothing, so the question it answered is still open.
		// Reopening keeps it answerable instead of leaving the task paused with
		// no dialog, which is what disabled the composer for good.
		if (continuation === "failed") await this.reopen(interactionId)
	}

	/** Put a retired interaction back in play after its continuation failed. */
	private async reopen(interactionId: string): Promise<void> {
		const session = this.session
		if (!session) return
		try {
			await session.assembly.runtime.submit({
				type: "dialog.reopened",
				generation: session.state().generation,
				interactionId,
			})
		} catch (error) {
			Logger.warn(`Failed to reopen interaction ${interactionId}: ${error instanceof Error ? error.message : error}`)
		}
	}

	/** Ask the host how an unowned answer carries the task on. */
	private async carryOn(resolution: UnownedDialogResolution): Promise<UnownedDialogOutcome> {
		if (!this.unownedContinuation) return "declined"
		try {
			return await this.unownedContinuation.continue(resolution)
		} catch (error) {
			// The user already answered, so the failure belongs in diagnostics: it
			// says the task accepted a resume it could not act on.
			Logger.error(
				`Failed to continue unowned interaction ${resolution.interactionId}: ${
					error instanceof Error ? error.message : error
				}`,
			)
			return "failed"
		}
	}

	/** Tell the kernel this receiver has consumed the response. */
	private async retire(interactionId: string): Promise<void> {
		const session = this.session
		if (!session) return
		try {
			await session.assembly.runtime.submit({
				type: "dialog.resolved",
				generation: session.state().generation,
				interactionId,
			})
		} catch (error) {
			// A retired interaction only affects later dialogs, so a failure here
			// must be visible without failing the answer the user already gave.
			Logger.warn(`Failed to retire interaction ${interactionId}: ${error instanceof Error ? error.message : error}`)
		}
	}

	private async request(request: InteractionRequest): Promise<InteractionOutcome> {
		// Refused rather than parked: the domain that would answer is stopped, so
		// admitting this caller would block the very stop it is waiting behind.
		if (this.suspendedReason) throw new InteractionCancellationError(this.suspendedReason)
		if (this.pending.has(request.interactionId)) throw new Error(`Interaction ${request.interactionId} is already pending`)
		const presentationRef = await this.payloads.put(
			encodeTaskPayload<DialogPresentationEnvelope>({
				kind: "dialog_presentation",
				presentationKind: request.kind,
				body: request.presentation,
				existingTs: request.existingTs,
				completionId: request.completionId,
			}),
		)
		const definition = getInteraction(request.kind)
		const anchorTs = request.existingTs ?? Date.now()
		const anchor = {
			ts: anchorTs,
			type: "ask" as const,
			ask: definition.taskAsk,
			text: request.presentation,
			interactionId: request.interactionId,
			partial: false,
		}
		if (this.messages.clineMessages.some((message) => message.ts === anchorTs))
			await this.messages.finalizeClineMessage(anchor)
		else await this.messages.addToClineMessages(anchor)
		const session = this.requireSession()
		const state = session.state()
		const event: TaskEvent = {
			type: "dialog.requested",
			generation: state.generation,
			interactionId: request.interactionId,
			turnId: request.turnId,
			kind: request.kind,
			presentationRef,
			actionRules: actionRules(request.kind),
		}
		const outcome = new Promise<InteractionOutcome>((resolve, reject) => {
			this.pending.set(request.interactionId, { resolve, reject })
		})
		const result = await session.assembly.runtime.submit(event)
		if (result.kind === "rejected") {
			this.pending.delete(request.interactionId)
			throw new Error(result.reason)
		}
		return outcome
	}

	private requireSession(): ActiveTaskSession {
		if (!this.session) throw new Error("Task interaction owner is not bound")
		return this.session
	}
}
