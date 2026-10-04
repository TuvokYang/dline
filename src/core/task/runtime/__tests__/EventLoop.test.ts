import { describe, expect, it, vi } from "vitest"
import { type Command, createInitialTaskState } from "../../kernel"
import type { StateVault, TaskViewPort } from "../../stores/contracts"
import { CommitPipeline } from "../CommitPipeline"
import type { CommitReceipt } from "../contracts"
import type { DurableCommandOutbox } from "../DurableCommandOutbox"
import { EventLoop } from "../EventLoop"

function harness(options: { readonly failPersistableOnce?: boolean } = {}) {
	const receipts: CommitReceipt[] = []
	const commit = vi.fn((state: { revision: number }) => {
		const receipt = { revision: state.revision, durable: Promise.resolve() }
		receipts.push(receipt)
		return receipt
	})
	let failPersistable = options.failPersistableOnce === true
	const persistableAfter = vi.fn((commands: readonly Command[]) => {
		if (failPersistable) {
			failPersistable = false
			throw new Error("outbox projection failed")
		}
		return commands
	})
	const enqueue = vi.fn()
	const loop = new EventLoop(
		createInitialTaskState("task-event-loop"),
		{ commit } as unknown as CommitPipeline,
		{ persistableAfter, enqueue } as unknown as DurableCommandOutbox,
	)
	return { loop, commit, persistableAfter, enqueue, receipts }
}

describe("EventLoop", () => {
	it("serializes concurrent submissions into one revision order", async () => {
		const { loop, commit, enqueue } = harness()
		const first = loop.submit({ type: "user.submit", generation: 0, entryId: "one", payloadRef: "payload:one" })
		const second = loop.submit({ type: "background.ready", generation: 0, entryId: "two", payloadRef: "payload:two" })

		const [firstResult, secondResult] = await Promise.all([first, second])
		expect(firstResult).toMatchObject({ kind: "accepted", state: { revision: 1 } })
		expect(secondResult).toMatchObject({ kind: "accepted", state: { revision: 2 } })
		expect(commit.mock.calls.map(([state]) => state.revision)).toEqual([1, 2])
		expect(enqueue).toHaveBeenCalledTimes(2)
		expect(loop.getState().revision).toBe(2)
	})

	it("returns a rejected transition without committing or publishing", async () => {
		const { loop, commit, persistableAfter, enqueue } = harness()
		const state = loop.getState()
		const result = await loop.submit({
			type: "user.submit",
			generation: 1,
			entryId: "stale",
			payloadRef: "payload:stale",
		})

		expect(result).toMatchObject({ kind: "rejected", reason: "generation_mismatch", state })
		expect(result.state).toBe(state)
		expect(commit).not.toHaveBeenCalled()
		expect(persistableAfter).not.toHaveBeenCalled()
		expect(enqueue).not.toHaveBeenCalled()
	})

	it("does not advance state when outbox projection rejects one submission", async () => {
		const { loop, commit, enqueue, receipts } = harness({ failPersistableOnce: true })
		const failed = loop.submit({ type: "user.submit", generation: 0, entryId: "one", payloadRef: "payload:one" })
		const next = loop.submit({ type: "background.ready", generation: 0, entryId: "two", payloadRef: "payload:two" })

		await expect(failed).rejects.toThrow("outbox projection failed")
		const accepted = await next
		expect(accepted).toMatchObject({ kind: "accepted", state: { revision: 1 } })
		if (accepted.kind !== "accepted") throw new Error("expected accepted submission")
		expect(accepted.receipt).toBe(receipts[0])
		expect(commit).toHaveBeenCalledTimes(1)
		expect(enqueue).toHaveBeenCalledOnce()
		expect(loop.getState()).toMatchObject({
			revision: 1,
			intake: { queued: [], background: [{ entryId: "two" }] },
		})
	})

	it("closes admission after the commit pipeline reaches a durability failure", async () => {
		const fatal = new Error("disk full")
		const vault: StateVault = {
			load: async () => undefined,
			save: async () => Promise.reject(fatal),
		}
		const view: TaskViewPort = { notifyCommitted: async () => undefined, notifyTransient: () => undefined }
		const commits = new CommitPipeline(vault, view)
		const outbox = { persistableAfter: (commands: readonly Command[]) => commands, enqueue: vi.fn() }
		const loop = new EventLoop(
			createInitialTaskState("task-event-loop-fatal"),
			commits,
			outbox as unknown as DurableCommandOutbox,
		)

		const first = await loop.submit({ type: "user.submit", generation: 0, entryId: "one", payloadRef: "payload:one" })
		if (first.kind !== "accepted") throw new Error("expected accepted submission")
		await expect(first.receipt.durable).rejects.toThrow("disk full")
		await expect(
			loop.submit({ type: "background.ready", generation: 0, entryId: "two", payloadRef: "payload:two" }),
		).rejects.toThrow("disk full")
		expect(loop.getState()).toMatchObject({ revision: 1, intake: { queued: [{ entryId: "one" }], background: [] } })
		expect(outbox.enqueue).toHaveBeenCalledOnce()
	})
})
