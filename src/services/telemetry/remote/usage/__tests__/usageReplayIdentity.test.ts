import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type OtelStorageLayout, resolveOtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import { UsageOutboxRepository } from "@/core/storage/telemetry-remote/UsageOutboxRepository"
import { USAGE_GRANT_HARD_LIMITS, type UsageGrantContract } from "../../contracts/deviceGrant"
import type { UsageClientWire } from "../../contracts/usageBody"
import { sealOpenAttemptBucket } from "../attemptBucket"
import {
    emptyUsageAttemptOutbox,
    foldUsageAttemptShards,
    settleUsageAttemptInflight,
    takeUsageAttemptBatch,
    usageReplayIdentity,
    usageUserAgent,
} from "../usageOutbox"

const MINUTE = 60_000
const DAY = 24 * 60 * MINUTE
const T0 = Math.floor(Date.UTC(2026, 9, 31, 12, 0, 0) / MINUTE) * MINUTE
const REQUEST_ID = "11111111-1111-4111-8111-111111111111"

const CONTRACT: UsageGrantContract = {
    schemaVersion: 5,
    contractVersion: 1,
    ...USAGE_GRANT_HARD_LIMITS,
    defaultIntervalMs: 600_000,
    newBatchJitterMaxMs: 0,
}
const CLIENT: UsageClientWire = { version: "0.11.1", platform: "win32" }

/** One real attempt fact, folded and sealed through the same paths production uses. */
function foldedState() {
    const folded = foldUsageAttemptShards(
        emptyUsageAttemptOutbox(7),
        [
            {
                name: "host-a.attempts.sealed.jsonl",
                claims: [],
                observations: [
                    {
                        id: "attempt-a",
                        revision: 1,
                        receivedAt: T0 + 3_000,
                        localSessionId: "session-a",
                        observation: {
                            attemptObservationId: "attempt-a",
                            logicalRequestId: "logical-attempt-a",
                            identity: {
                                role: "task" as const,
                                provider: "anthropic",
                                modelId: "catalog:claude-opus-4-1",
                                thinking: 2_048,
                            },
                            policyGeneration: 7,
                            admittedAt: T0 + 1_000,
                            outcome: "completed" as const,
                            durationMs: 1_000,
                            tokens: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: 1 },
                            tokenUsageReported: true,
                        },
                    },
                ],
            },
        ],
        { currentPolicyGeneration: 7, newBucketId: () => "bucket-1", sealedAt: T0 + 100_000 },
    )
    return { ...folded, buckets: sealOpenAttemptBucket(folded.buckets, T0 + 100_000) }
}

function batchDecision() {
    const decision = takeUsageAttemptBatch(foldedState(), {
        now: T0 + MINUTE,
        requestId: REQUEST_ID,
        client: CLIENT,
        random: () => 0,
        contract: CONTRACT,
    })
    if (decision.kind !== "batch") throw new Error(`expected a batch, got ${decision.kind}`)
    return decision
}

