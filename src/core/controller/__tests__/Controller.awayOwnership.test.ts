import { afterEach, describe, expect, it, vi } from "vitest"
import { createInitialTaskState, type TaskState } from "@/core/task/kernel"
import { TaskRuntime } from "@/core/task/runtime/TaskRuntime"
import { TrajectoryAdmission } from "@/core/trajectory/TrajectorySource"
import { Controller } from "../index"

vi.mock("@/core/storage/disk", async (importOriginal) => ({
    ...(await importOriginal<typeof import("@/core/storage/disk")>()),
    cleanupStaleTaskTempFiles: vi.fn(async () => undefined),
}))

const prototype = Controller.prototype as unknown as { startLockHeartbeat(taskId: string): void }
const cleanup: (() => Promise<void>)[] = []
afterEach(async () => {
    await Promise.all(cleanup.splice(0).map((close) => close()))
    vi.useRealTimers()
})

// The lifecycle close deliberately stays queued: only the production heartbeat can fence the timer.
describe("Controller Away ownership on heartbeat", () => {
    it.each([false, true])("keeps deadline execution consistent with observed lock ownership %s", async (held) => {
        vi.useFakeTimers()
        vi.setSystemTime(0)
        const base = createInitialTaskState("heartbeat-away")
        const initial: TaskState = {
            ...base,
            flow: { phase: "running" },
            away: { configuration: { enabled: true, automatic: true, modeRevocation: 0, automaticRevocation: 0 } },
            dialog: {
                approvalsByBlock: {},
                primary: {
                    interactionId: "question",
                    turnId: "turn",
                    kind: "followup",
                    status: "awaiting",
                    createdRevision: 0,
                    receiverGeneration: 0,
                    presentationRef: "question-body",
                    actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
                    deadline: { kind: "ask", deadlineAt: 61_000, modeRevocation: 0, automaticRevocation: 0 },
                },
            },
        }
        const save = vi.fn(async () => {})
        const deliver = vi.fn(async () => {})
        const runtime = new TaskRuntime({
            initialState: initial,
            vault: { load: async () => undefined, save },
            taskView: { notifyCommitted: async () => {}, notifyTransient: () => {} },
            publications: { has: async () => false, mark: async () => {} },
            executors: [{ domain: "dialog", execute: async () => {} }],
            automaticResponses: { deliver },
        })
        const opening = { taskId: initial.taskId, assembly: { runtime } }
        const clearTask = vi.fn(() => new Promise<void>(() => {}))
        const subject = {
            task: opening,
            trajectoryAdmission: new TrajectoryAdmission(),
            currentOpening: () => opening,
            lockService: { touchTaskLock: async () => held },
            clearTask,
            lockHeartbeatTimer: undefined as ReturnType<typeof setInterval> | undefined,
        }
        cleanup.push(async () => {
            clearInterval(subject.lockHeartbeatTimer)
            await runtime.disposeDeadlines()
        })
        runtime.allowRestoredCommands()
        prototype.startLockHeartbeat.call(subject, initial.taskId)
        await vi.advanceTimersByTimeAsync(60_000)
        expect(runtime.isWritable()).toBe(held)
        await vi.advanceTimersByTimeAsync(1_000)
        await runtime.waitForQuiescence()
        if (held) {
            expect(clearTask).not.toHaveBeenCalled()
            expect(save).toHaveBeenCalledTimes(1)
            expect(deliver).toHaveBeenCalledTimes(1)
            expect(runtime.getState().dialog.primary?.acceptedResponse?.origin).toBe("timeout")
        } else {
            expect(clearTask).toHaveBeenCalledExactlyOnceWith({ expectedOpening: opening, closeReason: "lock_lost" })
            expect(save).not.toHaveBeenCalled()
            expect(deliver).not.toHaveBeenCalled()
            expect(runtime.getState()).toBe(initial)
        }
    })
})
