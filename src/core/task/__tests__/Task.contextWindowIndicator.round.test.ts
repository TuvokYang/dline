import type { ApiHandler } from "@core/api"
import {
	estimateContextWindowCandidate,
	resolveContextWindowProjection,
} from "@core/context/context-management/context-window-projection"
import {
	type ContextWindowIndicatorLineage,
	type ContextWindowIndicatorSnapshot,
	getContextWindowIndicatorTotalTokens,
} from "@shared/context-window-indicator"
import { describe, expect, it, vi } from "vitest"
import { ContextWindowIndicator } from "../ContextWindowIndicator"
import { estimateContextWindowIndicatorSegments } from "../ContextWindowIndicatorProjection"
import { ContextWindowReceivingTracker } from "../ContextWindowReceivingTracker"
import type { CompactionProviderInput } from "../compaction/CompactionRequestReplay"
import { Task } from "../index"
import { TaskRuntimeProjectionScheduler } from "../runtime/TaskRuntimeProjectionScheduler"
import { createTaskRuntimeState, type TaskRuntimeState } from "../runtime/TaskRuntimeState"
import { TaskPhase } from "../TaskPhase"

interface RoundTaskHarness {
	taskId: string
	taskState: { contextWindowIndicator?: ContextWindowIndicatorSnapshot; apiRequestCount?: number }
	contextWindowIndicator: ContextWindowIndicator
	ordinaryContextIndicatorLineageByApiIndex: Map<number, ContextWindowIndicatorLineage>
	ordinaryContextIndicatorReceivingByApiIndex: Map<number, ContextWindowReceivingTracker>
	apiRateMetricsService: { setTaskLoopActive: ReturnType<typeof vi.fn> }
	postStateToWebview: ReturnType<typeof vi.fn<(options?: { immediate?: boolean }) => Promise<void>>>
	getContextWindowIndicatorProfile(mode: string, profileName?: string): { profileId?: string; profileName?: string }
	getContextWindowRequestPressures(): Array<{
		contextTokens?: number
		estimatedContextTokens?: number
		contextTokensSource?: "provider" | "estimate"
	}>
	beginOrdinaryContextWindowIndicator(
		apiIndex: number,
		providerAttempt: number,
		requestScope: unknown,
		providerInput: CompactionProviderInput,
	): Promise<ContextWindowIndicatorLineage>
	receiveOrdinaryContextWindowIndicator(
		apiIndex: number,
		expectedLineage: ContextWindowIndicatorLineage,
		chunk: unknown,
	): Promise<void>
	publishRuntimeTaskView(state: Readonly<TaskRuntimeState>): Promise<void>
	settleOrdinaryIndicatorRound(): Promise<void>
}

function createHarness(durableContextTokens = 100): RoundTaskHarness {
	const contextWindowIndicator = new ContextWindowIndicator({
		taskId: "task-round-indicator",
		durableContextTokens,
		environmentTokens: 0,
		contextWindow: 1_000,
		mode: "act",
		updatedAt: 1,
	})
	const harness = Object.assign(Object.create(Task.prototype), {
		taskId: "task-round-indicator",
		taskState: {
			contextWindowIndicator: contextWindowIndicator.getSnapshot(),
			apiRequestCount: 1,
		},
		contextWindowIndicator,
		ordinaryContextIndicatorLineageByApiIndex: new Map(),
		ordinaryContextIndicatorReceivingByApiIndex: new Map(),
		apiRateMetricsService: { setTaskLoopActive: vi.fn() },
		postStateToWebview: vi.fn(async () => undefined),
		getContextWindowIndicatorProfile: vi.fn(() => ({})),
		getContextWindowRequestPressures: vi.fn(() => []),
	}) as RoundTaskHarness
	// Views reach the Webview through the projection scheduler. The port resolves
	// postStateToWebview at call time so a test that replaces the mock afterwards
	// still observes what was published.
	Object.assign(harness, {
		projectionScheduler: new TaskRuntimeProjectionScheduler({
			ports: {
				postView: async () => {
					await harness.postStateToWebview()
				},
				scheduleSnapshot: () => {},
				flushSnapshot: async () => {},
			},
		}),
	})
	return harness
}

function providerInput(
	messages: CompactionProviderInput["messages"],
	contextWindow: number,
): {
	providerInput: CompactionProviderInput
	requestScope: {
		api: ApiHandler
		providerInfo: { providerId: string; model: ReturnType<ApiHandler["getModel"]>; mode: "act" }
	}
} {
	const model = { id: "m", info: { id: "m", capabilities: { contextWindow } } }
	const requestScope = {
		api: { getModel: () => model, getProviderId: () => "test" } as unknown as ApiHandler,
		providerInfo: { providerId: "test", model, mode: "act" as const },
	}
	return { providerInput: { systemPrompt: "system", messages, tools: [], serverTools: [] }, requestScope }
}

