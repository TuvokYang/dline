import type { Controller } from "@core/controller"
import { createInitialTaskState, type TaskState } from "@core/task/kernel"
import { TaskRuntime } from "@core/task/runtime/TaskRuntime"
import type { ActiveTaskSession } from "@core/task/session/ActiveTaskSession"
import type { DurableTaskSnapshot } from "@core/task/stores/contracts"
import { StopAwayModeRequest } from "@shared/proto/dline/task"
import { afterEach, describe, expect, it, vi } from "vitest"
import { stopAwayMode } from "../stopAwayMode"

const runtimes: TaskRuntime[] = []
afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((r) => r.disposeDeadlines()))
})

function harness(save: (snapshot: DurableTaskSnapshot) => Promise<void>, writable = true) {
    const initial: TaskState = {
        ...createInitialTaskState("task-1"),
        revision: 10,
        flow: { phase: "running" },
        away: {
            configuration: { enabled: true, automatic: false, modeRevocation: 0, automaticRevocation: 0 },
            mode: { source: "command", modeRevocation: 0, enteredRevision: 2 },
        },
        dialog: {
            approvalsByBlock: {},
            primary: {
                interactionId: "question",
                turnId: "turn",
                kind: "followup",
                status: "awaiting",
                createdRevision: 8,
                presentationRef: "question",
                actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
                receiverGeneration: 0,
            },
        },
    }
    const executed = vi.fn(async () => {})
    const runtime = new TaskRuntime({
        initialState: initial,
        deferRestoredCommands: !writable,
        vault: { load: async () => undefined, save },
        publications: { has: async () => false, mark: async () => {} },
        taskView: { notifyCommitted: async () => {}, notifyTransient: () => {} },
        executors: (["provider", "compose", "dialog", "tool", "halt"] as const).map((domain) => ({
            domain,
            execute: executed,
        })),
    })
    runtimes.push(runtime)
    const session = {
        taskId: "task-1",
        taskInstanceId: "opening-1",
        writable,
        state: () => runtime.getState(),
        assembly: { runtime },
    } as ActiveTaskSession
    const controller = { task: session, currentOpening: () => controller.task } as unknown as Controller
    const request = StopAwayModeRequest.decode(
        StopAwayModeRequest.encode({ taskId: "task-1", taskInstanceId: "opening-1" }).finish(),
    )
    return { initial, runtime, session, controller, request, executed }
}

// The oracle is the durable snapshot and unchanged live dialog/execution, not
// just a mocked event call. A cancel, reply or early RPC success fails it.
describe("stopAwayMode", () => {
    it("waits for durability and leaves the current question and execution untouched", async () => {
        let release!: () => void
        let entered!: () => void
        const started = new Promise<void>((resolve) => {
            entered = resolve
        })
        const saved = new Promise<void>((resolve) => {
            release = resolve
        })
        let snapshot: DurableTaskSnapshot | undefined
        const h = harness(async (value) => {
            entered()
            await saved
            snapshot = value
        })
        let returned = false
        const response = stopAwayMode(h.controller, h.request).then((r) => {
            returned = true
            return r
        })
        await started
        expect(returned).toBe(false)
        expect(snapshot).toBeUndefined()
        release()
        expect(await response).toEqual({ accepted: true, result: "accepted" })
        expect(snapshot?.state.away?.mode).toBeUndefined()
        expect(snapshot?.state.dialog).toEqual(h.initial.dialog)
        expect(snapshot?.state.flow).toEqual(h.initial.flow)
        expect(snapshot?.state.intake).toEqual(h.initial.intake)
        expect(snapshot?.state.roundMaterial?.notices).toMatchObject([{ kind: "away_exited", reason: "stopped" }])
        expect(h.executed).not.toHaveBeenCalled()
    })

    it("surfaces a failed commit and retries the same exit without duplicate notices", async () => {
        let fail = true
        let snapshot: DurableTaskSnapshot | undefined
        const h = harness(async (value) => {
            if (fail) throw new Error("Vault unavailable")
            snapshot = value
        })
        await expect(stopAwayMode(h.controller, h.request)).rejects.toThrow("Vault unavailable")
        expect(snapshot).toBeUndefined()
        fail = false
        expect((await stopAwayMode(h.controller, h.request)).accepted).toBe(true)
        expect(snapshot?.state.roundMaterial?.notices).toHaveLength(1)
        expect(snapshot?.state.dialog).toEqual(h.initial.dialog)
    })

    it("promotes the exact history opening without sending a Resume or answering its question", async () => {
        let snapshot: DurableTaskSnapshot | undefined
        const h = harness(async (value) => {
            snapshot = value
        })
        const display = { taskId: h.session.taskId, taskInstanceId: h.session.taskInstanceId }
        h.controller.task = undefined
        h.controller.currentOpening = () => h.controller.task ?? display
        h.controller.promoteHistoryDisplayForActivityControl = vi.fn(async (_taskId, expected) => {
            expect(expected).toBe(display)
            h.controller.task = h.session
            return true
        })
        expect((await stopAwayMode(h.controller, h.request)).accepted).toBe(true)
        expect(snapshot?.state.away?.mode).toBeUndefined()
        expect(snapshot?.state.dialog).toEqual(h.initial.dialog)
        expect(snapshot?.state.flow).toEqual(h.initial.flow)
        expect(h.executed).not.toHaveBeenCalled()
    })

    it.each(["missing", "other_task", "old_opening", "read_only"] as const)("refuses %s before writing", async (kind) => {
        const save = vi.fn(async () => {})
        const h = harness(save, kind !== "read_only")
        if (kind === "missing") h.controller.task = undefined
        const request = {
            ...h.request,
            ...(kind === "other_task" ? { taskId: "other" } : {}),
            ...(kind === "old_opening" ? { taskInstanceId: "opening-0" } : {}),
        }
        expect(await stopAwayMode(h.controller, request)).toEqual({
            accepted: false,
            result: kind === "read_only" ? "task_read_only" : "stale_task",
        })
        expect(h.runtime.getState()).toBe(h.initial)
        expect(save).not.toHaveBeenCalled()
    })
})
