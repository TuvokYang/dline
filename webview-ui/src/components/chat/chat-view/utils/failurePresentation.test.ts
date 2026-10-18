import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { supersededFailureIndexes } from "./failurePresentation"
import { filterVisibleMessages } from "./messageUtils"

function request(ts: number, failure?: string): UiMessage {
    return {
        ts,
        type: "say",
        say: "api_req_started",
        text: JSON.stringify(failure ? { streamingFailedMessage: failure } : { cost: 0.01 }),
    }
}

function compaction(ts: number, compactionStatus: string, error?: string): UiMessage {
    return { ts, type: "say", say: "tool", text: JSON.stringify({ tool: "summarizeTask", content: "", compactionStatus, error }) }
}

describe("supersededFailureIndexes", () => {
    it("stops drawing a failed request once a later request runs, keeping the latest failure", () => {
        const messages = [request(1, "first failure"), request(2, "second failure"), request(3)]

        expect([...supersededFailureIndexes(messages)].sort()).toEqual([0, 1])
        expect(supersededFailureIndexes([request(1, "only failure")]).size).toBe(0)
    })

    it("treats a request whose failure was recorded as a following api_req_failed ask the same way", () => {
        const failedAsk: UiMessage = { ts: 2, type: "ask", ask: "api_req_failed", text: "401 invalid key" }
        const messages = [request(1), failedAsk, request(3)]

        expect([...supersededFailureIndexes(messages)]).toEqual([0])
        // Without a later attempt the failure is still the current one.
        expect(supersededFailureIndexes([request(1), failedAsk]).size).toBe(0)
    })

    it("hides a compaction failure once the retried compaction shows any card, and leaves only the latest of repeated failures", () => {
        const retried = [compaction(1, "completed"), compaction(2, "failed", "first"), compaction(3, "waiting")]
        expect([...supersededFailureIndexes(retried)]).toEqual([1])

        const repeated = [compaction(1, "failed", "first"), compaction(2, "failed", "second")]
        expect([...supersededFailureIndexes(repeated)]).toEqual([0])
    })

    it("does not let one kind of work supersede the other's failure", () => {
        const compactionThenRequests = [compaction(1, "failed", "compaction broke"), request(2), request(3)]
        const requestThenCompaction = [request(1, "request broke"), compaction(2, "waiting"), compaction(3, "completed")]

        expect(supersededFailureIndexes(compactionThenRequests).size).toBe(0)
        expect(supersededFailureIndexes(requestThenCompaction).size).toBe(0)
    })
})

describe("filterVisibleMessages with retried failures", () => {
    it("keeps the failure record but no longer returns it for drawing after the retry", () => {
        const failure = compaction(10, "failed", "terminated")
        const messages = [failure, compaction(11, "waiting")]

        const visible = filterVisibleMessages(messages)

        expect(visible.map((message) => message.ts)).toEqual([11])
        expect(messages).toContain(failure)
    })

    it("leaves errors that are not API failures on screen", () => {
        const toolError: UiMessage = { ts: 20, type: "say", say: "error", text: "Tool failed" }
        const visible = filterVisibleMessages([toolError, request(21, "boom"), request(22, "boom again")])

        expect(visible.map((message) => message.ts)).toEqual([20, 22])
    })
})
