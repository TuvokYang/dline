import * as coreApi from "@core/api"
import { afterEach, describe, expect, it, vi } from "vitest"
import { TaskActivityPersistence } from "../activity/TaskActivityPersistence"
import { TaskActivityStore } from "../activity/TaskActivityStore"
import { TaskPromptLifecycle } from "../prompt/TaskPromptLifecycle"
import type { TaskPersistenceAssembly } from "../shell/TaskPersistenceAssembly"
import { InMemoryConversationJournal } from "../stores/InMemoryRuntimeStores"
import {
    cancelRunningActivities,
    closeTaskActivities,
    type OpenTaskSessionCompositionOptions,
    TaskSessionCompositionService,
} from "./TaskSessionCompositionService"
import { ApiHistoryImportError } from "./TaskUpgradeImport"

const persistenceMock = vi.hoisted(() => ({ open: vi.fn() }))

vi.mock("../shell/TaskPersistenceAssembly", () => ({
    openTaskPersistence: persistenceMock.open,
}))

function messageStores() {
    return {
        uiMessage: { close: vi.fn(async () => undefined), getAll: () => [] },
        apiConversation: { close: vi.fn(async () => undefined), getAll: () => [] },
    }
}

function openOptions(stores: ReturnType<typeof messageStores>): OpenTaskSessionCompositionOptions {
    return {
        taskId: "task-open-failure",
        openReason: "resume",
        messages: {
            uiMessage: stores.uiMessage,
            apiConversation: stores.apiConversation,
            updateTaskHistory: async () => [],
        },
    } as unknown as OpenTaskSessionCompositionOptions
}