describe("Task ordinary indicator round folding", () => {
	it("folds the completed round into durable, keeps ENV separate, and clears per-request bookkeeping", async () => {
		const task = createHarness()
		const current = task.contextWindowIndicator.beginSend({
			lineage: {
				kind: "ordinary",
				requestId: "ordinary:task-round-indicator:1",
				requestSequence: 1,
				attemptId: "attempt-0",
			},
			durableContextTokens: 100,
			pendingSendTokens: 200,
			environmentTokens: 30,
			contextWindow: 1_000,
			mode: "act",
		})
		task.taskState.contextWindowIndicator = current
		task.ordinaryContextIndicatorLineageByApiIndex.set(1, current.lineage)
		task.ordinaryContextIndicatorReceivingByApiIndex.set(1, new ContextWindowReceivingTracker())

		await task.settleOrdinaryIndicatorRound()

		const snapshot = task.contextWindowIndicator.getSnapshot()
		expect(snapshot.durableContextTokens).toBe(100)
		expect(snapshot.pendingSendTokens).toBe(0)
		expect(snapshot.receivingTokens).toBe(0)
		expect(snapshot.stagedTokens).toBe(200)
		expect(snapshot.environmentTokens).toBe(30)
		expect(snapshot.phase).toBe("stable")
		expect(task.ordinaryContextIndicatorLineageByApiIndex.size).toBe(0)
		expect(task.ordinaryContextIndicatorReceivingByApiIndex.size).toBe(0)
	})

	it("uses the frozen request decomposition before the first Provider usage instead of assigning the full request to Sending", async () => {
		const task = createHarness(0)
		const request = providerInput(
			[
				{
					role: "user",
					content: [
						{ type: "text", text: "current input" },
						{ type: "text", text: "<environment_details>current environment</environment_details>" },
					],
				},
			],
			372_000,
		)
		request.providerInput.systemPrompt = "system prompt ".repeat(4_000)
		const expected = estimateContextWindowIndicatorSegments({
			providerInput: request.providerInput,
			durableMessageCount: 0,
		})

		await task.beginOrdinaryContextWindowIndicator(0, 0, request.requestScope, request.providerInput)

		const snapshot = task.contextWindowIndicator.getSnapshot()
		expect(snapshot.phase).toBe("sending")
		expect(snapshot.durableContextTokens).toBe(expected.durableContextTokens)
		expect(snapshot.pendingSendTokens).toBe(expected.pendingSendTokens)
		expect(snapshot.environmentTokens).toBe(expected.environmentTokens)
		expect(snapshot.durableContextTokens).toBeGreaterThan(0)
		expect(snapshot.pendingSendTokens).toBeLessThan(snapshot.durableContextTokens)
	})

	it("keeps durable frozen across continuation requests and accumulates the round into sending", async () => {
		const task = createHarness()
		const firstTurnText = "first turn".padEnd(600, "a")
		const first = providerInput([{ role: "user", content: [{ type: "text", text: firstTurnText }] }], 1_000)
		await task.beginOrdinaryContextWindowIndicator(0, 0, first.requestScope, first.providerInput)
		const afterFirst = task.contextWindowIndicator.getSnapshot()
		expect(afterFirst.durableContextTokens).toBe(100)
		expect(afterFirst.pendingSendTokens).toBeGreaterThan(0)

		const second = providerInput(
			[
				{ role: "user", content: [{ type: "text", text: firstTurnText }] },
				{ role: "assistant", content: [{ type: "text", text: "response".padEnd(300, "b") }] },
				{ role: "user", content: [{ type: "text", text: "tool result continuation".padEnd(300, "c") }] },
			],
			1_000,
		)
		await task.beginOrdinaryContextWindowIndicator(1, 0, second.requestScope, second.providerInput)
		const afterSecond = task.contextWindowIndicator.getSnapshot()

		expect(afterSecond.durableContextTokens).toBe(100)
		expect(afterSecond.pendingSendTokens).toBeGreaterThan(afterFirst.pendingSendTokens)
	})

	it("projects a continuation from Provider occupancy plus local growth instead of re-estimating the full history", async () => {
		const task = createHarness()
		const largeRequestEnvelope = "system".repeat(8_000)
		const firstProviderInput: CompactionProviderInput = {
			systemPrompt: largeRequestEnvelope,
			messages: [{ role: "user", content: [{ type: "text", text: "first turn" }] }],
			tools: [],
			serverTools: [],
		}
		const secondProviderInput: CompactionProviderInput = {
			...firstProviderInput,
			messages: [
				...firstProviderInput.messages,
				{ role: "assistant", content: [{ type: "text", text: "first response" }] },
				{ role: "user", content: [{ type: "text", text: "continuation feedback".repeat(100) }] },
			],
		}
		const requestScope = providerInput([], 131_072).requestScope
		const firstEstimate = estimateContextWindowCandidate(firstProviderInput)
		const secondEstimate = estimateContextWindowCandidate(secondProviderInput)

		const firstLineage = await task.beginOrdinaryContextWindowIndicator(0, 0, requestScope, firstProviderInput)
		await task.receiveOrdinaryContextWindowIndicator(0, firstLineage, {
			type: "usage",
			inputTokens: 6_000,
			outputTokens: 100,
		})
		await task.settleOrdinaryIndicatorRound()
		task.getContextWindowRequestPressures = vi.fn(() => [
			{ contextTokens: 6_100, estimatedContextTokens: firstEstimate, contextTokensSource: "provider" as const },
			{ estimatedContextTokens: secondEstimate, contextTokensSource: "estimate" as const },
		])

		await task.beginOrdinaryContextWindowIndicator(1, 0, requestScope, secondProviderInput)

		const projection = resolveContextWindowProjection({
			requestInfos: task.getContextWindowRequestPressures(),
			candidateEstimatedTokens: secondEstimate,
			contextWindow: 131_072,
			triggerTokens: 131_072,
		})
		const snapshot = task.contextWindowIndicator.getSnapshot()
		const total =
			snapshot.durableContextTokens + snapshot.pendingSendTokens + snapshot.receivingTokens + snapshot.environmentTokens
		expect(secondEstimate).toBeGreaterThan(projection.projectedUsageTokens)
		expect(total).toBe(projection.projectedUsageTokens)
	})

	it("folds the latest Provider usage into the stable context snapshot for a completed turn", async () => {
		const task = createHarness()
		const request = providerInput(
			[
				{
					role: "user",
					content: [
						{ type: "text", text: "short local request" },
						{ type: "text", text: "<environment_details>small dynamic snapshot</environment_details>" },
					],
				},
			],
			272_000,
		)
		const lineage = await task.beginOrdinaryContextWindowIndicator(0, 0, request.requestScope, request.providerInput)
		await task.receiveOrdinaryContextWindowIndicator(0, lineage, {
			type: "usage",
			inputTokens: 140_000,
			outputTokens: 100,
			cacheWriteTokens: 0,
			cacheReadTokens: 0,
		})

		await task.settleOrdinaryIndicatorRound()

		const snapshot = task.contextWindowIndicator.getSnapshot()
		expect(snapshot.durableContextTokens + (snapshot.stagedTokens ?? 0) + snapshot.environmentTokens).toBe(140_100)
		expect(snapshot.durableContextTokens).toBeGreaterThan(snapshot.environmentTokens)
		expect(snapshot.phase).toBe("stable")
	})

	it("excludes Provider-hosted results and lets exact Provider output calibrate receiving", async () => {
		const task = createHarness()
		const request = providerInput(
			[{ role: "user", content: [{ type: "text", text: "small hosted result request" }] }],
			272_000,
		)
		const lineage = await task.beginOrdinaryContextWindowIndicator(0, 0, request.requestScope, request.providerInput)
		await task.receiveOrdinaryContextWindowIndicator(0, lineage, {
			type: "server_tool",
			function_id: "ws_large_result",
			tool: "WEB_SEARCH",
			phase: "completed",
			result: { results: [{ snippet: "provider result".repeat(4_000) }] },
		})

		const beforeExactUsage = task.contextWindowIndicator.getSnapshot().receivingTokens
		expect(beforeExactUsage).toBe(0)

		await task.receiveOrdinaryContextWindowIndicator(0, lineage, {
			type: "usage",
			inputTokens: 1_200,
			outputTokens: 800,
			cacheWriteTokens: 0,
			cacheReadTokens: 0,
		})

		const calibrated = task.contextWindowIndicator.getSnapshot()
		expect(calibrated.receivingTokens).toBe(800)
		expect(getContextWindowIndicatorTotalTokens(calibrated)).toBe(2_000)
	})

	it("accepts split Provider usage and does not double-count repeated output snapshots", async () => {
		const task = createHarness()
		const request = providerInput([{ role: "user", content: [{ type: "text", text: "split usage request" }] }], 272_000)
		const lineage = await task.beginOrdinaryContextWindowIndicator(0, 0, request.requestScope, request.providerInput)

		await task.receiveOrdinaryContextWindowIndicator(0, lineage, {
			type: "usage",
			inputTokens: 140_000,
			outputTokens: 0,
			cacheWriteTokens: 10,
			cacheReadTokens: 5,
		})

		let snapshot = task.contextWindowIndicator.getSnapshot()
		expect(getContextWindowIndicatorTotalTokens(snapshot)).toBe(140_015)
		expect(snapshot.receivingTokens).toBe(0)
		expect(snapshot.phase).toBe("receiving")

		const outputUsage = {
			type: "usage" as const,
			inputTokens: 0,
			outputTokens: 100,
			cacheWriteTokens: 0,
			cacheReadTokens: 0,
		}
		await task.receiveOrdinaryContextWindowIndicator(0, lineage, outputUsage)
		await task.receiveOrdinaryContextWindowIndicator(0, lineage, outputUsage)

		const receiving = task.ordinaryContextIndicatorReceivingByApiIndex.get(0)?.getSnapshot()
		expect(receiving).toMatchObject({
			providerOutputTokens: 100,
			receivingTokens: 100,
			authoritativeContextTokens: 140_115,
			providerUsage: {
				inputTokens: 140_000,
				outputTokens: 100,
				cacheWriteTokens: 10,
				cacheReadTokens: 5,
			},
		})
		snapshot = task.contextWindowIndicator.getSnapshot()
		expect(
			snapshot.durableContextTokens +
				(snapshot.stagedTokens ?? 0) +
				snapshot.pendingSendTokens +
				snapshot.receivingTokens +
				snapshot.environmentTokens,
		).toBe(140_115)
		expect(snapshot.receivingTokens).toBe(100)

		await task.settleOrdinaryIndicatorRound()

		snapshot = task.contextWindowIndicator.getSnapshot()
		expect(snapshot.durableContextTokens + (snapshot.stagedTokens ?? 0) + snapshot.environmentTokens).toBe(140_115)
		expect(snapshot.phase).toBe("stable")
	})

	it("settles the indicator before publishing completed and keeps repeated completed views idempotent", async () => {
		const task = createHarness()
		const request = providerInput(
			[{ role: "user", content: [{ type: "text", text: "completion lifecycle request" }] }],
			272_000,
		)
		const lineage = await task.beginOrdinaryContextWindowIndicator(0, 0, request.requestScope, request.providerInput)
		await task.receiveOrdinaryContextWindowIndicator(0, lineage, {
			type: "usage",
			inputTokens: 140_000,
			outputTokens: 100,
		})
		const publishedIndicatorPhases: string[] = []
		task.postStateToWebview.mockImplementation(async () => {
			publishedIndicatorPhases.push(task.taskState.contextWindowIndicator?.phase ?? "missing")
		})
		const completed = createTaskRuntimeState({ taskId: task.taskId, phase: TaskPhase.COMPLETED })

		await task.publishRuntimeTaskView(completed)

		const settled = task.contextWindowIndicator.getSnapshot()
		expect(settled.phase).toBe("stable")
		expect(settled.durableContextTokens + (settled.stagedTokens ?? 0) + settled.environmentTokens).toBe(140_100)
		expect(publishedIndicatorPhases).toEqual(["stable", "stable"])
		const settledRevision = settled.revision

		await task.publishRuntimeTaskView(completed)

		expect(task.contextWindowIndicator.getSnapshot().revision).toBe(settledRevision)
		expect(publishedIndicatorPhases).toEqual(["stable", "stable", "stable"])
	})

	it("recomputes ENV from each frozen request input instead of retaining a stale value", async () => {
		const task = createHarness()
		const withEnvironment = providerInput(
			[
				{
					role: "user",
					content: [
						{ type: "text", text: "turn" },
						{ type: "text", text: "<environment_details>fresh dynamic snapshot</environment_details>" },
					],
				},
			],
			1_000,
		)
		await task.beginOrdinaryContextWindowIndicator(0, 0, withEnvironment.requestScope, withEnvironment.providerInput)

		const snapshot = task.contextWindowIndicator.getSnapshot()
		expect(snapshot.environmentTokens).toBeGreaterThan(0)
		const total = snapshot.durableContextTokens + snapshot.pendingSendTokens + snapshot.environmentTokens
		expect(total).toBeGreaterThan(0)
		// The dynamic ENV segment is never folded into the durable segment.
		expect(snapshot.durableContextTokens + snapshot.environmentTokens).toBeLessThanOrEqual(total)
	})
})
