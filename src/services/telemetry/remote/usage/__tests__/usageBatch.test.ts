import { describe, expect, it } from "vitest"
import type { UsageSettlement } from "@/core/task/telemetry/UsageSettlement"
import {
    USAGE_BODY_LIMIT_BYTES,
    USAGE_SECOND_MS,
    type UsageBodyWire,
    type UsageFactWire,
    validateUsageBody,
} from "../../contracts/usageBody"
import { MAX_TOOL_NAMES_PER_FACT } from "../../contracts/usageExecution"
import {
    buildUsageBody,
    countFactIdentities,
    mergeSeconds,
    secondStartOf,
    selectBatchSeconds,
    type UsageSecond,
} from "../usageBatch"
import { mergeUsageTallies, parseUsageTally, projectUsageSettlement, type UsageFactTally, type UsageTally } from "../usageTally"

const CLIENT = { version: "0.12.0" }
const T0 = 1_792_456_800_000

function factTally(overrides: Partial<UsageFactTally> = {}): UsageFactTally {
    return {
        role: "task",
        provider: "anthropic",
        model: "claude-opus-5-5",
        custom: false,
        requests: { completed: 1, cancelled: 0, failed: 0 },
        tokens: { input: 10, output: 5, cache_read: 0, cache_write: 0 },
        duration_ms: { count: 1, sum: 900, min: 900, max: 900, buckets: [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0] },
        errors: {},
        retries: 0,
        ...overrides,
    }
}

function factWire(overrides: Partial<UsageFactWire> = {}): UsageFactWire {
    return {
        role: "task",
        provider: "anthropic",
        model: "claude-opus-5-5",
        custom: false,
        requests: { completed: 1, cancelled: 0, failed: 0 },
        tokens: { input: 10, output: 5, cache_read: 0, cache_write: 0 },
        duration_ms: { count: 1, sum: 900, min: 900, max: 900, buckets: [0, 0, 1, 0, 0, 0, 0, 0, 0, 0, 0] },
        errors: {},
        retries: 0,
        ...overrides,
    }
}

function tallyOf(...facts: UsageFactTally[]): UsageTally {
    return { sessions_started: 0, facts }
}

function secondsOf(...tallies: UsageTally[]): UsageSecond[] {
    return tallies.map((tally, index) => ({ startedAt: T0 + index * USAGE_SECOND_MS, tally }))
}

function body(seconds: UsageSecond[], dropped = 0): UsageBodyWire {
    const built = buildUsageBody(seconds, CLIENT, dropped)
    if (!built) throw new Error("expected a body")
    return built
}

function factOf(sent: UsageBodyWire, model: string): UsageFactWire | undefined {
    return sent.facts.find((fact) => fact.model === model)
}

describe("second buckets", () => {
    it("merges the same second and keeps them ordered", () => {
        const merged = mergeSeconds(
            [
                {
                    startedAt: T0 + USAGE_SECOND_MS,
                    tally: tallyOf(factTally({ tokens: { input: 5, output: 0, cache_read: 0, cache_write: 0 } })),
                },
            ],
            [
                { startedAt: T0, tally: tallyOf(factTally()) },
                {
                    startedAt: T0 + USAGE_SECOND_MS,
                    tally: tallyOf(factTally({ tokens: { input: 7, output: 0, cache_read: 0, cache_write: 0 } })),
                },
            ],
        )

        expect(merged.map((second) => second.startedAt)).toEqual([T0, T0 + USAGE_SECOND_MS])
        expect(merged[1]?.tally.facts[0]?.tokens.input).toBe(12)
    })

    it("floors a timestamp to its second", () => {
        expect(secondStartOf(T0 + 999)).toBe(T0)
        expect(secondStartOf(T0 + USAGE_SECOND_MS)).toBe(T0 + USAGE_SECOND_MS)
    })

    it("takes only the seconds that end inside the contract span", () => {
        const hour = 60 * 60 * 1000
        const selected = selectBatchSeconds([
            { startedAt: T0, tally: tallyOf(factTally()) },
            { startedAt: T0 + hour - USAGE_SECOND_MS, tally: tallyOf(factTally()) },
            { startedAt: T0 + hour, tally: tallyOf(factTally()) },
        ])

        // The last second starts at the end of the span, so it belongs to the next batch.
        expect(selected.map((second) => second.startedAt)).toEqual([T0, T0 + hour - USAGE_SECOND_MS])
    })
})

