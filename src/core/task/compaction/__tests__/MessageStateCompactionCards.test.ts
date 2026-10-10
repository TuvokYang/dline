import { createCompactionSourceSnapshot } from "@core/context/context-management/compaction-source-snapshot"
import { indexLogicalTurns } from "@core/context/context-management/logical-turns"
import type { CompactionPassIdentity, TargetWindowFittingState } from "@core/context/context-management/target-window-fitting"
import { startTargetWindowFitting } from "@core/context/context-management/target-window-fitting"
import type { UiMessage, UiSayTool } from "@shared/ExtensionMessage"
import type { ClineStorageMessage } from "@shared/messages/content"
import { describe, expect, it } from "vitest"
import type { ContextCompactionSessionEvent } from "../../ContextCompactionSession"
import type { MessageStateHandler } from "../../message-state"
import { MessageStateCompactionCards } from "../MessageStateCompactionCards"

const OPERATION = "compaction-1"

function pass(passIndex: number): CompactionPassIdentity {
    return {
        operationId: OPERATION,
        passIndex,
        passStartTurnIndex: passIndex,
        passEndTurnIndex: passIndex,
        coveredTurnCount: passIndex,
        summaryBaselineHash: `summary-${passIndex}`,
        passHistoryHash: `history-${passIndex}`,
    }
}

const attempt0 = { attemptIndex: 0, authorizationAttemptId: "attempt-0" }
const attempt1 = { attemptIndex: 1, authorizationAttemptId: "attempt-1" }

/** Session events carry fitting state and provider input the progress port never reads. */
function event(value: Record<string, unknown>): ContextCompactionSessionEvent {
    return value as unknown as ContextCompactionSessionEvent
}

/**
 * The row slice of MessageStateHandler the cards write through, keyed by `ts`
 * like the real handler: a transient row is rewritten in place and a durable
 * commit replaces the row with its timestamp.
 */
function createMessageStub(conversationSize = 4) {
    const rows = new Map<number, UiMessage>()
    const durable = new Set<number>()
    const handler = {
        get clineMessages() {
            return [...rows.values()]
        },
        get durableClineMessages() {
            return [...rows.entries()].filter(([ts]) => durable.has(ts)).map(([, row]) => row)
        },
        upsertTransientClineMessage(message: UiMessage) {
            rows.set(message.ts, message)
            return message
        },
        removeTransientClineMessage(ts: number) {
            return !durable.has(ts) && rows.delete(ts)
        },
        async addToClineMessages(message: UiMessage) {
            if (message.ts === undefined) throw new Error("addToClineMessages: ts is required")
            rows.set(message.ts, message)
            durable.add(message.ts)
        },
        async currentConversationSize() {
            return conversationSize
        },
        beginDurableClineMessage(message: UiMessage) {
            const prepared = { ...message, partial: false }
            rows.set(message.ts, prepared)
            durable.add(message.ts)
            return { message: prepared, persistence: Promise.resolve(prepared) }
        },
    }
    return { handler: handler as unknown as MessageStateHandler, rows, durable }
}

function fitting(operationId: string, suffix = ""): TargetWindowFittingState {
    const history: ClineStorageMessage[] = [
        { role: "user", content: [{ type: "text", text: `<task>task${suffix}</task>` }] },
        { role: "assistant", content: [{ type: "text", text: `answer-a${suffix}` }] },
        { role: "user", content: [{ type: "text", text: `turn-b${suffix}` }] },
        { role: "assistant", content: [{ type: "text", text: `answer-b${suffix}` }] },
        { role: "user", content: [{ type: "text", text: `turn-c${suffix}` }] },
    ]
    const snapshot = createCompactionSourceSnapshot(history)
    return startTargetWindowFitting(indexLogicalTurns(snapshot.messages), operationId, snapshot)
}

function sequence(start = 500): () => number {
    let last = start
    return () => ++last
}

function cardOf(row: UiMessage | undefined): UiSayTool {
    return JSON.parse(row?.text ?? "{}") as UiSayTool
}