describe("TaskSessionCompositionService", () => {
    afterEach(() => {
        vi.restoreAllMocks()
        persistenceMock.open.mockReset()
    })

    // The chat store holds the single messages.db writer. Left open, it refuses
    // every write of the next incarnation opened in this window.
    it("closes the message stores it was handed when the task persistence cannot open", async () => {
        const stores = messageStores()
        const failure = new Error("journal.db is unreadable")
        persistenceMock.open.mockRejectedValue(failure)

        await expect(new TaskSessionCompositionService().open(openOptions(stores))).rejects.toBe(failure)

        expect(stores.uiMessage.close).toHaveBeenCalledOnce()
        expect(stores.apiConversation.close).toHaveBeenCalledOnce()
    })

    it("closes the persistence and the message stores when composition fails, keeping the original error", async () => {
        const stores = messageStores()
        const persistence = { close: vi.fn(async () => undefined) } as unknown as TaskPersistenceAssembly
        persistenceMock.open.mockResolvedValue(persistence)
        const failure = new Error("composition failed")
        vi.spyOn(
            TaskSessionCompositionService.prototype as unknown as { compose: () => Promise<never> },
            "compose",
        ).mockRejectedValue(failure)
        stores.uiMessage.close.mockRejectedValue(new Error("close failed"))

        await expect(new TaskSessionCompositionService().open(openOptions(stores))).rejects.toBe(failure)

        expect(persistence.close).toHaveBeenCalledOnce()
        expect(stores.uiMessage.close).toHaveBeenCalledOnce()
        expect(stores.apiConversation.close).toHaveBeenCalledOnce()
    })

    // A task opened after a failed import would lose its history with the first
    // journal write; refusing the open keeps the import resumable.
    it("fails the open and releases every store when the saved conversation cannot be imported", async () => {
        const stores = messageStores()
        stores.apiConversation.getAll = () =>
            [{ role: "user", content: [{ type: "text", text: "<task>fix it</task>" }] }] as never
        const journal = new InMemoryConversationJournal()
        vi.spyOn(journal, "append").mockRejectedValue(new Error("journal.db is read-only"))
        const persistence = {
            close: vi.fn(async () => undefined),
            ports: { journal },
            payloads: { put: vi.fn(async () => "sha256:payload"), read: vi.fn() },
        } as unknown as TaskPersistenceAssembly
        persistenceMock.open.mockResolvedValue(persistence)

        await expect(new TaskSessionCompositionService().open(openOptions(stores))).rejects.toBeInstanceOf(ApiHistoryImportError)

        expect(persistence.close).toHaveBeenCalledOnce()
        expect(stores.uiMessage.close).toHaveBeenCalledOnce()
        expect(stores.apiConversation.close).toHaveBeenCalledOnce()
    })

    it.each(["host factory", "post-host composition"] as const)("releases acquired owners on %s failure", async (stage) => {
        const stores = messageStores()
        const persistence = {
            close: vi.fn(async () => undefined),
            ports: { journal: new InMemoryConversationJournal() },
            payloads: { put: vi.fn(), read: vi.fn() },
        } as unknown as TaskPersistenceAssembly
        persistenceMock.open.mockResolvedValue(persistence)
        const activityLoad = vi.spyOn(TaskActivityPersistence.prototype, "load").mockResolvedValue([])
        const activityClose = vi.spyOn(TaskActivityPersistence.prototype, "close").mockResolvedValue(undefined)
        const activityDispose = vi.spyOn(TaskActivityStore.prototype, "dispose")
        const promptStart = vi.spyOn(TaskPromptLifecycle.prototype, "start").mockImplementation(() => undefined)
        const promptDispose = vi.spyOn(TaskPromptLifecycle.prototype, "dispose").mockResolvedValue(undefined)
        vi.spyOn(coreApi, "buildApiHandler").mockReturnValue({} as never)
        const failure = new Error(`${stage} failed`)
        const browserDispose = vi.fn(async () => undefined)
        const commandsDispose = vi.fn(async () => undefined)
        const hostRelease = vi.fn(async () => {
            throw new Error("host cleanup failed")
        })
        const create = vi.fn(async () => {
            if (stage === "host factory") throw failure
            return {
                browser: { dispose: browserDispose },
                commands: { dispose: commandsDispose, bindBackgroundCommandSettlement: vi.fn() },
                releases: [{ release: hostRelease }],
                // Fail after acquisition, not in a mock of the whole composition.
                get services() {
                    throw failure
                },
            } as never
        })
        const options: OpenTaskSessionCompositionOptions = {
            ...openOptions(stores),
            cwd: ".",
            deferRestoredCommands: true,
            stateManager: {
                getTaskCacheRef: () => ({ mode: "act" }),
                getApiConfigurationForTask: () => ({}),
            } as never,
            prompt: { ports: { promptContext: {} } } as never,
            hostFactory: { create },
            publishState: async () => undefined,
        }

        await expect(new TaskSessionCompositionService().open(options)).rejects.toBe(failure)

        expect(activityLoad).toHaveBeenCalledOnce()
        expect(promptStart).toHaveBeenCalledOnce()
        expect(create).toHaveBeenCalledOnce()
        expect(promptDispose).toHaveBeenCalledOnce()
        expect(activityDispose).toHaveBeenCalledOnce()
        expect(activityClose).toHaveBeenCalledOnce()
        expect(persistence.close).toHaveBeenCalledOnce()
        expect(stores.uiMessage.close).toHaveBeenCalledOnce()
        expect(stores.apiConversation.close).toHaveBeenCalledOnce()
        if (stage === "post-host composition") {
            expect(hostRelease).toHaveBeenCalledOnce()
            expect(browserDispose).toHaveBeenCalledOnce()
            expect(commandsDispose).toHaveBeenCalledOnce()
        }
    })
})