describe("building a batch", () => {
    it("reports the second count as active seconds, not as minutes", () => {
        const sent = body(secondsOf(tallyOf(factTally()), tallyOf(factTally())))

        expect(sent.window.active_seconds).toBe(2)
        expect(sent.window.started_at).toBe(T0)
        expect(sent.window.ended_at).toBe(T0 + 2 * USAGE_SECOND_MS)
        expect(validateUsageBody(sent)).toEqual([])
    })

    it("carries the reported loss beside the active seconds", () => {
        expect(body(secondsOf(tallyOf(factTally())), 9).window.dropped_seconds).toBe(9)
    })

    it("keeps one fact per identity and adds the same identity up", () => {
        const sent = body(
            secondsOf(tallyOf(factTally()), tallyOf(factTally({ requests: { completed: 2, cancelled: 0, failed: 0 } }))),
        )

        expect(sent.facts).toHaveLength(1)
        expect(sent.facts[0]).toMatchObject({ role: "task", provider: "anthropic", model: "claude-opus-5-5", custom: false })
        expect(sent.facts[0]?.requests.completed).toBe(3)
    })

    it("keeps the custom and non-custom selection of one model apart", () => {
        const sent = body(secondsOf(tallyOf(factTally()), tallyOf(factTally({ custom: true }))))

        expect(sent.facts).toHaveLength(2)
        expect(sent.facts.map((fact) => fact.custom).sort()).toEqual([false, true])
    })

    it("refuses a batch of seconds that hold no activity", () => {
        expect(buildUsageBody(secondsOf({ sessions_started: 0, facts: [] }), CLIENT, 0)).toBeUndefined()
        expect(buildUsageBody([], CLIENT, 0)).toBeUndefined()
    })

    it("counts the distinct fact identities so the caller can seal before the bound", () => {
        const seconds = secondsOf(
            tallyOf(factTally()),
            tallyOf(factTally({ model: "other-model" })),
            tallyOf(factTally({ custom: true })),
        )

        expect(countFactIdentities(seconds)).toBe(3)
        expect(countFactIdentities(secondsOf(tallyOf(factTally()), tallyOf(factTally())))).toBe(1)
    })

    it("counts role as part of the full fact identity", () => {
        const seconds = secondsOf(tallyOf(factTally()), tallyOf(factTally({ role: "subagent" })))

        expect(countFactIdentities(seconds)).toBe(2)
    })

    it("fits the byte bound for the largest batch the identity bounds allow", () => {
        // Role, provider and model-identity bounds are tighter than the fact bound,
        // so the largest legal batch is their product rather than USAGE_MAX_FACTS.
        const roles = ["task", "subagent", "compaction", "other"] as const
        const facts = roles.flatMap((role) =>
            Array.from({ length: 8 }, (_, index) => factTally({ role, provider: `p${index}`, model: `m${index}` })),
        )
        const sent = body(secondsOf(tallyOf(...facts)))

        expect(facts).toHaveLength(32)
        expect(validateUsageBody(sent)).toEqual([])
        const bytes = new TextEncoder().encode(JSON.stringify(sent)).byteLength
        // The §18 deliverable reports this measured figure, so record it rather
        // than only asserting the bound: a body that barely fits would leave no
        // room for a future field without a contract change.
        console.info(`[usage] largest batch: ${facts.length} facts, ${bytes} of ${USAGE_BODY_LIMIT_BYTES} bytes`)
        expect(bytes).toBeLessThan(USAGE_BODY_LIMIT_BYTES)
        expect(bytes).toBeLessThan(USAGE_BODY_LIMIT_BYTES * 0.75)
    })

    it("refuses a body that would exceed the fact bound", () => {
        // Building a batch merges by identity, so the fact bounds are only reachable
        // on the wire. With four registered roles, eight model identities each is the
        // largest set every other bound still allows; one more fact than the bound is
        // what the reader must reject.
        const roles = ["task", "subagent", "compaction", "other"] as const
        // Four roles over eight providers already fills 32 facts; a ninth provider is
        // the first identity the fact bound cannot hold.
        const tooMany = roles.flatMap((role) =>
            Array.from({ length: 9 }, (_, index) => factWire({ role, provider: `p${index}`, model: `m${index}` })),
        )
        const wire: UsageBodyWire = {
            schema_version: 3,
            client: { version: "0.12.0" },
            window: { started_at: T0, ended_at: T0 + USAGE_SECOND_MS, active_seconds: 1, dropped_seconds: 0 },
            sessions_started: 0,
            facts: tooMany,
        }

        const violations = validateUsageBody(wire)

        expect(tooMany).toHaveLength(36)
        expect(violations).toContain("facts")
        // The identity bounds are what let the fact bound be reachable at all.
        expect(violations).toContain("model_cardinality")
        expect(violations).not.toContain("role_cardinality")
    })
})