describe("MessageStateCompactionCards", () => {
    it("rewrites a broken-off Pass's card as retrying instead of stacking another", async () => {
        const { handler, rows } = createMessageStub()
        const published: UiMessage[] = []
        const progress = new MessageStateCompactionCards(handler, sequence(), { publish: (row) => published.push(row) })
        const first = pass(0)

        await progress.present(OPERATION, event({ kind: "pass_started", passIdentity: first, attempt: attempt0 }))
        await progress.present(
            OPERATION,
            event({ kind: "pass_partial", passIdentity: first, attempt: attempt0, content: "half a sum" }),
        )
        const republish = await progress.present(
            OPERATION,
            event({
                kind: "pass_retry",
                passIdentity: first,
                event: {
                    kind: "pass_retry",
                    failedAttempt: attempt0,
                    nextAttempt: attempt1,
                    retryAttempt: 1,
                    maxRetryAttempts: 3,
                },
            }),
        )

        expect(republish).toBe(true)
        expect([...rows.keys()]).toEqual([501])
        const row = rows.get(501)
        expect(row).toMatchObject({ type: "say", say: "tool", partial: true })
        expect(cardOf(row)).toMatchObject({
            tool: "summarizeTask",
            compactionStatus: "retrying",
            retryAttempt: 1,
            maxRetryAttempts: 3,
            compactionOperationId: OPERATION,
            compactionUnitKind: "pass",
            compactionPassIndex: 0,
            compactionAttemptIndex: 1,
            compactionDurable: false,
        })
        // Every step reaches the open chat as it happens, not only on the next state post.
        expect(published.map((message) => message.ts)).toEqual([501, 501, 501])
    })

    it("leaves streamed text to the realtime row rather than republishing the task per chunk", async () => {
        const { handler } = createMessageStub()
        const progress = new MessageStateCompactionCards(handler, sequence())
        const first = pass(0)

        expect(await progress.present(OPERATION, event({ kind: "pass_started", passIdentity: first, attempt: attempt0 }))).toBe(
            true,
        )
        expect(await progress.present(OPERATION, event({ kind: "pass_receiving", passIdentity: first, attempt: attempt0 }))).toBe(
            false,
        )
        expect(
            await progress.present(
                OPERATION,
                event({ kind: "pass_partial", passIdentity: first, attempt: attempt0, content: "more" }),
            ),
        ).toBe(false)
    })

    it("gives each Pass its own card and withdraws them all when the run ends without a record", async () => {
        const { handler, rows } = createMessageStub()
        const progress = new MessageStateCompactionCards(handler, sequence())

        await progress.present(OPERATION, event({ kind: "pass_started", passIdentity: pass(0), attempt: attempt0 }))
        await progress.present(OPERATION, event({ kind: "pass_started", passIdentity: pass(1), attempt: attempt0 }))
        expect(rows.size).toBe(2)

        expect(progress.withdraw(OPERATION)).toBe(true)
        expect(rows.size).toBe(0)
        // A withdrawn run has nothing left to withdraw, and a later run starts fresh.
        expect(progress.withdraw(OPERATION)).toBe(false)
        await progress.present(OPERATION, event({ kind: "pass_started", passIdentity: pass(0), attempt: attempt0 }))
        expect([...rows.keys()]).toEqual([503])
    })

    it("keeps each step a multi-Pass run builds on and lands the run on its final Pass", async () => {
        const { handler, rows, durable } = createMessageStub(9)
        const cards = new MessageStateCompactionCards(handler, sequence())
        const overBudget = { status: "continue" }
        const withinBudget = { status: "complete" }

        await cards.present(OPERATION, event({ kind: "pass_started", passIdentity: pass(0), attempt: attempt0 }))
        await cards.present(
            OPERATION,
            event({ kind: "pass_completed", passIdentity: pass(0), attempt: attempt0, content: "first", projection: overBudget }),
        )
        await cards.present(OPERATION, event({ kind: "summary_refit_preparing", passIdentity: pass(0), refitAttempt: 1 }))
        await cards.present(
            OPERATION,
            event({ kind: "summary_refit_started", passIdentity: pass(0), refitAttempt: 1, attempt: attempt1 }),
        )
        await cards.present(
            OPERATION,
            event({ kind: "summary_refit_completed", passIdentity: pass(0), attempt: attempt1, content: "refit" }),
        )
        await cards.present(OPERATION, event({ kind: "pass_started", passIdentity: pass(1), attempt: attempt0 }))
        await cards.present(
            OPERATION,
            event({
                kind: "pass_completed",
                passIdentity: pass(1),
                attempt: attempt0,
                content: "final",
                projection: withinBudget,
            }),
        )

        // The over-budget Pass and the refit are records of their own as soon as they complete.
        expect([...durable]).toEqual([501, 502])
        expect(cardOf(rows.get(501))).toMatchObject({
            content: "first",
            compactionStatus: "completed",
            compactionUnitKind: "pass",
            compactionUnitIndex: 0,
            compactionDurable: true,
        })
        expect(cardOf(rows.get(502))).toMatchObject({
            content: "refit",
            compactionUnitKind: "summary_refit",
            compactionUnitIndex: 0,
            compactionDurable: true,
        })
        expect(rows.get(503)?.partial).toBe(true)

        await cards.record(OPERATION, {
            tool: "summarizeTask",
            content: "final",
            compactionStatus: "completed",
            compactionOperationId: OPERATION,
            compactionUnitKind: "pass",
            compactionDurable: true,
        })

        expect([...rows.keys()]).toEqual([501, 502, 503])
        expect(cardOf(rows.get(503))).toMatchObject({
            content: "final",
            compactionUnitKind: "pass",
            compactionUnitIndex: 1,
            compactionPassIndex: 1,
            compactionDurable: true,
        })
        expect(rows.get(503)?.partial).toBe(false)
    })

    it("keeps the completed steps of a run that stops before it lands", async () => {
        const { handler, rows } = createMessageStub()
        const cards = new MessageStateCompactionCards(handler, sequence())

        await cards.present(OPERATION, event({ kind: "pass_started", passIdentity: pass(0), attempt: attempt0 }))
        await cards.present(
            OPERATION,
            event({
                kind: "pass_completed",
                passIdentity: pass(0),
                attempt: attempt0,
                content: "first",
                projection: { status: "continue" },
                state: {
                    sourceHistoryHash: "sha256:source",
                    coveredTurnCount: 3,
                    passIndex: 1,
                    nextPassSummaryCarryLimitTokens: 700,
                } as TargetWindowFittingState,
            }),
        )
        await cards.present(OPERATION, event({ kind: "pass_started", passIdentity: pass(1), attempt: attempt0 }))

        expect(cards.withdraw(OPERATION)).toBe(true)
        expect([...rows.keys()]).toEqual([501])
        expect(cardOf(rows.get(501))).toMatchObject({
            content: "first",
            compactionDurable: true,
            compactionPassIndex: 0,
            compactionSourceHistoryHash: "sha256:source",
            compactionCoveredTurnCount: 3,
            compactionResumePassIndex: 1,
            compactionSummaryCarryLimitTokens: 700,
        })
    })

    it("restores the latest durable accepted Pass only for the same source history", async () => {
        const { handler } = createMessageStub()
        const cards = new MessageStateCompactionCards(handler, sequence())
        const initial = fitting("old-operation")

        await cards.present(OPERATION, event({ kind: "pass_started", passIdentity: pass(0), attempt: attempt0 }))
        await cards.present(
            OPERATION,
            event({
                kind: "pass_completed",
                passIdentity: pass(0),
                attempt: attempt0,
                content: "durable summary",
                projection: { status: "continue" },
                state: {
                    ...initial,
                    passIndex: 1,
                    coveredTurnCount: 1,
                    nextPassSummaryCarryLimitTokens: 640,
                } satisfies TargetWindowFittingState,
            }),
        )

        expect(cards.restore(fitting("new-operation"))).toMatchObject({
            operationId: "new-operation",
            passIndex: 1,
            coveredTurnCount: 1,
            cumulativeSummary: "durable summary",
            nextPassSummaryCarryLimitTokens: 640,
        })
        expect(cards.restore(fitting("changed-operation", "-changed"))).toBeUndefined()
    })

    it("records the run on its last card's row and delivers the rewrite as a row", async () => {
        const { handler, rows, durable } = createMessageStub(9)
        const published: UiMessage[] = []
        const cards = new MessageStateCompactionCards(handler, sequence(), { publish: (row) => published.push(row) })
        await cards.present(OPERATION, event({ kind: "pass_started", passIdentity: pass(0), attempt: attempt0 }))
        await cards.present(OPERATION, event({ kind: "pass_started", passIdentity: pass(1), attempt: attempt0 }))
        published.length = 0

        await cards.record(OPERATION, { tool: "summarizeTask", content: "landed", compactionStatus: "completed" })

        // Removing the progress and adding a row would leave the count unchanged,
        // and the chat would keep showing the withdrawn card beside the record.
        expect([...rows.keys()]).toEqual([502])
        expect([...durable]).toEqual([502])
        expect(rows.get(502)).toMatchObject({ type: "say", say: "tool", partial: false, conversationHistoryIndex: 8 })
        expect(cardOf(rows.get(502))).toMatchObject({ content: "landed", compactionStatus: "completed" })
        expect(published.map((row) => [row.ts, row.partial])).toEqual([[502, false]])
        // The record ends the run: nothing is left to withdraw.
        expect(cards.withdraw(OPERATION)).toBe(false)
    })

    it("adds the record as a new row when the run showed no card", async () => {
        const { handler, rows } = createMessageStub()
        const cards = new MessageStateCompactionCards(handler, sequence())

        await cards.record("compaction:admission:1", { tool: "summarizeTask", content: "", compactionStatus: "failed" })

        expect([...rows.keys()]).toEqual([501])
        expect(rows.get(501)?.partial).toBe(false)
    })

    it("does not reclaim a card a restore already cleared", async () => {
        const { handler, rows } = createMessageStub()
        const cards = new MessageStateCompactionCards(handler, sequence())
        await cards.present(OPERATION, event({ kind: "pass_started", passIdentity: pass(0), attempt: attempt0 }))
        handler.removeTransientClineMessage(501)

        await cards.record(OPERATION, { tool: "summarizeTask", content: "", compactionStatus: "failed" })

        // Writing at the cleared row would place the record at the rewound point.
        expect([...rows.keys()]).toEqual([502])
    })

    it("draws no progress card for a failure, which the failure card records", async () => {
        const { handler, rows } = createMessageStub()
        const progress = new MessageStateCompactionCards(handler, sequence())

        await progress.present(OPERATION, event({ kind: "pass_started", passIdentity: pass(0), attempt: attempt0 }))
        expect(await progress.present(OPERATION, event({ kind: "failed", error: "provider unavailable" }))).toBe(false)
        expect(cardOf(rows.get(501)).compactionStatus).toBe("waiting")
    })
})