describe("TaskSessionCompositionService orphaned activities", () => {
    afterEach(() => {
        vi.restoreAllMocks()
        persistenceMock.open.mockReset()
    })

    // A command started by an earlier session ended with it; only the window that
    // owns the task may say so, since a deferred window may be showing work that
    // another window still runs.
    it.each([
        { deferRestoredCommands: false, expected: "interrupted" },
        { deferRestoredCommands: true, expected: "running" },
    ])("settles a persisted running command only when the window owns the task (deferred: $deferRestoredCommands)", async ({
        deferRestoredCommands,
        expected,
    }) => {
        const rows: Array<Record<string, unknown>> = [
            { ts: 11, type: "say", say: "command", text: "npm run dev", activityId: "orphan", commandStatus: "running" },
        ]
        const stores = {
            uiMessage: {
                close: vi.fn(async () => undefined),
                getAll: () => rows,
                findIndexByTs: (ts: number) => rows.findIndex((row) => row.ts === ts),
                updateMessage: vi.fn(async (index: number, updates: Record<string, unknown>) => {
                    rows[index] = { ...rows[index], ...updates }
                }),
            },
            apiConversation: { close: vi.fn(async () => undefined), getAll: () => [] },
        }
        persistenceMock.open.mockResolvedValue({
            close: vi.fn(async () => undefined),
            ports: { journal: new InMemoryConversationJournal() },
            payloads: { put: vi.fn(), read: vi.fn() },
        } as unknown as TaskPersistenceAssembly)
        const earlierSession = new TaskActivityStore("task-open-failure")
        earlierSession.create({ activityId: "orphan", kind: "command", executionMode: "background", title: "npm run dev" })
        vi.spyOn(TaskActivityPersistence.prototype, "load").mockResolvedValue(earlierSession.list())
        const upsert = vi.spyOn(TaskActivityPersistence.prototype, "upsert").mockResolvedValue(undefined)
        vi.spyOn(TaskActivityPersistence.prototype, "close").mockResolvedValue(undefined)
        vi.spyOn(TaskPromptLifecycle.prototype, "start").mockImplementation(() => undefined)
        vi.spyOn(TaskPromptLifecycle.prototype, "dispose").mockResolvedValue(undefined)
        vi.spyOn(coreApi, "buildApiHandler").mockReturnValue({} as never)
        const failure = new Error("host factory failed")
        const options: OpenTaskSessionCompositionOptions = {
            ...openOptions(stores as unknown as ReturnType<typeof messageStores>),
            cwd: ".",
            deferRestoredCommands,
            stateManager: {
                getTaskCacheRef: () => ({ mode: "act" }),
                getApiConfigurationForTask: () => ({}),
            } as never,
            prompt: { ports: { promptContext: {} } } as never,
            hostFactory: {
                create: vi.fn(async () => {
                    throw failure
                }),
            },
            publishState: async () => undefined,
        }

        await expect(new TaskSessionCompositionService().open(options)).rejects.toBe(failure)

        const written = upsert.mock.calls.flatMap(([activities]) => activities)
        if (deferRestoredCommands) {
            expect(written).toEqual([])
            expect(stores.uiMessage.updateMessage).not.toHaveBeenCalled()
        } else {
            expect(written).toEqual([expect.objectContaining({ activityId: "orphan", status: "interrupted" })])
        }
        expect(rows[0].commandStatus).toBe(expected)
    })

    // The next opening recovers only activities persisted as in flight. An activity
    // settled while the session closes is already interrupted then, so its row has
    // to be settled on close or it stays running for good.
    it("settles the command row of an activity still running when the session closes", async () => {
        const rows: Array<Record<string, unknown>> = [
            { ts: 11, type: "say", say: "command", text: "npm run dev", activityId: "late", commandStatus: "running" },
        ]
        const stores = {
            uiMessage: {
                close: vi.fn(async () => undefined),
                getAll: () => rows,
                findIndexByTs: (ts: number) => rows.findIndex((row) => row.ts === ts),
                updateMessage: vi.fn(async (index: number, updates: Record<string, unknown>) => {
                    rows[index] = { ...rows[index], ...updates }
                }),
            },
            apiConversation: { close: vi.fn(async () => undefined), getAll: () => [] },
        }
        persistenceMock.open.mockResolvedValue({
            close: vi.fn(async () => undefined),
            ports: { journal: new InMemoryConversationJournal() },
            payloads: { put: vi.fn(), read: vi.fn() },
        } as unknown as TaskPersistenceAssembly)
        const runningSession = new TaskActivityStore("task-open-failure")
        runningSession.create({ activityId: "late", kind: "command", executionMode: "background", title: "npm run dev" })
        vi.spyOn(TaskActivityPersistence.prototype, "load").mockResolvedValue(runningSession.list())
        vi.spyOn(TaskActivityPersistence.prototype, "upsert").mockResolvedValue(undefined)
        vi.spyOn(TaskActivityPersistence.prototype, "close").mockResolvedValue(undefined)
        // The opening leaves the activity in flight, as it does for work this session still owns.
        vi.spyOn(TaskActivityStore.prototype, "recoverInterruptedActivities").mockResolvedValue([])
        vi.spyOn(TaskPromptLifecycle.prototype, "start").mockImplementation(() => undefined)
        vi.spyOn(TaskPromptLifecycle.prototype, "dispose").mockResolvedValue(undefined)
        vi.spyOn(coreApi, "buildApiHandler").mockReturnValue({} as never)
        const failure = new Error("host factory failed")
        const options: OpenTaskSessionCompositionOptions = {
            ...openOptions(stores as unknown as ReturnType<typeof messageStores>),
            cwd: ".",
            deferRestoredCommands: false,
            stateManager: {
                getTaskCacheRef: () => ({ mode: "act" }),
                getApiConfigurationForTask: () => ({}),
            } as never,
            prompt: { ports: { promptContext: {} } } as never,
            hostFactory: {
                create: vi.fn(async () => {
                    throw failure
                }),
            },
            publishState: async () => undefined,
        }

        await expect(new TaskSessionCompositionService().open(options)).rejects.toBe(failure)

        expect(rows[0].commandStatus).toBe("interrupted")
        expect(stores.uiMessage.close).toHaveBeenCalledOnce()
        expect(stores.uiMessage.updateMessage.mock.invocationCallOrder[0]).toBeLessThan(
            stores.uiMessage.close.mock.invocationCallOrder[0],
        )
    })
})

