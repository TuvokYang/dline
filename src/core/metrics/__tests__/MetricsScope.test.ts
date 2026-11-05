import path from "node:path"
import { getDlineDocumentsPathSync } from "@core/storage/documents-path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { globalMetricsDatabasePath, taskMetricsDatabasePath } from "../MetricsPaths"
import { globalMetricsScope, scopeStorageKey, taskMetricsScope } from "../MetricsScope"

describe("metrics scope", () => {
    const originalDocumentsDir = process.env.DLINE_DOCS_DIR
    const originalDataDir = process.env.DLINE_DIR

    beforeEach(() => {
        process.env.DLINE_DOCS_DIR = path.join("C:", "docs", "dline")
        process.env.DLINE_DIR = path.join("C:", "dline-dir")
    })

    afterEach(() => {
        if (originalDocumentsDir === undefined) delete process.env.DLINE_DOCS_DIR
        else process.env.DLINE_DOCS_DIR = originalDocumentsDir
        if (originalDataDir === undefined) delete process.env.DLINE_DIR
        else process.env.DLINE_DIR = originalDataDir
    })

    it("keeps the task level on the existing metrics database", async () => {
        const scope = await taskMetricsScope("task-a")
        const expected = path.join(getDlineDocumentsPathSync(), "tasks", "task-a", "metrics.db")

        expect(scope).toEqual({ level: "task", scopeId: "task-a", databasePath: expected })
        expect(await taskMetricsDatabasePath("task-a")).toBe(expected)
    })

    it("addresses the global level under the data root, apart from every Task", () => {
        const global = globalMetricsScope()
        expect(global.level).toBe("global")
        expect(global.scopeId).toBe("")
        expect(global.databasePath).toBe(globalMetricsDatabasePath())
        expect(global.databasePath).toBe(path.join(process.env.DLINE_DIR as string, "data", "metrics", "metrics.db"))
    })

    it("keeps the task and global databases apart even when an id matches", async () => {
        const task = await taskMetricsScope("shared-id")
        const global = globalMetricsScope()

        // The global scope id is empty on purpose, so a Task whose id happens to look
        // like a global key can never address global rows by accident.
        expect(scopeStorageKey(task)).not.toBe(scopeStorageKey(global))
        expect(task.databasePath).not.toBe(global.databasePath)
        expect(global.scopeId).toBe("")
    })

    it("routes each task to its own directory", async () => {
        const first = await taskMetricsScope("task-a")
        const second = await taskMetricsScope("task-b")
        expect(first.databasePath).not.toBe(second.databasePath)
        expect(first.scopeId).toBe("task-a")
        expect(second.scopeId).toBe("task-b")
    })
})
