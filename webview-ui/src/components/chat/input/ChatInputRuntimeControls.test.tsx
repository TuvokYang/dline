import { render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ChatInputRuntimeControls } from "./ChatInputRuntimeControls"

vi.mock("./TaskRuntimeControls", () => ({
    TaskRuntimeControls: () => (
        <>
            <div data-chat-input-slot="thinking">Thinking control</div>
            <div data-chat-input-slot="service-tier">Service Tier control</div>
        </>
    ),
}))

describe("ChatInputRuntimeControls", () => {
    it("keeps the existing Profile entry before Task Thinking and Service Tier", () => {
        const { container } = render(
            <ChatInputRuntimeControls profileControl={<button type="button">Existing Profile selector</button>} />,
        )

        const slots = Array.from(container.querySelectorAll<HTMLElement>("[data-chat-input-slot]")).map(
            (element) => element.dataset.chatInputSlot,
        )
        expect(slots).toEqual(["profile", "thinking", "service-tier"])
        expect(screen.getAllByRole("button", { name: "Existing Profile selector" })).toHaveLength(1)
    })

    it("uses one consistent gap for Profile, Thinking, and Service Tier", () => {
        const { container } = render(
            <ChatInputRuntimeControls profileControl={<button type="button">Existing Profile selector</button>} />,
        )

        const controls = container.querySelector<HTMLElement>("[data-chat-input-runtime-controls]")
        expect(controls).toHaveClass(
            "flex",
            "h-[18.5px]",
            "min-w-0",
            "flex-[0_1_auto]",
            "items-center",
            "gap-[4px]",
            "overflow-hidden",
        )
        expect(controls?.children).toHaveLength(3)
    })

    it("lets Profile use available space and shrink before Task-local controls", () => {
        const { container } = render(
            <ChatInputRuntimeControls profileControl={<button type="button">Existing Profile selector</button>} />,
        )

        const profileSlot = container.querySelector<HTMLElement>('[data-chat-input-slot="profile"]')
        expect(profileSlot).toHaveClass("min-w-0", "max-w-full", "flex-[0_1_auto]", "overflow-hidden")
        expect(profileSlot).not.toHaveClass("flex-1", "max-w-[12ch]", "min-w-[10ch]", "max-w-[24ch]", "flex-[1_0_12ch]")
    })
})
