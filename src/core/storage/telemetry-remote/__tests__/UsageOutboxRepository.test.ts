import { spawn } from "node:child_process"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
    emptyUsageOutbox,
    foldUsageAttemptShards,
    sha256Hex,
    type UsageOutboxState,
} from "@/services/telemetry/remote/usage/usageOutbox"
import { projectUsageSettlement, sessionStartedTally } from "@/services/telemetry/remote/usage/usageTally"
import { type OtelStorageLayout, resolveOtelStorageLayout } from "../OtelStorageLayout"
import {
    USAGE_OUTBOX_SCHEMA_VERSION,
    USAGE_SENDER_LEASE_MS,
    UsageOutboxRepository,
    type UsageSenderTurnEvent,
} from "../UsageOutboxRepository"
import { USAGE_SENDER_TAKEOVER_GRACE_MS, USAGE_SENDER_TURN_MS } from "../usageSenderTurn"

const REQUEST_ID = "0b4f8a52-5d0e-4e55-9a0c-5a1f1e7c0a01"
const OTHER_REQUEST_ID = "0b4f8a52-5d0e-4e55-9a0c-5a1f1e7c0a02"

function attemptObservation(id: string, admittedAt: number, durationMs: number, revision = 1) {
    return {
        id,
        revision,
        receivedAt: admittedAt + durationMs,
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

function pendingState(policyEpoch = 1): UsageOutboxState {
    const tally = projectUsageSettlement({
        observationId: "o",
        purpose: "task",
        outcome: "completed",
        inputTokens: 12,
        outputTokens: 3,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        durationMs: 30,
        servedBy: { provider: "anthropic", model: "claude-sonnet-4" },
        streamTiming: { ttftMs: 10, generationMs: 20 },
    })
    return {
        ...emptyUsageOutbox(policyEpoch),
        pacing: { nextEligibleAt: 1_900_000_120_000, waitUntil: 1_900_007_200_000, consecutiveWaits: 2 },
        seconds: [
            { startedAt: 1_899_999_960_000, tally },
            { startedAt: 1_900_000_020_000, tally: sessionStartedTally() },
        ],
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

    it("grants one live lease, renews it in place and hands an expired one over under a new generation", async () => {
        const first = await repository().claim("window-a")
        const contender = await repository().claim("window-b")
        now += USAGE_SENDER_LEASE_MS - 1
        const renewed = await repository().claim("window-a")
        now += USAGE_SENDER_LEASE_MS
        const takeover = await repository().claim("window-b")

        expect(first).toEqual({ ownerId: "window-a", generation: 1 })
        expect(contender).toBeUndefined()
        expect(renewed).toEqual(first)
        expect(takeover).toEqual({ ownerId: "window-b", generation: 2 })
    })

    it("fences off a sender whose lease lapsed or changed hands, and keeps the new owner's lease on a stale release", async () => {
        const stale = await repository().claim("window-a")
        now += USAGE_SENDER_LEASE_MS
        const current = await repository().claim("window-b")
        if (!stale || !current) throw new Error("expected both claims to succeed in turn")

        const fenced = await repository().transact(stale, () => ({ state: pendingState(), result: "stale write" }))
        await repository().release(stale)
        const committed = await repository().transact(current, () => ({ state: pendingState(), result: "current write" }))

        expect(fenced).toEqual({ status: "fenced" })
        expect(committed).toEqual({ status: "committed", result: "current write" })
        expect(await repository().claim("window-a")).toBeUndefined()
    })

    it("fences off the holder itself once its lease expired without renewal", async () => {
        const grant = await repository().claim("window-a")
        if (!grant) throw new Error("expected a lease")
        now += USAGE_SENDER_LEASE_MS

        expect(await repository().transact(grant, () => ({ state: pendingState(), result: undefined }))).toEqual({
            status: "fenced",
        })
        expect(await repository().read()).toEqual(emptyUsageOutbox(0))
    })

    it("lets exactly one of two racing windows take the lease", async () => {
        const grants = await Promise.all([repository().claim("window-a"), repository().claim("window-b")])

        expect(grants.filter((grant) => grant !== undefined)).toHaveLength(1)
    })

    it("waits for the outbox lock another process holds instead of breaking it, then takes the lease", async () => {
        await fs.mkdir(layout.usageDir, { recursive: true })
        // The child holds the lock the way FileLock does, then checks that nobody replaced it before releasing.
        const childScript = [
            'const fs = require("node:fs")',
            "const lock = process.argv[1]",
            'const mine = JSON.stringify({ pid: process.pid, ownerId: "child-window", ts: Date.now() })',
            'fs.writeFileSync(lock, mine, { flag: "wx" })',
            'process.stdout.write("locked\\n")',
            'setTimeout(() => { let intact = false; try { intact = fs.readFileSync(lock, "utf8") === mine } catch {} if (intact) fs.unlinkSync(lock); process.exit(intact ? 0 : 3) }, 1500)',
        ].join(";")
        const child = spawn(process.execPath, ["-e", childScript, `${layout.usageOutboxPath}.lck`], {
            stdio: ["ignore", "pipe", "ignore"],
        })
        const exitCode = new Promise<number | null>((resolve, reject) => {
            child.once("error", reject)
            child.once("exit", (code) => resolve(code))
        })
        await new Promise<void>((resolve, reject) => {
            child.once("error", reject)
            child.stdout.on("data", (chunk: Buffer) => {
                if (chunk.toString("utf8").includes("locked")) resolve()
            })
        })

        const grant = await repository().claim("window-a")

        expect(await exitCode).toBe(0)
        expect(grant).toEqual({ ownerId: "window-a", generation: 1 })
    })

    it("persists the committed state, including the inflight manifest, for the next reader", async () => {
        const grant = await repository().claim("window-a")
        if (!grant) throw new Error("expected a lease")
        const body = new TextEncoder().encode('{"schema_version":1}')
        const state: UsageOutboxState = {
            ...pendingState(),
            inflight: {
                requestId: REQUEST_ID,
                bodySha256: sha256Hex(body),
                seconds: pendingState().seconds,
                droppedSeconds: 2,
                createdAt: now,
                attempts: 1,
                notBefore: now + 30_000,
            },
        }

        await repository().transact(grant, async () => {
            await repository().writeBody(REQUEST_ID, body)
            return { state, result: undefined }
        })

        const replayed = await repository().readBody(state.inflight as NonNullable<UsageOutboxState["inflight"]>)
        expect(await repository().read()).toEqual(state)
        expect(replayed && new TextDecoder().decode(replayed)).toBe('{"schema_version":1}')
    })

    it("refuses bytes that no longer match the manifest and removes every body except the kept one", async () => {
        const body = new TextEncoder().encode('{"a":1}')
        await repository().writeBody(REQUEST_ID, body)
        await repository().writeBody(OTHER_REQUEST_ID, body)
        await fs.writeFile(path.join(layout.usageInflightDir, `${OTHER_REQUEST_ID}.bin`), '{"a":2}')

        const tampered = await repository().readBody({ requestId: OTHER_REQUEST_ID, bodySha256: sha256Hex(body) })
        await repository().removeBodies(REQUEST_ID)

        expect(tampered).toBeUndefined()
        expect(await fs.readdir(layout.usageInflightDir)).toEqual([`${REQUEST_ID}.bin`])
        await expect(repository().writeBody("../escape", body)).rejects.toThrow()
    })

    it("resets pending work from any window while keeping the lease, the server gate and a running wait", async () => {
        const grant = await repository().claim("window-a")
        if (!grant) throw new Error("expected a lease")
        await repository().transact(grant, () => ({ state: pendingState(), result: undefined }))
        await repository().writeBody(REQUEST_ID, new Uint8Array([1, 2, 3]))

        await repository().reset(9)

        expect(await repository().read()).toEqual({ ...emptyUsageOutbox(9), pacing: pendingState().pacing })
        expect(await fs.readdir(layout.usageInflightDir)).toEqual([])
        expect(await repository().claim("window-b")).toBeUndefined()
    })

    it("refuses a stale policy reset without clearing newer state or inflight bytes", async () => {
        const grant = await repository().claim("window-a")
        if (!grant) throw new Error("expected a lease")
        const state = pendingState(9)
        await repository().transact(grant, () => ({ state, result: undefined }))
        await repository().writeBody(REQUEST_ID, new Uint8Array([1, 2, 3]))

        expect(await repository().reset(8)).toBe(false)
        expect(await repository().reset(9)).toBe(false)
        expect(await repository().read()).toEqual(state)
        expect(await fs.readdir(layout.usageInflightDir)).toEqual([`${REQUEST_ID}.bin`])

        expect(await repository().reset(10)).toBe(true)
        expect(await repository().read()).toEqual({ ...emptyUsageOutbox(10), pacing: state.pacing })
        expect(await fs.readdir(layout.usageInflightDir)).toEqual([])
    })

    it("quarantines an outbox from an earlier schema instead of migrating facts it cannot hold", async () => {
        await fs.mkdir(layout.usageDir, { recursive: true })
        // A purpose-and-model outbox cannot be expressed as fact-keyed seconds, and a
        // queue of unsent claims is not history worth a migration, so it is set aside.
        await fs.writeFile(
            layout.usageOutboxPath,
            JSON.stringify({
                schema_version: 2,
                generation: 3,
                lease: { owner_id: "window-a", generation: 3, expires_at: now + 60_000 },
                state: { policy_epoch: 4, next_eligible_at: now + 30_000, sealed_through: 0, minutes: [] },
            }),
        )

        const grant = await repository().claim("window-a")

        expect(grant).toEqual({ ownerId: "window-a", generation: 1 })
        expect(await fs.readdir(layout.remoteQuarantineDir)).toHaveLength(1)
        const rebuilt = await repository().read()
        expect(rebuilt?.seconds).toEqual([])
        expect(rebuilt?.inflight).toBeUndefined()
    })

    it("quarantines an unreadable outbox and starts over instead of guessing its contents", async () => {
        await fs.mkdir(layout.usageDir, { recursive: true })
        await fs.writeFile(layout.usageOutboxPath, '{"schema_version":1,"generation":"x"}')

        const grant = await repository().claim("window-a")

        expect(grant).toEqual({ ownerId: "window-a", generation: 1 })
        expect(await fs.readdir(layout.remoteQuarantineDir)).toHaveLength(1)
    })

    it("leaves an outbox written by a newer Dline untouched and never sends from it", async () => {
        const newer = `${JSON.stringify({ schema_version: USAGE_OUTBOX_SCHEMA_VERSION + 1, generation: 4 })}\n`
        await fs.mkdir(layout.usageInflightDir, { recursive: true })
        await fs.writeFile(layout.usageOutboxPath, newer)
        await fs.writeFile(path.join(layout.usageInflightDir, `${REQUEST_ID}.bin`), "newer body")

        const grant = await repository().claim("window-a")
        await repository().reset(2)

        expect(grant).toBeUndefined()
        expect(await repository().read()).toBeUndefined()
        expect(await fs.readFile(layout.usageOutboxPath, "utf8")).toBe(newer)
        expect(await fs.readdir(layout.usageInflightDir)).toEqual([`${REQUEST_ID}.bin`])
    })

    describe("schema 4 attempt authority", () => {
        it("destructively activates schema 4 and durably folds a settled shard exactly once", async () => {
            const legacy = repository()
            const legacyGrant = await legacy.claim("legacy-window")
            if (!legacyGrant) throw new Error("expected legacy lease")
            await legacy.transact(legacyGrant, () => ({ state: pendingState(), result: undefined }))
            await legacy.writeBody(REQUEST_ID, new Uint8Array([1, 2, 3]))

            expect(await legacy.activateAttempts(7)).toBe("activated")
            expect(await legacy.read()).toBeUndefined()
            expect(await fs.readdir(layout.usageInflightDir)).toEqual([])
            expect(await legacy.claim("legacy-window")).toBeUndefined()

            const grant = await legacy.claimAttempts("window-a")
            if (!grant) throw new Error("expected schema 4 lease")
            const shards = [
                {
                    name: "host-a.1.attempts.sealed.jsonl",
                    observations: [attemptObservation("a", now, 58_400), attemptObservation("b", now + 1, 18_500)],
                },
            ]
            let nextBucket = 0
            const fold = (state: Parameters<typeof foldUsageAttemptShards>[0]) =>
                foldUsageAttemptShards(state, shards, {
                    currentPolicyGeneration: 7,
                    newBucketId: () => `bucket-${++nextBucket}`,
                    sealedAt: now + 100_000,
                })

            expect(await legacy.transactAttempts(grant, (state) => ({ state: fold(state), result: undefined }))).toEqual({
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

            await legacy.transactAttempts(grant, (state) => ({ state: fold(state), result: undefined }))
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

        /** Both windows run their cycle once, holder first, as two live extension hosts would. */
        async function cycle(a: UsageOutboxRepository, b: UsageOutboxRepository) {
            const first = await a.claim("window-a")
            const second = await b.claim("window-b")
            return { a: first, b: second }
        }

        it("hands the lease to a waiting window once the holder's turn is over, and does not take it straight back", async () => {
            const a = repository()
            const b = repository()
            const granted = await a.claim("window-a")
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
            const granted = await a.claim("window-a")
            let claimed = granted
            while (now - start < USAGE_SENDER_TURN_MS) {
                now += CYCLE
                claimed = await a.claim("window-a")
                if (now - start < USAGE_SENDER_TURN_MS) expect(claimed).toEqual(granted)
            }

            expect(claimed).toBeUndefined()
            now += CYCLE
            expect(await a.claim("window-a")).toEqual({ ownerId: "window-a", generation: (granted?.generation ?? 0) + 1 })
        })

        it("does not let a waiter that stopped asking keep the free lease from the next window", async () => {
            const start = now
            const a = repository()
            const granted = await a.claim("window-a")
            expect(await repository().claim("window-b")).toBeUndefined()
            while (now - start < USAGE_SENDER_TURN_MS) {
                now += CYCLE
                await a.claim("window-a")
            }

            now += CYCLE
            expect(await a.claim("window-a")).toEqual({ ownerId: "window-a", generation: (granted?.generation ?? 0) + 1 })
        })

        it("takes over an older build that keeps renewing past its turn, fences it and keeps its inflight bytes", async () => {
            await fs.mkdir(layout.usageInflightDir, { recursive: true })
            const body = new TextEncoder().encode('{"schema_version":3}')
            await fs.writeFile(path.join(layout.usageInflightDir, `${REQUEST_ID}.bin`), body)
            const inflight = {
                request_id: REQUEST_ID,
                body_sha256: sha256Hex(body),
                seconds: [],
                dropped_seconds: 0,
                created_at: now,
                attempts: 0,
                not_before: now,
            }
            // A holder that only writes its known fields: any waiter entry is dropped on renewal.
            const renewByOlderBuild = () =>
                fs.writeFile(
                    layout.usageOutboxPath,
                    JSON.stringify({
                        schema_version: 3,
                        generation: 5,
                        lease: { owner_id: "older-build", generation: 5, expires_at: now + USAGE_SENDER_LEASE_MS },
                        state: {
                            policy_epoch: 1,
                            pacing: { next_eligible_at: 0, wait_until: 0, consecutive_waits: 0 },
                            sealed_through: 0,
                            dropped_seconds: 0,
                            seconds: [],
                            folded_shards: [],
                            inflight,
                        },
                    }),
                )
            await fs.mkdir(layout.usageDir, { recursive: true })
            await renewByOlderBuild()
            const events: UsageSenderTurnEvent[] = []
            const b = new UsageOutboxRepository(layout, { clock: () => now, onSenderTurn: (event) => events.push(event) })
            const start = now
            let grant = await b.claim("window-b")
            while (grant === undefined && now - start <= USAGE_SENDER_TURN_MS + USAGE_SENDER_TAKEOVER_GRACE_MS + CYCLE) {
                now += CYCLE
                await renewByOlderBuild()
                grant = await b.claim("window-b")
            }

            expect(grant).toEqual({ ownerId: "window-b", generation: 6 })
            expect(events).toEqual([{ kind: "took_over", generation: 6 }])
            expect(now - start).toBeGreaterThanOrEqual(USAGE_SENDER_TURN_MS + USAGE_SENDER_TAKEOVER_GRACE_MS)
            const fenced = await repository().transact({ ownerId: "older-build", generation: 5 }, (state) => ({
                state,
                result: "written",
            }))
            expect(fenced).toEqual({ status: "fenced" })
            const state = await b.read()
            expect(state?.inflight?.requestId).toBe(REQUEST_ID)
            const kept = await b.readBody({ requestId: REQUEST_ID, bodySha256: sha256Hex(body) })
            expect(kept && new TextDecoder().decode(kept)).toBe('{"schema_version":3}')
        })
    })
})
