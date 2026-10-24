import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { type OtelStorageLayout, resolveOtelStorageLayout } from "@/core/storage/telemetry-remote/OtelStorageLayout"
import { UsageOutboxRepository } from "@/core/storage/telemetry-remote/UsageOutboxRepository"
import { USAGE_GRANT_HARD_LIMITS, type UsageGrantContract } from "../contracts/deviceGrant"
import type { UsageAttemptBodyValidation } from "../contracts/usageBody"
import {
    attemptBacklogStorageBytes,
    boundUsageAttemptBacklog,
    dueUsageAttemptReplay,
    emptyUsageAttemptOutbox,
    foldUsageAttemptShards,
    settleUsageAttemptInflight,
    takeUsageAttemptBatch,
    type UsageAttemptOutboxState,
} from "../usage/usageOutbox"

const POLICY_GENERATION = 7
const BASE_TIME = 1_900_000_000_000
const CONTRACT: UsageGrantContract = {
    schemaVersion: 4,
    contractVersion: 4,
    ...USAGE_GRANT_HARD_LIMITS,
    maxBuckets: 3,
    defaultIntervalMs: 1,
    newBatchJitterMaxMs: 0,
}
const VALIDATION: UsageAttemptBodyValidation = {
    contract: CONTRACT,
    estimateWriteRows: (body) => 6 + body.buckets.reduce((sum, bucket) => sum + bucket.facts.length, 0),
}
const CLIENT = {
    version: "0.11.1",
    platform: "win32",
    architecture: "x64",
    host_editor: "vscode",
    channel: "stable",
    is_dev: true,
} as const

