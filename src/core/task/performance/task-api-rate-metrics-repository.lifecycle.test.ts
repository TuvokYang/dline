import fs from "node:fs/promises"
import path from "node:path"
import { sqliteUnifyStoreRegistry } from "@core/storage/backend/sqlite/SqliteUnifyStore"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { API_RATE_METRICS_SCHEMA_VERSION, type ApiRateSecondRecord } from "./api-rate-metrics-types"
import { TaskApiRateMetricsRepository } from "./task-api-rate-metrics-repository"

function secondRecord(second: number, tokens: number): ApiRateSecondRecord {
    return {
        schemaVersion: API_RATE_METRICS_SCHEMA_VERSION,
        kind: "second",
        second,
        revision: 0,
        signals: ["request_start"],
        requestCount: 1,
        estimatedTokens: tokens,
        effectiveTokens: tokens,
        tokenQuality: "estimated",
        runningActiveSeconds: 1,
        runningRequestCount: 1,
        runningTokenCount: tokens,
        requestsPerMinute: 60,
        tokensPerMinute: tokens * 60,
    }
}

describe("TaskApiRateMetricsRepository lifecycle", () => {
    let root: string
    const repositories: TaskApiRateMetricsRepository[] = []

    beforeEach(async () => {
        const parent = path.join(process.cwd(), "tmp")
        await fs.mkdir(parent, { recursive: true })
        root = await fs.mkdtemp(path.join(parent, "api-rate-metrics-lifecycle-"))
    })

    afterEach(async () => {
        await Promise.allSettled(repositories.splice(0).map((repository) => repository.close()))
        await fs.rm(root, { recursive: true, force: true })
    })

    function create(taskId: string, location: string): TaskApiRateMetricsRepository {
        const repository = new TaskApiRateMetricsRepository({ taskId, location, migrateLegacy: false })
        repositories.push(repository)
        return repository
    }

    it("initializes two handles for one Task atomically and shares committed records", async () => {
        const location = path.join(root, "shared.db")
        const left = create("task-a", location)
        const right = create("task-a", location)

        await Promise.all([left.initialize(), right.initialize()])
        expect(sqliteUnifyStoreRegistry.getReferenceCount(location)).toBe(2)
        await left.append([secondRecord(10, 120)])
        expect((await right.readAll()).records).toEqual([secondRecord(10, 120)])

        await left.close()
        expect(sqliteUnifyStoreRegistry.getReferenceCount(location)).toBe(1)
        await right.close()
        expect(sqliteUnifyStoreRegistry.getReferenceCount(location)).toBe(0)
    })

    it("keeps four concurrent Task databases isolated", async () => {
        const taskIds = ["task-a", "task-b", "task-c", "task-d"]
        const entries = taskIds.map((taskId, index) => ({
            taskId,
            location: path.join(root, `${taskId}.db`),
            repository: create(taskId, path.join(root, `${taskId}.db`)),
            record: secondRecord(10 + index, 100 + index),
        }))
        await Promise.all(entries.map(({ repository }) => repository.initialize()))
        await Promise.all(entries.map(({ repository, record }) => repository.append([record])))

        const reads = await Promise.all(entries.map(({ repository }) => repository.readAll()))
        for (let index = 0; index < entries.length; index++) {
            expect(reads[index].records).toEqual([entries[index].record])
        }
    })

    it("releases SQLite handles so database and sidecar files can be deleted", async () => {
        const location = path.join(root, "deletable.db")
        const repository = create("task-a", location)
        await repository.initialize()
        await repository.append([secondRecord(10, 120)])
        await repository.close()
        expect(sqliteUnifyStoreRegistry.getReferenceCount(location)).toBe(0)

        for (const filePath of [location, `${location}-wal`, `${location}-shm`]) {
            await fs.rm(filePath, { force: true })
        }
        await expect(fs.stat(location)).rejects.toMatchObject({ code: "ENOENT" })
    })
})
