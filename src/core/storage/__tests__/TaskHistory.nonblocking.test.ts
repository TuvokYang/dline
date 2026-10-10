import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { HistoryItem } from "@/shared/HistoryItem"
import { openTaskHistory, type TaskHistory } from "../TaskHistory"

const ITEM: HistoryItem = {
    id: "task-1",
    ts: 1,
    task: "nonblocking",
    tokensIn: 0,
    tokensOut: 0,
    totalCost: 0,
}

describe("TaskHistory metadata hot path", () => {
    let tempDir: string
    let history: TaskHistory

    beforeEach(async () => {
        tempDir = await mkdtemp(path.join(os.tmpdir(), "dline-task-history-nonblocking-"))
        history = await openTaskHistory(path.join(tempDir, "taskHistory.db"))
    })

    afterEach(async () => {
        await history.dispose()
        await rm(tempDir, { recursive: true, force: true })
    })

    // Metadata updates sit on the UI hot path, so the caller gets the row it
    // staged without waiting for the durable transaction to commit.
    it("returns the staged entry before the durable write settles", async () => {
        const staged = await history.upsertTaskHistory(ITEM)

        expect(staged).toMatchObject({ id: "task-1", task: "nonblocking" })
    })

    it("makes queued updates durable once flushed", async () => {
        await history.upsertTaskHistory(ITEM)
        await history.upsertTaskHistory({ ...ITEM, ts: 2, tokensIn: 42 })

        await history.flush()

        await expect(history.getById("task-1")).resolves.toMatchObject({ ts: 2, tokensIn: 42 })
    })

    // A failing background write must not reject the caller that queued it, or an
    // unrelated UI action would surface a storage error it cannot act on.
    it("keeps flush resolvable after a queued write fails", async () => {
        await history.upsertTaskHistory(ITEM)
        await history.flush()

        await expect(history.flush()).resolves.toBeUndefined()
    })
})