describe("schema 4 remote Usage pressure gate", () => {
    let root: string
    let layout: OtelStorageLayout

    beforeEach(async () => {
        root = await fs.mkdtemp(path.join(os.tmpdir(), "dline-usage-pressure-"))
        layout = resolveOtelStorageLayout(path.join(root, "data"))
    })

    afterEach(async () => {
        await fs.rm(root, { recursive: true, force: true })
    })

    it("bounds a concurrent offline backlog by FIFO capacity and persists exact loss evidence", async () => {
        const now = BASE_TIME + 25_000
        const produced = foldConcurrentAttempts(24, BASE_TIME + 24_000)
        const bounded = boundUsageAttemptBacklog(produced, now, {
            maxAgeMs: 24 * 60 * 60_000,
            maxBuckets: 8,
            maxBytes: 16 * 1024 * 1024,
        })

        expect(bounded.state.buckets.sealed.map((bucket) => bucket.bucketId)).toEqual(
            Array.from({ length: 8 }, (_, index) => `bucket-${index + 1}`),
        )
        expect(bounded.state.buckets.open).toBeUndefined()
        expect(bounded.retainedBytes).toBe(attemptBacklogStorageBytes(bounded.state))
        expect(bounded.retainedBytes).toBeLessThanOrEqual(16 * 1024 * 1024)
        expect(bounded.losses).toEqual([
            {
                bucketIds: Array.from({ length: 16 }, (_, index) => `bucket-${index + 9}`),
                violations: ["backlog_capacity"],
            },
        ])

        const repository = new UsageOutboxRepository(layout, { clock: () => now })
        await repository.activateAttempts(POLICY_GENERATION)
        const grant = await repository.claimAttempts("pressure-owner")
        if (!grant) throw new Error("expected schema 4 sender grant")
        await repository.transactAttempts(grant, () => ({ state: bounded.state, result: undefined }))
        for (const loss of bounded.losses) {
            await repository.writeAttemptLoss({
                kind: "delivery",
                bucketIds: loss.bucketIds,
                violations: loss.violations,
                recordedAt: now,
            })
        }

        expect((await repository.readAttempts())?.buckets.sealed.map((bucket) => bucket.bucketId)).toEqual(
            Array.from({ length: 8 }, (_, index) => `bucket-${index + 1}`),
        )
        const evidenceNames = (await fs.readdir(layout.remoteQuarantineDir)).filter((name) =>
            name.startsWith("usage-attempt-loss-"),
        )
        expect(evidenceNames).toHaveLength(1)
        expect(JSON.parse(await fs.readFile(path.join(layout.remoteQuarantineDir, evidenceNames[0]), "utf8"))).toMatchObject({
            schema_version: 1,
            kind: "usage_attempt_bucket_loss",
            stage: "delivery",
            bucket_ids: Array.from({ length: 16 }, (_, index) => `bucket-${index + 9}`),
            violations: ["backlog_capacity"],
        })
    })

    it("expires an old inflight as one immutable unit and clears every released checkpoint", () => {
        const produced = foldConcurrentAttempts(4, BASE_TIME + 4_000)
        const protectedIds = produced.buckets.sealed.slice(0, 2).map((bucket) => bucket.bucketId)
        const withInflight: UsageAttemptOutboxState = {
            ...produced,
            inflight: {
                requestId: "11111111-1111-4111-8111-111111111111",
                bodySha256: "a".repeat(64),
                bucketIds: protectedIds,
                createdAt: BASE_TIME,
                attempts: 2,
                notBefore: BASE_TIME,
            },
        }

        const bounded = boundUsageAttemptBacklog(withInflight, BASE_TIME + 6_000, {
            maxAgeMs: 1_000,
            maxBuckets: 32,
            maxBytes: 16 * 1024 * 1024,
        })

        expect(bounded.state.inflight).toBeUndefined()
        expect(bounded.state.buckets).toEqual({ sealed: [] })
        expect(bounded.state.observationRevisions).toEqual({})
        expect(bounded.losses).toEqual([
            {
                bucketIds: ["bucket-1", "bucket-2", "bucket-3", "bucket-4"],
                violations: ["backlog_age"],
            },
        ])
    })

    it("holds the exact oldest request through a 429 and then drains every surviving bucket in FIFO order", () => {
        let state = foldConcurrentAttempts(10, BASE_TIME + 10_000)
        let now = BASE_TIME + 11_000
        let requestSequence = 0
        const drained: string[] = []

        const first = takeUsageAttemptBatch(state, {
            now,
            requestId: requestId(++requestSequence),
            client: CLIENT,
            random: () => 0,
            ...VALIDATION,
        })
        if (first.kind !== "batch") throw new Error("expected first pressure batch")
        expect(first.body.buckets.map((bucket) => bucket.bucket_id)).toEqual(["bucket-1", "bucket-2", "bucket-3"])

        const paused = settleUsageAttemptInflight(
            first.state,
            first.inflight.requestId,
            { kind: "wait", code: "telemetry_paused", retryAfterMs: 120_000 },
            now,
            () => 0,
        )
        expect(
            takeUsageAttemptBatch(paused, {
                now: now + 119_999,
                requestId: requestId(++requestSequence),
                client: CLIENT,
                random: () => 0,
                ...VALIDATION,
            }),
        ).toEqual({ kind: "none" })

        now = paused.pacing.waitUntil
        expect(dueUsageAttemptReplay(paused, now)).toMatchObject({
            requestId: first.inflight.requestId,
            bodySha256: first.inflight.bodySha256,
            bucketIds: first.inflight.bucketIds,
            attempts: first.inflight.attempts,
            createdAt: now,
            notBefore: now,
        })
        drained.push(...first.inflight.bucketIds)
        state = settleUsageAttemptInflight(
            paused,
            first.inflight.requestId,
            { kind: "acknowledged", disposition: "duplicate", nextEligibleAt: now },
            now,
            () => 0,
        )
        now = state.pacing.nextEligibleAt

        while (state.buckets.sealed.length > 0) {
            const decision = takeUsageAttemptBatch(state, {
                now,
                requestId: requestId(++requestSequence),
                client: CLIENT,
                random: () => 0,
                ...VALIDATION,
            })
            if (decision.kind !== "batch") {
                throw new Error(`expected FIFO recovery batch: ${JSON.stringify({ decision, now, pacing: state.pacing })}`)
            }
            drained.push(...decision.inflight.bucketIds)
            state = settleUsageAttemptInflight(
                decision.state,
                decision.inflight.requestId,
                { kind: "acknowledged", disposition: "accepted", nextEligibleAt: now },
                now,
                () => 0,
            )
            now = state.pacing.nextEligibleAt
        }

        expect(drained).toEqual(Array.from({ length: 10 }, (_, index) => `bucket-${index + 1}`))
        expect(new Set(drained).size).toBe(10)
        expect(state.inflight).toBeUndefined()
        expect(state.observationRevisions).toEqual({})
    })
})

function foldConcurrentAttempts(count: number, sealedAt: number): UsageAttemptOutboxState {
    const observations = Array.from({ length: count }, (_, index) => pendingAttempt(index))
    const shards = Array.from({ length: 4 }, (_, shardIndex) => ({
        name: `host-${shardIndex}.${sealedAt}.attempts.sealed.jsonl`,
        observations: observations.filter((_, index) => index % 4 === shardIndex),
    }))
    let nextBucket = 0
    return foldUsageAttemptShards(emptyUsageAttemptOutbox(POLICY_GENERATION), shards, {
        currentPolicyGeneration: POLICY_GENERATION,
        newBucketId: () => `bucket-${++nextBucket}`,
        sealedAt,
    })
}

function pendingAttempt(index: number) {
    const id = `attempt-${String(index).padStart(3, "0")}`
    const admittedAt = BASE_TIME + index * 1_000
    return {
        id,
        revision: 1,
        receivedAt: admittedAt + 60_000,
        observation: {
            attemptObservationId: id,
            logicalRequestId: `logical-${id}`,
            identity: {
                role: "task" as const,
                provider: "anthropic",
                modelId: "catalog:claude-opus-4-1",
                thinking: 2048,
            },
            policyGeneration: POLICY_GENERATION,
            admittedAt,
            outcome: "completed" as const,
            durationMs: 60_000,
            tokens: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0, reasoning: 5 },
            tokenUsageReported: true,
        },
    }
}

function requestId(sequence: number): string {
    return `00000000-0000-4000-8000-${String(sequence).padStart(12, "0")}`
}
