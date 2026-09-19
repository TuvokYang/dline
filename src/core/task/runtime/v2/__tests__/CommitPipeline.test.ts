import { describe, expect, it } from "vitest"
import { InMemoryTaskViewPort } from "../../../stores"
import { CommitPipeline } from "../CommitPipeline"
import { ControlledVault, RecordingDiagnostics, runningState, tick } from "./support"

describe("CommitPipeline", () => {
	it("persists revisions in order and notifies only after each save", async () => {
		const vault = new ControlledVault()
		const view = new InMemoryTaskViewPort()
		const pipeline = new CommitPipeline(vault, view)
		const one = { ...runningState(), revision: 1 }
		const two = { ...runningState(), revision: 2 }
		const receiptOne = pipeline.commit(one, [])
		const receiptTwo = pipeline.commit(two, [])

		await tick()
		expect(vault.saves.map((snapshot) => snapshot.state.revision)).toEqual([1])
		expect(view.committed).toEqual([])

		vault.resolve(0)
		await receiptOne.durable
		await tick()
		expect(view.committed.map((state) => state.revision)).toEqual([1])
		expect(vault.saves.map((snapshot) => snapshot.state.revision)).toEqual([1, 2])

		vault.resolve(1)
		await receiptTwo.durable
		expect(view.committed.map((state) => state.revision)).toEqual([1, 2])
	})

	it("escalates a vault failure and rejects later revisions", async () => {
		const vault = new ControlledVault()
		const diagnostics = new RecordingDiagnostics()
		const pipeline = new CommitPipeline(vault, new InMemoryTaskViewPort(), diagnostics)
		const first = pipeline.commit({ ...runningState(), revision: 1 }, [])
		await tick()
		vault.reject(0, new Error("disk unavailable"))
		await expect(first.durable).rejects.toThrow("disk unavailable")

		const second = pipeline.commit({ ...runningState(), revision: 2 }, [])
		await expect(second.durable).rejects.toThrow("disk unavailable")
		expect(pipeline.failed).toBe(true)
		expect(diagnostics.diagnostics).toEqual(
			expect.arrayContaining([expect.objectContaining({ source: "commit", code: "durability_failed", revision: 1 })]),
		)
	})
})
