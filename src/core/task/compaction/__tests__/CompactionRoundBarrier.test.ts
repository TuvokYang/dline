import { describe, expect, it, vi } from "vitest"
import type { CompactionPort } from "../../executors/compaction/CompactionCommandExecutor"
import { CompactionReviewWithdrawnError } from "../../executors/compaction/ProductionCompactionAdapter"
import { createInitialTaskState, type TaskState } from "../../kernel"
import type { ActiveTaskSession } from "../../session/ActiveTaskSession"
import { decodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { CompactionContextEnvelope, LifecycleCommand } from "../../stores/payload/TaskPayloadEnvelopes"
import {
	AUTOMATIC_COMPACTION_WITHDRAWN,
	COMPACT_COMMAND_ID,
	CompactionRoundBarrier,
	MANUAL_COMPACTION_FAILED,
} from "../CompactionRoundBarrier"

const TRIGGER = 100_000
/** Far beyond any deadline the barrier could have had: dev waits on the run itself. */
const LONG_WAIT_MS = 10 * 60_000

/** A conversation with a settled span, so a request is scheduled rather than refused. */
const COMPACTABLE = {
	read: async () => ({ messages: [], span: { from: { seq: 2 }, to: { seq: 3 } } }),
}

interface Probe {
	readonly session: ActiveTaskSession
	readonly submitted: string[]
	readonly contexts: CompactionContextEnvelope[]
	/** Compaction ids the probe scheduled, in order. */
	readonly scheduled: string[]
}

function probe(state: () => TaskState, submission: { kind: string; reason?: string } = { kind: "accepted" }): Probe {
	const submitted: string[] = []
	const contexts: CompactionContextEnvelope[] = []
	const scheduled: string[] = []
	const session = {
		state,
		payloads: {
			put: async (payload: Uint8Array) => {
				contexts.push(decodeTaskPayload<CompactionContextEnvelope>(payload))
				return "ctx-ref"
			},
		},
		conversation: COMPACTABLE,
		assembly: {
			runtime: {
				submit: async (event: { type: string; compactionId?: string }) => {
					submitted.push(event.type)
					if (event.compactionId) scheduled.push(event.compactionId)
					return submission
				},
			},
		},
	} as unknown as ActiveTaskSession
	return { session, submitted, contexts, scheduled }
}

function running(generation = 0): TaskState {
	return { ...createInitialTaskState("task-1"), generation, flow: { phase: "running" } }
}

/** The state after the kernel committed `compactionId` into its compaction slot with `status`. */
function withCompaction(state: TaskState, compactionId: string, status: "running" | "expired"): TaskState {
	return {
		...state,
		flow: { ...state.flow, compaction: { compactionId, attempt: `${compactionId}:1`, contextRef: "ctx-ref", status } },
	} as TaskState
}

const COMPACT: LifecycleCommand = { commandId: COMPACT_COMMAND_ID, premessage: "keep the audit" }

async function drain(): Promise<void> {
	for (let tick = 0; tick < 8; tick++) await Promise.resolve()
}

/** Drive one run through the barrier's instrumentation, as the executor would. */
async function run(
	barrier: CompactionRoundBarrier,
	compactionId: string,
	outcome: "resolve" | "reject" | "withdraw" = "resolve",
	signal = new AbortController().signal,
): Promise<void> {
	const port: CompactionPort = {
		run: async () => {
			if (outcome === "reject") throw new Error("provider refused")
			if (outcome === "withdraw") throw new CompactionReviewWithdrawnError("stopped")
			return { resultRef: "result-ref" }
		},
	}
	await barrier
		.instrument(port)
		.run({ compactionId, attempt: `${compactionId}:1`, contextRef: "ctx-ref", signal, publish: () => undefined })
		.catch(() => undefined)
}

function round(lifecycle: readonly LifecycleCommand[] = [], signal = new AbortController().signal) {
	return { signal, lifecycle }
}

describe("CompactionRoundBarrier - automatic", () => {
	it("holds the round until the run it scheduled settles, then lets it through", async () => {
		const state = running()
		const p = probe(() => state)
		const barrier = new CompactionRoundBarrier({ session: () => p.session, state: () => state })

		barrier.observe({ contextTokens: TRIGGER, compactTriggerTokens: TRIGGER })
		let settled = false
		const waiting = barrier.settleBeforeRound(round()).then((readiness) => {
			settled = true
			return readiness
		})
		await drain()
		expect(settled).toBe(false)

		await run(barrier, p.scheduled[0])
		await expect(waiting).resolves.toEqual({ kind: "ready" })
		expect(p.contexts[0].trigger).toBe("automatic")
	})

	it("leaves growth since the last provider usage to the guard that measures the complete request", async () => {
		const state = running()
		const p = probe(() => state)
		const barrier = new CompactionRoundBarrier({ session: () => p.session, state: () => state })

		// Large tool results arrived after a request that reported usage below
		// the trigger. Dev decides on the reported usage alone before the round
		// and lets the final guard measure the request carrying those results.
		barrier.observe({ contextTokens: TRIGGER - 10_000, compactTriggerTokens: TRIGGER })
		// The compose port still reports the growth; it feeds the usage view only.
		const composed = { ...round(), pendingContextTokens: 60_000 }
		const waiting = barrier.settleBeforeRound(composed)

		await expect(waiting).resolves.toEqual({ kind: "ready" })
		expect(p.scheduled).toHaveLength(0)
	})

	it("stops the round with the run's reason when an automatic run fails", async () => {
		const state = running()
		const p = probe(() => state)
		const barrier = new CompactionRoundBarrier({ session: () => p.session, state: () => state })

		barrier.observe({ contextTokens: TRIGGER, compactTriggerTokens: TRIGGER })
		const waiting = barrier.settleBeforeRound(round())
		await drain()
		await run(barrier, p.scheduled[0], "reject")

		await expect(waiting).resolves.toEqual({
			kind: "failed",
			reason: "automatic_compaction_failed",
			presentation: "provider refused",
		})
	})

	it("compacts again on the round that retries a failed automatic run", async () => {
		const state = running()
		const p = probe(() => state)
		const barrier = new CompactionRoundBarrier({ session: () => p.session, state: () => state })

		barrier.observe({ contextTokens: TRIGGER, compactTriggerTokens: TRIGGER })
		const failed = barrier.settleBeforeRound(round())
		await drain()
		await run(barrier, p.scheduled[0], "reject")
		await failed

		// The context is still over its trigger, so the retried round owes the same compaction.
		const retried = barrier.settleBeforeRound(round())
		await drain()
		expect(p.scheduled).toHaveLength(2)
		await run(barrier, p.scheduled[1])
		await expect(retried).resolves.toEqual({ kind: "ready" })
	})

	it("does not owe a retried round a compaction that succeeded", async () => {
		const state = running()
		const p = probe(() => state)
		const barrier = new CompactionRoundBarrier({ session: () => p.session, state: () => state })

		barrier.observe({ contextTokens: TRIGGER, compactTriggerTokens: TRIGGER })
		const first = barrier.settleBeforeRound(round())
		await drain()
		await run(barrier, p.scheduled[0])
		await first

		await expect(barrier.settleBeforeRound(round())).resolves.toEqual({ kind: "ready" })
		expect(p.scheduled).toHaveLength(1)
	})

	it("keeps the round waiting on its automatic run with no deadline", async () => {
		vi.useFakeTimers()
		try {
			const state = running()
			const p = probe(() => state)
			const barrier = new CompactionRoundBarrier({ session: () => p.session, state: () => state })

			barrier.observe({ contextTokens: TRIGGER, compactTriggerTokens: TRIGGER })
			let settled = false
			const waiting = barrier.settleBeforeRound(round()).then((readiness) => {
				settled = true
				return readiness
			})
			await vi.advanceTimersByTimeAsync(LONG_WAIT_MS)
			expect(settled).toBe(false)

			await run(barrier, p.scheduled[0])
			await expect(waiting).resolves.toEqual({ kind: "ready" })
		} finally {
			vi.useRealTimers()
		}
	})

	it("stops a round whose automatic run the kernel abandoned without reporting back", async () => {
		let state = running()
		const p = probe(() => state)
		const barrier = new CompactionRoundBarrier({ session: () => p.session, state: () => state })

		barrier.observe({ contextTokens: TRIGGER, compactTriggerTokens: TRIGGER })
		let settled = false
		const waiting = barrier.settleBeforeRound(round()).then((readiness) => {
			settled = true
			return readiness
		})
		await drain()
		const [compactionId] = p.scheduled

		// A commit that still shows the run in flight, or shows nothing, proves nothing.
		barrier.committed(state)
		state = withCompaction(state, compactionId, "running")
		barrier.committed(state)
		await drain()
		expect(settled).toBe(false)

		state = withCompaction(state, compactionId, "expired")
		barrier.committed(state)
		await expect(waiting).resolves.toEqual({ kind: "withdrawn", reason: AUTOMATIC_COMPACTION_WITHDRAWN })
	})

	it("stops a round whose automatic run was replaced in the kernel's slot", async () => {
		let state = running()
		const p = probe(() => state)
		const barrier = new CompactionRoundBarrier({ session: () => p.session, state: () => state })

		barrier.observe({ contextTokens: TRIGGER, compactTriggerTokens: TRIGGER })
		const waiting = barrier.settleBeforeRound(round())
		await drain()

		state = withCompaction(state, "compaction:someone-else", "running")
		barrier.committed(state)
		await expect(waiting).resolves.toEqual({ kind: "withdrawn", reason: AUTOMATIC_COMPACTION_WITHDRAWN })
	})

	it("stops waiting on an automatic run as withdrawn when the round itself is stopped", async () => {
		const state = running()
		const p = probe(() => state)
		const barrier = new CompactionRoundBarrier({ session: () => p.session, state: () => state })
		const stop = new AbortController()

		barrier.observe({ contextTokens: TRIGGER, compactTriggerTokens: TRIGGER })
		const waiting = barrier.settleBeforeRound(round([], stop.signal))
		await drain()
		stop.abort("compose_cancelled")

		await expect(waiting).resolves.toEqual({ kind: "withdrawn", reason: AUTOMATIC_COMPACTION_WITHDRAWN })
	})

	it("waits for an admission compaction with no deadline and stops when the kernel abandons it", async () => {
		vi.useFakeTimers()
		try {
			let state = running()
			const p = probe(() => state)
			const barrier = new CompactionRoundBarrier({ session: () => p.session, state: () => state })

			let settled = false
			const waiting = barrier.compactForAdmission(new AbortController().signal).then((result) => {
				settled = true
				return result
			})
			await vi.advanceTimersByTimeAsync(LONG_WAIT_MS)
			expect(settled).toBe(false)

			state = withCompaction(state, p.scheduled[0], "expired")
			barrier.committed(state)
			await expect(waiting).resolves.toEqual({ kind: "withdrawn" })
		} finally {
			vi.useRealTimers()
		}
	})

	it("resolves a recovery settlement as withdrawn once the kernel abandons the run", async () => {
		let state = running()
		const barrier = new CompactionRoundBarrier({ session: () => undefined, state: () => state })

		const settlement = barrier.settlement("compaction:truncate")
		await drain()
		state = withCompaction(state, "compaction:truncate", "expired")
		barrier.committed(state)

		await expect(settlement).resolves.toBe("withdrawn")
	})

	it("leaves the conversation alone when automatic compaction is disabled", async () => {
		const state = running()
		const p = probe(() => state)
		const barrier = new CompactionRoundBarrier({ session: () => p.session, state: () => state, enabled: () => false })

		barrier.observe({ contextTokens: TRIGGER, compactTriggerTokens: TRIGGER })
		await expect(barrier.settleBeforeRound(round())).resolves.toEqual({ kind: "ready" })
		expect(p.submitted).toEqual([])
	})

	it("offers truncation only while the round a failed automatic run stopped awaits a retry", async () => {
		const state = running()
		const p = probe(() => state)
		const barrier = new CompactionRoundBarrier({ session: () => p.session, state: () => state })
		expect(barrier.truncationOffered()).toBe(false)

		barrier.observe({ contextTokens: TRIGGER, compactTriggerTokens: TRIGGER })
		const failed = barrier.settleBeforeRound(round())
		await drain()
		await run(barrier, p.scheduled[0], "reject")
		await failed
		expect(barrier.truncationOffered()).toBe(true)

		// Retrying is the user's other choice; the offer belonged to the stopped round.
		const retried = barrier.settleBeforeRound(round())
		expect(barrier.truncationOffered()).toBe(false)
		await drain()
		await run(barrier, p.scheduled[1])
		await retried
	})

	it("lets the retried round through once a run replaced the conversation the failure measured", async () => {
		const state = running()
		const p = probe(() => state)
		const barrier = new CompactionRoundBarrier({ session: () => p.session, state: () => state })

		barrier.observe({ contextTokens: TRIGGER, compactTriggerTokens: TRIGGER })
		const failed = barrier.settleBeforeRound(round())
		await drain()
		await run(barrier, p.scheduled[0], "reject")
		await failed

		// A truncation the user confirmed lands between the failure and the retry.
		const settlement = barrier.settlement("compaction:truncate")
		await run(barrier, "compaction:truncate")
		await expect(settlement).resolves.toBe("completed")
		expect(barrier.truncationOffered()).toBe(false)

		await expect(barrier.settleBeforeRound(round())).resolves.toEqual({ kind: "ready" })
		expect(p.scheduled).toHaveLength(1)
	})

	it("does not let a stale run release a newer round waiting on its own run", async () => {
		const state = running()
		const p = probe(() => state)
		const barrier = new CompactionRoundBarrier({ session: () => p.session, state: () => state })

		barrier.observe({ contextTokens: TRIGGER, compactTriggerTokens: TRIGGER })
		let settled = false
		const waiting = barrier.settleBeforeRound(round()).then(() => {
			settled = true
		})
		await drain()
		// A run from before a halt finishes late; it is not the one this round owns.
		await run(barrier, "compaction:stale")
		await drain()
		expect(settled).toBe(false)

		await run(barrier, p.scheduled[0])
		await waiting
		expect(settled).toBe(true)
	})
})

describe("CompactionRoundBarrier - manual", () => {
	it("owns /compact only", () => {
		const state = running()
		const barrier = new CompactionRoundBarrier({ session: () => probe(() => state).session, state: () => state })

		expect(barrier.owns(COMPACT_COMMAND_ID)).toBe(true)
		expect(barrier.owns("command.newtask")).toBe(false)
	})

	it("runs the command an admitted input carries, with its premessage as guidance, even when automatic is disabled", async () => {
		const state = running()
		const p = probe(() => state)
		const barrier = new CompactionRoundBarrier({ session: () => p.session, state: () => state, enabled: () => false })

		const waiting = barrier.settleBeforeRound(round([COMPACT]))
		await drain()
		await run(barrier, p.scheduled[0])

		await expect(waiting).resolves.toEqual({ kind: "ready" })
		expect(p.contexts[0].trigger).toBe("manual")
		expect(p.contexts[0].mode).toBe("summarize")
		expect(p.contexts[0].context).toMatchObject({ guidance: "keep the audit" })
	})

	it("runs once for every /compact the round owes, keeping each one's guidance in order", async () => {
		const state = running()
		const p = probe(() => state)
		const barrier = new CompactionRoundBarrier({ session: () => p.session, state: () => state })

		// A reply's command and two admitted inputs' commands all land on the same round.
		barrier.request({ commandId: COMPACT_COMMAND_ID, premessage: "keep the reply notes" })
		const waiting = barrier.settleBeforeRound(
			round([
				{ commandId: COMPACT_COMMAND_ID, premessage: "keep A" },
				{ commandId: COMPACT_COMMAND_ID, premessage: "keep B" },
			]),
		)
		await drain()
		await run(barrier, p.scheduled[0])

		await expect(waiting).resolves.toEqual({ kind: "ready" })
		expect(p.scheduled).toHaveLength(1)
		expect(p.contexts[0].context).toMatchObject({ guidance: "keep A\n\nkeep B\n\nkeep the reply notes" })
	})

	it("fails the round retryably when the compaction the user asked for fails, and retries it", async () => {
		const state = running()
		const p = probe(() => state)
		const barrier = new CompactionRoundBarrier({ session: () => p.session, state: () => state })

		const waiting = barrier.settleBeforeRound(round([{ commandId: COMPACT_COMMAND_ID, premessage: "keep the notes" }]))
		await drain()
		await run(barrier, p.scheduled[0], "reject")

		// A failure after retries is an error the user can retry, not a withdrawal.
		await expect(waiting).resolves.toEqual({
			kind: "failed",
			reason: MANUAL_COMPACTION_FAILED,
			presentation: expect.any(String),
		})
		// The input that carried `/compact` is released, so Retry opens a round
		// with no command; the barrier still owes it the failed compaction.
		const retried = barrier.settleBeforeRound(round([]))
		await drain()
		expect(p.scheduled).toHaveLength(2)
		expect(p.contexts[1].context).toMatchObject({ guidance: "keep the notes" })
		await run(barrier, p.scheduled[1])
		await expect(retried).resolves.toEqual({ kind: "ready" })

		// Once it completed, later rounds owe nothing.
		await expect(barrier.settleBeforeRound(round([]))).resolves.toEqual({ kind: "ready" })
		expect(p.scheduled).toHaveLength(2)
	})

	it("retires a failed /compact when the user stops the task instead of retrying it", async () => {
		let state = running()
		const p = probe(() => state)
		const barrier = new CompactionRoundBarrier({ session: () => p.session, state: () => state })

		const waiting = barrier.settleBeforeRound(round([{ commandId: COMPACT_COMMAND_ID, premessage: "keep the notes" }]))
		await drain()
		await run(barrier, p.scheduled[0], "reject")
		await expect(waiting).resolves.toMatchObject({ kind: "failed", reason: MANUAL_COMPACTION_FAILED })

		// A stop advances the generation; the round resumed after it owes nothing.
		state = running(state.generation + 1)
		await expect(barrier.settleBeforeRound(round([]))).resolves.toEqual({ kind: "ready" })
		expect(p.scheduled).toHaveLength(1)
	})

	it("retires a failed /compact when the user dismisses the failure", async () => {
		let state = running()
		const p = probe(() => state)
		const barrier = new CompactionRoundBarrier({ session: () => p.session, state: () => state })

		const waiting = barrier.settleBeforeRound(round([{ commandId: COMPACT_COMMAND_ID, premessage: "keep the notes" }]))
		await drain()
		await run(barrier, p.scheduled[0], "reject")
		await expect(waiting).resolves.toMatchObject({ kind: "failed", reason: MANUAL_COMPACTION_FAILED })

		// Dismissing hands the task back with one ordinary reply, not a retry.
		state = { ...state, flow: { phase: "waiting", replyAdmission: "profile_recovery" } }
		barrier.committed(state)
		state = running()
		await expect(barrier.settleBeforeRound(round([]))).resolves.toEqual({ kind: "ready" })
		expect(p.scheduled).toHaveLength(1)
	})

	it("withdraws the round when the user withdraws the review", async () => {
		const state = running()
		const p = probe(() => state)
		const barrier = new CompactionRoundBarrier({ session: () => p.session, state: () => state })

		const waiting = barrier.settleBeforeRound(round([COMPACT]))
		await drain()
		await run(barrier, p.scheduled[0], "withdraw")

		await expect(waiting).resolves.toEqual({ kind: "withdrawn", reason: "manual_compaction_withdrawn" })
	})

	it("replaces an owed automatic compaction instead of summarizing a summary", async () => {
		const state = running()
		const p = probe(() => state)
		const barrier = new CompactionRoundBarrier({ session: () => p.session, state: () => state })

		barrier.observe({ contextTokens: TRIGGER, compactTriggerTokens: TRIGGER })
		const waiting = barrier.settleBeforeRound(round([COMPACT]))
		await drain()
		await run(barrier, p.scheduled[0])
		await waiting
		await barrier.settleBeforeRound(round())

		expect(p.contexts.map((context) => context.trigger)).toEqual(["manual"])
	})

	it("keeps waiting while the user reviews, however long it takes", async () => {
		vi.useFakeTimers()
		try {
			const state = running()
			const p = probe(() => state)
			const barrier = new CompactionRoundBarrier({ session: () => p.session, state: () => state })

			let settled = false
			const waiting = barrier.settleBeforeRound(round([COMPACT])).then(() => {
				settled = true
			})
			await vi.advanceTimersByTimeAsync(LONG_WAIT_MS)
			expect(settled).toBe(false)

			await run(barrier, p.scheduled[0])
			await waiting
			expect(settled).toBe(true)
		} finally {
			vi.useRealTimers()
		}
	})

	it("stops waiting as withdrawn when the round itself is stopped", async () => {
		const state = running()
		const p = probe(() => state)
		const barrier = new CompactionRoundBarrier({ session: () => p.session, state: () => state })
		const stop = new AbortController()

		const waiting = barrier.settleBeforeRound(round([COMPACT], stop.signal))
		await drain()
		stop.abort("compose_cancelled")

		await expect(waiting).resolves.toEqual({ kind: "withdrawn", reason: "manual_compaction_withdrawn" })
	})

	it("carries out a reply's command in the round the reply opens", async () => {
		const state = running()
		const p = probe(() => state)
		const barrier = new CompactionRoundBarrier({ session: () => p.session, state: () => state })

		barrier.request(COMPACT)
		const waiting = barrier.settleBeforeRound(round())
		await drain()
		await run(barrier, p.scheduled[0])

		await expect(waiting).resolves.toEqual({ kind: "ready" })
		expect(p.contexts[0].trigger).toBe("manual")
	})

	it("retires a reply's command when a stop intervened before its round", async () => {
		let state = running(0)
		const p = probe(() => state)
		const barrier = new CompactionRoundBarrier({ session: () => p.session, state: () => state })

		barrier.request(COMPACT)
		state = running(1)

		await expect(barrier.settleBeforeRound(round())).resolves.toEqual({ kind: "ready" })
		expect(p.submitted).toEqual([])
	})
})
