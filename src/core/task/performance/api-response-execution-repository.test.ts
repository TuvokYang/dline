import fs from "node:fs/promises"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { TaskApiResponseExecutionRepository } from "./api-response-execution-repository"
import type { ApiResponseExecutionRecord } from "./api-response-execution-types"

function execution(executionId: string, revision: number, completedAtMs: number): ApiResponseExecutionRecord {
	return {
		schemaVersion: 1,
		taskId: "task-a",
		executionId,
		revision,
		roundId: executionId,
		logicalRequestId: "request-a",
		apiIndex: 7,
		taskAttempt: 0,
		providerAttempt: Number(executionId.at(-1) ?? 0),
		startedAtMs: completedAtMs - 10_000,
		providerCompletedAtMs: completedAtMs - 8_000,
		completedAtMs,
		providerDurationMs: 2_000,
		executionDurationMs: 10_000,
		status: revision > 0 ? "failed" : "completed",
		terminalKind: "tools_settled",
		toolCount: 2,
		completedToolCount: revision > 0 ? 1 : 2,
		failedToolCount: revision > 0 ? 1 : 0,
		cancelledToolCount: 0,
	}
}

describe("TaskApiResponseExecutionRepository", () => {
	let root: string
	const repositories: TaskApiResponseExecutionRepository[] = []

	beforeEach(async () => {
		await fs.mkdir(path.join(process.cwd(), "tmp"), { recursive: true })
		root = await fs.mkdtemp(path.join(process.cwd(), "tmp", "api-response-executions-"))
	})

	afterEach(async () => {
		await Promise.allSettled(repositories.splice(0).map((repository) => repository.close()))
		await fs.rm(root, { recursive: true, force: true })
	})

	it("restores canonical revisions and bounded recent/range results", async () => {
		const location = path.join(root, "task.db")
		const repository = new TaskApiResponseExecutionRepository({ taskId: "task-a", location })
		repositories.push(repository)
		await repository.append([
			execution("task-a:request-a:provider:0", 0, 11_000),
			execution("task-a:request-a:provider:0", 1, 11_000),
			execution("task-a:request-a:provider:1", 0, 12_000),
			execution("task-a:request-a:provider:2", 0, 13_000),
		])

		await expect(repository.readRecent(2)).resolves.toEqual([
			expect.objectContaining({ executionId: "task-a:request-a:provider:1", revision: 0 }),
			expect.objectContaining({ executionId: "task-a:request-a:provider:2", revision: 0 }),
		])
		await expect(repository.readRange({ startMs: 10_500, endMs: 12_500, maxPoints: 10 })).resolves.toEqual([
			expect.objectContaining({ executionId: "task-a:request-a:provider:0", revision: 1 }),
			expect.objectContaining({ executionId: "task-a:request-a:provider:1", revision: 0 }),
		])

		await repository.close()
		const reopened = new TaskApiResponseExecutionRepository({ taskId: "task-a", location })
		repositories.push(reopened)
		await expect(reopened.readRecent(60)).resolves.toHaveLength(3)
	})

	it("rejects cross-Task writes and recovers its write queue after a conflict", async () => {
		const repository = new TaskApiResponseExecutionRepository({ taskId: "task-a", location: path.join(root, "failure.db") })
		repositories.push(repository)
		const first = execution("task-a:request-a:provider:0", 0, 11_000)
		await repository.append([first])
		await expect(repository.append([first])).rejects.toThrow("UnifyStore conflict")
		await repository.append([execution("task-a:request-a:provider:1", 0, 12_000)])
		await expect(repository.readRecent()).resolves.toHaveLength(2)

		await expect(
			repository.append([{ ...first, taskId: "task-b", executionId: "task-b:request-a:provider:0" }]),
		).rejects.toThrow("API response execution Task mismatch")
	})

	it("does not repeat an initialization failure while closing", async () => {
		const repository = new TaskApiResponseExecutionRepository({ taskId: "task-a", location: root })
		repositories.push(repository)

		await expect(repository.readRecent()).rejects.toThrow()
		await expect(repository.close()).resolves.toBeUndefined()
	})
})
