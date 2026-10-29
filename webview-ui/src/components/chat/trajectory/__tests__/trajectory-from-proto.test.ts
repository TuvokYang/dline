import { TrajectoryState, TrajectoryTurnSummary, TrajectoryUpdate } from "@shared/proto/dline/task"
import { describe, expect, it } from "vitest"
import { applyTrajectoryUpdate, isTrajectoryShown, TRAJECTORY_GAP, toTrajectoryAttempts } from "../trajectory-from-proto"

const READY = TrajectoryState.TRAJECTORY_STATE_READY

const turn = (seq: number, fields: Partial<TrajectoryTurnSummary> = {}) =>
    TrajectoryTurnSummary.create({ seq, anchorTs: 100 + seq, prompt: `prompt ${seq}`, rounds: 1, ...fields })

const update = (fields: Partial<TrajectoryUpdate>) =>
    TrajectoryUpdate.create({ taskId: "task", taskInstanceId: "open", state: READY, ...fields })

describe("applyTrajectoryUpdate", () => {
    const base = applyTrajectoryUpdate(
        undefined,
        update({ reset: true, revision: 4, turnCount: 3, turns: [turn(0), turn(1), turn(2)] }),
    )

    it("replaces the log on a reset whatever it held", () => {
        const reset = applyTrajectoryUpdate(
            base as never,
            update({ reset: true, revision: 9, turnCount: 1, turns: [turn(0, { prompt: "rebuilt" })] }),
        )

        expect(reset).toMatchObject({ revision: 9, turns: [{ seq: 0, prompt: "rebuilt" }] })
    })

    it("rewrites changed turns, appends new ones and drops those past the count", () => {
        const grown = applyTrajectoryUpdate(
            base as never,
            update({ baseRevision: 4, revision: 5, turnCount: 4, turns: [turn(2, { rounds: 7 }), turn(3)] }),
        )
        expect(grown).not.toBe(TRAJECTORY_GAP)
        expect((grown as Exclude<typeof grown, string>).turns.map(({ seq, rounds }) => [seq, rounds])).toEqual([
            [0, 1],
            [1, 1],
            [2, 7],
            [3, 1],
        ])

        // A restore that removes the last turns is a delta with no turns and a smaller count.
        const truncated = applyTrajectoryUpdate(grown as never, update({ baseRevision: 5, revision: 6, turnCount: 2 }))
        expect((truncated as Exclude<typeof truncated, string>).turns.map(({ seq }) => seq)).toEqual([0, 1])
    })

    it("refuses a delta that does not follow the held revision, or arrives before any reset", () => {
        expect(applyTrajectoryUpdate(base as never, update({ baseRevision: 3, revision: 5, turnCount: 3 }))).toBe(TRAJECTORY_GAP)
        expect(applyTrajectoryUpdate(undefined, update({ baseRevision: 0, revision: 1, turnCount: 1, turns: [turn(0)] }))).toBe(
            TRAJECTORY_GAP,
        )
    })

    it("never shows a turn after a seq the stream did not send", () => {
        const holed = applyTrajectoryUpdate(
            undefined,
            update({ reset: true, revision: 1, turnCount: 3, turns: [turn(0), turn(2)] }),
        )

        expect((holed as Exclude<typeof holed, string>).turns.map(({ seq }) => seq)).toEqual([0])
    })
})

describe("isTrajectoryShown", () => {
    it.each([
        [TrajectoryState.TRAJECTORY_STATE_READY, true],
        [TrajectoryState.TRAJECTORY_STATE_BUILDING, true],
        [TrajectoryState.TRAJECTORY_STATE_ERROR, false],
        [TrajectoryState.TRAJECTORY_STATE_UNAVAILABLE, false],
        [TrajectoryState.TRAJECTORY_STATE_UNSPECIFIED, false],
    ])("state %s shown: %s", (state, shown) => {
        expect(isTrajectoryShown({ state, revision: 1, turns: [] })).toBe(shown)
    })
})

describe("toTrajectoryAttempts", () => {
    it("starts an attempt per attemptSeq and marks the ones that ended at a completion", () => {
        const attempts = toTrajectoryAttempts([
            turn(0, { attemptSeq: 0, toolUsage: [{ tool: "read_file", count: 2 }] }),
            turn(1, { attemptSeq: 0, endsAttempt: true }),
            turn(2, { attemptSeq: 1 }),
        ])

        expect(attempts).toEqual([
            {
                id: "attempt-0",
                completed: true,
                turns: [
                    { anchorTs: 100, prompt: "prompt 0", rounds: 1, toolUsage: [{ tool: "read_file", count: 2 }] },
                    { anchorTs: 101, prompt: "prompt 1", rounds: 1, toolUsage: [] },
                ],
            },
            { id: "attempt-1", completed: false, turns: [{ anchorTs: 102, prompt: "prompt 2", rounds: 1, toolUsage: [] }] },
        ])
    })
})
