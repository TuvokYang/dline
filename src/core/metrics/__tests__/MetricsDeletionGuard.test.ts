/**
 * The metrics deletion protocol is only useful if it observes a real lease.
 *
 * These tests open an actual SQLite database through the same backend a history
 * view uses, so the read-only lease under test is the one a deletion would meet in
 * production rather than a stub that could agree with any implementation.
 */

import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SqliteUnifyStoreBackend, sqliteUnifyStoreRegistry } from "@core/storage/backend/sqlite/SqliteUnifyStore"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
    hasTaskMetricsWriter,
    registerTaskMetricsWriter,
    releaseTaskMetricsBeforeDeletion,
    resetTaskMetricsDeletionGuard,
    stopTaskMetricsWriters,
    waitForMetricsDatabaseRelease,
} from "../MetricsDeletionGuard"

const TASK_ID = "task-deletion-guard"

describe("MetricsDeletionGuard", () => {
    let root: string
    let databasePath: string

    beforeEach(async () => {
        root = await mkdtemp(path.join(os.tmpdir(), "dline-metrics-guard-"))
        databasePath = path.join(root, TASK_ID, "metrics.db")
    })

    afterEach(async () => {
        resetTaskMetricsDeletionGuard()
        await rm(root, { recursive: true, force: true })
    })

    it("reports released when no lease is open", async () => {
        await expect(waitForMetricsDatabaseRelease(databasePath, 100)).resolves.toEqual({ released: true })
    })

    it("waits for a real read-only lease and reports release once it closes", async () => {
        const writer = new SqliteUnifyStoreBackend()
        const writable = await writer.open(databasePath)
        await writable.close()

        const reader = new SqliteUnifyStoreBackend()
        const lease = await reader.open(databasePath, { readonly: true })
        expect(sqliteUnifyStoreRegistry.getReferenceCount(databasePath)).toBe(1)

        // The wait must not succeed while a history view still holds the file.
        await expect(waitForMetricsDatabaseRelease(databasePath, 60)).resolves.toMatchObject({ released: false })

        const pending = waitForMetricsDatabaseRelease(databasePath, 2_000)
        await lease.close()
        await expect(pending).resolves.toEqual({ released: true })
    })

    it("fails instead of hanging when a lease outlives the budget", async () => {
        const writer = new SqliteUnifyStoreBackend()
        const writable = await writer.open(databasePath)
        const reader = new SqliteUnifyStoreBackend()
        const lease = await reader.open(databasePath, { readonly: true })

        const outcome = await waitForMetricsDatabaseRelease(databasePath, 50)

        expect(outcome.released).toBe(false)
        expect(outcome.reason).toContain("connection(s) still hold")
        await lease.close()
        await writable.close()
    })

    it("stops a registered writer and clears the registration", async () => {
        let stops = 0
        const forget = registerTaskMetricsWriter(TASK_ID, async () => {
            stops += 1
            return { released: true }
        })
        expect(hasTaskMetricsWriter(TASK_ID)).toBe(true)

        await expect(stopTaskMetricsWriters(TASK_ID)).resolves.toEqual({ released: true })
        expect(stops).toBe(1)

        forget()
        expect(hasTaskMetricsWriter(TASK_ID)).toBe(false)
    })

    it("refuses to release when a writer cannot confirm it stopped", async () => {
        registerTaskMetricsWriter(TASK_ID, async () => ({ released: false, reason: "worker wedged" }))

        const outcome = await stopTaskMetricsWriters(TASK_ID)

        expect(outcome.released).toBe(false)
        expect(outcome.reason).toContain("worker wedged")
    })

    it("does not wait for leases when a writer is still holding the database", async () => {
        registerTaskMetricsWriter(TASK_ID, async () => ({ released: false, reason: "worker wedged" }))

        const outcome = await releaseTaskMetricsBeforeDeletion({ taskId: TASK_ID, databasePath, leaseTimeoutMs: 10 })

        expect(outcome).toEqual({ released: false, reason: "worker wedged" })
    })
})
