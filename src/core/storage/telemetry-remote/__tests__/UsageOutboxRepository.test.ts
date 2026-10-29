import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { foldUsageAttemptShards } from "@/services/telemetry/remote/usage/usageOutbox"
import { type OtelStorageLayout, resolveOtelStorageLayout } from "../OtelStorageLayout"
import { USAGE_SENDER_LEASE_MS, UsageOutboxRepository } from "../UsageOutboxRepository"
import { USAGE_SENDER_TURN_MS } from "../usageSenderTurn"

const REQUEST_ID = "0b4f8a52-5d0e-4e55-9a0c-5a1f1e7c0a01"
const OTHER_REQUEST_ID = "0b4f8a52-5d0e-4e55-9a0c-5a1f1e7c0a02"

function attemptObservation(id: string, admittedAt: number, durationMs: number, revision = 1) {
    return {
        id,
        revision,
        receivedAt: admittedAt + durationMs,
        localSessionId: "outbox-session",
        observation: {
            attemptObservationId: id,
            logicalRequestId: `logical-${id}`,
            identity: { role: "task" as const, provider: "anthropic", modelId: "catalog:claude-opus-4-1", thinking: 2048 },
            policyGeneration: 7,
            admittedAt,
            outcome: "completed" as const,
            durationMs,
            tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 1 },
            tokenUsageReported: true,
        },
    }
}

