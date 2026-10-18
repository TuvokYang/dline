import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type OtelStorageLayout, resolveOtelStorageLayout } from "../OtelStorageLayout"
import { SEALED_SHARD_SETTLE_MS, type SpooledObservation, UsageObservationSpool } from "../UsageObservationSpool"

function observation(id: string, inputTokens = 10): SpooledObservation {
    return {
        id,
        receivedAt: 1_900_000_000_000,
        counters: { "dline.usage.requests.task.completed": 1, "dline.usage.tokens.input": inputTokens },
        measurements: { "dline.usage.duration": { count: 1, sum: 250, min: 250, max: 250 } },
    }
}

describe("UsageObservationSpool", () => {
    let root: string
    let layout: OtelStorageLayout
    let observationsDir: string

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-otel-spool-"))
        layout = resolveOtelStorageLayout(path.join(root, "data"))
        observationsDir = path.join(layout.usageDir, "observations")
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

        expect(settled.observations.map((entry) => entry.id).sort()).toEqual(["obs-1", "obs-2"])
        expect(settled.observations.find((entry) => entry.id === "obs-1")?.counters["dline.usage.tokens.input"]).toBe(10)
        expect(settled.files).toHaveLength(2)
        expect(settled.skipped).toBe(0)
    })

    it("does not read a sealed shard until it settled after the seal", async () => {
        const spool = new UsageObservationSpool(layout, "host-a")
        await spool.append(observation("obs-1"))
        const sealedAt = futureSeal()
        await spool.sealActive(sealedAt)

        const early = await spool.readSettled(sealedAt + SEALED_SHARD_SETTLE_MS - 1)
        const settled = await spool.readSettled(sealedAt + SEALED_SHARD_SETTLE_MS)

        expect(early).toEqual({ files: [], observations: [], skipped: 0 })
        expect(settled.observations.map((entry) => entry.id)).toEqual(["obs-1"])
    })

    it("starts a fresh active shard for an append after the seal and keeps it out of the sealed batch", async () => {
        const spool = new UsageObservationSpool(layout, "host-a")
        await spool.append(observation("obs-1"))
        const firstSeal = futureSeal()
        await spool.sealActive(firstSeal)
        await spool.append(observation("obs-2"))

        const firstBatch = await spool.readSettled(firstSeal + SEALED_SHARD_SETTLE_MS)
        await spool.discard(firstBatch.files)
        const secondSeal = firstSeal + 1
        await spool.sealActive(secondSeal)
        const secondBatch = await spool.readSettled(secondSeal + SEALED_SHARD_SETTLE_MS)

        expect(firstBatch.observations.map((entry) => entry.id)).toEqual(["obs-1"])
        expect(secondBatch.observations.map((entry) => entry.id)).toEqual(["obs-2"])
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

        expect(settled.observations.map((entry) => entry.id)).toEqual(["obs-1"])
        expect(later.observations.map((entry) => entry.id).sort()).toEqual(["obs-1", "obs-2"])
    })

    it("skips torn and invalid lines without losing the valid observations around them", async () => {
        const sealedAt = futureSeal()
        await fs.mkdir(observationsDir, { recursive: true })
        await fs.writeFile(
            path.join(observationsDir, `host-a.${sealedAt}.sealed.jsonl`),
            [
                JSON.stringify(observation("obs-1")),
                '{"id":"torn","receivedAt":19',
                JSON.stringify({ ...observation("negative"), counters: { "dline.usage.tokens.input": -1 } }),
                JSON.stringify(observation("obs-2")),
                "",
            ].join("\n"),
        )

        const settled = await new UsageObservationSpool(layout, "host-b").readSettled(sealedAt + SEALED_SHARD_SETTLE_MS)

        expect(settled.observations.map((entry) => entry.id)).toEqual(["obs-1", "obs-2"])
        expect(settled.skipped).toBe(2)
    })

    it("reports an observation that appears in two sealed shards once", async () => {
        const sealedAt = futureSeal()
        await fs.mkdir(observationsDir, { recursive: true })
        for (const shard of ["host-a", "host-b"]) {
            await fs.writeFile(
                path.join(observationsDir, `${shard}.${sealedAt}.sealed.jsonl`),
                `${JSON.stringify(observation("obs-1"))}\n`,
            )
        }

        const settled = await new UsageObservationSpool(layout, "host-c").readSettled(sealedAt + SEALED_SHARD_SETTLE_MS)

        expect(settled.observations).toHaveLength(1)
        expect(settled.files).toHaveLength(2)
    })

    it("purges unsent observations and forgets which IDs it appended", async () => {
        const spool = new UsageObservationSpool(layout, "host-a")
        await spool.append(observation("obs-1"))

        await spool.purge()
        await spool.append(observation("obs-1"))
        const sealedAt = futureSeal()
        await spool.sealActive(sealedAt)
        const settled = await spool.readSettled(sealedAt + SEALED_SHARD_SETTLE_MS)
        await spool.discard(settled.files)

        expect(settled.observations.map((entry) => entry.id)).toEqual(["obs-1"])
        expect(await fs.readdir(observationsDir)).toEqual([])
    })

    it("rejects a shard ID that could escape or collide with the shard naming scheme", () => {
        for (const shardId of ["", "../host", "host.1", "a".repeat(65)]) {
            expect(() => new UsageObservationSpool(layout, shardId)).toThrow()
        }
    })
})
