import { describe, expect, it } from "vitest"
import { foldNativeCompactionSummary, readNativeCompactionSummary } from "../NativeCompactionSummary"

const CALL = "call_summary"
const SUMMARY = "the conversation so far"

describe("native compaction summary", () => {
    it("reads the summary a single snapshot call carried", () => {
        const state = foldNativeCompactionSummary(
            {},
            { functionId: CALL, name: "summarize_task", arguments: { context: SUMMARY }, argumentsMode: "snapshot" },
        )

        expect(readNativeCompactionSummary(state)).toBe(SUMMARY)
    })

    it("joins argument deltas before reading them, because no single chunk is valid JSON", () => {
        let state = foldNativeCompactionSummary({}, { functionId: CALL, name: "summarize_task", arguments: '{"context":"the ' })
        expect(readNativeCompactionSummary(state)).toBeUndefined()
        state = foldNativeCompactionSummary(state, { functionId: CALL, arguments: 'conversation so far"}' })

        expect(readNativeCompactionSummary(state)).toBe(SUMMARY)
    })

    it("ignores a tool that is not summarize_task", () => {
        const state = foldNativeCompactionSummary(
            {},
            { functionId: "call_other", name: "read_file", arguments: { context: SUMMARY }, argumentsMode: "snapshot" },
        )

        expect(readNativeCompactionSummary(state)).toBeUndefined()
    })

    it("reports no summary when the call carried an empty context", () => {
        // An empty summary would compact the conversation into nothing, so the
        // caller must fall back to the text channel instead of accepting it.
        const state = foldNativeCompactionSummary(
            {},
            { functionId: CALL, name: "summarize_task", arguments: { context: "   " }, argumentsMode: "snapshot" },
        )

        expect(readNativeCompactionSummary(state)).toBeUndefined()
    })

    it("reports no summary for a call that never completed its arguments", () => {
        const state = foldNativeCompactionSummary({}, { functionId: CALL, name: "summarize_task", arguments: '{"context":"the ' })

        expect(readNativeCompactionSummary(state)).toBeUndefined()
    })
})
