/**
 * The batch deletion exit must report what it actually removed.
 *
 * `deleteAllTaskHistory` used to answer with the number of history rows it had
 * requested. A task whose metrics database could not be released is now kept on
 * disk, so counting it would tell the user a task is gone while its directory and
 * numbers are still there.
 */

import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { registerTaskMetricsWriter, resetTaskMetricsDeletionGuard } from "@core/metrics/MetricsDeletionGuard"
import { SqliteUnifyStoreBackend, sqliteUnifyStoreRegistry } from "@core/storage/backend/sqlite/SqliteUnifyStore"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

const showMessage = vi.hoisted(() => vi.fn(async () => ({ selectedOption: "Delete Everything" })))

vi.mock("@/hosts/host-provider", () => ({
    HostProvider: {
        window: {
            showMessage,
        },
    },
}))

const { deleteAllTaskHistory } = await import("../deleteAllTaskHistory")

describe("deleteAllTaskHistory", () => {
    let documentsRoot: string
    const previousDocs = process.env.DLINE_DOCS_DIR

    beforeEach(async () => {
        documentsRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dline-delete-all-"))
        process.env.DLINE_DOCS_DIR = documentsRoot
        showMessage.mockClear()
        showMessage.mockResolvedValue({ selectedOption: "Delete Everything" })
    })

    afterEach(async () => {
        resetTaskMetricsDeletionGuard()
        if (previousDocs === undefined) delete process.env.DLINE_DOCS_DIR
        else process.env.DLINE_DOCS_DIR = previousDocs
        await fs.rm(documentsRoot, { recursive: true, force: true })
    })

    /** One task directory with a real metrics database, as a run would leave it. */
    async function seedTask(taskId: string): Promise<string> {
        const taskDirPath = path.join(documentsRoot, "tasks", taskId)
        await fs.mkdir(taskDirPath, { recursive: true })
        await fs.writeFile(path.join(taskDirPath, "task_metadata.json"), "{}")
        const writer = new SqliteUnifyStoreBackend()
        const writable = await writer.open(path.join(taskDirPath, "metrics.db"))
        await writable.close()
        return taskDirPath
    }

    function controllerFor(taskIds: readonly string[]) {
        return {
            clearTask: async () => {},
            postStateToWebview: async () => {},
            stateManager: {
                getGlobalStateKey: () => taskIds.map((id) => ({ id, isFavorited: false })),
                setGlobalState: () => {},
                taskHistory: { clearAll: async () => {}, deleteAllExceptFavorites: async () => {} },
            },
        } as never
    }

    const exists = (target: string) =>
        fs.access(target).then(
            () => true,
            () => false,
        )

    it("removes task directories and counts only what it really deleted", async () => {
        const removedPath = await seedTask("task-removable")
        const keptPath = await seedTask("task-held")
        registerTaskMetricsWriter("task-held", async () => ({ released: false, reason: "worker wedged" }))

        const result = await deleteAllTaskHistory(controllerFor(["task-removable", "task-held"]))

        // One of the two could not be released, so the reported count is one, not two.
        expect(result.tasksDeleted).toBe(1)
        expect(await exists(removedPath)).toBe(false)
        expect(await exists(keptPath)).toBe(true)
        expect(await exists(path.join(keptPath, "metrics.db"))).toBe(true)
    })

    it("removes a directory once its read-only lease is released", async () => {
        const taskDirPath = await seedTask("task-with-view")
        const metricsPath = path.join(taskDirPath, "metrics.db")
        const reader = new SqliteUnifyStoreBackend()
        const lease = await reader.open(metricsPath, { readonly: true })
        expect(sqliteUnifyStoreRegistry.getReferenceCount(metricsPath)).toBe(1)
        registerTaskMetricsWriter("task-with-view", async () => {
            await lease.close()
            return { released: true }
        })

        try {
            const result = await deleteAllTaskHistory(controllerFor(["task-with-view"]))

            expect(result.tasksDeleted).toBe(1)
            expect(await exists(taskDirPath)).toBe(false)
        } finally {
            await lease.close().catch(() => undefined)
        }
    })
})