describe("UsageOutboxRepository", () => {
    let root: string
    let layout: OtelStorageLayout
    let now: number

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-otel-outbox-"))
        layout = resolveOtelStorageLayout(path.join(root, "data"))
        now = 1_900_000_000_000
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    function repository(): UsageOutboxRepository {
        return new UsageOutboxRepository(layout, { clock: () => now })
    }

    describe("contract 5 attempt authority", () => {
        it("replaces an earlier contract's outbox with loss evidence and durably folds a settled shard exactly once", async () => {
            const outbox = repository()
            await fs.mkdir(layout.usageInflightDir, { recursive: true })
            await fs.writeFile(layout.usageOutboxPath, JSON.stringify({ schema_version: 4, generation: 4, state: {} }))
            await fs.writeFile(path.join(layout.usageInflightDir, `${REQUEST_ID}.bin`), "earlier body")

            expect(await outbox.activateAttempts(7)).toBe("activated")
            expect(await fs.readdir(layout.usageInflightDir)).toEqual([])
            const [evidenceName, ...others] = await fs.readdir(layout.remoteQuarantineDir)
            expect(others).toEqual([])
            expect(JSON.parse(await fs.readFile(path.join(layout.remoteQuarantineDir, evidenceName), "utf8"))).toEqual({
                schema_version: 1,
                kind: "telemetry_state_discarded",
                document: "usage-outbox",
                reason: "older_schema",
                found_schema_version: 4,
                recorded_at: now,
            })

            const grant = await outbox.claimAttempts("window-a")
            if (!grant) throw new Error("expected schema 4 lease")
            const shards = [
                {
                    name: "host-a.1.attempts.sealed.jsonl",
                    observations: [attemptObservation("a", now, 58_400), attemptObservation("b", now + 1, 18_500)],
                    claims: [],
                },
            ]
            let nextBucket = 0
            const fold = (state: Parameters<typeof foldUsageAttemptShards>[0]) =>
                foldUsageAttemptShards(state, shards, {
                    currentPolicyGeneration: 7,
                    newBucketId: () => `bucket-${++nextBucket}`,
                    sealedAt: now + 100_000,
                })

            expect(await outbox.transactAttempts(grant, (state) => ({ state: fold(state), result: undefined }))).toEqual({
                status: "committed",
                result: undefined,
            })
            const persisted = await repository().readAttempts()
            if (!persisted) throw new Error("expected schema 4 state")
            expect(persisted.buckets.open).toBeUndefined()
            expect(persisted.buckets.sealed).toHaveLength(1)
            expect(persisted.buckets.sealed[0].durationMs).toBe(76_900)
            expect(persisted.observationRevisions).toEqual({
                a: { revision: 1, bucketId: "bucket-1" },
                b: { revision: 1, bucketId: "bucket-1" },
            })
            expect(persisted.foldedShards).toEqual(["host-a.1.attempts.sealed.jsonl"])

            await outbox.transactAttempts(grant, (state) => ({ state: fold(state), result: undefined }))
            expect(await repository().readAttempts()).toEqual(persisted)
        })

        it("fences schema 4 body cleanup so an expired holder cannot delete the takeover generation", async () => {
            const outbox = repository()
            await outbox.activateAttempts(7)
            const stale = await outbox.claimAttempts("window-a")
            if (!stale) throw new Error("expected schema 4 lease")
            await outbox.writeBody(REQUEST_ID, new Uint8Array([1]))

            now += USAGE_SENDER_LEASE_MS
            const current = await repository().claimAttempts("window-b")
            if (!current) throw new Error("expected schema 4 takeover")
            await outbox.writeBody(OTHER_REQUEST_ID, new Uint8Array([2]))

            expect(await outbox.removeAttemptBodies(stale)).toBe(false)
            expect((await fs.readdir(layout.usageInflightDir)).sort()).toEqual(
                [`${OTHER_REQUEST_ID}.bin`, `${REQUEST_ID}.bin`].sort(),
            )
            expect(await outbox.removeAttemptBodies(current, OTHER_REQUEST_ID)).toBe(true)
            expect(await fs.readdir(layout.usageInflightDir)).toEqual([`${OTHER_REQUEST_ID}.bin`])
        })

        it("uses the existing generation fence for schema 4 transactions and resets only on a newer policy generation", async () => {
            const outbox = repository()
            await outbox.activateAttempts(7)
            const stale = await outbox.claimAttempts("window-a")
            if (!stale) throw new Error("expected schema 4 lease")
            now += USAGE_SENDER_LEASE_MS
            const current = await repository().claimAttempts("window-b")
            if (!current) throw new Error("expected schema 4 takeover")

            expect(await outbox.transactAttempts(stale, (state) => ({ state, result: "stale" }))).toEqual({ status: "fenced" })
            expect(await outbox.resetAttempts(7)).toBe(false)
            expect(await outbox.resetAttempts(8)).toBe(true)
            expect(await outbox.readAttempts()).toMatchObject({
                policyGeneration: 8,
                buckets: { sealed: [] },
                foldedShards: [],
                observationRevisions: {},
            })
        })
    })

    describe("sender rotation", () => {
        const CYCLE = 30_000

        beforeEach(async () => {
            await repository().activateAttempts(7)
        })

        /** Both windows run their cycle once, holder first, as two live extension hosts would. */
        async function cycle(a: UsageOutboxRepository, b: UsageOutboxRepository) {
            const first = await a.claimAttempts("window-a")
            const second = await b.claimAttempts("window-b")
            return { a: first, b: second }
        }

        it("hands the lease to a waiting window once the holder's turn is over, and does not take it straight back", async () => {
            const a = repository()
            const b = repository()
            const granted = await a.claimAttempts("window-a")
            let turn = await cycle(a, b)
            expect(turn).toEqual({ a: granted, b: undefined })
            while (now - 1_900_000_000_000 < USAGE_SENDER_TURN_MS) {
                now += CYCLE
                turn = await cycle(a, b)
                if (now - 1_900_000_000_000 < USAGE_SENDER_TURN_MS) expect(turn).toEqual({ a: granted, b: undefined })
            }

            expect(turn.a).toBeUndefined()
            expect(turn.b).toEqual({ ownerId: "window-b", generation: (granted?.generation ?? 0) + 1 })
            now += CYCLE
            expect(await cycle(a, b)).toEqual({ a: undefined, b: turn.b })
        })

        // An older build waits without writing anything, so the holder cannot see it; only a free cycle lets it in.
        it("gives the lease up for one cycle after its turn even when nobody is seen waiting, then takes it back", async () => {
            const start = now
            const a = repository()
            const granted = await a.claimAttempts("window-a")
            let claimed = granted
            while (now - start < USAGE_SENDER_TURN_MS) {
                now += CYCLE
                claimed = await a.claimAttempts("window-a")
                if (now - start < USAGE_SENDER_TURN_MS) expect(claimed).toEqual(granted)
            }

            expect(claimed).toBeUndefined()
            now += CYCLE
            expect(await a.claimAttempts("window-a")).toEqual({ ownerId: "window-a", generation: (granted?.generation ?? 0) + 1 })
        })

        it("does not let a waiter that stopped asking keep the free lease from the next window", async () => {
            const start = now
            const a = repository()
            const granted = await a.claimAttempts("window-a")
            expect(await repository().claimAttempts("window-b")).toBeUndefined()
            while (now - start < USAGE_SENDER_TURN_MS) {
                now += CYCLE
                await a.claimAttempts("window-a")
            }

            now += CYCLE
            expect(await a.claimAttempts("window-a")).toEqual({ ownerId: "window-a", generation: (granted?.generation ?? 0) + 1 })
        })
    })
})