describe("cancelRunningActivities", () => {
    it("ends a running command as cancelled even when the kill reports a failure", async () => {
        const store = new TaskActivityStore("task-close")
        // The command executor reports the killed process as a failure before
        // its canceller resolves; closing must still record the user-facing
        // outcome as a cancellation.
        const cancel = vi.fn(async () => {
            store.update("background-command", { status: "failed", error: "Terminated by SIGTERM" })
        })
        store.create({
            activityId: "background-command",
            kind: "command",
            executionMode: "background",
            cancellationOwner: "explicit",
            title: "npm run dev",
            cancel,
        })
        store.create({
            activityId: "finished-command",
            kind: "command",
            executionMode: "foreground",
            title: "npm test",
        })
        store.update("finished-command", { status: "completed" })

        await cancelRunningActivities(store)

        expect(cancel).toHaveBeenCalledOnce()
        expect(store.get("background-command")?.status).toBe("cancelled")
        expect(store.get("finished-command")?.status).toBe("completed")
    })

    it("does nothing when no activity is running", async () => {
        const store = new TaskActivityStore("task-close")
        const cancel = vi.spyOn(store, "cancel")

        await cancelRunningActivities(store)

        expect(cancel).not.toHaveBeenCalled()
    })
})

describe("closeTaskActivities", () => {
    // Closing a task must stop a background subagent through its own canceller;
    // settling first marked it interrupted and dropped the canceller, so the run
    // kept streaming and was reported as interrupted instead of cancelled.
    it("cancels running work through its canceller before settling what remains", async () => {
        const store = new TaskActivityStore("task-close")
        const abortSubagent = vi.fn(async () => undefined)
        store.create({
            activityId: "background-subagent",
            kind: "subagent",
            executionMode: "background",
            cancellationOwner: "explicit",
            title: "Investigate",
            cancel: abortSubagent,
        })
        const messages = { clineMessages: [], updateClineMessage: vi.fn(async () => undefined) }

        await closeTaskActivities(store, messages)

        expect(abortSubagent).toHaveBeenCalledOnce()
        expect(store.get("background-subagent")?.status).toBe("cancelled")
    })
})