describe("settlement projection", () => {
    function settlement(overrides: Partial<UsageSettlement> = {}): UsageSettlement {
        return {
            observationId: "obs-1",
            purpose: "task",
            outcome: "completed",
            inputTokens: 10,
            outputTokens: 5,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            durationMs: 900,
            servedBy: { provider: "anthropic", model: "claude-opus-5-5" },
            ...overrides,
        }
    }

    it("projects one request into exactly one fact", () => {
        const tally = projectUsageSettlement(settlement())

        expect(tally.sessions_started).toBe(0)
        expect(tally.facts).toHaveLength(1)
        expect(tally.facts[0]).toMatchObject({
            role: "task",
            provider: "anthropic",
            model: "claude-opus-5-5",
            requests: { completed: 1, cancelled: 0, failed: 0 },
        })
    })

    it("reports an unknown purpose under other instead of inventing a role", () => {
        const tally = projectUsageSettlement(settlement({ purpose: "planning" as never }))

        expect(tally.facts[0]?.role).toBe("other")
    })

    it("names a model the wire pattern cannot carry, keeping its totals", () => {
        const tally = projectUsageSettlement(settlement({ servedBy: { provider: "anthropic", model: "openai/gpt-4o" } }))

        // The provider reported this exact model; keeping its normalized name is what
        // makes a per-model analysis possible. `_unknown` is reserved for a model the
        // producer could not state at all.
        expect(tally.facts[0]?.model).toBe("openai_gpt-4o")
        expect(tally.facts[0]?.tokens.input).toBe(10)
    })

    it("falls back to the explicit unknown bucket when no model was reported", () => {
        const tally = projectUsageSettlement(settlement({ servedBy: undefined }))

        expect(tally.facts[0]?.model).toBe("_unknown")
        expect(tally.facts[0]?.provider).toBe("_unknown")
        expect(tally.facts[0]?.tokens.input).toBe(10)
    })

    it("counts a failure under the provider's error class", () => {
        const tally = projectUsageSettlement(settlement({ outcome: "failed", failureClass: "timeout" }))

        expect(tally.facts[0]?.errors).toEqual({ timeout: 1 })
        expect(tally.facts[0]?.requests.failed).toBe(1)
    })

    it("counts every retry that was followed by another attempt", () => {
        const tally = projectUsageSettlement(settlement({ retries: { waitsMs: [100, 200] } }))

        expect(tally.facts[0]?.retries).toBe(2)
        expect(tally.facts[0]?.retry_wait_ms).toEqual({ count: 2, sum: 300, min: 100, max: 200 })
    })

    it("never reports reasoning above the output it belongs to", () => {
        const tally = projectUsageSettlement(settlement({ outputTokens: 5, reasoningTokens: 50 }))

        expect(tally.facts[0]?.tokens.reasoning).toBe(5)
    })

    it("groups the tool calls a request reported and conserves their outcomes", () => {
        const tally = projectUsageSettlement(
            settlement({
                toolCalls: [
                    { outcome: "completed", toolName: "read_file" },
                    { outcome: "completed", toolName: "read_file" },
                    { outcome: "failed", toolName: "execute_command" },
                ],
            }),
        )
        const tools = tally.facts[0]?.tools

        expect(tools?.completed).toBe(2)
        expect(tools?.failed).toBe(1)
        expect(tools?.cancelled).toBe(0)
        expect(tools?.by_name).toEqual({
            read_file: { completed: 2, failed: 0, cancelled: 0 },
            execute_command: { completed: 0, failed: 1, cancelled: 0 },
        })
        expect(validateUsageBody(body(secondsOf(tally)))).toEqual([])
    })

    it("counts a call with no identity as unlisted instead of losing it", () => {
        const tally = projectUsageSettlement(
            settlement({
                toolCalls: [{ outcome: "completed", toolName: "read_file" }, { outcome: "cancelled" }],
            }),
        )
        const tools = tally.facts[0]?.tools

        expect(tools?.completed).toBe(1)
        expect(tools?.cancelled).toBe(1)
        expect(tools?.by_name).toEqual({ read_file: { completed: 1, failed: 0, cancelled: 0 } })
        expect(tools?.unlisted).toEqual({ completed: 0, failed: 0, cancelled: 1 })
        expect(validateUsageBody(body(secondsOf(tally)))).toEqual([])
    })

    it("reports no tools for a request that ran none", () => {
        const tally = projectUsageSettlement(settlement())

        expect(tally.facts[0]?.tools).toBeUndefined()
    })

    it("counts a declared and completed item as one completion of one item", () => {
        const tally = projectUsageSettlement(
            settlement({
                checklistChanges: [
                    { itemId: "item-a", transition: "declared" },
                    { itemId: "item-a", transition: "completed" },
                ],
            }),
        )
        const todos = tally.facts[0]?.todos

        expect(todos?.declared).toBe(1)
        expect(todos?.completed).toBe(1)
        expect(todos?.reopened).toBe(0)
        expect(todos?.abandoned).toBe(0)
        // The declaration was seen in this batch, so the completion has an honest
        // round sample rather than a fabricated or missing one.
        expect(todos?.rounds_to_complete).toEqual({ count: 1, sum: 1, min: 1, max: 1, buckets: expect.any(Array) })
        expect(validateUsageBody(body(secondsOf(tally)))).toEqual([])
    })

    it("counts a completion whose declaration was never seen without inventing a round count", () => {
        const tally = projectUsageSettlement(settlement({ checklistChanges: [{ itemId: "unseen", transition: "completed" }] }))
        const todos = tally.facts[0]?.todos

        expect(todos?.completed).toBe(1)
        expect(todos?.declared).toBe(1)
        // No first sighting means no measurable interval: an empty distribution,
        // never a fabricated sample that would claim a measured round count.
        expect(todos?.rounds_to_complete).toMatchObject({ count: 0, sum: 0 })
        expect(validateUsageBody(body(secondsOf(tally)))).toEqual([])
    })

    it("reports no todos for a request whose surface has no checklist", () => {
        const tally = projectUsageSettlement(settlement())

        expect(tally.facts[0]?.todos).toBeUndefined()
    })

    it("counts the attempts a request needed from the retries it recorded", () => {
        const firstTry = projectUsageSettlement(settlement()).facts[0]
        const thirdTry = projectUsageSettlement(settlement({ retries: { waitsMs: [100, 200] } })).facts[0]

        // One sample per logical request, and the sample is the attempt count.
        expect(firstTry?.task_attempts).toEqual({ count: 1, sum: 1, min: 1, max: 1 })
        expect(thirdTry?.task_attempts).toEqual({ count: 1, sum: 3, min: 3, max: 3 })
        // The attempt count and the retry count describe the same events.
        expect(thirdTry?.retries).toBe(2)
    })
})

