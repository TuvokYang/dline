import fs from "node:fs/promises"
import path from "node:path"
import type { UsageEvent } from "@shared/metrics/events"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { MetricsLedger } from "../MetricsLedger"
import type { MetricsScope } from "../MetricsScope"

const MINUTE = 60_000
const T0 = Date.UTC(2026, 0, 2, 3, 4, 0)

function scope(databasePath: string): MetricsScope {
    return { level: "task", scopeId: "task-a", databasePath }
}

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
        inputTokens: 0,
        outputTokens: 0,
        usageReported: true,
        costComplete: false,
        currencyMixed: false,
        usageQuality: "exact",
        ...overrides,
    }
}

describe("MetricsLedger", () => {
    let root: string
    const ledgers: MetricsLedger[] = []

    beforeEach(async () => {
        await fs.mkdir(path.join(process.cwd(), "tmp"), { recursive: true })
        root = await fs.mkdtemp(path.join(process.cwd(), "tmp", "metrics-ledger-"))
    })

    afterEach(async () => {
        await Promise.allSettled(ledgers.splice(0).map((ledger) => ledger.close()))
        await fs.rm(root, { recursive: true, force: true })
    })

    async function openLedger(nowMs = T0 + 10 * MINUTE): Promise<MetricsLedger> {
        const ledger = await MetricsLedger.open({ scope: scope(path.join(root, "metrics.db")), now: () => nowMs })
        ledgers.push(ledger)
        return ledger
    }

    it("accumulates onto the stored row instead of overwriting it", async () => {
        const ledger = await openLedger()
        await ledger.commitBatch([usage("usage:1", { inputTokens: 100, outputTokens: 10 })])
        await ledger.commitBatch([usage("usage:2", { inputTokens: 20, outputTokens: 5 })])

        const rows = await ledger.readUsageRows()
        expect(rows).toHaveLength(1)
        expect(rows[0]).toMatchObject({ inputTokens: 120, outputTokens: 15, respondingRequests: 2 })
    })

    it("counts a repeated event once and reports it as a duplicate", async () => {
        const ledger = await openLedger()
        const first = await ledger.commitBatch([usage("usage:1", { inputTokens: 100 })])
        const second = await ledger.commitBatch([usage("usage:1", { inputTokens: 100 })])

        expect(first).toMatchObject({ accepted: 1, duplicate: 0 })
        expect(second).toMatchObject({ accepted: 0, duplicate: 1 })
        expect((await ledger.readUsageRows())[0]).toMatchObject({ inputTokens: 100, respondingRequests: 1 })
    })

    it("rolls the whole batch back when one row cannot be stored", async () => {
        const ledger = await openLedger()
        await expect(
            ledger.commitBatch([usage("usage:1", { inputTokens: 7 }), usage("usage:2", { outputTokens: Number.NaN })]),
        ).rejects.toThrow()

        expect(await ledger.readUsageRows()).toEqual([])
    })

    it("keeps profiles and performance fact kinds in separate rows", async () => {
        const ledger = await openLedger()
        await ledger.commitBatch([
            usage("usage:1", { profileId: "profile-a", inputTokens: 10 }),
            usage("usage:2", { profileId: "profile-b", inputTokens: 20 }),
        ])
        await ledger.commitBatch([
            {
                ...usage("provider:1"),
                kind: "performance",
                factKind: "provider",
                providerDurationMs: 100,
                status: "completed",
                perfQuality: "exact",
            },
            {
                ...usage("execution:1"),
                kind: "performance",
                factKind: "execution",
                executionDurationMs: 1_000,
                status: "completed",
                perfQuality: "exact",
            },
        ])

        const usageRows = await ledger.readUsageRows()
        expect(usageRows.map((row) => [row.profileId, row.inputTokens])).toEqual([
            ["profile-a", 10],
            ["profile-b", 20],
        ])
        const performanceRows = await ledger.readPerformanceRows()
        expect(performanceRows.map((row) => row.factKind).sort()).toEqual(["execution", "provider"])
        expect(performanceRows.find((row) => row.factKind === "execution")).toMatchObject({
            executionCount: 1,
            providerRoundCount: 0,
        })
    })

    it("commits a legacy marker and its numbers together", async () => {
        const ledger = await openLedger()
        await ledger.recordLegacyImport({
            subjectKey: "legacy:2026-01-02",
            inputTokens: 500,
            outputTokens: 250,
            cost: 0.42,
            currency: "USD",
        })

        expect(await ledger.readLegacyBaseline("legacy:2026-01-02")).toEqual({
            subjectKey: "legacy:2026-01-02",
            inputTokens: 500,
            outputTokens: 250,
            cost: 0.42,
            currency: "USD",
        })
        expect(await ledger.readLegacyBaseline("legacy:unknown")).toBeUndefined()
    })

    it("rejects events older than the acceptance floor", async () => {
        const ledger = await openLedger()
        await ledger.setAcceptanceFloor(T0 + 2 * MINUTE)

        const outcome = await ledger.commitBatch([usage("usage:old", { observedAtMs: T0 + 1_000 })])
        expect(outcome).toMatchObject({ accepted: 0, lateExpired: 1 })
        expect(await ledger.readUsageRows()).toEqual([])
    })

    it("folds only closed buckets and leaves the rest as they were", async () => {
        const ledger = await openLedger(T0 + 120 * MINUTE)
        await ledger.commitBatch([
            usage("usage:1", { observedAtMs: T0 + 1_000, inputTokens: 10 }),
            usage("usage:2", { observedAtMs: T0 + 2 * MINUTE, inputTokens: 20 }),
            usage("usage:3", { observedAtMs: T0 + 61 * MINUTE, inputTokens: 40 }),
        ])

        const withoutFloor = await ledger.rollup({
            sourceResolution: "minute",
            targetResolution: "hour",
            beforeMs: T0 + 120 * MINUTE,
        })
        expect(withoutFloor).toEqual({ sourceRowsRemoved: 0, targetRowsWritten: 0 })

        await ledger.setAcceptanceFloor(T0 + 61 * MINUTE)
        const folded = await ledger.rollup({
            sourceResolution: "minute",
            targetResolution: "hour",
            beforeMs: T0 + 120 * MINUTE,
        })
        expect(folded).toEqual({ sourceRowsRemoved: 2, targetRowsWritten: 1 })

        const hourStart = T0 - (T0 % 3_600_000)
        const rows = await ledger.readUsageRows()
        expect(rows.map((row) => [row.resolution, row.bucketStartMs, row.inputTokens])).toEqual([
            ["hour", hourStart, 30],
            ["minute", T0 + 61 * MINUTE, 40],
        ])
    })

    it("applies retention and the floor in one transaction and drops covered receipts", async () => {
        const ledger = await openLedger(T0 + 60 * MINUTE)
        await ledger.commitBatch([
            usage("usage:1", { observedAtMs: T0 + 1_000, inputTokens: 10 }),
            usage("usage:2", { observedAtMs: T0 + 30 * MINUTE, inputTokens: 20 }),
        ])

        const outcome = await ledger.prune({
            retentionStartMs: T0 + 10 * MINUTE,
            acceptanceFloorMs: T0 + 10 * MINUTE,
        })
        expect(outcome.usageRowsRemoved).toBe(1)
        expect(outcome.performanceRowsRemoved).toBe(0)
        expect(outcome.receiptsRemoved).toBe(1)
        expect(await ledger.acceptanceFloorMs()).toBe(T0 + 10 * MINUTE)
        expect((await ledger.readUsageRows()).map((row) => row.inputTokens)).toEqual([20])

        const replay = await ledger.commitBatch([usage("usage:1", { observedAtMs: T0 + 1_000, inputTokens: 10 })])
        expect(replay).toMatchObject({ accepted: 0, lateExpired: 1 })
    })

    it("refuses a floor newer than the retention start", async () => {
        const ledger = await openLedger()
        await expect(ledger.prune({ retentionStartMs: T0, acceptanceFloorMs: T0 + MINUTE })).rejects.toThrow()
    })

    // A read path must be able to open the file while a writer holds it. A read-write
    // connection would issue `BEGIN IMMEDIATE` for the same `SELECT` and wait on the
    // writer instead of reading the last committed state.
    it("reads committed rows through a read-only connection", async () => {
        const databasePath = path.join(root, "metrics.db")
        const writer = await openLedger()
        await writer.commitBatch([usage("usage:1", { inputTokens: 42 })])
        await writer.close()

        const reader = await MetricsLedger.open({ scope: scope(databasePath), readOnly: true })
        ledgers.push(reader)
        expect((await reader.readUsageRows()).map((row) => row.inputTokens)).toEqual([42])
    })

    // A readonly ledger cannot commit, so the attempt must be refused by the owner
    // rather than reaching SQLite and reporting a generic transaction failure.
    it("refuses every mutation on a read-only ledger", async () => {
        const databasePath = path.join(root, "metrics.db")
        const writer = await openLedger()
        await writer.commitBatch([usage("usage:1")])
        await writer.close()

        const reader = await MetricsLedger.open({ scope: scope(databasePath), readOnly: true })
        ledgers.push(reader)
        await expect(reader.commitBatch([usage("usage:2")])).rejects.toThrow(/read-only/)
        await expect(reader.setAcceptanceFloor(T0)).rejects.toThrow(/read-only/)
        await expect(reader.clearAll()).rejects.toThrow(/read-only/)
    })

    // A read must not create the database. Opening an absent file readonly fails, which
    // keeps a view of a task that recorded nothing from leaving a file behind.
    it("rejects a read-only opening of a database that does not exist", async () => {
        await expect(MetricsLedger.open({ scope: scope(path.join(root, "absent.db")), readOnly: true })).rejects.toThrow()
        await expect(fs.stat(path.join(root, "absent.db"))).rejects.toThrow()
    })
})