describe("usage replay identity", () => {
    it("freezes the manifest's user agent to the body's client version", () => {
        const decision = batchDecision()

        expect(decision.inflight.userAgent).toBe(usageUserAgent("0.11.1"))
        expect(decision.inflight.contract).toBe("5")
        // The frozen agent must name the same version as the canonical bytes it will be sent with.
        const body = JSON.parse(new TextDecoder().decode(decision.bytes)) as { client: { version: string } }
        expect(decision.inflight.userAgent).toBe(usageUserAgent(body.client.version))
    })

    it("recovers the replay identity from the stored body when the manifest predates the freeze", () => {
        const decision = batchDecision()

        expect(usageReplayIdentity({}, decision.bytes)).toEqual({
            userAgent: usageUserAgent("0.11.1"),
            contract: "5",
        })
    })

    it("prefers a frozen identity over anything the running build could derive", () => {
        const decision = batchDecision()

        expect(usageReplayIdentity({ userAgent: "Dline/0.9.9", contract: "5" }, decision.bytes)).toEqual({
            userAgent: "Dline/0.9.9",
            contract: "5",
        })
    })

    it("refuses to invent an identity for bytes that no longer parse", () => {
        expect(usageReplayIdentity({}, new TextEncoder().encode("not json"))).toBeUndefined()
    })

    it("keeps the manifest origin when a 429 wait postpones the replay", () => {
        const decision = batchDecision()

        const waited = settleUsageAttemptInflight(
            decision.state,
            REQUEST_ID,
            { kind: "wait", code: "reservation_limited", retryAfterMs: 10 * MINUTE },
            T0 + 2 * MINUTE,
            { maxAttempts: Number.POSITIVE_INFINITY, maxAgeMs: DAY },
            () => 0,
        )

        // A 429 stored nothing, so it may postpone `notBefore` but never the idempotency origin.
        expect(waited.inflight?.createdAt).toBe(decision.inflight.createdAt)
        expect(waited.inflight?.notBefore).toBeGreaterThan(decision.inflight.notBefore)
    })

    it("releases the buckets when the horizon passed, so nothing is rebuilt under a new identity", () => {
        const decision = batchDecision()

        const expired = settleUsageAttemptInflight(decision.state, REQUEST_ID, { kind: "replay_expired" }, T0 + DAY, {
            maxAttempts: Number.POSITIVE_INFINITY,
            maxAgeMs: DAY,
        })

        expect(expired.inflight).toBeUndefined()
        expect(expired.buckets.sealed).toEqual([])
    })
})

describe("usage manifest persistence", () => {
    let root: string
    let layout: OtelStorageLayout
    const now = T0 + MINUTE
    // One sealed bucket from the same fold path production uses; its identity is what a manifest names.
    const sealedBucket = () => {
        const sealed = foldedState().buckets.sealed[0]
        if (!sealed) throw new Error("the fold must produce one sealed bucket")
        return sealed
    }

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-otel-manifest-"))
        layout = resolveOtelStorageLayout(path.join(root, "data"))
        await new UsageOutboxRepository(layout, { clock: () => now }).activateAttempts(7)
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    /** Write one inflight manifest into the live document, then read the document back. */
    async function roundTrip(inflight: Record<string, unknown>): Promise<Record<string, unknown> | undefined> {
        const document = JSON.parse(await fs.readFile(layout.usageOutboxPath, "utf8")) as {
            state: { sealed_buckets: unknown[]; inflight?: unknown }
        }
        document.state.sealed_buckets = [sealedBucket()]
        document.state.inflight = inflight
        await fs.writeFile(layout.usageOutboxPath, JSON.stringify(document), "utf8")

        const state = await new UsageOutboxRepository(layout, { clock: () => now }).readAttempts()
        return state?.inflight as Record<string, unknown> | undefined
    }

    const baseInflight = {
        request_id: REQUEST_ID,
        body_sha256: "a".repeat(64),
        bucket_ids: [sealedBucket().bucketId],
        created_at: now,
        attempts: 0,
        not_before: now,
    }

    it("keeps the frozen user agent and contract across a restart", async () => {
        const restored = await roundTrip({ ...baseInflight, user_agent: "Dline/0.11.1", contract: "5" })

        expect(restored).toMatchObject({ requestId: REQUEST_ID, userAgent: "Dline/0.11.1", contract: "5" })
    })

    it("still reads a manifest written before the identity was frozen", async () => {
        const restored = await roundTrip(baseInflight)

        expect(restored).toMatchObject({ requestId: REQUEST_ID })
        expect(restored?.userAgent).toBeUndefined()
        expect(restored?.contract).toBeUndefined()
    })

    it("drops an agent or contract the service would refuse instead of replaying one", async () => {
        const restored = await roundTrip({ ...baseInflight, user_agent: "Mozilla/5.0", contract: "five" })

        expect(restored).toMatchObject({ requestId: REQUEST_ID })
        expect(restored?.userAgent).toBeUndefined()
        expect(restored?.contract).toBeUndefined()
    })
})
