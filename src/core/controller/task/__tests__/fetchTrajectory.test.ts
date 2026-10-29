import { TrajectoryRequest, TrajectoryState } from "@shared/proto/dline/task"
import { afterEach, describe, expect, it } from "vitest"
import { fetchTrajectory } from "../fetchTrajectory"
import { taskWithRows, trajectoryController } from "./fixtures/trajectoryOpening"

const TASK_ID = "task-trajectory-fetch"
const OPENING = { taskId: TASK_ID, taskInstanceId: "open-1" }

describe("fetchTrajectory", () => {
    let task: Awaited<ReturnType<typeof taskWithRows>> | undefined

    afterEach(async () => {
        await task?.dispose()
        task = undefined
    })

    it("answers one full snapshot caught up to the committed rows, and releases trajectory.db", async () => {
        task = await taskWithRows(TASK_ID)
        await task.append(task.prompt("first"), task.tool(), task.reply("second"))
        const { controller, admission } = trajectoryController(OPENING)
        admission.admit(TASK_ID)

        const update = await fetchTrajectory(controller as never, TrajectoryRequest.create(OPENING))

        expect(update).toMatchObject({ state: TrajectoryState.TRAJECTORY_STATE_READY, reset: true, turnCount: 2, ...OPENING })
        expect(update.turns.map((turn) => turn.prompt)).toEqual(["first", "second"])
        expect(await task.trajectoryReleased()).toBe(true)
    })

    it("answers unavailable without creating trajectory.db while the opening lacks the lock", async () => {
        task = await taskWithRows(TASK_ID)
        await task.append(task.prompt("first"))
        const { controller } = trajectoryController(OPENING)

        const update = await fetchTrajectory(controller as never, TrajectoryRequest.create(OPENING))

        expect(update).toMatchObject({ state: TrajectoryState.TRAJECTORY_STATE_UNAVAILABLE, turns: [], ...OPENING })
        expect(await task.trajectoryExists()).toBe(false)
    })

    it("answers unavailable, keyed to the request, for an opening that is no longer current", async () => {
        const { controller } = trajectoryController({ taskId: TASK_ID, taskInstanceId: "open-2" })

        const update = await fetchTrajectory(controller as never, TrajectoryRequest.create(OPENING))

        expect(update).toMatchObject({ state: TrajectoryState.TRAJECTORY_STATE_UNAVAILABLE, ...OPENING })
    })
})
