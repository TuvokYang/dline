import fs from "node:fs/promises"
import path from "node:path"
import type { UsageEvent } from "@shared/metrics/events"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { MetricsRepository } from "../MetricsRepository"
import type { MetricsScope } from "../MetricsScope"

const MINUTE = 60_000
const T0 = Date.UTC(2026, 0, 2, 3, 4, 0)

function usage(eventId: string, overrides: Partial<UsageEvent> = {}): UsageEvent {
    return {
        kind: "usage",
        eventId,
        observedAtMs: T0 + 1_000,
        sequence: 1,
        workspaceId: "ws",
        taskId: "task-a",
        profileId: "profile-a",
        providerId: "provider-a",
        modelId: "model-a",
        keyFingerprint: "fp",
        logicalRequestId: "request-a",
        roundId: eventId,
        inputTokens: 10,
        outputTokens: 1,
        usageReported: true,
        costComplete: false,
        currencyMixed: false,
        usageQuality: "exact",
        ...overrides,
    }
}

describe("MetricsRepository", () => {
    let root: string
    const repositories: MetricsRepository[] = []

    beforeEach(async () => {
        await fs.mkdir(path.join(process.cwd(), "tmp"), { recursive: true })
        root = await fs.mkdtemp(path.join(process.cwd(), "tmp", "metrics-repository-"))
    })

    afterEach(async () => {
        await Promise.allSettled(repositories.splice(0).map((repository) => repository.close()))
        await fs.rm(root, { recursive: true, force: true })
    })

    async function open(scopeId = "task-a"): Promise<MetricsRepository> {
        const scope: MetricsScope = {
            level: "task",
            scopeId,
            databasePath: path.join(root, `${scopeId}.db`),
        }
        const repository = await MetricsRepository.open({ scope, now: () => T0 + 10 * MINUTE })
        repositories.push(repository)
        return repository
    }

    it("clears one profile without touching another", async () => {
        const repository = await open()
        await repository.record([
            usage("usage:1", { profileId: "profile-a", inputTokens: 10 }),
            usage("usage:2", { profileId: "profile-b", eventId: "usage:2", inputTokens: 20 }),
        ])

        const cleared = await repository.clearKey({ profileId: "profile-a" })
        expect(cleared.usageRowsRemoved).toBe(1)
        expect(cleared.performanceRowsRemoved).toBe(0)
        expect(cleared.legacyBaselineRetained).toBe(true)
        expect((await repository.usage()).map((row) => [row.profileId, row.inputTokens])).toEqual([["profile-b", 20]])
    })

    it("requires a key when clearing by key", async () => {
        const repository = await open()
        await expect(repository.clearKey({})).rejects.toThrow()
    })

    it("clears a closed bucket range only", async () => {
        const repository = await open()
        await repository.record([
            usage("usage:1", { observedAtMs: T0 + 1_000 }),
            usage("usage:2", { observedAtMs: T0 + 31 * MINUTE }),
        ])

        const cleared = await repository.clearRange({ fromMs: T0, toMs: T0 + 30 * MINUTE })
        expect(cleared.usageRowsRemoved).toBe(1)
        expect((await repository.usage()).map((row) => row.bucketStartMs)).toEqual([T0 + 31 * MINUTE])
        await expect(repository.clearRange({ fromMs: T0, toMs: T0 })).rejects.toThrow()
    })

    it("keeps the legacy marker but releases its numbers on a full usage clear", async () => {
        const repository = await open()
        await repository.recordLegacyImport({ subjectKey: "legacy:a", inputTokens: 500, outputTokens: 200 })
        await repository.record([usage("usage:1")])

        await repository.clear({ tables: ["usage"], releaseLegacyBaseline: true })

        const released = await repository.readLegacyBaseline("legacy:a")
        expect(released).toEqual({ subjectKey: "legacy:a", inputTokens: 0, outputTokens: 0 })
        // The marker and the receipt survive a clear on purpose: the marker records that
        // the import happened, and the receipt keeps one fact from being counted twice.
        await expect(repository.record([usage("usage:1")])).resolves.toMatchObject({ accepted: 0, duplicate: 1 })
        await expect(repository.record([usage("usage:2")])).resolves.toMatchObject({ accepted: 1 })
    })

    it("releases the legacy numbers on an unfiltered usage clear without being told", async () => {
        const repository = await open()
        await repository.recordLegacyImport({ subjectKey: "legacy:a", inputTokens: 500, outputTokens: 200 })
        await repository.record([usage("usage:1")])

        const cleared = await repository.clear({ tables: ["usage"] })

        expect(cleared.legacyBaselineRetained).toBe(false)
        expect(await repository.readLegacyBaseline("legacy:a")).toMatchObject({ inputTokens: 0, outputTokens: 0 })
    })

    it("keeps and reports the legacy numbers when the clear is filtered", async () => {
        const repository = await open()
        await repository.recordLegacyImport({ subjectKey: "legacy:a", inputTokens: 500, outputTokens: 200 })
        await repository.record([usage("usage:1")])

        // A Profile filter cannot attribute a Profile-day baseline it never matched, so
        // the numbers stay and the caller is told they are still there.
        const cleared = await repository.clear({ tables: ["usage"], profileId: "profile-a" })

        expect(cleared.legacyBaselineRetained).toBe(true)
        expect(await repository.readLegacyBaseline("legacy:a")).toMatchObject({ inputTokens: 500, outputTokens: 200 })
    })

    it("keeps the legacy numbers when only performance is cleared", async () => {
        const repository = await open()
        await repository.recordLegacyImport({ subjectKey: "legacy:a", inputTokens: 500, outputTokens: 200 })
        await repository.clear({ tables: ["performance"], releaseLegacyBaseline: true })

        expect(await repository.readLegacyBaseline("legacy:a")).toMatchObject({ inputTokens: 500, outputTokens: 200 })
    })

    // AC-11: a clear removes numbers, never the bookkeeping that keeps them removed.
    // Dropping the marker would let the retained legacy state re-import cleared usage on
    // the next start, and dropping receipts would let a replayed event count twice.
    it("clears the numbers but keeps the marker, receipts and acceptance floor", async () => {
        const repository = await open()
        await repository.recordLegacyImport({ subjectKey: "legacy:a", inputTokens: 500, outputTokens: 200 })
        await repository.record([usage("usage:1")])

        const cleared = await repository.clearAll()
        expect(cleared.usageRowsRemoved).toBe(1)
        // Only the numeric baseline goes; the marker and the receipt stay.
        expect(cleared.metadataRowsRemoved).toBe(1)
        expect(await repository.readLegacyBaseline("legacy:a")).toBeUndefined()

        // The same event replayed after the clear must still be recognised as a duplicate,
        // because its receipt survived; otherwise a replay would resurrect cleared usage.
        const replayed = await repository.record([usage("usage:1")])
        expect(replayed.accepted).toBe(0)
        expect(replayed.duplicate).toBe(1)
        expect(await repository.usage()).toHaveLength(0)
    })

    it("keeps one scope's rows invisible to another scope", async () => {
        const taskA = await open("task-a")
        const taskB = await open("task-b")
        await taskA.record([usage("usage:1", { inputTokens: 10 })])
        await taskB.record([usage("usage:1", { inputTokens: 99 })])

        expect((await taskA.usage()).map((row) => row.inputTokens)).toEqual([10])
        expect((await taskB.usage()).map((row) => row.inputTokens)).toEqual([99])
        expect((await taskA.usage())[0]?.scopeId).toBe("task-a")
    })
})
