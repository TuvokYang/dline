import {
    getUncoveredStartMessageIndex,
    restoreTargetWindowFitting,
    type TargetWindowFittingState,
} from "@core/context/context-management/target-window-fitting"
import type { UiMessage, UiSayTool } from "@shared/ExtensionMessage"
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
     * Resolves whether the change is a step the whole view should be republished
     * for. Streamed text is not: it reaches the open chat row by row, and
     * republishing the task per chunk would cost more than the summary itself.
     */
    present(operationId: string, event: ContextCompactionSessionEvent): Promise<boolean>
    restore(state: TargetWindowFittingState): TargetWindowFittingState | undefined
}

/** Writes the card a run ends with: its landed summary, or why it failed. */
export interface CompactionRecordPort {
    record(operationId: string, card: UiSayTool): Promise<void>
}

/**
 * Every chat card of a compaction run, from its first Pass to its record.
 *
 * Progress rows are transient because they describe work in flight. Each unit
 * keeps one row across its attempts, so a retry rewrites the card the
 * interrupted attempt showed instead of stacking another one.
 *
 * A unit the run builds on - a Pass that left the target over budget, or a
 * summary refit - is kept as soon as it completes: the next unit starts from
 * it, so it stays in the chat as the step it was, even if the run later stops.
 *
 * The record takes over the row of the last card the run showed, as main
 * commits its final Pass card, instead of removing the progress and adding a
 * new row. Removing one row and adding another leaves the message count where
 * it was, and the chat only fetches rows when that count moves, so it kept
 * rendering the withdrawn progress card - a second summary beside the landed
 * one, a broken-off attempt's text, or a partial row that held the composer.
 */
export class MessageStateCompactionCards implements CompactionProgressPort, CompactionRecordPort {
    private readonly presentation = new ContextCompactionPresentation()

    constructor(
        private readonly messages: MessageStateHandler,
        private readonly nextPresentationId: PresentationIdSequence,
        private readonly realtime?: RealtimeMessagePublisher,
    ) {}

    async present(operationId: string, event: ContextCompactionSessionEvent): Promise<boolean> {
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
        if (isKeptStep(event)) {
            const state = event.kind === "pass_completed" || event.kind === "summary_refit_completed" ? event.state : undefined
            await this.keep({ ...snapshot, existingTs: ts }, state)
        }
        return !isStreamedText(event)
    }

    restore(state: TargetWindowFittingState): TargetWindowFittingState | undefined {
        for (let index = this.messages.durableClineMessages.length - 1; index >= 0; index -= 1) {
            const message = this.messages.durableClineMessages[index]
            if (message?.type !== "say" || message.say !== "tool" || !message.text) continue
            let card: UiSayTool
            try {
                card = JSON.parse(message.text) as UiSayTool
            } catch {
                continue
            }
            if (
                card.tool !== "summarizeTask" ||
                card.compactionStatus !== "completed" ||
                card.compactionDurable !== true ||
                typeof card.content !== "string" ||
                typeof card.compactionSourceHistoryHash !== "string" ||
                typeof card.compactionCoveredTurnCount !== "number" ||
                typeof card.compactionResumePassIndex !== "number"
            ) {
                continue
            }
            const restored = restoreTargetWindowFitting(state, {
                sourceHistoryHash: card.compactionSourceHistoryHash,
                coveredTurnCount: card.compactionCoveredTurnCount,
                ...(typeof card.compactionCoveredMessageIndex === "number"
                    ? { coveredMessageIndex: card.compactionCoveredMessageIndex }
                    : {}),
                passIndex: card.compactionResumePassIndex,
                cumulativeSummary: card.content,
                nextPassSummaryCarryLimitTokens: card.compactionSummaryCarryLimitTokens,
            })
            if (restored) return restored
        }
        return undefined
    }

    async record(operationId: string, card: UiSayTool): Promise<void> {
        const claimed = this.claim(operationId)
        // A landed Pass keeps the identity of the unit whose row it takes over.
        const recorded = claimed && claimed.unitKind === card.compactionUnitKind ? { ...unitIdentityOf(claimed), ...card } : card
        const row = { type: "say", say: "tool", partial: false, text: JSON.stringify(recorded) } satisfies Partial<UiMessage>
        if (claimed?.existingTs === undefined) {
            await this.messages.addToClineMessages({ ts: this.nextPresentationId(), ...row })
            return
        }
        await this.commitRow({ ts: claimed.existingTs, ...row })
    }

