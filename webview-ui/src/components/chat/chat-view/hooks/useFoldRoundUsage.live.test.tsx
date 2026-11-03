import type { UiMessage } from "@shared/ExtensionMessage"
import { GetTaskRateMetricsResponse, TaskRateMetricPoint, TaskRateUsageQuality } from "@shared/proto/dline/task"
import { act, cleanup, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { finishedRequest, streamingRequest, thinking } from "../components/messages/activityFoldStoryFixtures"
import { useFoldRoundUsage } from "./useFoldRoundUsage"

const mocks = vi.hoisted(() => ({ query: vi.fn() }))
vi.mock("@/services/grpc-client", () => ({ TaskServiceClient: { getTaskRateMetrics: mocks.query } }))

const point = (outputTokens = 100) =>
    TaskRateMetricPoint.create({
        roundId: "round-1",
        providerDurationMs: 2_000,
        outputTokens,
        usageQuality: TaskRateUsageQuality.TASK_RATE_USAGE_QUALITY_EXACT,
    })
const response = (points = [point()], taskInstanceId = "opening-1") =>
    GetTaskRateMetricsResponse.create({ taskId: "task-1", taskInstanceId, points })
const settle = () =>
    act(async () => {
        await Promise.resolve()
    })
const advance = (ms: number) =>
    act(async () => {
        await vi.advanceTimersByTimeAsync(ms)
    })
function renderUsage(messages: UiMessage[], opening = "opening-1") {
    return renderHook(({ rows, instance }) => useFoldRoundUsage("task-1", instance, rows, true), {
        initialProps: { rows: messages, instance: opening },
    })
}

beforeEach(() => {
    vi.useFakeTimers()
    mocks.query.mockReset()
    vi.spyOn(console, "warn").mockImplementation(() => undefined)
})
afterEach(() => {
    cleanup()
    vi.useRealTimers()
    vi.restoreAllMocks()
})

describe("live fold usage query lifecycle", () => {
    it("refreshes in the same opening when a send completes, not for streamed prose", async () => {
        mocks.query.mockResolvedValueOnce(response([])).mockResolvedValue(response())
        const hook = renderUsage([streamingRequest(10)])
        await settle()
        expect(hook.result.current.size).toBe(0)
        hook.rerender({ rows: [streamingRequest(10), thinking(11, "stream", { partial: true })], instance: "opening-1" })
        await settle()
        expect(mocks.query).toHaveBeenCalledTimes(1)
        hook.rerender({ rows: [finishedRequest(10)], instance: "opening-1" })
        await settle()
        expect(hook.result.current.get(10)?.[0].outputTokens).toBe(100)
        expect(mocks.query).toHaveBeenCalledTimes(2)
    })

    it("recovers from History owner readiness without reopening", async () => {
        mocks.query.mockRejectedValueOnce(new Error("not ready")).mockResolvedValue(response())
        const hook = renderUsage([finishedRequest(10)])
        await settle()
        expect(hook.result.current.size).toBe(0)
        await advance(250)
        expect(hook.result.current.get(10)?.[0].providerDurationMs).toBe(2_000)
        await advance(30_000)
        expect(mocks.query).toHaveBeenCalledTimes(2)
    })

    it("reconciles a late exact usage revision after the initial duration-only record", async () => {
        mocks.query
            .mockResolvedValueOnce(
                response([
                    TaskRateMetricPoint.create({
                        roundId: "round-1",
                        providerDurationMs: 2_000,
                        usageQuality: TaskRateUsageQuality.TASK_RATE_USAGE_QUALITY_NONE,
                    }),
                ]),
            )
            .mockResolvedValue(response())
        const hook = renderUsage([finishedRequest(10)])
        await settle()
        expect(hook.result.current.get(10)?.[0].outputTokens).toBeUndefined()
        await advance(250)
        expect(hook.result.current.get(10)?.[0].outputTokens).toBe(100)
    })

    it("fences a stale response from an earlier snapshot of the same opening", async () => {
        let resolveOld!: (value: GetTaskRateMetricsResponse) => void
        mocks.query
            .mockImplementationOnce(
                () =>
                    new Promise<GetTaskRateMetricsResponse>((resolve) => {
                        resolveOld = resolve
                    }),
            )
            .mockResolvedValue(response())
        const hook = renderUsage([streamingRequest(10)])
        await settle()
        hook.rerender({ rows: [finishedRequest(10)], instance: "opening-1" })
        await settle()
        expect(hook.result.current.get(10)?.[0].outputTokens).toBe(100)
        await act(async () => resolveOld(response([point(900)])))
        expect(hook.result.current.get(10)?.[0].outputTokens).toBe(100)
    })

    it("hides the previous opening synchronously and ignores its late response", async () => {
        let resolveOld!: (value: GetTaskRateMetricsResponse) => void
        mocks.query
            .mockResolvedValueOnce(response())
            .mockImplementationOnce(
                () =>
                    new Promise<GetTaskRateMetricsResponse>((resolve) => {
                        resolveOld = resolve
                    }),
            )
            .mockResolvedValue(response([point(50)], "opening-2"))
        const hook = renderUsage([finishedRequest(10)])
        await settle()
        hook.rerender({ rows: [finishedRequest(10), streamingRequest(20)], instance: "opening-1" })
        await settle()
        expect(hook.result.current.get(10)?.[0].outputTokens).toBe(100)
        hook.rerender({ rows: [finishedRequest(30)], instance: "opening-2" })
        expect(hook.result.current.has(10)).toBe(false)
        await settle()
        await act(async () => resolveOld(response([point(900)])))
        expect([...hook.result.current.keys()]).toEqual([30])
        expect(hook.result.current.get(30)?.[0].outputTokens).toBe(50)
    })

    it("does not let several old attempts hide a later send's missing metric", async () => {
        mocks.query
            .mockResolvedValueOnce(
                response([
                    { ...point(), roundId: "old-0", startedAtMs: 11 },
                    { ...point(), roundId: "old-1", startedAtMs: 15 },
                ]),
            )
            .mockResolvedValue(
                response([
                    { ...point(), roundId: "old-0", startedAtMs: 11 },
                    { ...point(), roundId: "old-1", startedAtMs: 15 },
                    { ...point(40), roundId: "new", startedAtMs: 31 },
                ]),
            )
        const hook = renderUsage([finishedRequest(10), finishedRequest(30)])
        await settle()
        expect(hook.result.current.has(30)).toBe(false)
        await advance(250)
        expect(hook.result.current.get(30)?.[0].outputTokens).toBe(40)
    })

    it("retains last-good figures through degraded empty and partial replies", async () => {
        const old = { ...point(), startedAtMs: 11 }
        const newer = { ...point(50), roundId: "new", startedAtMs: 31 }
        mocks.query
            .mockResolvedValueOnce(response([old]))
            .mockResolvedValueOnce({ ...response([]), degraded: true })
            .mockResolvedValueOnce({ ...response([newer]), degraded: true })
            .mockResolvedValue(response([{ ...old, outputTokens: 120 }, newer]))
        const hook = renderUsage([finishedRequest(10)])
        await settle()
        hook.rerender({ rows: [finishedRequest(10), finishedRequest(30)], instance: "opening-1" })
        await settle()
        expect(hook.result.current.get(10)?.[0].outputTokens).toBe(100)
        await advance(250)
        expect(hook.result.current.get(10)?.[0].outputTokens).toBe(100)
        expect(hook.result.current.get(30)?.[0].outputTokens).toBe(50)
        await advance(1_000)
        expect(hook.result.current.get(10)?.[0].outputTokens).toBe(120)
    })

    it("bounds failures and cancels retries on unmount", async () => {
        mocks.query.mockRejectedValue(new Error("unavailable"))
        const hook = renderUsage([finishedRequest(10)])
        await settle()
        await advance(60_000)
        expect(mocks.query).toHaveBeenCalledTimes(4)
        expect(hook.result.current.size).toBe(0)
        hook.rerender({ rows: [finishedRequest(10), finishedRequest(20)], instance: "opening-1" })
        await settle()
        hook.unmount()
        await advance(60_000)
        expect(mocks.query).toHaveBeenCalledTimes(5)
    })
})
