import { strict as assert } from "node:assert"
import { describe, it } from "vitest"
import type { UiMessage } from "../ExtensionMessage"
import { getApiMetrics, getLastApiReqTotalTokens } from "../getApiMetrics"

describe("getApiMetrics", () => {
    it("includes subagent_usage in aggregate totals", () => {
        const messages: UiMessage[] = [
            {
                ts: 1,
                type: "say",
                say: "api_req_started",
                text: JSON.stringify({
                    tokensIn: 10,
                    tokensOut: 20,
                    cacheWrites: 3,
                    cacheReads: 1,
                    cost: 0.12,
                }),
            },
            {
                ts: 2,
                type: "say",
                say: "subagent_usage",
                text: JSON.stringify({
                    source: "subagents",
                    tokensIn: 4,
                    tokensOut: 8,
                    cacheWrites: 2,
                    cacheReads: 1,
                    cost: 0.05,
                }),
            },
            {
                ts: 3,
                type: "say",
                say: "deleted_api_reqs",
                text: JSON.stringify({
                    tokensIn: 6,
                    tokensOut: 9,
                    cacheWrites: 1,
                    cacheReads: 0,
                    cost: 0.03,
                }),
            },
        ]

        const metrics = getApiMetrics(messages)

        assert.equal(metrics.totalTokensIn, 20)
        assert.equal(metrics.totalTokensOut, 37)
        assert.equal(metrics.totalCacheWrites, 6)
        assert.equal(metrics.totalCacheReads, 2)
        assert.ok(Math.abs(metrics.totalCost - 0.2) < 1e-9)
    })

    it("keeps currency tied to the latest amount, including zero", () => {
        const messages: UiMessage[] = [
            { ts: 1, type: "say", say: "api_req_started", text: JSON.stringify({ cost: 0.12, currency: "CNY" }) },
            { ts: 2, type: "say", say: "subagent_usage", text: JSON.stringify({ tokensIn: 10 }) },
        ]
        assert.equal(getApiMetrics(messages).currency, "CNY")
        messages.push({ ts: 3, type: "say", say: "api_req_started", text: JSON.stringify({ cost: 0 }) })
        const metrics = getApiMetrics(messages)
        assert.equal(metrics.totalCost, 0.12)
        assert.equal(metrics.currency, undefined)
        assert.equal(metrics.totalTokensIn, 10)
    })

    it("keeps each currency in its own segment instead of adding them together", () => {
        const metrics = getApiMetrics([
            { ts: 1, type: "say", say: "api_req_started", text: JSON.stringify({ cost: 0.12, currency: "CNY" }) },
            { ts: 2, type: "say", say: "api_req_started", text: JSON.stringify({ cost: 0.05, currency: "USD" }) },
        ])

        // Switching provider mid-task changes the unit; a sum of 0.12 CNY and 0.05 USD
        // has no unit at all, so each amount stays in the segment it was reported in.
        assert.deepEqual(metrics.costSegments, [
            { currency: "CNY", totalCost: 0.12 },
            { currency: "USD", totalCost: 0.05 },
        ])
        assert.equal(metrics.currency, "USD")
    })

    it("merges consecutive amounts that share a currency", () => {
        const metrics = getApiMetrics([
            { ts: 1, type: "say", say: "api_req_started", text: JSON.stringify({ cost: 0.25, currency: "CNY" }) },
            { ts: 2, type: "say", say: "subagent_usage", text: JSON.stringify({ cost: 0.25, currency: "CNY" }) },
        ])

        assert.deepEqual(metrics.costSegments, [{ currency: "CNY", totalCost: 0.5 }])
    })

    it("starts a new segment when a currency returns after another one", () => {
        const metrics = getApiMetrics([
            { ts: 1, type: "say", say: "api_req_started", text: JSON.stringify({ cost: 1, currency: "CNY" }) },
            { ts: 2, type: "say", say: "api_req_started", text: JSON.stringify({ cost: 2, currency: "USD" }) },
            { ts: 3, type: "say", say: "api_req_started", text: JSON.stringify({ cost: 4, currency: "CNY" }) },
        ])

        // The newest segment is the one a header states, so a returning currency is
        // its own run rather than a continuation of the first one.
        assert.deepEqual(metrics.costSegments, [
            { currency: "CNY", totalCost: 1 },
            { currency: "USD", totalCost: 2 },
            { currency: "CNY", totalCost: 4 },
        ])
    })

    it("records an amount reported without a currency as its own unlabelled segment", () => {
        const metrics = getApiMetrics([
            { ts: 1, type: "say", say: "api_req_started", text: JSON.stringify({ cost: 0.5, currency: "CNY" }) },
            { ts: 2, type: "say", say: "api_req_started", text: JSON.stringify({ cost: 0.25 }) },
        ])

        assert.deepEqual(metrics.costSegments, [
            { currency: "CNY", totalCost: 0.5 },
            { currency: "", totalCost: 0.25 },
        ])
        assert.equal(metrics.currency, undefined)
    })

    it("preserves an explicitly reported zero-percent cache hit rate", () => {
        const metrics = getApiMetrics([
            {
                ts: 1,
                type: "say",
                say: "api_req_started",
                text: JSON.stringify({ tokensIn: 100, tokensOut: 20, cacheWrites: 0, cacheReads: 0 }),
            },
        ])

        assert.equal(metrics.cacheHitRate, 0)
    })

    it("ignores malformed usage payloads", () => {
        const messages: UiMessage[] = [
            {
                ts: 1,
                type: "say",
                say: "subagent_usage",
                text: "{not-json",
            },
        ]

        const metrics = getApiMetrics(messages)
        assert.equal(metrics.totalTokensIn, 0)
        assert.equal(metrics.totalTokensOut, 0)
        assert.equal(metrics.totalCost, 0)
    })
})

describe("getLastApiReqTotalTokens", () => {
    it("uses only the latest api_req_started payload", () => {
        const messages: UiMessage[] = [
            {
                ts: 1,
                type: "say",
                say: "subagent_usage",
                text: JSON.stringify({
                    source: "subagents",
                    tokensIn: 100,
                    tokensOut: 200,
                }),
            },
            {
                ts: 2,
                type: "say",
                say: "api_req_started",
                text: JSON.stringify({
                    tokensIn: 11,
                    tokensOut: 7,
                    cacheWrites: 2,
                    cacheReads: 3,
                }),
            },
        ]

        const total = getLastApiReqTotalTokens(messages)
        assert.equal(total, 23)
    })
})
