import { describe, expect, it } from "vitest"
import { hashStableJson, stableJsonStringify } from "./stable-json"

describe("stable JSON fingerprinting", () => {
    it("normalizes object key order recursively", () => {
        const left = { type: "object", properties: { query: { type: "string" }, limit: { type: "number" } } }
        const right = { properties: { limit: { type: "number" }, query: { type: "string" } }, type: "object" }

        expect(stableJsonStringify(left)).toBe(stableJsonStringify(right))
        expect(hashStableJson(left)).toBe(hashStableJson(right))
    })

    it("preserves array order because JSON schema array order can be meaningful", () => {
        expect(hashStableJson({ required: ["query", "limit"] })).not.toBe(hashStableJson({ required: ["limit", "query"] }))
    })

    it("matches JSON semantics for unsupported values", () => {
        expect(stableJsonStringify({ kept: true, omitted: undefined, values: [1, undefined, Number.NaN] })).toBe(
            '{"kept":true,"values":[1,null,null]}',
        )
    })
})
