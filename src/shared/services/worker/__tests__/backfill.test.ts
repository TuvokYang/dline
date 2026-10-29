import { beforeEach, describe, expect, it, vi } from "vitest"

const harness = vi.hoisted(() => ({
    history: [] as { id: string }[],
    enqueue: vi.fn(),
}))

vi.mock("@/core/storage/disk", () => ({
    GlobalFileNames: { apiConversationHistory: "api_conversation_history.json" },
}))
vi.mock("@/core/storage/StateManager", () => ({
    StateManager: { get: () => ({ taskHistory: { getDeduplicated: async () => harness.history } }) },
}))
vi.mock("@/core/task/conversation/TaskConversationReader", () => ({
    readTaskConversation: async (taskId: string) => [{ role: "user", content: `task ${taskId}` }],
}))
vi.mock("../sync", () => ({
    syncWorker: () => ({ getSyncQueue: () => ({ getItem: () => undefined, enqueue: harness.enqueue }) }),
}))

import { backfillTasks } from "../backfill"

describe("backfillTasks", () => {
    beforeEach(() => {
        harness.enqueue.mockReset()
        harness.history = []
    })

    it("queues every task recorded in the task history", async () => {
        harness.history = [{ id: "1700000000002" }, { id: "1700000000001" }]

        const result = await backfillTasks()

        expect(result).toMatchObject({ totalTasks: 2, successCount: 2, failCount: 0 })
        expect(harness.enqueue.mock.calls.map(([taskId]) => taskId)).toEqual(["1700000000002", "1700000000001"])
    })

    it("leaves out tasks created during the backfill and before the requested start", async () => {
        const createdDuringBackfill = String(Date.now() + 60_000)
        harness.history = [{ id: createdDuringBackfill }, { id: "1700000000500" }, { id: "1700000000100" }]

        const result = await backfillTasks({ sinceTimestamp: 1_700_000_000_200 })

        expect(result?.totalTasks).toBe(1)
        expect(harness.enqueue.mock.calls.map(([taskId]) => taskId)).toEqual(["1700000000500"])
    })
})
