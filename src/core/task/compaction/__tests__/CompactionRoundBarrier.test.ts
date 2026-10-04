import { describe, expect, it } from "vitest"
import type { CompactionPort } from "../../executors/compaction/CompactionCommandExecutor"
import { CompactionReviewWithdrawnError } from "../../executors/compaction/ProductionCompactionAdapter"
import { createInitialTaskState, type TaskState } from "../../kernel"
import type { ActiveTaskSession } from "../../session/ActiveTaskSession"
import { decodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { CompactionContextEnvelope, LifecycleCommand } from "../../stores/payload/TaskPayloadEnvelopes"
import { COMPACT_COMMAND_ID, CompactionRoundBarrier } from "../CompactionRoundBarrier"

const TRIGGER = 100_000
const TEST_BARRIER_TIMEOUT_MS = 50

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

	it("includes terminal-result growth that arrived after the last provider usage sample", async () => {
		const state = running()
		const p = probe(() => state)
		const barrier = new CompactionRoundBarrier({ session: () => p.session, state: () => state })

		barrier.observe({ contextTokens: TRIGGER - 10_000, compactTriggerTokens: TRIGGER })
		const waiting = barrier.settleBeforeRound({ ...round(), pendingContextTokens: 10_000 })
		await drain()
		expect(p.scheduled).toHaveLength(1)

		await run(barrier, p.scheduled[0])
		await expect(waiting).resolves.toEqual({ kind: "ready" })
	})

	it("still lets the round through when an automatic run fails", async () => {
		const state = running()
		const p = probe(() => state)
		const barrier = new CompactionRoundBarrier({ session: () => p.session, state: () => state })

		barrier.observe({ contextTokens: TRIGGER, compactTriggerTokens: TRIGGER })
		const waiting = barrier.settleBeforeRound(round())
		await drain()
		await run(barrier, p.scheduled[0], "reject")

		await expect(waiting).resolves.toEqual({ kind: "ready" })
	})

	it("releases a round whose automatic run never reports back", async () => {
		const state = running()
		const p = probe(() => state)
		const barrier = new CompactionRoundBarrier({
			session: () => p.session,
			state: () => state,
			barrierTimeoutMs: TEST_BARRIER_TIMEOUT_MS,
		})

		barrier.observe({ contextTokens: TRIGGER, compactTriggerTokens: TRIGGER })
		await expect(barrier.settleBeforeRound(round())).resolves.toEqual({ kind: "ready" })
	})

	it("leaves the conversation alone when automatic compaction is disabled", async () => {
		const state = running()
		const p = probe(() => state)
		const barrier = new CompactionRoundBarrier({ session: () => p.session, state: () => state, enabled: () => false })

		barrier.observe({ contextTokens: TRIGGER, compactTriggerTokens: TRIGGER })
		await expect(barrier.settleBeforeRound(round())).resolves.toEqual({ kind: "ready" })
		expect(p.submitted).toEqual([])
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
		expect(p.contexts[0].context).toMatchObject({ mode: "summarize", guidance: "keep the audit" })
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

	it("withdraws the round when the compaction the user asked for fails", async () => {
		const state = running()
		const p = probe(() => state)
		const barrier = new CompactionRoundBarrier({ session: () => p.session, state: () => state })

		const waiting = barrier.settleBeforeRound(round([COMPACT]))
		await drain()
		await run(barrier, p.scheduled[0], "reject")

		await expect(waiting).resolves.toEqual({ kind: "withdrawn", reason: "manual_compaction_failed" })
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

	it("waits past the automatic deadline while the user reviews", async () => {
		const state = running()
		const p = probe(() => state)
		const barrier = new CompactionRoundBarrier({
			session: () => p.session,
			state: () => state,
			barrierTimeoutMs: TEST_BARRIER_TIMEOUT_MS,
		})

		let settled = false
		const waiting = barrier.settleBeforeRound(round([COMPACT])).then(() => {
			settled = true
		})
		await new Promise((resolve) => setTimeout(resolve, TEST_BARRIER_TIMEOUT_MS * 3))
		expect(settled).toBe(false)

		await run(barrier, p.scheduled[0])
		await waiting
		expect(settled).toBe(true)
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
