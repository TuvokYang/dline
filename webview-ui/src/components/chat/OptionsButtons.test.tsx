import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { OptionsButtons } from "./OptionsButtons"

describe("OptionsButtons", () => {
    it("delegates an active option to the causal interaction callback", async () => {
        const onSelect = vi.fn(async () => undefined)
        render(<OptionsButtons isActive onSelect={onSelect} options={["First", "Second"]} />)

        fireEvent.click(screen.getByRole("button", { name: "Second" }))

        await waitFor(() => expect(onSelect).toHaveBeenCalledWith("Second"))
    })

    it("renders the persisted selected option as pressed and disables further selection", () => {
        render(<OptionsButtons isActive onSelect={vi.fn()} options={["First", "Second"]} selected="Second" />)

        expect(screen.getByRole("button", { name: "Second" })).toHaveAttribute("aria-pressed", "true")
        expect(screen.getByRole("button", { name: "First" })).toBeDisabled()
        expect(screen.getByRole("button", { name: "Second" })).toBeDisabled()
    })
})