describe("persisted tallies", () => {
    it("round-trips a tally through JSON", () => {
        const tally = mergeUsageTallies(tallyOf(factTally({ retries: 2 })), { sessions_started: 2, facts: [] })

        expect(parseUsageTally(JSON.parse(JSON.stringify(tally)))).toEqual(tally)
    })

    it("refuses a persisted tally the contract would not accept", () => {
        expect(parseUsageTally({ counters: {}, measurements: {} })).toBeUndefined()
        expect(parseUsageTally({ sessions_started: 1, facts: [{ role: "made_up" }] })).toBeUndefined()
        expect(parseUsageTally({ sessions_started: -1, facts: [] })).toBeUndefined()
    })
})

describe("tool counters keep the per-name bound when merged", () => {
    it("folds names beyond the bound into unlisted instead of dropping them", () => {
        const many = Object.fromEntries(
            Array.from({ length: MAX_TOOL_NAMES_PER_FACT + 2 }, (_, index) => [
                `tool_name_${String.fromCharCode(97 + index)}_x`,
                { completed: 1, failed: 0, cancelled: 0 },
            ]),
        )
        const total = MAX_TOOL_NAMES_PER_FACT + 2
        const merged = mergeUsageTallies(
            tallyOf(factTally({ tools: { completed: total, failed: 0, cancelled: 0, by_name: many } })),
            tallyOf(factTally()),
        )

        expect(merged.facts).toHaveLength(1)
        expect(Object.keys(merged.facts[0]?.tools?.by_name ?? {}).length).toBeLessThanOrEqual(MAX_TOOL_NAMES_PER_FACT)
        expect(merged.facts[0]?.tools?.completed).toBe(total)
        expect(validateUsageBody(body(secondsOf(merged)))).toEqual([])
    })

    it("keeps a batch of one fact per model as separate facts", () => {
        const merged = mergeUsageTallies(tallyOf(factTally()), tallyOf(factTally({ model: "second-model" })))
        const sent = body(secondsOf(merged))

        expect(factOf(sent, "claude-opus-5-5")).toBeDefined()
        expect(factOf(sent, "second-model")).toBeDefined()
    })
})
