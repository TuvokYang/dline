import type { ApiHandler } from "@core/api"
import type { ClineApiReqInfo, ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it, vi } from "vitest"
import type { MessageStateHandler } from "../../message-state"
import { PromptCacheHealthTracker } from "../../prompt-cache/PromptCacheHealthTracker"
import { TaskProviderRequestReporter } from "../TaskProviderRequestReporter"

/** A message store that keeps rows in an array, which is all the reporter needs. */
function messageState() {
	const rows: ClineMessage[] = []
	const flushed: number[] = []
	const handler = {
		get clineMessages() {
			return rows
		},
		addToClineMessages: vi.fn(async (message: Partial<ClineMessage>) => {
			rows.push(message as ClineMessage)
		}),
		updateClineMessage: vi.fn(async (index: number, updates: Partial<ClineMessage>) => {
			rows[index] = { ...rows[index], ...updates }
		}),
		removeMessagesByTs: vi.fn(async (tsList: number[]) => {
			for (const ts of tsList) {
				const index = rows.findIndex((row) => row.ts === ts)
				if (index >= 0) rows.splice(index, 1)
			}
		}),
		flushMessageUpdate: vi.fn(async (index: number) => {
			flushed.push(index)
		}),
	} as unknown as MessageStateHandler
	return { handler, rows, flushed }
}

function apiHandler(): ApiHandler {
	return {
		getModel: () => ({
			id: "test-model",
			info: {
				id: "test-model",
				capabilities: { contextWindow: 200_000, supportsPromptCache: true },
				pricing: { inputPrice: 3, outputPrice: 15, currency: "USD" },
			},
		}),
	} as unknown as ApiHandler
}

function createReporter() {
	const state = messageState()
	const samples: string[] = []
	const promptCache = new PromptCacheHealthTracker("task-1", {
		debug: (message) => samples.push(message),
		warn: (message) => samples.push(message),
	})
	const pressures: { contextTokens: number; compactTriggerTokens: number }[] = []
	const usages: { turnId: string; contextTokens: number; contextWindow: number }[] = []
	const lifecycle: string[] = []
	let next = 100
	const reporter = new TaskProviderRequestReporter({
		messages: state.handler,
		nextPresentationId: () => ++next,
		api: apiHandler,
		promptCache,
		pressure: { observe: (pressure) => void pressures.push({ ...pressure }) },
		usage: {
			started: async (request) => {
				lifecycle.push(`started:${request.turnId}`)
			},
			record: async (usage) => {
				lifecycle.push(`record:${usage.turnId}`)
				usages.push({ ...usage })
			},
			unmeasured: async () => {
				lifecycle.push("unmeasured")
			},
		},
	})
	return { ...state, promptCache, samples, pressures, usages, lifecycle, reporter }
}

function requestInfo(row: ClineMessage): ClineApiReqInfo {
	return JSON.parse(row.text ?? "{}") as ClineApiReqInfo
}

