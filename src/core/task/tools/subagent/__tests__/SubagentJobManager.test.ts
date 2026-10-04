import { strict as assert } from "node:assert"
import { describe, it, vi } from "vitest"
import type { SubagentExecResult } from "../SubagentExecutor"
import { SubagentJobManager } from "../SubagentJobManager"

function result(status: SubagentExecResult["status"], detail: string, retryable = false): SubagentExecResult {
	return {
		status,
		...(status === "completed" ? { result: detail } : { error: detail }),
		retryable,
		stats: {
			toolCalls: 0,
			inputTokens: 0,
			outputTokens: 0,
			cacheWriteTokens: 0,
			cacheReadTokens: 0,
			totalCost: 0,
			currency: "USD",
			contextTokens: 0,
			contextWindow: 1,
			contextUsagePercentage: 0,
		},
	}
}

describe("SubagentJobManager", () => {
	it("allocates unique job identities across manager instances", () => {
		const runner = async () => result("completed", "done")
		const first = new SubagentJobManager().startJob({ task: "first", prompt: "first", timeoutSeconds: 30, runner })
		const second = new SubagentJobManager().startJob({ task: "second", prompt: "second", timeoutSeconds: 30, runner })

		assert.match(first.jobId, /^subagent_[0-9a-f-]{36}$/i)
		assert.match(second.jobId, /^subagent_[0-9a-f-]{36}$/i)
		assert.notEqual(first.jobId, second.jobId)
	})

	it("publishes a completed batch snapshot through the status callback", async () => {
		const manager = new SubagentJobManager()
		const onStatusChange = vi.fn()
		const batch = manager.startBatch({
			timeoutSeconds: 30,
			items: [
				{ task: "review api", prompt: "review api", runner: async () => result("completed", "api ok") },
				{ task: "review tests", prompt: "review tests", runner: async () => result("completed", "tests ok") },
			],
			onStatusChange,
		})

		await vi.waitFor(() => assert.equal(manager.getBatch(batch.batchJobId)?.status, "completed"))
		const finalNotification = onStatusChange.mock.calls.find((call) => call[1]?.status === "completed")
		assert.ok(finalNotification)
		assert.equal(finalNotification[1].batchJobId, batch.batchJobId)
		assert.deepEqual(
			batch.itemJobIds.map((jobId) => manager.getJob(jobId)?.status),
			["completed", "completed"],
		)
	})

	it("notifies batch creation before starting item runners", async () => {
		const manager = new SubagentJobManager()
		let runnerStarted = false
		let createdBeforeRun = false
		let createdJobIds: string[] = []

		manager.startBatch({
			timeoutSeconds: 30,
			items: [
				{
					task: "review api",
					prompt: "review api",
					runner: async () => {
						runnerStarted = true
						return result("completed", "api ok")
					},
				},
			],
			onCreated: (batch) => {
				createdBeforeRun = !runnerStarted
				createdJobIds = batch.itemJobIds
			},
		})

		await vi.waitFor(() => assert.equal(runnerStarted, true))
		assert.equal(createdBeforeRun, true)
		assert.equal(createdJobIds.length, 1)
		assert.match(createdJobIds[0] ?? "", /^subagent_[0-9a-f-]{36}$/i)
	})

	it("marks an all-cancelled background batch as cancelled", async () => {
		const manager = new SubagentJobManager()
		const batch = manager.startBatch({
			timeoutSeconds: 30,
			items: ["one", "two", "three"].map((task) => ({
				task,
				prompt: task,
				runner: async () => result("cancelled", "Subagent run cancelled."),
			})),
		})

		await vi.waitFor(() => assert.equal(manager.getBatch(batch.batchJobId)?.status, "cancelled"))
		assert.deepEqual(
			batch.itemJobIds.map((jobId) => manager.getJob(jobId)?.status),
			["cancelled", "cancelled", "cancelled"],
		)
	})

	it("retains a retryable failure and reports the successful retry through the callback", async () => {
		const manager = new SubagentJobManager()
		const onStatusChange = vi.fn()
		let attempt = 0
		const job = manager.startJob({
			task: "review api",
			prompt: "review api",
			timeoutSeconds: 30,
			runner: async () => {
				attempt += 1
				return attempt === 1
					? result("failed", "temporary provider failure", true)
					: result("completed", "recovered result")
			},
			onStatusChange,
		})

		await vi.waitFor(() => assert.equal(manager.getJob(job.jobId)?.status, "failed"))
		assert.deepEqual(
			{ retryable: manager.getJob(job.jobId)?.retryable, attempt: manager.getJob(job.jobId)?.attempt },
			{ retryable: true, attempt: 1 },
		)
		assert.equal(await manager.retryJob(job.jobId), true)
		assert.equal(await manager.retryJob(job.jobId), false)
		await vi.waitFor(() => assert.equal(manager.getJob(job.jobId)?.status, "completed"))
		assert.deepEqual(
			{
				result: manager.getJob(job.jobId)?.result,
				retryable: manager.getJob(job.jobId)?.retryable,
				attempt: manager.getJob(job.jobId)?.attempt,
			},
			{ result: "recovered result", retryable: false, attempt: 2 },
		)
		assert.equal(onStatusChange.mock.calls.at(-1)?.[0].result, "recovered result")
	})

	it("keeps a batch failed while one item is retained for retry", async () => {
		const manager = new SubagentJobManager()
		const batch = manager.startBatch({
			timeoutSeconds: 30,
			items: [
				{ task: "stable", prompt: "stable", runner: async () => result("completed", "stable") },
				{ task: "retry", prompt: "retry", runner: async () => result("failed", "temporary", true) },
			],
		})

		await vi.waitFor(() => assert.equal(manager.getBatch(batch.batchJobId)?.status, "failed"))
		assert.equal(manager.getJob(batch.itemJobIds[1])?.retryable, true)
	})

	it("notifies single job creation before starting its runner", async () => {
		const manager = new SubagentJobManager()
		let createdBeforeRun = false
		let runnerStarted = false

		manager.startJob({
			task: "review api",
			prompt: "review api",
			timeoutSeconds: 30,
			runner: async () => {
				runnerStarted = true
				return result("completed", "api ok")
			},
			onCreated: () => {
				createdBeforeRun = !runnerStarted
			},
		})

		await vi.waitFor(() => assert.equal(runnerStarted, true))
		assert.equal(createdBeforeRun, true)
	})
})
