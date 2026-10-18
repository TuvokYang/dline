import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import type { PendingUsageObservation, SettledUsageShard } from "@/services/telemetry/remote/usage/usageOutbox"
import { type OtelStorageLayout, resolveOtelStorageLayout } from "../OtelStorageLayout"
import { SEALED_SHARD_SETTLE_MS, UsageObservationSpool } from "../UsageObservationSpool"

function observation(id: string, inputTokens = 10): PendingUsageObservation {
    return {
        id,
        receivedAt: 1_900_000_000_000,
        policyEpoch: 7,
        counters: { "dline.usage.requests.task.completed": 1, "dline.usage.tokens.input.task": inputTokens },
        measurements: { "dline.usage.request_duration_ms.task": { count: 1, sum: 250, min: 250, max: 250 } },
    }
}

function ids(shards: readonly SettledUsageShard[]): string[] {
    return shards.flatMap((shard) => shard.observations.map((entry) => entry.id)).sort()
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

    it("collects every process shard once each and ignores a duplicate append within one process", async () => {
        const first = new UsageObservationSpool(layout, "host-a")
        const second = new UsageObservationSpool(layout, "host-b")
        await first.append(observation("obs-1"))
        await first.append(observation("obs-1", 999))
        await second.append(observation("obs-2"))

        const sealedAt = futureSeal()
        await first.sealActive(sealedAt)
        const settled = await second.readSettled(sealedAt + SEALED_SHARD_SETTLE_MS)

        expect(ids(settled.shards)).toEqual(["obs-1", "obs-2"])
        const firstShard = settled.shards.find((shard) => shard.observations.some((entry) => entry.id === "obs-1"))
        expect(firstShard?.observations[0]).toEqual(observation("obs-1"))
        expect(settled.shards).toHaveLength(2)
        expect(settled.skipped).toBe(0)
    })

    it("does not read a sealed shard until it settled after the seal", async () => {
        const spool = new UsageObservationSpool(layout, "host-a")
        await spool.append(observation("obs-1"))
        const sealedAt = futureSeal()
        await spool.sealActive(sealedAt)

        const early = await spool.readSettled(sealedAt + SEALED_SHARD_SETTLE_MS - 1)
        const settled = await spool.readSettled(sealedAt + SEALED_SHARD_SETTLE_MS)

        expect(early).toEqual({ shards: [], skipped: 0 })
        expect(ids(settled.shards)).toEqual(["obs-1"])
    })

    it("starts a fresh active shard for an append after the seal and keeps it out of the sealed batch", async () => {
        const spool = new UsageObservationSpool(layout, "host-a")
        await spool.append(observation("obs-1"))
        const firstSeal = futureSeal()
        await spool.sealActive(firstSeal)
        await spool.append(observation("obs-2"))

        const firstBatch = await spool.readSettled(firstSeal + SEALED_SHARD_SETTLE_MS)
        await spool.discard(firstBatch.shards.map((shard) => shard.name))
        const secondSeal = firstSeal + 1
        await spool.sealActive(secondSeal)
        const secondBatch = await spool.readSettled(secondSeal + SEALED_SHARD_SETTLE_MS)

        expect(ids(firstBatch.shards)).toEqual(["obs-1"])
        expect(ids(secondBatch.shards)).toEqual(["obs-2"])
    })

    it("does not overwrite a sealed shard when the same seal time repeats", async () => {
        const spool = new UsageObservationSpool(layout, "host-a")
        const sealedAt = futureSeal()
        await spool.append(observation("obs-1"))
        await spool.sealActive(sealedAt)
        await spool.append(observation("obs-2"))
        await spool.sealActive(sealedAt)

        const settled = await spool.readSettled(sealedAt + SEALED_SHARD_SETTLE_MS)
        await spool.sealActive(sealedAt + 1)
        const later = await spool.readSettled(sealedAt + 1 + SEALED_SHARD_SETTLE_MS)

        expect(ids(settled.shards)).toEqual(["obs-1"])
        expect(ids(later.shards)).toEqual(["obs-1", "obs-2"])
    })

    it("skips torn and invalid lines without losing the valid observations around them", async () => {
        const sealedAt = futureSeal()
        await fs.mkdir(layout.usageObservationsDir, { recursive: true })
        await fs.writeFile(
            path.join(layout.usageObservationsDir, `host-a.${sealedAt}.sealed.jsonl`),
            [
                JSON.stringify(observation("obs-1")),
                '{"id":"torn","receivedAt":19',
                JSON.stringify({ ...observation("negative"), counters: { "dline.usage.tokens.input.task": -1 } }),
                JSON.stringify({ ...observation("no-epoch"), policyEpoch: undefined }),
                JSON.stringify(observation("obs-2")),
                "",
            ].join("\n"),
        )

        const settled = await new UsageObservationSpool(layout, "host-b").readSettled(sealedAt + SEALED_SHARD_SETTLE_MS)

        expect(ids(settled.shards)).toEqual(["obs-1", "obs-2"])
        expect(settled.skipped).toBe(3)
    })

    it("reports an observation that appears in two sealed shards once", async () => {
        const sealedAt = futureSeal()
        await fs.mkdir(layout.usageObservationsDir, { recursive: true })
        for (const shard of ["host-a", "host-b"]) {
            await fs.writeFile(
                path.join(layout.usageObservationsDir, `${shard}.${sealedAt}.sealed.jsonl`),
                `${JSON.stringify(observation("obs-1"))}\n`,
            )
        }

        const settled = await new UsageObservationSpool(layout, "host-c").readSettled(sealedAt + SEALED_SHARD_SETTLE_MS)

        expect(ids(settled.shards)).toEqual(["obs-1"])
        expect(settled.shards.map((shard) => shard.name)).toEqual([
            `host-a.${sealedAt}.sealed.jsonl`,
            `host-b.${sealedAt}.sealed.jsonl`,
        ])
    })

    it("purges unsent observations and forgets which IDs it appended", async () => {
        const spool = new UsageObservationSpool(layout, "host-a")
        await spool.append(observation("obs-1"))

        await spool.purge()
        await spool.append(observation("obs-1"))
        const sealedAt = futureSeal()
        await spool.sealActive(sealedAt)
        const settled = await spool.readSettled(sealedAt + SEALED_SHARD_SETTLE_MS)
        await spool.discard([...settled.shards.map((shard) => shard.name), "../outbox.json"])

        expect(ids(settled.shards)).toEqual(["obs-1"])
        expect(await fs.readdir(layout.usageObservationsDir)).toEqual([])
    })

    it("rejects a shard ID that could escape or collide with the shard naming scheme", () => {
        for (const shardId of ["", "../host", "host.1", "a".repeat(65)]) {
            expect(() => new UsageObservationSpool(layout, shardId)).toThrow()
        }
    })
})
