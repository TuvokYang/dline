import { TrajectoryRequest, TrajectoryState } from "@shared/proto/dline/task"
import { afterEach, describe, expect, it, vi } from "vitest"
import { getRequestRegistry } from "../../grpc-handler"
import { subscribeToTrajectory } from "../subscribeToTrajectory"
import { taskWithRows, trajectoryController, trajectoryReceiver } from "./fixtures/trajectoryOpening"

const TASK_ID = "task-trajectory-stream"
const OPENING = { taskId: TASK_ID, taskInstanceId: "open-1" }
const UNAVAILABLE = TrajectoryState.TRAJECTORY_STATE_UNAVAILABLE

/** Real storage plus a lock poll: allow a few poll rounds and catch-ups. */
const waitFor = (assertion: () => unknown) => vi.waitFor(assertion, { timeout: 5_000, interval: 20 })

describe("subscribeToTrajectory", () => {
    let task: Awaited<ReturnType<typeof taskWithRows>> | undefined
    let requestCounter = 0
    const requests: string[] = []
    const nextRequestId = () => {
        const id = `trajectory-stream-${++requestCounter}`
        requests.push(id)
        return id
    }

    afterEach(async () => {
        for (const id of requests.splice(0)) getRequestRegistry().cancelRequest(id)
        // Cancelled streams release their maintainer asynchronously.
        await new Promise((resolve) => setTimeout(resolve, 50))
        await task?.dispose()
        task = undefined
    })

    it("ends at once, keyed to the request, when the request names no current opening", async () => {
        const { controller } = trajectoryController({ taskId: TASK_ID, taskInstanceId: "open-2" })
        const view = trajectoryReceiver()

        await subscribeToTrajectory(controller as never, TrajectoryRequest.create(OPENING), view.responseStream, nextRequestId())

        expect(view.updates).toHaveLength(1)
        expect(view.last()).toMatchObject({ isLast: true, update: { state: UNAVAILABLE, reset: true, ...OPENING } })
    })

    it("opens with a reset of the committed history and then streams based deltas", async () => {
        task = await taskWithRows(TASK_ID)
        await task.append(task.prompt("first"), task.tool())
        const { controller, admission } = trajectoryController(OPENING)
        admission.admit(TASK_ID)
        const view = trajectoryReceiver()

        await subscribeToTrajectory(controller as never, TrajectoryRequest.create(OPENING), view.responseStream, nextRequestId())
        await waitFor(() => expect(view.ready() && view.prompts()).toEqual(["first"]))
        expect(view.updates[0].update).toMatchObject({ reset: true, baseRevision: 0, ...OPENING })

        await task.append(task.reply("second"), task.tool())

        // The receiver rejects any delta whose base is not the previous revision.
        await waitFor(() => expect(view.prompts()).toEqual(["first", "second"]))
        expect(view.updates.at(-1)?.update.reset).toBe(false)
        expect(view.updates.every(({ isLast }) => !isLast)).toBe(true)
    })

    it("reports unavailable without creating trajectory.db while the live opening lacks the lock", async () => {
        task = await taskWithRows(TASK_ID)
        await task.append(task.prompt("first"))
        const { controller } = trajectoryController(OPENING)
        const view = trajectoryReceiver()

        await subscribeToTrajectory(controller as never, TrajectoryRequest.create(OPENING), view.responseStream, nextRequestId())
        await waitFor(() => expect(view.updates).toHaveLength(1))
        await new Promise((resolve) => setTimeout(resolve, 100))

        expect(view.last()).toMatchObject({ isLast: false, update: { state: UNAVAILABLE, reset: true } })
        expect(await task.trajectoryExists()).toBe(false)
    })

    it("stops writing as soon as the lock is lost, then resumes from a reset once the lock is taken over", async () => {
        task = await taskWithRows(TASK_ID)
        await task.append(task.prompt("first"))
        const { controller, admission } = trajectoryController(OPENING)
        admission.admit(TASK_ID)
        const view = trajectoryReceiver()
        await subscribeToTrajectory(controller as never, TrajectoryRequest.create(OPENING), view.responseStream, nextRequestId())
        await waitFor(() => expect(view.ready()).toBe(true))

        admission.revoke()
        await waitFor(() => expect(view.last()?.update.state).toBe(UNAVAILABLE))
        await waitFor(async () => expect(await task?.trajectoryReleased()).toBe(true))

        const before = view.updates.length
        admission.admit(TASK_ID)
        await waitFor(() => expect(view.ready()).toBe(true))
        expect(view.updates[before].update).toMatchObject({ reset: true, baseRevision: 0 })
        expect(view.prompts()).toEqual(["first"])
    })

    it("follows a history display between ownerless and foreign-locked, closing trajectory.db while foreign", async () => {
        task = await taskWithRows(TASK_ID)
        await task.append(task.prompt("first"))
        const { controller, state } = trajectoryController(OPENING, { historyDisplay: true, ownerless: false })
        const view = trajectoryReceiver()
        await subscribeToTrajectory(controller as never, TrajectoryRequest.create(OPENING), view.responseStream, nextRequestId())
        await waitFor(() => expect(view.last()?.update.state).toBe(UNAVAILABLE))
        expect(await task.trajectoryExists()).toBe(false)

        state.ownerless = true
        await waitFor(() => expect(view.ready() && view.prompts()).toEqual(["first"]))

        state.ownerless = false
        await waitFor(() => expect(view.last()?.update.state).toBe(UNAVAILABLE))
        await waitFor(async () => expect(await task?.trajectoryReleased()).toBe(true))

        state.ownerless = true
        const before = view.updates.length
        await waitFor(() => expect(view.ready()).toBe(true))
        expect(view.updates[before].update.reset).toBe(true)
    })

    it("catches up on rows another window committed while the display was ownerless", async () => {
        task = await taskWithRows(TASK_ID)
        await task.append(task.prompt("first"))
        const { controller } = trajectoryController(OPENING, { historyDisplay: true, ownerless: true })
        const view = trajectoryReceiver()
        await subscribeToTrajectory(controller as never, TrajectoryRequest.create(OPENING), view.responseStream, nextRequestId())
        await waitFor(() => expect(view.ready() && view.prompts()).toEqual(["first"]))

        // Same process here, but the poll alone must be enough: it wakes catch-up on every round.
        await task.append(task.reply("second"))

        await waitFor(() => expect(view.prompts()).toEqual(["first", "second"]))
    })

    it("ends the stream, keyed to its opening, when the opening is replaced", async () => {
        task = await taskWithRows(TASK_ID)
        await task.append(task.prompt("first"))
        const { controller, admission, state } = trajectoryController(OPENING)
        admission.admit(TASK_ID)
        const view = trajectoryReceiver()
        const requestId = nextRequestId()
        await subscribeToTrajectory(controller as never, TrajectoryRequest.create(OPENING), view.responseStream, requestId)
        await waitFor(() => expect(view.ready()).toBe(true))

        state.current = { taskId: TASK_ID, taskInstanceId: "open-2" }
        admission.revoke()

        await waitFor(() => expect(view.last()?.isLast).toBe(true))
        expect(view.last()?.update).toMatchObject({ state: UNAVAILABLE, ...OPENING })
        expect(getRequestRegistry().hasRequest(requestId)).toBe(false)
        await waitFor(async () => expect(await task?.trajectoryReleased()).toBe(true))
    })

    it("ends the stream, keyed to its opening, while the task has no messages.db, and creates neither database", async () => {
        task = await taskWithRows(TASK_ID)
        const { controller, admission } = trajectoryController(OPENING)
        admission.admit(TASK_ID)
        const view = trajectoryReceiver()
        const requestId = nextRequestId()

        await subscribeToTrajectory(controller as never, TrajectoryRequest.create(OPENING), view.responseStream, requestId)

        // Ending the RPC is what lets the Webview resubscribe with backoff once the history exists.
        await waitFor(() => expect(view.last()?.isLast).toBe(true))
        expect(view.updates).toHaveLength(1)
        expect(view.last()?.update).toMatchObject({ state: UNAVAILABLE, reset: true, ...OPENING })
        expect(getRequestRegistry().hasRequest(requestId)).toBe(false)
        expect(await task.messagesExist()).toBe(false)
        expect(await task.trajectoryExists()).toBe(false)
        expect(await task.trajectoryReleased()).toBe(true)
    })

    it("releases trajectory.db when the client cancels", async () => {
        task = await taskWithRows(TASK_ID)
        await task.append(task.prompt("first"))
        const { controller, admission } = trajectoryController(OPENING)
        admission.admit(TASK_ID)
        const view = trajectoryReceiver()
        const requestId = nextRequestId()
        await subscribeToTrajectory(controller as never, TrajectoryRequest.create(OPENING), view.responseStream, requestId)
        await waitFor(() => expect(view.ready()).toBe(true))
        expect(await task.trajectoryReleased()).toBe(false)

        getRequestRegistry().cancelRequest(requestId)

        await waitFor(async () => expect(await task?.trajectoryReleased()).toBe(true))
        const sent = view.updates.length
        await task.append(task.reply("after cancel"))
        await new Promise((resolve) => setTimeout(resolve, 200))
        expect(view.updates).toHaveLength(sent)
    })
})
