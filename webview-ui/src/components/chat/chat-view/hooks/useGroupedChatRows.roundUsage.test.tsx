import { GetTaskRateMetricsRequest, TaskRateMetricsResolution, TaskRateUsageQuality } from "@shared/proto/dline/task"
import { renderHook, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { finishedTurnTranscript } from "../components/messages/activityFoldStoryFixtures"
import { isActivityFold } from "../utils/chatRowKinds"
import { filterVisibleMessages } from "../utils/messageUtils"
import { useGroupedChatRows } from "./useGroupedChatRows"

const mocks = vi.hoisted(() => ({ getTaskRateMetrics: vi.fn() }))

vi.mock("@/services/grpc-client", () => ({
    TaskServiceClient: { getTaskRateMetrics: mocks.getTaskRateMetrics },
}))

const TASK_ID = "task-1"
const INSTANCE = "opening-1"
const visible = filterVisibleMessages(finishedTurnTranscript)

function roundPoint(roundId: string, providerDurationMs: number, outputTokens: number) {
    return {
        roundId,
        providerDurationMs,
        inputTokens: 9_000,
        outputTokens,
        cacheWriteTokens: 0,
        cacheReadTokens: 0,
        totalCost: 0.012,
        currency: "USD",
        usageQuality: TaskRateUsageQuality.TASK_RATE_USAGE_QUALITY_EXACT,
        provisional: false,
        cacheUsageAvailable: true,
        usageAvailable: true,
    }
}

/**
 * The projection reads plain point records, so the fixture mirrors that shape.
 * Building it through the generated `create()` helper is not required and would
 * only re-test the generator.
 */
function respondWith(points: ReturnType<typeof roundPoint>[], overrides: Record<string, unknown> = {}) {
    mocks.getTaskRateMetrics.mockResolvedValue({
        taskId: TASK_ID,
        taskInstanceId: INSTANCE,
        points,
        degraded: false,
        truncated: false,
        ...overrides,
    })
}

function renderFolded(opening: { taskId?: string; taskInstanceId?: string } | undefined) {
    const hook = renderHook(
        ({ current }: { current: { taskId?: string; taskInstanceId?: string } | undefined }) =>
            useGroupedChatRows(finishedTurnTranscript, visible, { user: "user_turn", featureFlag: true }, undefined, current),
        { initialProps: { current: opening } },
    )
    /**
     * The rounds arrive after the first render, so the figures only reach the
     * fold step on a later render. Re-rendering with the same opening is what a
     * parent re-render does in production, and it is what commits the new hook
     * state into the rows this test reads.
     */
    const settle = async () => {
        await waitFor(() => expect(mocks.getTaskRateMetrics).toHaveBeenCalledTimes(1))
        hook.rerender({ current: opening })
        hook.rerender({ current: opening })
        return hook
    }
    return Object.assign(hook, { settle })
}

function foldUsageOf(rows: ReturnType<typeof useGroupedChatRows>) {
    const fold = rows.find(isActivityFold)
    if (!fold) throw new Error("expected the transcript to fold one turn")
    return fold._usage
}

beforeEach(() => {
    mocks.getTaskRateMetrics.mockReset()
})

/**
 * These tests guard the wiring, not the renderer. Before it existed every fold
 * rendered no figures at all, because the fold step only states a cost when it
 * is handed the Provider rounds; a green suite below the wiring could not see
 * that the production path never passed them.
 */
describe("useGroupedChatRows Provider round wiring", () => {
    it("sums the generation time and token rate of the rounds the block holds", async () => {
        // Four records: the block covers nine transcript rounds, so the newest
        // four are what it can reconcile against. Three distinct durations mean a
        // block that reached for the wrong records could not sum to the same total.
        respondWith([
            roundPoint("round-3", 4_000, 600),
            roundPoint("round-4", 6_000, 900),
            roundPoint("round-5", 2_000, 300),
            roundPoint("round-6", 1_000, 150),
        ])
        const hook = renderFolded({ taskId: TASK_ID, taskInstanceId: INSTANCE })
        const { result } = await hook.settle()

        await waitFor(() => expect(foldUsageOf(result.current)).toBeDefined())
        const usage = foldUsageOf(result.current)
        expect(usage?.durationMs).toBe(12_000)
        // 1,800 output tokens over 12s of generation is 150 tokens per second.
        expect(usage?.averageTokensPerSecond).toBeCloseTo(150, 5)
        expect(usage?.totalCost).toBeCloseTo(0.036, 6)
        // The oldest covered round has no retained record, so it contributes no
        // duration rather than an invented one. This is the known limit of
        // binding records from the end; it is stated here so a future change that
        // silently starts guessing a duration fails this test.
        expect(usage?.durationMs).toBeLessThan(4_000 + 6_000 + 2_000 + 1_000)
    })

    it("asks the round resolution rather than a time bucket", async () => {
        respondWith([roundPoint("round-1", 4_000, 600)])
        renderFolded({ taskId: TASK_ID, taskInstanceId: INSTANCE })

        await waitFor(() => expect(mocks.getTaskRateMetrics).toHaveBeenCalledTimes(1))
        const request = mocks.getTaskRateMetrics.mock.calls[0][0] as GetTaskRateMetricsRequest
        expect(request.resolution).toBe(TaskRateMetricsResolution.TASK_RATE_METRICS_RESOLUTION_ROUND)
        expect(request.taskId).toBe(TASK_ID)
        expect(request.taskInstanceId).toBe(INSTANCE)
    })

    it("states no figures when the Task has no canonical opening", async () => {
        renderFolded({ taskId: TASK_ID })

        // The RPC refuses a request that does not belong to the opening it answers.
        expect(mocks.getTaskRateMetrics).not.toHaveBeenCalled()
        expect(foldUsageOf(renderFolded({ taskId: TASK_ID }).result.current)).toBeUndefined()
    })

    it("keeps a block silent instead of failing when the rounds cannot be read", async () => {
        mocks.getTaskRateMetrics.mockRejectedValue(new Error("history unavailable"))
        const { result } = renderFolded({ taskId: TASK_ID, taskInstanceId: INSTANCE })

        await waitFor(() => expect(mocks.getTaskRateMetrics).toHaveBeenCalledTimes(1))
        expect(foldUsageOf(result.current)).toBeUndefined()
    })

    it("ignores rounds tagged with a different Task opening", async () => {
        respondWith([roundPoint("round-1", 4_000, 600)], { taskInstanceId: "another-opening" })
        const { result } = renderFolded({ taskId: TASK_ID, taskInstanceId: INSTANCE })

        await waitFor(() => expect(mocks.getTaskRateMetrics).toHaveBeenCalledTimes(1))
        expect(foldUsageOf(result.current)).toBeUndefined()
    })

    it("states no generation time for a round that never reported one", async () => {
        // A round without timing contributes no duration rather than an estimate.
        respondWith([
            { ...roundPoint("round-3", 6_000, 900), providerDurationMs: undefined },
            { ...roundPoint("round-4", 2_000, 300), providerDurationMs: undefined },
            { ...roundPoint("round-5", 1_000, 150), providerDurationMs: undefined },
        ])
        const hook = renderFolded({ taskId: TASK_ID, taskInstanceId: INSTANCE })
        const { result } = await hook.settle()

        await waitFor(() => expect(foldUsageOf(result.current)).toBeDefined())
        const usage = foldUsageOf(result.current)
        expect(usage?.durationMs).toBe(0)
        expect(usage?.averageTokensPerSecond).toBeUndefined()
    })
})
