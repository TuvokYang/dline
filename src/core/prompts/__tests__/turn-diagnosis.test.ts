import { describe, expect, it } from "vitest"
import { buildTurnFailureFeedback, ConsecutiveTurnFailures, classifyToollessTurn, describeTurnFailure } from "../turn-diagnosis"

const TOOLS = ["read_file", "attempt_completion"]

describe("classifyToollessTurn", () => {
    it("prefers the provider stop reason over the response content", () => {
        expect(
            classifyToollessTurn(
                { visibleText: "partial", reasoningPresent: true, outputTokens: 8_192, stopReason: "output_limit" },
                TOOLS,
            ),
        ).toEqual({ kind: "output_limit", outputTokens: 8_192 })
    })

    it("recognizes tool markup that did not become a tool call", () => {
        expect(classifyToollessTurn({ visibleText: "<read_file><path>a.ts</path>", reasoningPresent: false }, TOOLS).kind).toBe(
            "tool_markup_in_text",
        )
        expect(classifyToollessTurn({ visibleText: '<invoke name="x">', reasoningPresent: false }, TOOLS).kind).toBe(
            "tool_markup_in_text",
        )
    })

    it("does not mistake ordinary markup in prose for a tool call", () => {
        expect(classifyToollessTurn({ visibleText: "Use a <div> element here.", reasoningPresent: false }, TOOLS).kind).toBe(
            "text_only",
        )
    })

    it("separates reasoning-only from empty responses", () => {
        expect(classifyToollessTurn({ visibleText: "  ", reasoningPresent: true, outputTokens: 1_200 }, TOOLS)).toEqual({
            kind: "reasoning_only",
            outputTokens: 1_200,
        })
        expect(classifyToollessTurn({ visibleText: "", reasoningPresent: false }, TOOLS)).toEqual({ kind: "empty_response" })
    })
})

describe("buildTurnFailureFeedback", () => {
    it("states the failure, the remaining budget and the next step", () => {
        const feedback = buildTurnFailureFeedback(
            { kind: "reasoning_only", outputTokens: 1_200 },
            {
                usesNativeToolCalls: true,
                availableTools: TOOLS,
                finishing: false,
                consecutiveFailures: 2,
                maxConsecutiveFailures: 5,
            },
        )

        expect(feedback).toContain(`only internal reasoning (~${(1_200).toLocaleString()} output tokens)`)
        expect(feedback).toContain("Consecutive failed responses: 2 of 5.")
        expect(feedback).toContain("Do not restart or repeat earlier analysis")
        expect(feedback).toContain("Available tools: read_file, attempt_completion.")
        expect(feedback).toContain("native tool-calling interface")
    })

    it("asks only for attempt_completion while finishing, with an XML example in XML mode", () => {
        const feedback = buildTurnFailureFeedback(
            { kind: "convergence_violation", rejectedTools: ["read_file"] },
            { usesNativeToolCalls: false, availableTools: ["attempt_completion"], finishing: true },
        )

        expect(feedback).toContain("called read_file after you were told to finish")
        expect(feedback).toContain("Call attempt_completion now")
        expect(feedback).toContain("<attempt_completion>\n<result>")
        expect(feedback).not.toContain("Consecutive failed responses")
    })

    it("explains malformed markup differently for native and XML tools", () => {
        expect(describeTurnFailure({ kind: "tool_markup_in_text" }, true)).toContain("native tool-calling interface")
        expect(describeTurnFailure({ kind: "tool_markup_in_text" }, false)).toContain("could not be parsed")
    })
})

describe("ConsecutiveTurnFailures", () => {
    it("is exhausted at the limit and cleared by reset", () => {
        const failures = new ConsecutiveTurnFailures(2)
        failures.record({ kind: "text_only" })
        expect(failures.exhausted).toBe(false)
        failures.record({ kind: "empty_response" })
        expect(failures.exhausted).toBe(true)
        expect(failures.list().map((failure) => failure.kind)).toEqual(["text_only", "empty_response"])

        failures.reset()
        expect(failures.count).toBe(0)
        expect(failures.exhausted).toBe(false)
    })
})
