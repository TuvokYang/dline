// @vitest-environment jsdom

import { ApiFormat } from "@shared/proto/dline/models/metadata"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ApiFormatSelector } from "./ApiFormatSelector"
import { ApiKeyField } from "./ApiKeyField"
import { BaseUrlField } from "./BaseUrlField"
import { ModelSelector } from "./ModelSelector"

describe("Profile settings fields", () => {
    it("renders API keys with one accessible label and settings description", () => {
        render(
            <ApiKeyField
                helpText="Stored locally"
                initialValue=""
                onChange={vi.fn()}
                providerName="OpenAI"
                signupUrl="https://example.com/key"
            />,
        )

        const input = screen.getByLabelText("OpenAI API Key")
        expect(input.tagName.toLowerCase()).toBe("vscode-text-field")
        expect(input).toHaveClass("min-h-7", "w-full")
        expect(screen.getAllByText("OpenAI API Key")).toHaveLength(1)
        expect(screen.getByText("Stored locally")).toHaveClass("text-xs", "text-description")
        expect(screen.getByText(/signing up here/i).closest("vscode-link")).toBeInTheDocument()
    })

    it("keeps the Base URL toggle semantics and clears the value when disabled", () => {
        const onChange = vi.fn()
        render(<BaseUrlField initialValue="https://example.com" onChange={onChange} />)

        const toggle = screen.getByRole("checkbox", { name: "Use custom base URL" })
        const input = document.querySelector("vscode-text-field")
        expect(input).toHaveClass("min-h-7", "w-full")

        fireEvent.click(toggle)
        expect(document.querySelector("vscode-text-field")).not.toBeInTheDocument()
    })

    it("renders each model selector with a unique label association and settings field shell", () => {
        render(
            <>
                <ModelSelector models={{ alpha: {} }} onChange={vi.fn() as never} selectedModelId="alpha" />
                <ModelSelector label="Fallback model" models={{ beta: {} }} onChange={vi.fn() as never} selectedModelId="beta" />
            </>,
        )

        const [primary, fallback] = screen.getAllByRole("combobox")
        expect(primary).toHaveAccessibleName("Model")
        expect(fallback).toHaveAccessibleName("Fallback model")
        expect(primary.getAttribute("id")).not.toBe(fallback.getAttribute("id"))
        expect(primary).toHaveClass("w-full")
        expect(fallback).toHaveClass("w-full")
    })

    it("uses the shared field hierarchy for API Format without changing conditional rendering", () => {
        const { rerender } = render(
            <ApiFormatSelector
                apiFormats={[ApiFormat.OPENAI_CHAT]}
                fallbackApiFormat={ApiFormat.OPENAI_CHAT}
                onChange={vi.fn()}
                selectedApiFormat={undefined}
            />,
        )
        expect(screen.queryByRole("combobox", { name: "API Format" })).not.toBeInTheDocument()

        rerender(
            <ApiFormatSelector
                apiFormats={[ApiFormat.OPENAI_CHAT, ApiFormat.OPENAI_RESPONSES]}
                fallbackApiFormat={ApiFormat.OPENAI_CHAT}
                onChange={vi.fn()}
                selectedApiFormat={undefined}
            />,
        )

        const selector = screen.getByRole("combobox", { name: "API Format" })
        expect(selector).toHaveClass("min-h-7", "w-full")
        expect(screen.getAllByText("API Format")).toHaveLength(1)
    })
})
