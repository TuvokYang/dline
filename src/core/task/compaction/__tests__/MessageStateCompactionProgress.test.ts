import type { CompactionPassIdentity } from "@core/context/context-management/target-window-fitting"
import type { UiMessage, UiSayTool } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import type { ContextCompactionSessionEvent } from "../../ContextCompactionSession"
import type { MessageStateHandler } from "../../message-state"
import { MessageStateCompactionProgress } from "../MessageStateCompactionProgress"

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

/** The transient-row slice of MessageStateHandler, keyed by `ts` like the real handler. */
function createMessageStub() {
	const rows = new Map<number, UiMessage>()
	const handler = {
		upsertTransientClineMessage(message: UiMessage) {
			rows.set(message.ts, message)
			return message
		},
		removeTransientClineMessage(ts: number) {
			return rows.delete(ts)
		},
	}
	return { handler: handler as unknown as MessageStateHandler, rows }
}

function sequence(start = 500): () => number {
	let last = start
	return () => ++last
}

function cardOf(row: UiMessage | undefined): UiSayTool {
	return JSON.parse(row?.text ?? "{}") as UiSayTool
}

describe("MessageStateCompactionProgress", () => {
	it("rewrites a broken-off Pass's card as retrying instead of stacking another", () => {
		const { handler, rows } = createMessageStub()
		const published: UiMessage[] = []
		const progress = new MessageStateCompactionProgress(handler, sequence(), { publish: (row) => published.push(row) })
		const first = pass(0)

		progress.present(OPERATION, event({ kind: "pass_started", passIdentity: first, attempt: attempt0 }))
		progress.present(
			OPERATION,
			event({ kind: "pass_partial", passIdentity: first, attempt: attempt0, content: "half a sum" }),
		)
		const republish = progress.present(
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

	it("leaves streamed text to the realtime row rather than republishing the task per chunk", () => {
		const { handler } = createMessageStub()
		const progress = new MessageStateCompactionProgress(handler, sequence())
		const first = pass(0)

		expect(progress.present(OPERATION, event({ kind: "pass_started", passIdentity: first, attempt: attempt0 }))).toBe(true)
		expect(progress.present(OPERATION, event({ kind: "pass_receiving", passIdentity: first, attempt: attempt0 }))).toBe(false)
		expect(
			progress.present(OPERATION, event({ kind: "pass_partial", passIdentity: first, attempt: attempt0, content: "more" })),
		).toBe(false)
	})

	it("gives each Pass its own card and withdraws them all when the run settles", () => {
		const { handler, rows } = createMessageStub()
		const progress = new MessageStateCompactionProgress(handler, sequence())

		progress.present(OPERATION, event({ kind: "pass_started", passIdentity: pass(0), attempt: attempt0 }))
		progress.present(OPERATION, event({ kind: "pass_started", passIdentity: pass(1), attempt: attempt0 }))
		expect(rows.size).toBe(2)

		expect(progress.settle(OPERATION)).toBe(true)
		expect(rows.size).toBe(0)
		// A settled run has nothing left to withdraw, and a later run starts fresh.
		expect(progress.settle(OPERATION)).toBe(false)
		progress.present(OPERATION, event({ kind: "pass_started", passIdentity: pass(0), attempt: attempt0 }))
		expect([...rows.keys()]).toEqual([503])
	})

	it("draws no progress card for a failure, which the failure card records", () => {
		const { handler, rows } = createMessageStub()
		const progress = new MessageStateCompactionProgress(handler, sequence())

		progress.present(OPERATION, event({ kind: "pass_started", passIdentity: pass(0), attempt: attempt0 }))
		expect(progress.present(OPERATION, event({ kind: "failed", error: "provider unavailable" }))).toBe(false)
		expect(cardOf(rows.get(501)).compactionStatus).toBe("waiting")
	})
})
