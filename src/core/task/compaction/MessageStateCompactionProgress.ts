import type { UiSayTool } from "@shared/ExtensionMessage"
import { ContextCompactionPresentation, type ContextCompactionPresentationSnapshot } from "../ContextCompactionPresentation"
import type { ContextCompactionSessionEvent } from "../ContextCompactionSession"
import type { MessageStateHandler } from "../message-state"
import type { PresentationIdSequence } from "../session/PresentationIdSequence"
import type { RealtimeMessagePublisher } from "../session/RealtimeMessagePublisher"

/**
 * Shows a compaction run while it is still working.
 *
 * The summary card is only written once the run lands, so without this the
 * user sees nothing between asking and the result - not the Pass streaming,
 * and not a Pass that broke off and is being sent again.
 */
export interface CompactionProgressPort {
	/**
	 * Reflect one session event.
	 *
	 * Returns whether the change is a step the whole view should be republished
	 * for. Streamed text is not: it reaches the open chat row by row, and
	 * republishing the task per chunk would cost more than the summary itself.
	 */
	present(operationId: string, event: ContextCompactionSessionEvent): boolean
	/**
	 * Withdraw the run's progress cards; the landed summary or the failure card
	 * replaces them. Returns whether any card was withdrawn.
	 */
	settle(operationId: string): boolean
}

/**
 * Progress cards as transient chat rows, one per execution unit.
 *
 * Rows are transient because they describe work in flight: the durable record
 * of a run is the summary card its landing writes, or the failure card. Each
 * unit keeps one row across its attempts, so a retry rewrites the card the
 * interrupted attempt showed instead of stacking another one.
 */
export class MessageStateCompactionProgress implements CompactionProgressPort {
	private readonly presentation = new ContextCompactionPresentation()

	constructor(
		private readonly messages: MessageStateHandler,
		private readonly nextPresentationId: PresentationIdSequence,
		private readonly realtime?: RealtimeMessagePublisher,
	) {}

	present(operationId: string, event: ContextCompactionSessionEvent): boolean {
		const snapshot = this.snapshotOf(operationId, event)
		if (!snapshot) return false
		const ts = snapshot.existingTs ?? this.nextPresentationId()
		const row = this.messages.upsertTransientClineMessage({
			ts,
			type: "say",
			say: "tool",
			partial: true,
			text: JSON.stringify(cardOf(snapshot)),
		})
		if (snapshot.existingTs === undefined) this.presentation.bindMessageTs(snapshot, ts)
		this.realtime?.publish(row)
		return !isStreamedText(event)
	}

	settle(operationId: string): boolean {
		let withdrawn = false
		for (const snapshot of this.presentation.getSnapshots(operationId)) {
			if (snapshot.existingTs !== undefined) {
				withdrawn = this.messages.removeTransientClineMessage(snapshot.existingTs) || withdrawn
			}
		}
		this.presentation.clear(operationId)
		return withdrawn
	}

	private snapshotOf(
		operationId: string,
		event: ContextCompactionSessionEvent,
	): ContextCompactionPresentationSnapshot | undefined {
		const presentation = this.presentation
		switch (event.kind) {
			case "pass_preparing":
				return presentation.preparePass(operationId, event.state.passIndex)
			case "pass_started":
				return presentation.startPass(event.passIdentity, event.attempt)
			case "pass_receiving":
				return presentation.receiving(event.passIdentity, event.attempt)
			case "pass_partial":
				return presentation.partial(event.passIdentity, event.attempt, event.content)
			case "pass_retry":
				return presentation.retry(
					event.passIdentity,
					event.event.failedAttempt,
					event.event.nextAttempt,
					event.event.kind === "pass_retry" ? event.event.retryAttempt : undefined,
					event.event.kind === "pass_retry" ? event.event.maxRetryAttempts : undefined,
				)
			case "pass_completed":
				return presentation.complete(event.passIdentity, event.attempt, event.content)
			case "summary_refit_preparing":
				return presentation.prepareSummaryRefit(event.passIdentity, event.refitAttempt - 1)
			case "summary_refit_started":
				return presentation.startSummaryRefit(event.passIdentity, event.refitAttempt - 1, event.attempt)
			case "summary_refit_receiving":
				return presentation.receivingSummaryRefit(event.passIdentity, event.attempt)
			case "summary_refit_partial":
				return presentation.partialSummaryRefit(event.passIdentity, event.attempt, event.content)
			case "summary_refit_retry":
				return presentation.retrySummaryRefit(
					event.passIdentity,
					event.event.failedAttempt,
					event.event.nextAttempt,
					event.event.kind === "pass_retry" ? event.event.retryAttempt : undefined,
					event.event.kind === "pass_retry" ? event.event.maxRetryAttempts : undefined,
					event.event.error instanceof Error ? event.event.error.message : String(event.event.error),
				)
			case "summary_refit_completed":
				return presentation.completeSummaryRefit(event.passIdentity, event.attempt, event.content)
			case "failed":
				// The failure card the run's failure port writes is the record; the
				// progress card only has to go.
				return undefined
		}
	}
}

/** Events that only carry more of a summary already on screen. */
function isStreamedText(event: ContextCompactionSessionEvent): boolean {
	return (
		event.kind === "pass_receiving" ||
		event.kind === "pass_partial" ||
		event.kind === "summary_refit_receiving" ||
		event.kind === "summary_refit_partial"
	)
}

/** The summarizeTask card a snapshot renders as, one per execution unit. */
function cardOf(snapshot: ContextCompactionPresentationSnapshot): UiSayTool {
	return {
		tool: "summarizeTask",
		content: snapshot.content,
		compactionStatus: snapshot.status,
		...(snapshot.error ? { error: snapshot.error } : {}),
		...(snapshot.retryAttempt !== undefined ? { retryAttempt: snapshot.retryAttempt } : {}),
		...(snapshot.maxRetryAttempts !== undefined ? { maxRetryAttempts: snapshot.maxRetryAttempts } : {}),
		compactionOperationId: snapshot.operationId,
		compactionUnitKind: snapshot.unitKind,
		compactionUnitIndex: snapshot.unitIndex,
		compactionDurable: false,
		...(snapshot.passIdentity ? { compactionPassIndex: snapshot.passIdentity.passIndex } : {}),
		...(snapshot.attempt ? { compactionAttemptIndex: snapshot.attempt.attemptIndex } : {}),
		...(snapshot.attempt ? { compactionAttemptId: snapshot.attempt.authorizationAttemptId } : {}),
	} satisfies UiSayTool
}
