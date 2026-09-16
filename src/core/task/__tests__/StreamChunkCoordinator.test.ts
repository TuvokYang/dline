import { createIdentityFactory } from "@core/api/transform/block-identity"
import type { ApiStream } from "@core/api/transform/stream"
import { createStreamNormalizer, normalizeApiStream } from "@core/api/transform/stream-identity-normalizer"
import { describe, expect, it, vi } from "vitest"
import { StreamChunkCoordinator } from "../StreamChunkCoordinator"

/**
 * Create a deterministic identity source for coordinator tests.
 *
 * @param values Ordered identity suffixes.
 * @returns Function returning the next suffix.
 */
function createSource(values: string[]): () => string {
	let index = 0
	return () => {
		const value = values[index]
		index += 1
		if (value === undefined) throw new Error("Identity source exhausted")
		return value
	}
}

/**
 * Create a provider stream containing one raw tool chunk and one usage chunk.
 *
 * @returns Raw provider stream.
 */
async function* createRawStream(): ApiStream {
	yield {
		type: "tool_calls",
		function_id: "call_provider_1",
		tool_index: 0,
		tool_call: {
			function: {
				name: "read_file",
				arguments: "{}",
			},
		},
	}
	yield {
		type: "usage",
		inputTokens: 4,
		outputTokens: 2,
	}
}

describe("StreamChunkCoordinator", () => {
	it("tracks and periodically reports queued chunk depth while the consumer is behind", async () => {
		vi.useFakeTimers()
		try {
			async function* createQueuedStream(): ApiStream {
				yield { type: "text", text: "one" }
				yield { type: "reasoning", reasoning: "two" }
				yield { type: "text", text: "three" }
			}
			const factory = createIdentityFactory(createSource(["ONE", "TWO", "THREE"]))
			const stream = normalizeApiStream(createQueuedStream(), createStreamNormalizer(factory))
			const onQueueMetrics = vi.fn()
			const coordinator = new StreamChunkCoordinator(stream, {
				onUsageChunk: vi.fn(),
				onQueueMetrics,
				queueMetricsIntervalMs: 1_000,
			})

			await coordinator.waitForCompletion()
			await vi.advanceTimersByTimeAsync(1_000)

			expect(coordinator.getQueueDepth()).toBe(3)
			expect(coordinator.getMaxQueueDepth()).toBe(3)
			expect(onQueueMetrics).toHaveBeenCalledWith({ queueDepth: 3, maxQueueDepth: 3, streamCompleted: true })
			await coordinator.nextChunk()
			expect(coordinator.getQueueDepth()).toBe(2)
			expect(coordinator.getMaxQueueDepth()).toBe(3)
			await coordinator.stop()
		} finally {
			vi.useRealTimers()
		}
	})

	it("drains final usage when it immediately follows a turn-ending chunk", async () => {
		async function* createTurnEndingStream(): ApiStream {
			yield {
				type: "tool_calls",
				function_id: "call_attempt",
				tool_index: 0,
				tool_call: { function: { name: "attempt_completion", arguments: "{}" } },
			}
			yield { type: "usage", inputTokens: 40, outputTokens: 20 }
		}

		const factory = createIdentityFactory(createSource(["ATTEMPT"]))
		const stream = normalizeApiStream(createTurnEndingStream(), createStreamNormalizer(factory))
		const onUsageChunk = vi.fn()
		const abortStream = vi.fn()
		const coordinator = new StreamChunkCoordinator(stream, { abortStream, onUsageChunk })

		const terminalChunk = await coordinator.nextChunk()
		await coordinator.drainUsageOnly()

		expect(terminalChunk?.type).toBe("tool_calls")
		expect(await coordinator.nextChunk()).toBeUndefined()
		expect(onUsageChunk).toHaveBeenCalledWith(expect.objectContaining({ inputTokens: 40, outputTokens: 20 }))
		expect(abortStream).not.toHaveBeenCalled()
	})

	it("closes the provider stream when presentation content follows a turn-ending chunk", async () => {
		let releasePostToolContent: (() => void) | undefined
		let streamClosed = false
		const postToolContent = new Promise<void>((resolve) => {
			releasePostToolContent = resolve
		})
		async function* createTurnEndingStream(): ApiStream {
			try {
				yield {
					type: "tool_calls",
					function_id: "call_plan",
					tool_index: 0,
					tool_call: { function: { name: "make_plan", arguments: "{}" } },
				}
				await postToolContent
				yield { type: "reasoning", reasoning: "must not be presented" }
			} finally {
				streamClosed = true
			}
		}

		const factory = createIdentityFactory(createSource(["PLAN", "REASONING"]))
		const stream = normalizeApiStream(createTurnEndingStream(), createStreamNormalizer(factory))
		const abortStream = vi.fn()
		const coordinator = new StreamChunkCoordinator(stream, { abortStream, onUsageChunk: vi.fn() })

		const terminalChunk = await coordinator.nextChunk()
		const drainPromise = coordinator.drainUsageOnly()
		releasePostToolContent?.()
		await drainPromise

		expect(terminalChunk?.type).toBe("tool_calls")
		expect(abortStream).toHaveBeenCalledOnce()
		expect(streamClosed).toBe(true)
		expect(await coordinator.nextChunk()).toBeUndefined()
	})

	it("receives only canonical chunks after provider stream normalization", async () => {
		const factory = createIdentityFactory(createSource(["TRACE"]))
		const normalizer = createStreamNormalizer(factory)
		const stream = normalizeApiStream(createRawStream(), normalizer)
		const onUsageChunk = vi.fn()
		const coordinator = new StreamChunkCoordinator(stream, { onUsageChunk })

		const chunk = await coordinator.nextChunk()
		await coordinator.waitForCompletion()

		expect(chunk?.type).toBe("tool_calls")
		if (chunk?.type !== "tool_calls") throw new Error("Expected canonical tool chunk")
		expect(chunk.function_id).toBe("call_provider_1")
		expect(chunk.dline_tid).toBe("dline_tid_TRACE")
		expect(chunk).not.toHaveProperty("item_id")
		expect(onUsageChunk).toHaveBeenCalledOnce()
	})
})
