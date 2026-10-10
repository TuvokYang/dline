// @vitest-environment jsdom

import type { ModelInfo } from "@shared/api"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ModelAutocomplete } from "./ModelAutocomplete"

const models: Record<string, ModelInfo> = {
    "catalog-model": { id: "catalog-model" },
    "listing-only-model": { id: "listing-only-model" },
}

const optionOrigins = {
    "catalog-model": "catalog",
    "listing-only-model": "remote",
} as const

/**
 * jsdom does not upgrade the toolkit element, so the host has no value setter
 * and `fireEvent.input` cannot assign through it. Setting the property and
 * dispatching `input` matches how the real field reports typing.
 */
function typeQuery(combobox: HTMLElement, value: string): void {
    ;(combobox as unknown as { value: string }).value = value
    fireEvent(combobox, new Event("input", { bubbles: true }))
}

describe("ModelAutocomplete", () => {
    it("uses the shared settings field hierarchy and a full-width 28px control", () => {
        render(<ModelAutocomplete label="Model ID" models={{}} onChange={vi.fn()} selectedModelId="custom-model" />)

        const label = screen.getByText("Model ID").closest("label")
        const input = document.getElementById(label?.getAttribute("for") ?? "")
        expect(input).toHaveClass("min-h-7", "w-full")
        expect(screen.getAllByText("Model ID")).toHaveLength(1)
        expect(input?.closest(".profile-field")).toBeInTheDocument()
    })

    it("lists every candidate when opened instead of filtering by the current selection", () => {
        render(
            <ModelAutocomplete
                models={models}
                onChange={vi.fn()}
                optionOrigins={optionOrigins}
                selectedModelId="catalog-model"
            />,
        )

        fireEvent.focus(screen.getByRole("combobox"))

        expect(screen.getByRole("option", { name: /catalog-model/ })).toBeInTheDocument()
        expect(screen.getByRole("option", { name: /listing-only-model/ })).toBeInTheDocument()
    })

    it("badges models the local catalog does not carry", () => {
        render(
            <ModelAutocomplete
                models={models}
                onChange={vi.fn()}
                optionOrigins={optionOrigins}
                selectedModelId="catalog-model"
            />,
        )

        fireEvent.focus(screen.getByRole("combobox"))

        expect(screen.getByRole("option", { name: /listing-only-model/ })).toHaveTextContent("New")
        expect(screen.getByRole("option", { name: /^catalog-model/ })).not.toHaveTextContent("New")
    })

    it("commits a clicked suggestion and shows it once the profile round-trips", () => {
        const onChange = vi.fn()
        const { rerender } = render(
            <ModelAutocomplete
                models={models}
                onChange={onChange}
                optionOrigins={optionOrigins}
                selectedModelId="catalog-model"
            />,
        )

        fireEvent.focus(screen.getByRole("combobox"))
        fireEvent.click(screen.getByRole("option", { name: /listing-only-model/ }))

        expect(onChange).toHaveBeenCalledWith("listing-only-model", models["listing-only-model"])
        rerender(
            <ModelAutocomplete
                models={models}
                onChange={onChange}
                optionOrigins={optionOrigins}
                selectedModelId="listing-only-model"
            />,
        )
        expect(screen.getByRole("combobox")).toHaveValue("listing-only-model")
    })

    it("offers an unlisted query as an explicit custom row", () => {
        const onChange = vi.fn()
        render(
            <ModelAutocomplete
                models={models}
                onChange={onChange}
                optionOrigins={optionOrigins}
                selectedModelId="catalog-model"
            />,
        )

        const input = screen.getByRole("combobox")
        fireEvent.focus(input)
        typeQuery(input, "hand-typed-model")
        const customOption = screen.getByRole("option", { name: /hand-typed-model/ })
        expect(customOption).toHaveTextContent("Custom")

        fireEvent.click(customOption)
        expect(onChange).toHaveBeenCalledWith("hand-typed-model", undefined)
    })

    it("does not offer a custom row when free-form ids are rejected", () => {
        render(
            <ModelAutocomplete
                allowCustomModelId={false}
                models={models}
                onChange={vi.fn()}
                optionOrigins={optionOrigins}
                selectedModelId="catalog-model"
            />,
        )

        const input = screen.getByRole("combobox")
        fireEvent.focus(input)
        typeQuery(input, "hand-typed-model")

        expect(screen.queryByRole("option", { name: /hand-typed-model/ })).not.toBeInTheDocument()
    })

    it("restores the committed selection when the picker closes without a choice", () => {
        const onChange = vi.fn()
        render(
            <ModelAutocomplete
                models={models}
                onChange={onChange}
                optionOrigins={optionOrigins}
                selectedModelId="catalog-model"
            />,
        )

        const input = screen.getByRole("combobox")
        fireEvent.focus(input)
        typeQuery(input, "partial-quer")
        fireEvent.keyDown(input, { key: "Escape" })

        expect(onChange).not.toHaveBeenCalled()
        expect(input).toHaveValue("catalog-model")
    })

    it("toggles the listbox from the chevron without a clear button", () => {
        render(
            <ModelAutocomplete
                models={models}
                onChange={vi.fn()}
                optionOrigins={optionOrigins}
                selectedModelId="catalog-model"
            />,
        )

        expect(screen.queryByLabelText("Clear search")).not.toBeInTheDocument()
        const toggle = screen.getByRole("button", { name: "Open Model options" })
        fireEvent.mouseDown(toggle)

        expect(screen.getByRole("listbox", { name: "Model suggestions" })).toBeInTheDocument()
        fireEvent.mouseDown(screen.getByRole("button", { name: "Close Model options" }))
        expect(screen.queryByRole("listbox")).not.toBeInTheDocument()
    })
})
