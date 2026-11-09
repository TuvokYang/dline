import { fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { describe, expect, it } from "vitest"
import { ChatUiText } from "./ChatUiText"

function DraftControl() {
    const [value, setValue] = useState("")
    return <input aria-label="Rich slot draft" onChange={(event) => setValue(event.currentTarget.value)} value={value} />
}

describe("ChatUiText named React slots", () => {
    it("retains control state and DOM identity when a translation reorders named slots", () => {
        const slots = { control: <DraftControl />, code: <code>TRUNCATE</code> }
        const view = render(<ChatUiText slots={slots} text="Before {control}, then {code}." />)
        const input = screen.getByRole("textbox", { name: "Rich slot draft" })
        const code = screen.getByText("TRUNCATE")
        fireEvent.change(input, { target: { value: "RAW draft 原文" } })

        view.rerender(<ChatUiText slots={slots} text="{code}，再显示 {control}。" />)
        expect(screen.getByRole("textbox", { name: "Rich slot draft" })).toBe(input)
        expect(input).toHaveValue("RAW draft 原文")
        expect(screen.getByText("TRUNCATE")).toBe(code)
        expect(code.tagName).toBe("CODE")

        view.rerender(<ChatUiText slots={slots} text="Before {control}, then {code}." />)
        expect(screen.getByRole("textbox", { name: "Rich slot draft" })).toBe(input)
        expect(input).toHaveValue("RAW draft 原文")
        expect(screen.getByText("TRUNCATE")).toBe(code)
    })

    it("keeps unknown markers and markup as literal text rather than injecting HTML", () => {
        const { container } = render(
            <ChatUiText slots={{ known: <kbd>Ctrl</kbd> }} text="{known} {unknown} <script>raw</script> {known}" />,
        )
        expect(screen.getAllByText("Ctrl")).toHaveLength(2)
        expect(container.textContent).toBe("Ctrl {unknown} <script>raw</script> Ctrl")
        expect(container.querySelector("script")).toBeNull()
    })
})
