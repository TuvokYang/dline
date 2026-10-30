import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { attemptElapsedMs, formatElapsedDuration } from "./attemptElapsed"

const SECOND = 1_000
const MINUTE = 60 * SECOND
const HOUR = 60 * MINUTE

function userInput(ts: number, text = "prompt"): UiMessage {
    return { type: "say", say: "user_feedback", text, ts }
}

function taskPrompt(ts: number, text = "first prompt"): UiMessage {
    return { type: "say", say: "task", text, ts }
}

function completion(ts: number): UiMessage {
    return { type: "ask", ask: "completion_result", text: "Completed", ts }
}

function thinking(ts: number): UiMessage {
    return { type: "say", say: "reasoning", text: "thinking", ts }
}

describe("attemptElapsedMs", () => {
    it("measures from the most recent user input that precedes the attempt", () => {
        const messages = [taskPrompt(1_000), thinking(2_000), completion(1_000 + 95 * SECOND)]

        expect(attemptElapsedMs(messages, 1_000 + 95 * SECOND)).toBe(95 * SECOND)
    })

    it("re-bases on the newest user input when an earlier attempt already completed", () => {
        const firstCompletion = completion(10 * SECOND)
        const messages = [
            taskPrompt(1 * SECOND),
            firstCompletion,
            userInput(5 * MINUTE),
            thinking(5 * MINUTE + SECOND),
            completion(5 * MINUTE + 40 * SECOND),
        ]

        // The second attempt is measured from the follow-up input, not from the
        // original prompt, so a long finished attempt cannot inflate it.
        expect(attemptElapsedMs(messages, 5 * MINUTE + 40 * SECOND)).toBe(40 * SECOND)
        // The first attempt keeps its own anchor.
        expect(attemptElapsedMs(messages, 10 * SECOND)).toBe(9 * SECOND)
    })

    it("treats the opening task prompt as a user input", () => {
        const messages = [taskPrompt(1_000), completion(1_000 + 7 * SECOND)]

        expect(attemptElapsedMs(messages, 1_000 + 7 * SECOND)).toBe(7 * SECOND)
    })

    it("ignores messages at or after the attempt being measured", () => {
        const messages = [taskPrompt(1_000), completion(20 * SECOND), userInput(30 * SECOND), completion(40 * SECOND)]

        expect(attemptElapsedMs(messages, 20 * SECOND)).toBe(19 * SECOND)
    })

    it("reports no measurement when the attempt has no user input before it", () => {
        const messages = [thinking(1_000), completion(5 * SECOND)]

        expect(attemptElapsedMs(messages, 5 * SECOND)).toBeUndefined()
    })

    it("reports no measurement for a pre-threshold interval", () => {
        const messages = [taskPrompt(5 * SECOND), completion(5 * SECOND)]

        expect(attemptElapsedMs(messages, 5 * SECOND)).toBeUndefined()
    })
})

describe("formatElapsedDuration", () => {
    it.each([
        [0, "0s"],
        [7 * SECOND, "7s"],
        [59 * SECOND, "59s"],
        [MINUTE, "1m"],
        [3 * MINUTE + 20 * SECOND, "3m 20s"],
        [HOUR, "1h"],
        [HOUR + 5 * MINUTE, "1h 5m"],
        [2 * HOUR + 30 * MINUTE + 59 * SECOND, "2h 30m"],
    ])("formats %ims as %s", (elapsedMs, expected) => {
        expect(formatElapsedDuration(elapsedMs)).toBe(expected)
    })

    it("never renders a negative duration", () => {
        expect(formatElapsedDuration(-5 * SECOND)).toBe("0s")
    })
})
