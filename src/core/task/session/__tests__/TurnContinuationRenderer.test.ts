import { formatResponse } from "@core/prompts/responses"
import type { ClineStorageMessage } from "@shared/messages/content"
import { describe, expect, it } from "vitest"
import type { PreviousResponseObservation } from "../../executors/compose/ProductionComposeAdapter"
import { TurnContinuationRenderer } from "../TurnContinuationRenderer"

function render(previousResponse: PreviousResponseObservation, usesNativeToolCalls = true) {
    return new TurnContinuationRenderer({ usesNativeToolCalls: () => usesNativeToolCalls }).render({
        reason: "no_tools_used",
        previousResponse,
        toollessStreak: 2,
        toollessLimit: 3,
    })
}

function journaled(message: Omit<ClineStorageMessage, "role">): PreviousResponseObservation {
    return { kind: "journaled", message: { role: "assistant", ...message } as ClineStorageMessage }
}

describe("TurnContinuationRenderer", () => {
    it("keeps the plain reminder when the previous response cannot be observed", () => {
        expect(render({ kind: "unobserved" })).toBe(formatResponse.noToolsUsed(true))
    })

    it("names a reasoning-only response, its output tokens and the remaining budget before the reminder", () => {
        const text = render(
            journaled({
                content: [{ type: "thinking", thinking: "planning the next step", signature: "sig" }],
                metrics: { tokens: { prompt: 1_000, completion: 812, cached: 0 } },
            }),
        )

        expect(text).toMatch(/^\[ERROR\] The previous response contained only internal reasoning \(~812 output tokens\)/)
        expect(text).toContain("Consecutive failed responses: 2 of 3. At 3 the task pauses and asks the user for guidance.")
        expect(text).toContain("Do not restart or repeat earlier analysis")
        expect(text?.endsWith(formatResponse.noToolsUsed(true))).toBe(true)
    })

    it("reports a response that left nothing in the conversation as empty", () => {
        expect(render({ kind: "not_journaled" })).toMatch(/^\[ERROR\] The previous response was empty/)
    })

    it("distinguishes unparsed tool markup from plain text in XML mode", () => {
        const markup = render(
            journaled({ content: [{ type: "text", text: "<read_file>\n<path>src/a.ts</path>\n</readfile>" }] }),
            false,
        )
        const prose = render(journaled({ content: "I will now read the file." }), false)

        expect(markup).toMatch(/could not be parsed into a valid tool call/)
        expect(prose).toMatch(/contained text but no tool call/)
        expect(prose?.endsWith(formatResponse.noToolsUsed(false))).toBe(true)
    })
})
