import { Controller } from "@core/controller"
import type { ActiveTaskSession } from "@core/task/session/ActiveTaskSession"
import { describe, expect, it, vi } from "vitest"

/** A session reduced to the opening identity the successor fence compares. */
function opening(taskId: string, taskInstanceId: string): ActiveTaskSession {
    return { taskId, taskInstanceId } as ActiveTaskSession
}

describe("Controller New Task successor ownership", () => {
    it("starts the successor only while the source opening still owns the surface", async () => {
        const controller = Object.create(Controller.prototype) as Controller
        const source = opening("task-old", "open-1")
        Object.assign(controller as unknown as Record<string, unknown>, { task: source })
        const clearTask = vi.fn(async () => undefined)
        vi.spyOn(controller, "runTaskLifecycleOperation").mockImplementation(async (operation) => operation({ clearTask }))
        const initTask = vi.spyOn(controller, "initTask").mockResolvedValue("task-new")

        const taskId = await controller.startSuccessorTask(source, {
            task: "Successor task",
            context: "Successor context",
            source: { functionId: "call-1", dlineTid: "tid-1" },
            taskSettings: { mode: "act", planModeProfile: "plan-old", actModeProfile: "act-old" },
        })

        expect(taskId).toBe("task-new")
        expect(clearTask).toHaveBeenCalledWith({ suppressPostState: true, closeReason: "handoff" })
        expect(initTask).toHaveBeenCalledWith(
            "Successor task",
            undefined,
            undefined,
            undefined,
            { mode: "act", planModeProfile: "plan-old", actModeProfile: "act-old" },
            // Opened like a spawned task: the task as `<task>`, the context as `<context>`, nothing else.
            // The handoff source names the kernel approval the user answered (`approval:<dlineTid>`),
            // the same id the Webview captured the unsent draft under, so it recognises its successor.
            {
                context: ["Successor context"],
                startInBackground: true,
                skipInitialClear: true,
                handoffSource: { taskId: "task-old", interactionId: "approval:tid-1" },
            },
        )
    })

    it.each([
        ["another task", "task-user-opened"],
        ["the same task reopened", "task-old"],
    ])("does not clear a replacement opening of %s before a deferred successor", async (_label, replacementId) => {
        const controller = Object.create(Controller.prototype) as Controller
        const source = opening("task-old", "open-1")
        const replacement = opening(replacementId, "open-2")
        Object.assign(controller as unknown as Record<string, unknown>, { task: replacement })
        const clearTask = vi.fn(async () => undefined)
        vi.spyOn(controller, "runTaskLifecycleOperation").mockImplementation(async (operation) => operation({ clearTask }))
        const initTask = vi.spyOn(controller, "initTask").mockResolvedValue("task-new")

        const taskId = await controller.startSuccessorTask(source, {
            task: "Successor task",
            context: "Successor context",
            source: { functionId: "call-1", dlineTid: "tid-1" },
            taskSettings: { mode: "plan" },
        })

        expect(taskId).toBeUndefined()
        expect(clearTask).not.toHaveBeenCalled()
        expect(initTask).not.toHaveBeenCalled()
        expect(controller.task).toBe(replacement)
    })

    it("checks the source opening inside the lifecycle lane before a delayed footer close", async () => {
        const controller = Object.create(Controller.prototype) as Controller
        const source = opening("task-old", "open-1")
        const replacement = opening("task-old", "open-2")
        controller.task = source
        const clearTask = vi.fn(async () => undefined)
        vi.spyOn(controller, "runTaskLifecycleOperation").mockImplementation(async (operation) => {
            controller.task = replacement
            return operation({ clearTask })
        })

        await controller.clearTask({ expectedOpening: source, preserveCompletedState: true })
        expect(clearTask).not.toHaveBeenCalled()
        expect(controller.task).toBe(replacement)
    })
})
