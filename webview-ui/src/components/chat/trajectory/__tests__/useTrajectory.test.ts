import { TrajectoryState, TrajectoryTurnSummary, TrajectoryUpdate } from "@shared/proto/dline/task"
import { act, renderHook } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

interface StreamCallbacks {
    onResponse: (update: TrajectoryUpdate) => void
    onError: (error: unknown) => void
    onComplete: () => void
}

interface OpenStream extends StreamCallbacks {
    request: { taskId: string; taskInstanceId: string }
    cancel: ReturnType<typeof vi.fn>
}

const streams: OpenStream[] = []

vi.mock("@/services/grpc-client", () => ({
    TaskServiceClient: {
        subscribeToTrajectory: (request: OpenStream["request"], callbacks: StreamCallbacks) => {
            const cancel = vi.fn()
            streams.push({ ...callbacks, request, cancel })
            return cancel
        },
    },
}))

const { useTrajectory, TRAJECTORY_RESUBSCRIBE_MIN_MS, TRAJECTORY_RESUBSCRIBE_MAX_MS } = await import("../useTrajectory")

const OPENING = { taskId: "task-1", taskInstanceId: "open-1" }
const READY = TrajectoryState.TRAJECTORY_STATE_READY
const UNAVAILABLE = TrajectoryState.TRAJECTORY_STATE_UNAVAILABLE

const turn = (seq: number, attemptSeq = 0, endsAttempt = false) =>
    TrajectoryTurnSummary.create({ seq, attemptSeq, endsAttempt, anchorTs: 100 + seq, prompt: `prompt ${seq}`, rounds: 1 })

const reset = (revision: number, turns: TrajectoryTurnSummary[], state = READY) =>
    TrajectoryUpdate.create({ ...OPENING, state, reset: true, revision, turnCount: turns.length, turns })

const delta = (baseRevision: number, revision: number, turnCount: number, turns: TrajectoryTurnSummary[]) =>
    TrajectoryUpdate.create({ ...OPENING, state: READY, baseRevision, revision, turnCount, turns })

