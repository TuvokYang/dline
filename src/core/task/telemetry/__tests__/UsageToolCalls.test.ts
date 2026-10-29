import { countToolCallOutcomes, namesTool, toolCallOutcome, type UsageToolCall } from "../UsageToolCalls"

describe("usage tool call classification", () => {
    it("reports the awaited turn-ending call as completed even before its phase settles", () => {
        expect(toolCallOutcome("executing", true)).toBe("completed")
        expect(toolCallOutcome("executing", false)).toBe("cancelled")
    })

    it("reports a settled result as completed and a refusal as failed", () => {
        expect(toolCallOutcome("completed", false)).toBe("completed")
        expect(toolCallOutcome("failed", false)).toBe("failed")
        // A rejected call never ran, but it settled without a result.
        expect(toolCallOutcome("rejected", false)).toBe("failed")
    })

    it("reports anything else as cancelled rather than dropping it", () => {
        for (const phase of ["pending", "awaiting_approval", "ready", "skipped", "cancelled"] as const) {
            expect(toolCallOutcome(phase, false)).toBe("cancelled")
        }
    })

    it("treats an absent or empty name as unnamed so the caller counts it unlisted", () => {
        expect(namesTool({ outcome: "completed" })).toBe(false)
        expect(namesTool({ outcome: "completed", toolName: "" })).toBe(false)
        expect(namesTool({ outcome: "completed", toolName: "read_file" })).toBe(true)
    })

    it("sums every call into exactly one outcome total", () => {
        const calls: UsageToolCall[] = [
            { outcome: "completed", toolName: "read_file" },
            { outcome: "completed" },
            { outcome: "failed", toolName: "execute_command" },
            { outcome: "cancelled" },
        ]
        const totals = countToolCallOutcomes(calls)
        expect(totals).toEqual({ completed: 2, failed: 1, cancelled: 1 })
        expect(totals.completed + totals.failed + totals.cancelled).toBe(calls.length)
    })
})
