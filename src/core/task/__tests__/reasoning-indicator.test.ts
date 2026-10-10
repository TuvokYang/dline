import { describe, expect, it } from "vitest"
import { ReasoningIndicator, type ReasoningIndicatorSignals } from "../reasoning-indicator"

const signals = (overrides: Partial<ReasoningIndicatorSignals> = {}): ReasoningIndicatorSignals => ({
    hasPlainReasoning: false,
    hasEncryptedReasoning: false,
    assistantTextStarted: false,
    hasPendingNativeToolUse: false,
    ...overrides,
})

describe("ReasoningIndicator", () => {
    it("opens a placeholder for the first encrypted reasoning chunk", () => {
        const indicator = new ReasoningIndicator()

        expect(indicator.decide(signals({ hasEncryptedReasoning: true }))).toBe("open_placeholder")
        expect(indicator.isPlaceholderOnly).toBe(true)
    })

    it("opens the placeholder only once across many encrypted snapshots", () => {
        const indicator = new ReasoningIndicator()
        const actions: string[] = []

        // Responses API emits one `added` snapshot per payload growth step.
        for (let i = 0; i < 20; i++) {
            actions.push(indicator.decide(signals({ hasEncryptedReasoning: true })))
        }

        expect(actions.filter((action) => action === "open_placeholder")).toHaveLength(1)
        expect(actions.slice(1).every((action) => action === "none")).toBe(true)
    })

    it("publishes plain reasoning text", () => {
        const indicator = new ReasoningIndicator()

        expect(indicator.decide(signals({ hasPlainReasoning: true }))).toBe("publish_text")
        expect(indicator.isPlaceholderOnly).toBe(false)
    })

    it("promotes an open placeholder when plain reasoning arrives later", () => {
        const indicator = new ReasoningIndicator()

        expect(indicator.decide(signals({ hasEncryptedReasoning: true }))).toBe("open_placeholder")
        expect(indicator.decide(signals({ hasPlainReasoning: true }))).toBe("publish_text")

        // The row now carries text, so it must never be withdrawn.
        expect(indicator.isPlaceholderOnly).toBe(false)
    })

    it("does not reopen a placeholder after text was published", () => {
        const indicator = new ReasoningIndicator()

        indicator.decide(signals({ hasPlainReasoning: true }))

        expect(indicator.decide(signals({ hasEncryptedReasoning: true }))).toBe("none")
        expect(indicator.isPlaceholderOnly).toBe(false)
    })

    it("stays silent once assistant text has started", () => {
        const indicator = new ReasoningIndicator()

        expect(indicator.decide(signals({ hasEncryptedReasoning: true, assistantTextStarted: true }))).toBe("none")
        expect(indicator.decide(signals({ hasPlainReasoning: true, assistantTextStarted: true }))).toBe("none")
        expect(indicator.isPlaceholderOnly).toBe(false)
    })

    it("stays silent while a native tool call is streaming", () => {
        const indicator = new ReasoningIndicator()

        expect(indicator.decide(signals({ hasEncryptedReasoning: true, hasPendingNativeToolUse: true }))).toBe("none")
        expect(indicator.isPlaceholderOnly).toBe(false)
    })

    it("reports nothing to withdraw for chunks without reasoning", () => {
        const indicator = new ReasoningIndicator()

        expect(indicator.decide(signals())).toBe("none")
        expect(indicator.isPlaceholderOnly).toBe(false)
    })

    it("clears the pending placeholder after it is closed", () => {
        const indicator = new ReasoningIndicator()
        indicator.decide(signals({ hasEncryptedReasoning: true }))

        indicator.onClosed()

        // Withdrawal is idempotent: a second boundary must not remove another row.
        expect(indicator.isPlaceholderOnly).toBe(false)
    })
})