describe("useTrajectory", () => {
    beforeEach(() => {
        vi.useFakeTimers()
        streams.length = 0
    })

    afterEach(() => {
        vi.useRealTimers()
    })

    const render = (opening = OPENING) =>
        renderHook(({ taskId, taskInstanceId }) => useTrajectory(taskId, taskInstanceId), { initialProps: opening })
    const anchors = (attempts: ReturnType<typeof useTrajectory>) =>
        attempts.map((attempt) => attempt.turns.map((t) => t.anchorTs))
    const send = (stream: OpenStream, update: TrajectoryUpdate) => act(() => stream.onResponse(update))
    const latest = (): OpenStream => {
        const stream = streams.at(-1)
        if (!stream) throw new Error("no stream was opened")
        return stream
    }

    it("builds attempts from a reset and keeps them current through based deltas", () => {
        const { result } = render()
        expect(streams).toHaveLength(1)
        expect(streams[0].request).toEqual(OPENING)

        send(streams[0], reset(3, [turn(0), turn(1, 0, true)]))
        expect(anchors(result.current)).toEqual([[100, 101]])
        expect(result.current[0].completed).toBe(true)

        send(streams[0], delta(3, 4, 3, [turn(2, 1)]))
        expect(anchors(result.current)).toEqual([[100, 101], [102]])

        // A checkpoint restore removes the newest turns: a delta with a smaller count.
        send(streams[0], delta(4, 5, 1, []))
        expect(anchors(result.current)).toEqual([[100]])
        expect(streams).toHaveLength(1)
    })

    it("reopens on a delta that skips a revision and converges on the next reset", () => {
        const { result } = render()
        send(streams[0], reset(3, [turn(0)]))

        send(streams[0], delta(4, 5, 2, [turn(1)]))
        expect(streams[0].cancel).toHaveBeenCalledOnce()
        // The held turns stay up until the reopened stream replaces them.
        expect(anchors(result.current)).toEqual([[100]])

        act(() => vi.advanceTimersByTime(TRAJECTORY_RESUBSCRIBE_MIN_MS))
        expect(streams).toHaveLength(2)
        send(streams[1], reset(5, [turn(0), turn(1)]))
        expect(anchors(result.current)).toEqual([[100, 101]])

        // Late responses of the abandoned stream change nothing.
        send(streams[0], delta(5, 6, 0, []))
        expect(anchors(result.current)).toEqual([[100, 101]])
    })

    it("hides the rail while unavailable and shows it again on a later reset of the same stream", () => {
        const { result } = render()
        send(streams[0], reset(2, [turn(0)]))
        expect(result.current).toHaveLength(1)

        send(streams[0], reset(0, [], UNAVAILABLE))
        expect(result.current).toEqual([])

        send(streams[0], reset(7, [turn(0), turn(1)]))
        expect(anchors(result.current)).toEqual([[100, 101]])
        expect(streams).toHaveLength(1)
    })

    it("shows only the current reset during empty error/building results and accepts later based updates", () => {
        const { result } = render()
        send(streams[0], reset(2, [turn(0)]))

        send(streams[0], reset(2, [], TrajectoryState.TRAJECTORY_STATE_ERROR))
        expect(result.current).toEqual([])
        send(streams[0], reset(3, [], TrajectoryState.TRAJECTORY_STATE_BUILDING))
        expect(result.current).toEqual([])
        send(streams[0], delta(3, 4, 2, [turn(0), turn(1)]))
        expect(anchors(result.current)).toEqual([[100, 101]])
        send(streams[0], reset(5, []))
        expect(result.current).toEqual([])
        expect(streams).toHaveLength(1)
    })

    it("preserves every duplicate/reversed timestamp point, attempt and count through reset, replacement and append", () => {
        const { result } = render()
        const first = TrajectoryTurnSummary.create({
            seq: 0,
            anchorIndex: 0,
            anchorTs: 200,
            prompt: "task",
            rounds: 2,
            toolUsage: [{ tool: "read_file", count: 4 }],
        })
        const second = TrajectoryTurnSummary.create({
            seq: 1,
            anchorIndex: 19,
            anchorTs: 200,
            prompt: "equal identity",
            rounds: 3,
            endsAttempt: true,
            toolUsage: [{ tool: "search_files", count: 2 }],
        })
        const third = TrajectoryTurnSummary.create({
            seq: 2,
            attemptSeq: 1,
            anchorIndex: 28,
            anchorTs: 80,
            prompt: "earlier timestamp",
            rounds: 5,
        })
        const projection = () =>
            result.current.map((attempt) => ({
                id: attempt.id,
                completed: attempt.completed,
                points: attempt.turns.map(({ seq, anchorIndex, anchorTs, rounds, toolUsage }) => ({
                    seq,
                    anchorIndex,
                    anchorTs,
                    rounds,
                    toolUsage,
                })),
            }))
        send(streams[0], reset(8, [first, second, third]))
        expect(projection()).toEqual([
            {
                id: "attempt-0",
                completed: true,
                points: [
                    { seq: 0, anchorIndex: 0, anchorTs: 200, rounds: 2, toolUsage: [{ tool: "read_file", count: 4 }] },
                    { seq: 1, anchorIndex: 19, anchorTs: 200, rounds: 3, toolUsage: [{ tool: "search_files", count: 2 }] },
                ],
            },
            {
                id: "attempt-1",
                completed: false,
                points: [{ seq: 2, anchorIndex: 28, anchorTs: 80, rounds: 5, toolUsage: [] }],
            },
        ])
        send(
            streams[0],
            delta(8, 9, 4, [
                { ...second, rounds: 7, toolUsage: [{ tool: "search_files", count: 6 }] },
                TrajectoryTurnSummary.create({ seq: 3, attemptSeq: 1, anchorTs: 70, rounds: 11 }),
            ]),
        )
        const points = result.current.flatMap((attempt) => attempt.turns)
        expect(points.map(({ seq, anchorIndex, rounds }) => [seq, anchorIndex, rounds])).toEqual([
            [0, 0, 2],
            [1, 19, 7],
            [2, 28, 5],
            [3, undefined, 11],
        ])
        expect(result.current[0].turns[1].toolUsage).toEqual([{ tool: "search_files", count: 6 }])
        expect(result.current.flatMap((attempt) => attempt.turns).reduce((sum, point) => sum + point.rounds, 0)).toBe(25)
        send(streams[0], delta(9, 10, 2, []))
        expect(anchors(result.current)).toEqual([[200, 200]])
        expect(streams).toHaveLength(1)
    })

    it("reopens an ended or failed stream with a doubling wait that stops at the cap", () => {
        const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined)
        render()
        const waits: number[] = []
        let expected = TRAJECTORY_RESUBSCRIBE_MIN_MS
        for (let attempt = 0; attempt < 6; attempt++) {
            const stream = latest()
            // A failing source ends its stream with an unavailable reset before completing it.
            if (attempt % 2 === 0) send(stream, reset(0, [], UNAVAILABLE))
            act(() => (attempt % 2 === 0 ? stream.onComplete() : stream.onError(new Error("closed"))))
            act(() => vi.advanceTimersByTime(expected - 1))
            const reopenedEarly = streams.at(-1) !== stream
            act(() => vi.advanceTimersByTime(1))
            expect(reopenedEarly).toBe(false)
            expect(streams.at(-1)).not.toBe(stream)
            waits.push(expected)
            expected = Math.min(expected * 2, TRAJECTORY_RESUBSCRIBE_MAX_MS)
        }
        expect(waits).toEqual([500, 1_000, 2_000, 4_000, 8_000, 8_000])

        // A reset proves the stream healthy again, so the next failure waits the minimum.
        send(latest(), reset(1, [turn(0)]))
        const healthy = latest()
        act(() => healthy.onComplete())
        act(() => vi.advanceTimersByTime(TRAJECTORY_RESUBSCRIBE_MIN_MS))
        expect(streams.at(-1)).not.toBe(healthy)
        consoleError.mockRestore()
    })

    it("cancels on unmount and drops a reopen that was still waiting", () => {
        const { unmount } = render()
        act(() => streams[0].onComplete())

        unmount()
        act(() => vi.advanceTimersByTime(TRAJECTORY_RESUBSCRIBE_MAX_MS))

        expect(streams).toHaveLength(1)
    })

    it("follows a new opening and ignores responses addressed to another one", () => {
        const { result, rerender } = render()
        send(streams[0], reset(1, [turn(0)]))

        rerender({ taskId: "task-1", taskInstanceId: "open-2" })
        expect(streams[0].cancel).toHaveBeenCalledOnce()
        expect(streams).toHaveLength(2)
        expect(streams[1].request).toEqual({ taskId: "task-1", taskInstanceId: "open-2" })
        expect(result.current).toEqual([])

        // A response of the previous opening on the new stream is not this opening's trajectory.
        send(streams[1], reset(1, [turn(0)]))
        expect(result.current).toEqual([])
    })
})
