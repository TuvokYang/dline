import { describe, expect, it } from "vitest"
import { createCanonicalAskRow } from "../ask-row"

describe("createCanonicalAskRow", () => {
    it("starts a command ask pending so the chat never reads it as a finished command", () => {
        expect(createCanonicalAskRow("command", "npm test", 7, "approval:t1")).toEqual({
            ts: 7,
            type: "ask",
            say: undefined,
            ask: "command",
            text: "npm test",
            partial: false,
            interactionId: "approval:t1",
            commandStatus: "pending",
            exitCode: undefined,
        })
    })

    it("leaves every other ask without a command status", () => {
        const row = createCanonicalAskRow("followup", "Which one?", 8)
        expect(row).toMatchObject({ ts: 8, type: "ask", ask: "followup", partial: false })
        expect(row).not.toHaveProperty("commandStatus")
        expect(row).not.toHaveProperty("interactionId")
    })
})
