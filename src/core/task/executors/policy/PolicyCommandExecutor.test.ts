import { describe, expect, it, vi } from "vitest"
import type { ApprovalEvaluateCommand, TaskEvent } from "../../kernel"
import { PolicyCommandExecutor } from "./PolicyCommandExecutor"

function command(id: string, blockId: string): ApprovalEvaluateCommand {
	return {
		commandId: id,
		originRevision: 1,
		generation: 0,
		type: "approval.evaluate",
		interactionId: `policy:${blockId}`,
		blockId,
		attempt: `attempt:${blockId}`,
		policyRevision: 3,
		riskFacts: { writes: true },
	}
}

describe("PolicyCommandExecutor", () => {
	it("evaluates blocks concurrently without sharing causal identity", async () => {
		const releases = new Map<string, (approved: boolean) => void>()
		const events: TaskEvent[] = []
		const executor = new PolicyCommandExecutor(
			{
				evaluate: ({ blockId }) => new Promise((resolve) => releases.set(blockId, (approved) => resolve({ approved }))),
			},
			{ submit: async (event) => (events.push(event), { kind: "accepted" as const }) },
		)
		const first = executor.execute(command("p1", "b1"))
		const second = executor.execute(command("p2", "b2"))
		await vi.waitFor(() => expect(releases.size).toBe(2))
		releases.get("b2")?.(false)
		releases.get("b1")?.(true)
		await Promise.all([first, second])

		expect(events).toEqual([
			expect.objectContaining({ type: "approval.evaluated", commandId: "p2", blockId: "b2", approved: false }),
			expect.objectContaining({ type: "approval.evaluated", commandId: "p1", blockId: "b1", approved: true }),
		])
	})

	it("fences a late policy result after halt", async () => {
		let release!: (approved: boolean) => void
		const events: TaskEvent[] = []
		const executor = new PolicyCommandExecutor(
			{ evaluate: () => new Promise((resolve) => (release = (approved) => resolve({ approved }))) },
			{ submit: async (event) => (events.push(event), { kind: "accepted" as const }) },
		)
		const running = executor.execute(command("p1", "b1"))
		await vi.waitFor(() => expect(release).toBeTypeOf("function"))
		const order = { haltId: "halt-1", generation: 0, reason: "cancel" as const }
		executor.fence(order)
		executor.stop(order)
		release(true)
		await executor.drain(order)
		await running
		expect(events).toEqual([])
	})
})
