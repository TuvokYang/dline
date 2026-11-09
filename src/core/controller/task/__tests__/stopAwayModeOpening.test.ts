import { Controller } from "@core/controller"
import { describe, expect, it, vi } from "vitest"
import type { TaskOpening } from "../opened-task"

// A request can wait behind the lifecycle lock while the same task is reopened.
// Removing the in-lock comparison would promote that different opening.
describe("Away history opening admission", () => {
    it.each([
        false,
        true,
    ])("checks the exact opening again when the lifecycle lock is acquired (switched=%s)", async (switched) => {
        const expected: TaskOpening = { taskId: "task", taskInstanceId: "opening-1" }
        let current = expected
        let operation!: () => Promise<boolean>
        const promoted = vi.fn(async (_display: TaskOpening) => {})
        const subject = {
            task: undefined as TaskOpening | undefined,
            currentOpening: () => current,
            historyDisplaySession: expected,
            canPromoteHistoryDisplay: () => true,
            runTaskLifecycleOperation: (callback: () => Promise<boolean>) =>
                new Promise<boolean>((resolve, reject) => {
                    operation = async () => {
                        try {
                            const result = await callback()
                            resolve(result)
                            return result
                        } catch (error) {
                            reject(error)
                            throw error
                        }
                    }
                }),
            promoteHistoryDisplay: async (display: TaskOpening) => {
                await promoted(display)
                subject.task = display
            },
            postTaskViewPatchToWebview: async () => {},
        }
        const result = Controller.prototype.promoteHistoryDisplayForActivityControl.call(
            subject as unknown as Controller,
            "task",
            expected,
        )
        if (switched) current = { taskId: "task", taskInstanceId: "opening-2" }
        await operation()
        expect(await result).toBe(!switched)
        expect(promoted.mock.calls.map(([display]) => display)).toEqual(switched ? [] : [expected])
    })
})
