import { describe, expect, it } from "vitest"
import { hashCompactionSummary, hashCompactionValue, stableSerializeForCompaction } from "../compaction-hash"

describe("compaction hash", () => {
    it("produces identical hashes for the same logical object regardless of key order", () => {
        const left = { sourceHistoryHash: "sha256:aaa", passStartTurnIndex: 1, messages: [{ role: "user", content: "x" }] }
        const right = { messages: [{ role: "user", content: "x" }], passStartTurnIndex: 1, sourceHistoryHash: "sha256:aaa" }

        expect(hashCompactionValue(left)).toBe(hashCompactionValue(right))
        expect(hashCompactionValue(left)).toMatch(/^sha256:[a-f0-9]{64}$/)
    })

    it("produces different hashes for different logical values", () => {
        expect(hashCompactionValue({ a: 1 })).not.toBe(hashCompactionValue({ a: 2 }))
    })

    it("serializes nested arrays and objects deterministically", () => {
        const value = { z: [1, { b: 2, a: 3 }], a: "text" }
        expect(stableSerializeForCompaction(value)).toBe('{"a":"text","z":[1,{"a":3,"b":2}]}')
    })

    it("hashes summaries as plain text without JSON wrapping", () => {
        expect(hashCompactionSummary("summary text")).toMatch(/^sha256:[a-f0-9]{64}$/)
        expect(hashCompactionSummary("summary text")).toBe(hashCompactionSummary("summary text"))
        expect(hashCompactionSummary("summary text")).not.toBe(hashCompactionSummary("summary text 2"))
    })
})
