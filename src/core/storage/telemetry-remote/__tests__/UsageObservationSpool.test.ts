import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type OtelStorageLayout, resolveOtelStorageLayout } from "../OtelStorageLayout"
import { type PendingUsageAttemptObservation, SEALED_SHARD_SETTLE_MS, UsageObservationSpool } from "../UsageObservationSpool"

function attemptObservation(id: string, revision = 1): PendingUsageAttemptObservation {
    return {
        id,
        revision,
        receivedAt: 1_900_000_000_000,
        observation: {
            attemptObservationId: id,
            logicalRequestId: "request-1",
            identity: { role: "task", provider: "openai", modelId: "state:unknown", thinking: "state:disabled" },
            policyGeneration: 7,
            admittedAt: 1_900_000_000_000,
            outcome: "completed",
            durationMs: 250,
            tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 0 },
            tokenUsageReported: true,
        },
    }
}

describe("UsageObservationSpool", () => {
    let root: string
    let layout: OtelStorageLayout

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-otel-spool-"))
        layout = resolveOtelStorageLayout(path.join(root, "data"))
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    /** A seal time safely after every append in the test, so settling is decided by the seal, not by mtime. */
    function futureSeal(): number {
        return Date.now() + 60_000
    }

    it("keeps schema 4 attempt revisions in a separate durable shard and deduplicates exact retries", async () => {
        const spool = new UsageObservationSpool(layout, "host-a")
        await spool.appendAttempt(attemptObservation("attempt-1"))
        await spool.appendAttempt(attemptObservation("attempt-1"))
        const sealedAt = futureSeal()

        await spool.sealActiveAttempts(sealedAt)
        const settled = await spool.readSettledAttempts(sealedAt + SEALED_SHARD_SETTLE_MS)

        expect(settled.skipped).toBe(0)
        expect(settled.shards.flatMap((shard) => shard.observations)).toEqual([attemptObservation("attempt-1")])
        await spool.discardAttempts(settled.shards.map((shard) => shard.name))
        expect(await fs.readdir(layout.usageObservationsDir)).toEqual([])
    })

    it("selects only the highest attempt revision across settled process shards", async () => {
        const first = new UsageObservationSpool(layout, "host-a")
        const second = new UsageObservationSpool(layout, "host-b")
        await first.appendAttempt(attemptObservation("attempt-1", 1))
        await first.appendAttempt(attemptObservation("attempt-1", 2))
        await second.appendAttempt(attemptObservation("attempt-1", 2))
        const sealedAt = futureSeal()

        await first.sealActiveAttempts(sealedAt)
        const settled = await second.readSettledAttempts(sealedAt + SEALED_SHARD_SETTLE_MS)

        expect(settled.skipped).toBe(0)
        expect(settled.shards).toHaveLength(2)
        expect(settled.shards.flatMap((shard) => shard.observations)).toEqual([attemptObservation("attempt-1", 2)])
    })

    it("purges only legacy shards at schema 4 clean-cut and preserves attempt revisions", async () => {
        const spool = new UsageObservationSpool(layout, "host-a")
        await fs.mkdir(layout.usageObservationsDir, { recursive: true })
        await fs.writeFile(path.join(layout.usageObservationsDir, "host-a.jsonl"), '{"legacy":true}\n')
        await spool.appendAttempt(attemptObservation("attempt-1"))
        const sealedAt = futureSeal()
        await spool.sealActiveAttempts(sealedAt)

        await spool.purgeLegacy()

        const names = await fs.readdir(layout.usageObservationsDir)
        expect(names).toEqual([`host-a.${sealedAt}.attempts.sealed.jsonl`])
        const settled = await spool.readSettledAttempts(sealedAt + SEALED_SHARD_SETTLE_MS)
        expect(settled.shards.flatMap((shard) => shard.observations)).toEqual([attemptObservation("attempt-1")])
    })

    it("purges unsent attempt observations and forgets exact revisions", async () => {
        const spool = new UsageObservationSpool(layout, "host-a")
        await spool.appendAttempt(attemptObservation("attempt-1"))

        await spool.purge()
        await spool.appendAttempt(attemptObservation("attempt-1"))
        const sealedAt = futureSeal()
        await spool.sealActiveAttempts(sealedAt)
        const settled = await spool.readSettledAttempts(sealedAt + SEALED_SHARD_SETTLE_MS)
        await spool.discardAttempts([...settled.shards.map((shard) => shard.name), "../outbox.json"])

        expect(settled.shards.flatMap((shard) => shard.observations)).toEqual([attemptObservation("attempt-1")])
        expect(await fs.readdir(layout.usageObservationsDir)).toEqual([])
    })

    it("rejects a shard ID that could escape or collide with the shard naming scheme", () => {
        for (const shardId of ["", "../host", "host.1", "a".repeat(65)]) {
            expect(() => new UsageObservationSpool(layout, shardId)).toThrow()
        }
    })
})
