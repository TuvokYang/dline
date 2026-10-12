import type { UiMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { StickyUserMessage } from "./StickyUserMessage"

const USER_MESSAGE: UiMessage = {
    ts: 1,
    type: "say",
    say: "text",
    text: "Keep this message reachable",
}

describe("StickyUserMessage", () => {
    it("owns pointer events only on the visible clickable card", () => {
        const onScrollToMessage = vi.fn()
        render(<StickyUserMessage isVisible lastUserMessage={USER_MESSAGE} onScrollToMessage={onScrollToMessage} />)

        const message = screen.getByRole("button", { name: /Scroll to your message/ })
        expect(message).toHaveClass("pointer-events-auto")

        fireEvent.click(message)
        expect(onScrollToMessage).toHaveBeenCalledOnce()
    })

    it("highlights only the commands the submission recorded as run", () => {
        const message: UiMessage = {
            ...USER_MESSAGE,
            text: "/compact then /explain-changes",
            submittedInputs: [
                {
                    segments: [
                        { text: "/compact", role: "command", active: true },
                        { text: " then ", role: "text", active: false },
                        { text: "/explain-changes", role: "command", active: false },
                    ],
                },
            ],
        }
        const { container } = render(<StickyUserMessage isVisible lastUserMessage={message} onScrollToMessage={vi.fn()} />)

        const highlighted = [...container.querySelectorAll(".mention-context-highlight")].map((node) => node.textContent)
        expect(highlighted).toEqual(["/compact"])
        expect(container.textContent).toContain("/compact then /explain-changes")
    })

    it("shows a legacy row as typed instead of reading it against today's catalog", () => {
        const message: UiMessage = { ...USER_MESSAGE, text: "/compact @/src/index.ts" }
        const { container } = render(<StickyUserMessage isVisible lastUserMessage={message} onScrollToMessage={vi.fn()} />)

        expect(container.querySelectorAll(".mention-context-highlight")).toHaveLength(0)
        expect(container.textContent).toContain("/compact @/src/index.ts")
    })
})
