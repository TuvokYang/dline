/**
 * The contract 5 wire projection and the `/usage` response classifier, held
 * against the vendored dline-web reference fixture (usage-contract §14, §15).
 */

import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it } from "vitest"
import { classifyUsageResponse, type DeliveryOutcome } from "../../contracts/classification"
import { buildUsageBody, type UsageBodyWire } from "../../contracts/usageBody"
import { canonicalUsageBodyBytes, USAGE_HARD_LIMITS, validateUsageBodySchema } from "../../contracts/usageBodySchema"
import { type AttemptBucket, type AttemptFactAggregate, validateAttemptBucket } from "../attemptBucket"

const fixture = JSON.parse(
    readFileSync(path.join(__dirname, "..", "..", "contracts", "__tests__", "fixtures", "usage-schema4-reference.json"), "utf8"),
)
const reference = fixture.valid_requests[0].body as UsageBodyWire

/** Read a reference wire bucket back into the reducer's shape, independently of the projection under test. */
function bucketFromWire(bucket: UsageBodyWire["buckets"][number]): AttemptBucket {
    return {
        bucketId: bucket.bucket_id,
        policyGeneration: bucket.policy_epoch,
        windowStartedAt: bucket.event_window.started_at,
        windowEndedAt: bucket.event_window.ended_at,
        firstAttemptAt: bucket.event_window.first_attempt_at,
        lastAttemptAt: bucket.event_window.last_attempt_at,
        sealedAt: bucket.event_window.sealed_at,
        durationMs: bucket.duration_ms,
        sessionsStarted: bucket.sessions_started,
        // Reversed so the test also proves the projection applies the semantic order itself.
        facts: [...bucket.facts].reverse().map(factFromWire),
    }
}

function factFromWire(fact: UsageBodyWire["buckets"][number]["facts"][number]): AttemptFactAggregate {
    const execution = fact.logical_execution
    return {
        identity: { role: fact.role, provider: fact.provider, modelId: fact.model_id, thinking: fact.thinking },
        requests: fact.requests,
        tokens: {
            input: fact.tokens.input,
            output: fact.tokens.output,
            cacheRead: fact.tokens.cache_read,
            cacheWrite: fact.tokens.cache_write,
            reasoning: fact.tokens.reasoning,
        },
        tokenCoverage: fact.token_coverage,
        generationCoverage: fact.generation_coverage,
        logicalExecutionCoverage: fact.logical_execution_coverage,
        generationOutputTokens: fact.generation_output_tokens,
        duration: fact.duration_ms,
        ...(fact.ttft_ms ? { ttft: fact.ttft_ms } : {}),
        ...(fact.generation_ms ? { generation: fact.generation_ms } : {}),
        errors: fact.errors,
        ...(execution
            ? {
                  logicalExecution: {
                      logicalRequests: execution.logical_requests,
                      turnDurationMs: execution.turn_duration_ms,
                      ...(execution.tools ? { tools: execution.tools } : {}),
                      taskAttempts: execution.task_attempts,
                  },
              }
            : {}),
    }
}

describe("contract 5 wire projection", () => {
    it("reproduces the reference request byte for byte from equivalent sealed buckets", () => {
        const buckets = reference.buckets.map(bucketFromWire)
        for (const bucket of buckets) expect(() => validateAttemptBucket(bucket)).not.toThrow()

        const body = buildUsageBody(buckets, reference.client)

        expect(new TextDecoder().decode(canonicalUsageBodyBytes(body))).toBe(
            new TextDecoder().decode(canonicalUsageBodyBytes(reference)),
        )
        expect(validateUsageBodySchema(body, { limits: USAGE_HARD_LIMITS, clientVersion: reference.client.version })).toEqual([])
    })

    it("refuses an open bucket instead of sending a window that may still grow", () => {
        const { sealedAt: _sealedAt, ...open } = bucketFromWire(reference.buckets[0])
        expect(() => buildUsageBody([open], reference.client)).toThrow(/sealed/)
    })
})

describe("/usage response classification", () => {
    const NOW = 1_792_800_300_000
    /** Client actions of usage-contract §15, one per fixture response case. */
    const EXPECTED: Readonly<Record<string, DeliveryOutcome>> = {
        "accepted-ack": { kind: "acknowledged", disposition: "accepted", nextEligibleAt: 1_792_800_900_000 },
        "duplicate-ack": { kind: "acknowledged", disposition: "duplicate", nextEligibleAt: 1_792_800_900_000 },
        "request-conflict": { kind: "discard", code: "request_id_conflict" },
        "quota-limited": { kind: "wait", code: "quota_limited", retryAfterMs: 1_792_801_200_000 - NOW },
        "temporarily-unavailable": { kind: "replay" },
    }

    it("covers every response case the fixture freezes", () => {
        expect(fixture.response_cases.map((entry: { name: string }) => entry.name).sort()).toEqual(Object.keys(EXPECTED).sort())
    })

    it.each(fixture.response_cases as { name: string; status: number; body: unknown }[])("$name", (entry) => {
        expect(classifyUsageResponse({ status: entry.status, json: entry.body, retryAfter: null }, NOW)).toEqual(
            EXPECTED[entry.name],
        )
    })

    it("confirms ignored_version without a business write and treats a gate-less 200 as unknown", () => {
        expect(
            classifyUsageResponse(
                { status: 200, json: { disposition: "ignored_version", next_eligible_at: NOW }, retryAfter: null },
                NOW,
            ),
        ).toEqual({ kind: "acknowledged", disposition: "ignored_version", nextEligibleAt: NOW })
        expect(classifyUsageResponse({ status: 200, json: { disposition: "accepted" }, retryAfter: null }, NOW)).toEqual({
            kind: "replay",
        })
        // A 200 that rejects is not an acknowledgement either: nothing confirms the request was stored.
        expect(
            classifyUsageResponse(
                { status: 200, json: { disposition: "rejected", next_eligible_at: NOW }, retryAfter: null },
                NOW,
            ),
        ).toEqual({ kind: "replay" })
    })

    it("prefers the body gate over Retry-After and falls back to the header without one", () => {
        const waitFor = (json: unknown, retryAfter: string | null) =>
            classifyUsageResponse({ status: 429, json, retryAfter }, NOW)

        expect(waitFor({ disposition: "rejected", code: "reservation_limited", next_eligible_at: NOW + 7_000 }, "60")).toEqual({
            kind: "wait",
            code: "reservation_limited",
            retryAfterMs: 7_000,
        })
        expect(waitFor({ disposition: "rejected", code: "reservation_limited" }, "60")).toEqual({
            kind: "wait",
            code: "reservation_limited",
            retryAfterMs: 60_000,
        })
    })

    it.each([
        [401, { disposition: "rejected", code: "invalid_authorization" }, { kind: "refresh_token" }],
        [403, { disposition: "rejected", code: "device_revoked" }, { kind: "stop", scope: "profile", code: "device_revoked" }],
        [403, undefined, { kind: "stop", scope: "all", code: "edge_blocked" }],
        [413, { disposition: "rejected", code: "payload_too_large" }, { kind: "too_large" }],
        [422, { disposition: "rejected", code: "invalid_coverage" }, { kind: "discard", code: "invalid_coverage" }],
        [408, undefined, { kind: "replay" }],
    ] as const)("maps HTTP %i to its §15 action", (status, json, expected) => {
        expect(classifyUsageResponse({ status, json, retryAfter: null }, NOW)).toEqual(expected)
    })
})
