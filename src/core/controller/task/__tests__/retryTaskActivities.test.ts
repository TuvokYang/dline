import { createSessionFixture } from "@core/task/session/__fixtures__/active-task-session"
import { RetryTaskActivitiesRequest } from "@shared/proto/dline/task"
import { describe, expect, it, vi } from "vitest"
import { retryTaskActivities } from "../retryTaskActivities"

type Opening = { readonly taskId: string; readonly taskInstanceId: string }

/** A Controller double whose current opening is its session, or else its history display. */
function controllerWith<T extends Opening>(fields: {
    task?: T
    historyDisplay?: Opening
    promoteHistoryDisplayForActivityControl?: (taskId: string) => Promise<boolean>
}) {
    const controller = {
        ...fields,
        currentOpening: (): Opening | undefined => controller.task ?? controller.historyDisplay,
    }
    return controller
}

function request(activityIds: string[], taskInstanceId = "open-1") {
    return RetryTaskActivitiesRequest.create({ taskId: "task-1", taskInstanceId, activityIds })
}

describe("retryTaskActivities", () => {
    it("loads persisted activities before deciding a reopened activity is retryable", async () => {
        // A promoted runtime starts with an empty store; the record only exists after hydrate.
        let hydrated = false
        let liveRetryControl = false
        const hydrate = vi.fn(async () => {
            hydrated = true
        })
        const restoreSubagentActivityRetry = vi.fn(async () => {
            liveRetryControl = true
            return true
        })
        const retry = vi.fn(async (activityIds: string[]) => (liveRetryControl ? activityIds : []))
        const session = createSessionFixture({
            taskId: "task-1",
            taskInstanceId: "open-1",
            owners: {
                activities: {
                    hydrate,
                    hasLiveRetryControl: vi.fn(() => liveRetryControl),
                    isRetryable: vi.fn(() => hydrated),
                    retry,
                },
                toolExecution: { restoreSubagentActivityRetry },
            },
        })

        const response = await retryTaskActivities(controllerWith({ task: session }) as never, request(["subagent-reopened"]))

        expect(response.retriedActivityIds).toEqual(["subagent-reopened"])
        expect(hydrate).toHaveBeenCalledTimes(1)
        expect(restoreSubagentActivityRetry).toHaveBeenCalledWith("subagent-reopened")
    })

    it("does not retry when a same-ID replacement opens while activities load", async () => {
        let release!: () => void
        const retry = vi.fn(async (activityIds: string[]) => activityIds)
        const owners = {
            activities: {
                hydrate: vi.fn(
                    () =>
                        new Promise<void>((resolve) => {
                            release = resolve
                        }),
                ),
                hasLiveRetryControl: () => true,
                isRetryable: () => true,
                retry,
            },
        }
        const session = createSessionFixture({ taskId: "task-1", taskInstanceId: "open-1", owners })
        const controller = controllerWith<typeof session>({ task: session })
        const pending = retryTaskActivities(controller as never, request(["job"]))
        controller.task = createSessionFixture({ taskId: "task-1", taskInstanceId: "open-2", owners })
        release()
        await expect(pending).resolves.toMatchObject({ retriedActivityIds: [] })
        expect(retry).not.toHaveBeenCalled()
    })

    it("restores a persisted retry control before retrying a reopened activity", async () => {
        let liveRetryControl = false
        const restoreSubagentActivityRetry = vi.fn(async () => {
            liveRetryControl = true
            return true
        })
        const retry = vi.fn(async (activityIds: string[]) => (liveRetryControl ? activityIds : []))
        const session = createSessionFixture({
            taskId: "task-1",
            taskInstanceId: "open-1",
            owners: {
                activities: {
                    hydrate: vi.fn(async () => undefined),
                    hasLiveRetryControl: vi.fn(() => liveRetryControl),
                    isRetryable: vi.fn(() => true),
                    retry,
                },
                toolExecution: { restoreSubagentActivityRetry },
            },
        })

        const response = await retryTaskActivities(controllerWith({ task: session }) as never, request(["subagent-reopened"]))

        expect(response.retriedActivityIds).toEqual(["subagent-reopened"])
        expect(restoreSubagentActivityRetry).toHaveBeenCalledWith("subagent-reopened")
        expect(retry).toHaveBeenCalledWith(["subagent-reopened"])
        expect(restoreSubagentActivityRetry.mock.invocationCallOrder[0]).toBeLessThan(retry.mock.invocationCallOrder[0])
    })

    it("promotes a history display into the task's runtime before retrying", async () => {
        const retry = vi.fn(async (activityIds: string[]) => activityIds)
        const session = createSessionFixture({
            taskId: "task-1",
            taskInstanceId: "open-2",
            owners: {
                activities: {
                    hydrate: vi.fn(async () => undefined),
                    hasLiveRetryControl: vi.fn(() => true),
                    isRetryable: vi.fn(() => true),
                    retry,
                },
                toolExecution: { restoreSubagentActivityRetry: vi.fn(async () => true) },
            },
        })
        const controller = controllerWith<typeof session>({
            historyDisplay: { taskId: "task-1", taskInstanceId: "open-1" },
            promoteHistoryDisplayForActivityControl: vi.fn(async () => {
                controller.task = session
                return true
            }),
        })

        const response = await retryTaskActivities(controller as never, request(["subagent-history"]))

        expect(controller.promoteHistoryDisplayForActivityControl).toHaveBeenCalledWith("task-1")
        expect(response.retriedActivityIds).toEqual(["subagent-history"])
    })

    it("retries nothing when the history display cannot become the runtime", async () => {
        const controller = controllerWith({
            historyDisplay: { taskId: "task-1", taskInstanceId: "open-1" },
            promoteHistoryDisplayForActivityControl: vi.fn(async () => false),
        })

        const response = await retryTaskActivities(controller as never, request(["subagent-locked"]))

        expect(response.retriedActivityIds).toEqual([])
    })

    it("does not rebuild a retry control that is already live", async () => {
        const restoreSubagentActivityRetry = vi.fn(async () => true)
        const retry = vi.fn(async (activityIds: string[]) => activityIds)
        const session = createSessionFixture({
            taskId: "task-1",
            taskInstanceId: "open-1",
            owners: {
                activities: {
                    hydrate: vi.fn(async () => undefined),
                    hasLiveRetryControl: vi.fn(() => true),
                    isRetryable: vi.fn(() => true),
                    retry,
                },
                toolExecution: { restoreSubagentActivityRetry },
            },
        })

        const response = await retryTaskActivities(controllerWith({ task: session }) as never, request(["subagent-live"]))

        expect(response.retriedActivityIds).toEqual(["subagent-live"])
        expect(restoreSubagentActivityRetry).not.toHaveBeenCalled()
    })

    it("ignores a retry rendered by a previous opening of the same task", async () => {
        const retry = vi.fn(async (activityIds: string[]) => activityIds)
        const session = createSessionFixture({
            taskId: "task-1",
            taskInstanceId: "open-2",
            owners: {
                activities: { hydrate: async () => undefined, hasLiveRetryControl: () => true, isRetryable: () => true, retry },
            },
        })

        const response = await retryTaskActivities(controllerWith({ task: session }) as never, request(["job"], "open-1"))

        expect(response.retriedActivityIds).toEqual([])
        expect(retry).not.toHaveBeenCalled()
    })

    it("does not retry when a same-ID replacement opens during retry restoration", async () => {
        let release!: () => void
        const retry = vi.fn(async (activityIds: string[]) => activityIds)
        const owners = {
            activities: { hydrate: async () => undefined, hasLiveRetryControl: () => false, isRetryable: () => true, retry },
            toolExecution: {
                restoreSubagentActivityRetry: vi.fn(
                    () =>
                        new Promise<boolean>((resolve) => {
                            release = () => resolve(true)
                        }),
                ),
            },
        }
        const session = createSessionFixture({ taskId: "task-1", taskInstanceId: "open-1", owners })
        const controller = controllerWith<typeof session>({ task: session })
        const pending = retryTaskActivities(controller as never, request(["job"]))
        await vi.waitFor(() => expect(owners.toolExecution.restoreSubagentActivityRetry).toHaveBeenCalled())
        controller.task = createSessionFixture({ taskId: "task-1", taskInstanceId: "open-2", owners })
        release()
        await expect(pending).resolves.toMatchObject({ retriedActivityIds: [] })
        expect(retry).not.toHaveBeenCalled()
    })
})
