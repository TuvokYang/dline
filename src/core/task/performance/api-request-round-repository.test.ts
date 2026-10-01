import fs from "node:fs/promises"
import path from "node:path"
import type { ClineMessage } from "@shared/ExtensionMessage"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { TaskApiRequestRoundRepository } from "./api-request-round-repository"
import type { ApiRequestRoundRecord } from "./api-request-round-types"

function round(roundId: string, revision: number, completedAtMs: number): ApiRequestRoundRecord {
	return {
		schemaVersion: 1,
		taskId: "task-a",
		roundId,
		revision,
		logicalRequestId: "request-a",
		apiIndex: 7,
		taskAttempt: 0,
		providerAttempt: Number(roundId.at(-1) ?? 0),
		startedAtMs: completedAtMs - 2_000,
		completedAtMs,
		providerDurationMs: 2_000,
		status: "completed",
		cacheUsageReported: revision > 0,
		usageQuality: revision > 0 ? "exact" : "none",
		...(revision > 0 ? { inputTokens: 100, outputTokens: 20, cacheWriteTokens: 10, cacheReadTokens: 30 } : {}),
	}
}

describe("TaskApiRequestRoundRepository", () => {
	let root: string
	const repositories: TaskApiRequestRoundRepository[] = []

	beforeEach(async () => {
		await fs.mkdir(path.join(process.cwd(), "tmp"), { recursive: true })
		root = await fs.mkdtemp(path.join(process.cwd(), "tmp", "api-request-rounds-"))
	})

	afterEach(async () => {
		await Promise.allSettled(repositories.splice(0).map((repository) => repository.close()))
		await fs.rm(root, { recursive: true, force: true })
	})

	it("restores canonical revisions and bounded recent/range results", async () => {
		const location = path.join(root, "task.db")
		const repository = new TaskApiRequestRoundRepository({ taskId: "task-a", location })
		repositories.push(repository)
		await repository.append([round("task-a:request-a:provider:0", 0, 3_000), round("task-a:request-a:provider:0", 1, 3_000)])
		await repository.append([round("task-a:request-a:provider:1", 0, 4_000), round("task-a:request-a:provider:2", 0, 5_000)])

		await expect(repository.readRecent(2)).resolves.toEqual([
			expect.objectContaining({ roundId: "task-a:request-a:provider:1", revision: 0 }),
			expect.objectContaining({ roundId: "task-a:request-a:provider:2", revision: 0 }),
		])
		await expect(repository.readRange({ startMs: 2_500, endMs: 4_500, maxPoints: 10 })).resolves.toEqual([
			expect.objectContaining({ roundId: "task-a:request-a:provider:0", revision: 1 }),
			expect.objectContaining({ roundId: "task-a:request-a:provider:1", revision: 0 }),
		])

		await repository.close()
		const reopened = new TaskApiRequestRoundRepository({ taskId: "task-a", location })
		repositories.push(reopened)
		await expect(reopened.readRecent(60)).resolves.toHaveLength(3)
	})

	it("imports legacy rounds once while keeping aggregate-only facts out of history and RPM", async () => {
		const location = path.join(root, "legacy.db")
		const messages: ClineMessage[] = [
			{
				ts: 1_000,
				type: "say",
				say: "api_req_started",
				text: JSON.stringify({
					tokensIn: 100,
					tokensOut: 20,
					cacheWrites: 10,
					cacheReads: 30,
					cost: 0.1,
					currency: "USD",
				}),
			},
			{
				ts: 2_000,
				type: "say",
				say: "deleted_api_reqs",
				text: JSON.stringify({ tokensIn: 50, tokensOut: 5, cost: 0.01, currency: "USD" }),
			},
		]
		const source = { getAll: () => messages }
		const repository = new TaskApiRequestRoundRepository({
			taskId: "task-a",
			location,
			legacySource: source,
			clock: () => 5_000,
		})
		repositories.push(repository)

		await expect(repository.readRecent(60)).resolves.toEqual([])
		const legacyHistory = await repository.readRecentHistory(60)
		expect(legacyHistory).toEqual([
			expect.objectContaining({
				roundId: "task-a:legacy-ui:1000:provider:0",
				usageQuality: "legacy",
				inputTokens: 100,
				cacheReadTokens: 30,
			}),
		])
		expect(legacyHistory[0]).not.toHaveProperty("providerDurationMs")
		await expect(repository.readCumulativeUsage()).resolves.toEqual({
			degraded: false,
			inputTokens: 150,
			outputTokens: 25,
			cacheWriteTokens: 10,
			cacheReadTokens: 30,
			cacheNumerator: 30,
			cacheDenominator: 140,
			totalCost: 0.11,
			currency: "USD",
		})

		await repository.close()
		messages.push({
			ts: 3_000,
			type: "say",
			say: "api_req_started",
			text: JSON.stringify({ tokensIn: 900, tokensOut: 90 }),
		})
		const reopened = new TaskApiRequestRoundRepository({
			taskId: "task-a",
			location,
			legacySource: source,
			clock: () => 6_000,
		})
		repositories.push(reopened)
		await expect(reopened.readRecentHistory(60)).resolves.toHaveLength(1)
		await expect(reopened.readCumulativeUsage()).resolves.toMatchObject({ inputTokens: 150, outputTokens: 25 })
	})

	it("keeps exact round writes available when legacy import fails", async () => {
		const repository = new TaskApiRequestRoundRepository({
			taskId: "task-a",
			location: path.join(root, "legacy-failure.db"),
			legacySource: {
				getAll: () => {
					throw new Error("legacy source unavailable")
				},
			},
		})
		repositories.push(repository)

		await repository.append([round("task-a:request-a:provider:0", 0, 3_000)])

		await expect(repository.readRecent(60)).resolves.toEqual([
			expect.objectContaining({ roundId: "task-a:request-a:provider:0" }),
		])
		expect(repository.isDegraded()).toBe(true)
	})

	it("recovers the exact write queue after one failed durable insert", async () => {
		const repository = new TaskApiRequestRoundRepository({ taskId: "task-a", location: path.join(root, "write-failure.db") })
		repositories.push(repository)
		const first = round("task-a:request-a:provider:0", 0, 3_000)
		await repository.append([first])

		await expect(repository.append([first])).rejects.toThrow("UnifyStore conflict")
		await repository.append([round("task-a:request-a:provider:1", 0, 4_000)])

		await expect(repository.readRecent(60)).resolves.toHaveLength(2)
	})

	it("reads a complete canonical range snapshot through bounded keyset pages", async () => {
		const repository = new TaskApiRequestRoundRepository({ taskId: "task-a", location: path.join(root, "paged.db") })
		repositories.push(repository)
		const rounds = Array.from({ length: 620 }, (_, index) =>
			round(`task-a:request-a:provider:${index.toString().padStart(4, "0")}`, 0, 10_000),
		)
		await repository.append([...rounds, round("task-a:request-a:provider:0619", 1, 10_000)])

		const snapshot = await repository.readRangeSnapshot({ startMs: 0, endMs: 20_000, pageSize: 128 })

		expect(snapshot).toHaveLength(620)
		expect(new Set(snapshot.map(({ roundId }) => roundId)).size).toBe(620)
		expect(snapshot.find(({ roundId }) => roundId.endsWith(":0619"))?.revision).toBe(1)
	})

	it("does not repeat an initialization failure while closing", async () => {
		const repository = new TaskApiRequestRoundRepository({ taskId: "task-a", location: root })
		repositories.push(repository)

		await expect(repository.readRecent()).rejects.toThrow()
		await expect(repository.close()).resolves.toBeUndefined()
	})
})