describe("TaskProviderRequestReporter", () => {
	it("opens a request row before the stream and settles it with the reported usage", async () => {
		const harness = createReporter()

		const record = await harness.reporter.begin({ turnId: "turn-1" })
		expect(harness.rows).toEqual([expect.objectContaining({ type: "say", say: "api_req_started" })])
		// Nothing is known yet, so the open row must not read as a settled request.
		expect(requestInfo(harness.rows[0]).cost).toBeUndefined()

		await record.settle({
			usage: { inputTokens: 1_000, outputTokens: 200, cacheWriteTokens: 50, cacheReadTokens: 750, totalCost: 0.25 },
			outcome: "completed",
		})

		const settled = requestInfo(harness.rows[0])
		expect(settled).toMatchObject({
			tokensIn: 1_000,
			tokensOut: 200,
			cacheWrites: 50,
			cacheReads: 750,
			cost: 0.25,
			contextTokens: 2_000,
			contextTokensSource: "provider",
		})
		expect(settled.cancelReason).toBeUndefined()
		expect(harness.flushed).toEqual([0])
	})

	it("records a cache sample only for a completed request", async () => {
		const harness = createReporter()
		const usage = { inputTokens: 1_000, outputTokens: 10, cacheWriteTokens: 0, cacheReadTokens: 120_000 }

		const cancelled = await harness.reporter.begin({ turnId: "turn-1" })
		await cancelled.settle({ usage, outcome: "cancelled" })
		expect(harness.promptCache.getSnapshot().sampleCount).toBe(0)

		const completed = await harness.reporter.begin({ turnId: "turn-2" })
		await completed.settle({ usage, outcome: "completed" })
		expect(harness.promptCache.getSnapshot().sampleCount).toBe(1)
	})

	it("marks a cancelled request so its row stops reading as running", async () => {
		const harness = createReporter()

		const record = await harness.reporter.begin({ turnId: "turn-1" })
		await record.settle({ outcome: "cancelled" })

		expect(requestInfo(harness.rows[0]).cancelReason).toBe("user_cancelled")
	})

	it("marks a failed request with its streaming failure reason", async () => {
		const harness = createReporter()

		const record = await harness.reporter.begin({ turnId: "turn-1" })
		await record.settle({ outcome: "failed" })

		expect(requestInfo(harness.rows[0]).cancelReason).toBe("streaming_failed")
	})

	it("reports what the settled request left in the context window", async () => {
		const harness = createReporter()

		const record = await harness.reporter.begin({ turnId: "turn-1" })
		await record.settle({
			usage: { inputTokens: 120_000, outputTokens: 500, cacheReadTokens: 10_000 },
			outcome: "completed",
		})

		// The observer has to see the same context size the row reports, otherwise
		// compaction would judge pressure the user never saw.
		const reported = requestInfo(harness.rows[0]).contextTokens
		expect(harness.pressures).toEqual([
			{ contextTokens: reported, compactTriggerTokens: expect.any(Number) as unknown as number },
		])
		expect(harness.pressures[0].compactTriggerTokens).toBeGreaterThan(0)
	})

	it("reports no pressure for a request that never entered the conversation", async () => {
		const harness = createReporter()
		const usage = { inputTokens: 120_000, outputTokens: 500 }

		const cancelled = await harness.reporter.begin({ turnId: "turn-1" })
		await cancelled.settle({ usage, outcome: "cancelled" })
		const failed = await harness.reporter.begin({ turnId: "turn-2" })
		await failed.settle({ usage, outcome: "failed" })

		expect(harness.pressures).toEqual([])
	})

	it("tells the usage observer the occupancy a completed request reported", async () => {
		const harness = createReporter()

		const record = await harness.reporter.begin({ turnId: "turn-1" })
		await record.settle({ usage: { inputTokens: 80_000, outputTokens: 100 }, outcome: "completed" })

		expect(harness.usages).toEqual([{ turnId: "turn-1", contextTokens: 80_100, contextWindow: 200_000 }])
		expect(harness.lifecycle).toEqual(["started:turn-1", "record:turn-1"])
	})

	it("keeps the displayed occupancy when a request never entered the conversation or reported nothing", async () => {
		const harness = createReporter()
		const usage = { inputTokens: 80_000, outputTokens: 100 }

		const cancelled = await harness.reporter.begin({ turnId: "turn-1" })
		await cancelled.settle({ usage, outcome: "cancelled" })
		const failed = await harness.reporter.begin({ turnId: "turn-2" })
		await failed.settle({ usage, outcome: "failed" })
		// A provider that omits usage says nothing about the window; reading that
		// as zero would show an emptied conversation.
		const silent = await harness.reporter.begin({ turnId: "turn-3" })
		await silent.settle({ outcome: "completed" })
		// Explicit zeros carry no more information about the window than silence.
		const empty = await harness.reporter.begin({ turnId: "turn-4" })
		await empty.settle({ usage: { inputTokens: 0, outputTokens: 0 }, outcome: "completed" })

		expect(harness.usages).toEqual([])
		// Each of them still ends its request, so the header stops showing it in flight.
		expect(harness.lifecycle.filter((entry) => entry === "unmeasured")).toHaveLength(4)
	})

	it("keeps one live retry card per request and withdraws it once the request recovers", async () => {
		const harness = createReporter()
		const record = await harness.reporter.begin({ turnId: "turn-1" })

		await record.retrying?.({ attempt: 1, maxAttempts: 5, delayMs: 3000, errorMessage: "first" })
		await record.retrying?.({ attempt: 2, maxAttempts: 5, delayMs: 5000, errorMessage: "second" })

		const cards = harness.rows.filter((row) => row.say === "error_retry")
		expect(cards).toHaveLength(1)
		expect(JSON.parse(cards[0].text ?? "{}")).toEqual({
			attempt: 2,
			maxAttempts: 5,
			delaySeconds: 5,
			errorMessage: "second",
		})

		await record.recovered?.()
		await record.settle({ usage: { inputTokens: 10, outputTokens: 1 }, outcome: "completed" })

		expect(harness.rows.filter((row) => row.say === "error_retry")).toEqual([])
		expect(requestInfo(harness.rows[0]).tokensIn).toBe(10)
	})

	it("marks the retry card failed when the retries did not recover the request", async () => {
		const harness = createReporter()
		const record = await harness.reporter.begin({ turnId: "turn-1" })

		await record.retrying?.({ attempt: 5, maxAttempts: 5, delayMs: 30_000, errorMessage: "still down" })
		await record.settle({ outcome: "failed" })

		const card = harness.rows.find((row) => row.say === "error_retry")
		expect(JSON.parse(card?.text ?? "{}")).toMatchObject({ failed: true, delaySeconds: 0, errorMessage: "still down" })
		expect(requestInfo(harness.rows[0]).cancelReason).toBe("streaming_failed")
	})

	it("withdraws the retry card when the user cancels during the countdown", async () => {
		const harness = createReporter()
		const record = await harness.reporter.begin({ turnId: "turn-1" })

		await record.retrying?.({ attempt: 1, maxAttempts: 5, delayMs: 3000, errorMessage: "down" })
		await record.settle({ outcome: "cancelled" })

		expect(harness.rows.filter((row) => row.say === "error_retry")).toEqual([])
	})

	it("settles each request against its own row", async () => {
		const harness = createReporter()

		const first = await harness.reporter.begin({ turnId: "turn-1" })
		const second = await harness.reporter.begin({ turnId: "turn-2" })
		await second.settle({ usage: { inputTokens: 20, outputTokens: 2 }, outcome: "completed" })
		await first.settle({ usage: { inputTokens: 10, outputTokens: 1 }, outcome: "completed" })

		expect(requestInfo(harness.rows[0]).tokensIn).toBe(10)
		expect(requestInfo(harness.rows[1]).tokensIn).toBe(20)
	})
})
