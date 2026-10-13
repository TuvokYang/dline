import { act, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { composerShortcutLabels } from "@/utils/chat-input-shortcut"
import { ComposerActionButton } from "../ComposerActionButton"
import { type ComposerActionState, resolveComposerAction } from "../composer-action"
import { outputSpeedTier, tokensPerSecondFromPerMinute } from "../output-speed"

const shortcuts = composerShortcutLabels("enter")
const idle: ComposerActionState = { canSend: true, canQueue: true, canCancel: false, hasContent: true }
const paused: ComposerActionState = { canSend: true, submitKind: "resume", canQueue: false, canCancel: false, hasContent: false }
const busyWithDraft: ComposerActionState = { canSend: false, canQueue: true, canCancel: true, hasContent: true }
const busyEmpty: ComposerActionState = { canSend: false, canQueue: true, canCancel: true, hasContent: false }

describe("resolveComposerAction", () => {
    it.each<[string, ComposerActionState, string]>([
        ["sends when the task takes input", idle, "send"],
        ["resumes a paused task, even with an empty draft", paused, "resume"],
        ["queues a draft while the task is busy", busyWithDraft, "queue"],
        ["offers cancel when a busy task has nothing to queue", busyEmpty, "cancel"],
        ["cancels when the queue cannot deliver", { ...busyWithDraft, canQueue: false }, "cancel"],
        ["is unavailable when nothing can take a click", { ...busyWithDraft, canQueue: false, canCancel: false }, "unavailable"],
    ])("%s", (_, state, expected) => {
        expect(resolveComposerAction(state)).toBe(expected)
    })
})

describe("output speed", () => {
    it.each<[number, string]>([
        [0, "slow"],
        [49.9, "slow"],
        [50, "moderate"],
        [99.9, "moderate"],
        [100, "fast"],
        [199.9, "fast"],
        [200, "very_fast"],
        [Number.NaN, "slow"],
    ])("puts %s tokens/s in the %s tier", (rate, tier) => {
        expect(outputSpeedTier(rate)).toBe(tier)
    })

    it("reads the per-second rate off a TPM figure", () => {
        expect(tokensPerSecondFromPerMinute(4_500)).toBe(75)
        expect(tokensPerSecondFromPerMinute(undefined)).toBeUndefined()
        expect(tokensPerSecondFromPerMinute(-60)).toBe(0)
    })
})

describe("ComposerActionButton", () => {
    beforeEach(() => {
        vi.useFakeTimers()
    })
    afterEach(() => {
        vi.useRealTimers()
    })

    function button() {
        return screen.getByTestId("send-button")
    }

    it("is an enabled pointer target while it queues, so a busy task never looks blocked", () => {
        const onSend = vi.fn()
        render(
            <ComposerActionButton onCancel={vi.fn(async () => {})} onSend={onSend} shortcuts={shortcuts} state={busyWithDraft} />,
        )

        expect(button()).toHaveAttribute("data-action", "queue")
        expect(button()).toHaveAttribute("aria-disabled", "false")
        expect(button()).toHaveAccessibleName("Queue message")
        fireEvent.click(button())
        expect(onSend).toHaveBeenCalledOnce()
    })

    it("turns into cancel after resting on it, and back once the pointer leaves", async () => {
        const onSend = vi.fn()
        const onCancel = vi.fn(async () => {})
        render(<ComposerActionButton onCancel={onCancel} onSend={onSend} shortcuts={shortcuts} state={busyWithDraft} />)

        fireEvent.pointerEnter(button())
        act(() => vi.advanceTimersByTime(2999))
        expect(button()).toHaveAttribute("data-action", "queue")
        act(() => vi.advanceTimersByTime(1))
        expect(button()).toHaveAttribute("data-action", "cancel")

        await act(async () => fireEvent.click(button()))
        expect(onCancel).toHaveBeenCalledOnce()
        expect(onSend).not.toHaveBeenCalled()

        fireEvent.pointerLeave(button())
        expect(button()).toHaveAttribute("data-action", "queue")
    })

    it("never reveals cancel when the task offers none", () => {
        render(<ComposerActionButton onSend={vi.fn()} shortcuts={shortcuts} state={{ ...busyWithDraft, canCancel: false }} />)

        fireEvent.pointerEnter(button())
        act(() => vi.advanceTimersByTime(10_000))
        expect(button()).toHaveAttribute("data-action", "queue")
    })

    it("cancels directly when a busy task has no draft, and ignores clicks while the cancel is in flight", async () => {
        let settle: () => void = () => {}
        const onCancel = vi.fn(() => new Promise<void>((resolve) => (settle = resolve)))
        render(<ComposerActionButton onCancel={onCancel} onSend={vi.fn()} shortcuts={shortcuts} state={busyEmpty} />)

        expect(button()).toHaveAttribute("data-action", "cancel")
        fireEvent.click(button())
        fireEvent.click(button())
        expect(onCancel).toHaveBeenCalledOnce()
        expect(button()).toHaveAttribute("aria-disabled", "true")

        await act(async () => settle())
        expect(button()).toHaveAttribute("aria-disabled", "false")
    })

    it("resumes a paused task from the same button, with the resume glyph and label", () => {
        const onSend = vi.fn()
        render(<ComposerActionButton onSend={onSend} shortcuts={shortcuts} state={paused} />)

        expect(button()).toHaveAttribute("data-action", "resume")
        expect(button()).toHaveAccessibleName("Resume task")
        expect(button()).toHaveAttribute("aria-disabled", "false")
        expect(button()).not.toHaveClass("composer-action--empty")
        fireEvent.click(button())
        expect(onSend).toHaveBeenCalledOnce()
    })

    it("keeps naming resume while a paused task cannot be resumed yet", () => {
        render(<ComposerActionButton onSend={vi.fn()} shortcuts={shortcuts} state={{ ...paused, canSend: false }} />)

        expect(button()).toHaveAttribute("data-action", "unavailable")
        expect(button()).toHaveAccessibleName("Resume task")
        expect(button()).toHaveAttribute("aria-disabled", "true")
    })

    it("lists the steer shortcut next to the configured send key", () => {
        render(
            <ComposerActionButton
                onCancel={vi.fn(async () => {})}
                onSend={vi.fn()}
                shortcuts={composerShortcutLabels("ctrlEnter")}
                state={busyWithDraft}
            />,
        )

        expect(button().title).toContain("Queue message (Ctrl + Enter)")
        expect(button().title).toContain("Queue as steering (Ctrl + Alt + S)")
        expect(button().title).not.toContain("plain text")
    })

    // With nothing running to steer the shortcut just sends, so the tooltip does not offer it.
    it("does not offer steering when nothing can be queued", () => {
        render(<ComposerActionButton onSend={vi.fn()} shortcuts={shortcuts} state={{ ...idle, canQueue: false }} />)

        expect(button().title).toBe("Send message (Enter)")
    })

    it("tints by output speed only while a rate is given", () => {
        const { rerender } = render(<ComposerActionButton onSend={vi.fn()} shortcuts={shortcuts} state={busyEmpty} />)
        expect(button()).not.toHaveAttribute("data-output-speed")

        rerender(<ComposerActionButton onSend={vi.fn()} outputTokensPerSecond={150} shortcuts={shortcuts} state={busyEmpty} />)
        expect(button()).toHaveAttribute("data-output-speed", "fast")
        expect(button().title).toContain("Model output: 150 tps")
    })

    it("still reports an unavailable send so the composer can explain the refusal", () => {
        const onSend = vi.fn()
        render(
            <ComposerActionButton
                onSend={onSend}
                shortcuts={shortcuts}
                state={{ canSend: false, canQueue: false, canCancel: false, hasContent: true }}
            />,
        )

        expect(button()).toHaveAttribute("aria-disabled", "true")
        fireEvent.click(button())
        expect(onSend).toHaveBeenCalledOnce()
    })
})