    /**
     * Withdraw the cards of a run that ended without a record, as a stopped run
     * does. Returns whether any card was withdrawn.
     */
    withdraw(operationId: string): boolean {
        let withdrawn = false
        for (const { existingTs } of this.transientUnits(operationId)) {
            withdrawn = this.messages.removeTransientClineMessage(existingTs) || withdrawn
        }
        this.presentation.clear(operationId)
        return withdrawn
    }

    /** Write a completed step the run builds on as a card of its own. */
    private async keep(
        snapshot: ContextCompactionPresentationSnapshot & { existingTs: number },
        state: TargetWindowFittingState | undefined,
    ): Promise<void> {
        await this.commitRow({
            ts: snapshot.existingTs,
            type: "say",
            say: "tool",
            partial: false,
            text: JSON.stringify({
                ...cardOf(snapshot),
                compactionDurable: true,
                ...(state
                    ? {
                          compactionSourceHistoryHash: state.sourceHistoryHash,
                          compactionCoveredTurnCount: state.coveredTurnCount,
                          compactionCoveredMessageIndex: getUncoveredStartMessageIndex(state),
                          compactionResumePassIndex: state.passIndex,
                      }
                    : {}),
                ...(state?.nextPassSummaryCarryLimitTokens === undefined
                    ? {}
                    : { compactionSummaryCarryLimitTokens: state.nextPassSummaryCarryLimitTokens }),
            } satisfies UiSayTool),
        })
        this.presentation.markDurable(snapshot)
    }

    /** Turn a shown progress row into the durable row it ends as. */
    private async commitRow(row: Omit<UiMessage, "conversationHistoryIndex">): Promise<void> {
        // Placed where the conversation stands now, as a newly added row would be:
        // the progress card was drawn before the run changed the conversation.
        const conversationSize = await this.messages.currentConversationSize()
        const { message, persistence } = this.messages.beginDurableClineMessage({
            ...row,
            conversationHistoryIndex: conversationSize - 1,
        })
        // A rewritten row keeps the message count, so it is delivered as a row.
        this.realtime?.publish(message)
        await persistence
    }

    /**
     * Hand the run's latest transient card to its record and withdraw the others.
     *
     * A card that is no longer on screen - a restore cleared it - is not
     * reclaimed: writing the record there would place it at the rewound point.
     * Kept steps are already records of their own and stay as they are.
     */
    private claim(operationId: string): ContextCompactionPresentationSnapshot | undefined {
        const shown = this.transientUnits(operationId).sort((left, right) => right.existingTs - left.existingTs)
        this.presentation.clear(operationId)
        const [latest, ...older] = shown
        for (const { existingTs } of older) this.messages.removeTransientClineMessage(existingTs)
        if (!latest) return undefined
        const onScreen = this.messages.clineMessages.some((message) => message.ts === latest.existingTs)
        return onScreen ? latest : { ...latest, existingTs: undefined }
    }

    private transientUnits(operationId: string): (ContextCompactionPresentationSnapshot & { existingTs: number })[] {
        return this.presentation
            .getSnapshots(operationId)
            .flatMap((snapshot) =>
                snapshot.existingTs === undefined || snapshot.durable ? [] : [{ ...snapshot, existingTs: snapshot.existingTs }],
            )
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
                // The failure card the run's failure port records takes this card's
                // place; drawing the failure here as well would show it twice.
                return undefined
        }
    }
}

/**
 * Completed units the run goes on from, which main keeps as cards of their own.
 * The Pass that brings the target within budget is not one: the run's record
 * lands on its card.
 */
function isKeptStep(event: ContextCompactionSessionEvent): boolean {
    return (event.kind === "pass_completed" && event.projection.status !== "complete") || event.kind === "summary_refit_completed"
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
        ...unitIdentityOf(snapshot),
        compactionDurable: false,
    } satisfies UiSayTool
}

/** Which execution unit of the run a card shows. */
function unitIdentityOf(snapshot: ContextCompactionPresentationSnapshot): Partial<UiSayTool> {
    return {
        compactionUnitKind: snapshot.unitKind,
        compactionUnitIndex: snapshot.unitIndex,
        ...(snapshot.passIdentity ? { compactionPassIndex: snapshot.passIdentity.passIndex } : {}),
        ...(snapshot.attempt ? { compactionAttemptIndex: snapshot.attempt.attemptIndex } : {}),
        ...(snapshot.attempt ? { compactionAttemptId: snapshot.attempt.authorizationAttemptId } : {}),
    }
}
