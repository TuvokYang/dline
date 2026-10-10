// @vitest-environment jsdom
import { fireEvent, render, screen } from "@testing-library/react"
import React from "react"
import { describe, expect, it, vi } from "vitest"
import OpenAIServiceTierSelector from "./OpenAIServiceTierSelector"

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
    VSCodeCheckbox: ({ checked, children, onChange }: any) => (
        <label>
            <input checked={checked} onChange={onChange} type="checkbox" />
            {children}
        </label>
    ),
}))

vi.mock("@/components/ui/label", () => ({
    Label: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}))

vi.mock("@/components/ui/select", () => ({
    Select: ({
        children,
        onValueChange,
        value,
    }: {
        children: React.ReactNode
        onValueChange: (value: string) => void
        value: string
    }) => (
        <div data-testid="service-tier" data-value={value}>
            {children}
            <button onClick={() => onValueChange("priority")} type="button">
                Choose Priority
            </button>
            <button onClick={() => onValueChange("provider-default")} type="button">
                Choose Provider Default
            </button>
        </div>
    ),
    SelectContent: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    SelectItem: ({ children, title }: { children: React.ReactNode; title?: string }) => <div title={title}>{children}</div>,
    SelectTrigger: ({ children, title }: { children: React.ReactNode; title?: string }) => <div title={title}>{children}</div>,
    SelectValue: () => <span />,
}))

describe("OpenAIServiceTierSelector", () => {
    it("selects an explicit tier and can restore provider default", () => {
        const onServiceTierChange = vi.fn()
        const onServiceTierEnabledChange = vi.fn()
        const { rerender } = render(
            <OpenAIServiceTierSelector
                onServiceTierChange={onServiceTierChange}
                onServiceTierEnabledChange={onServiceTierEnabledChange}
                serviceTierEnabled={true}
            />,
        )

        expect(screen.getByTestId("service-tier")).toHaveAttribute("data-value", "provider-default")
        expect(screen.getAllByTitle("Do not send service_tier; let the provider choose.")).toHaveLength(2)
        expect(screen.getByText("Priority")).toHaveAttribute(
            "title",
            'Send service_tier: "priority", the API tier used by Codex Fast.',
        )
        fireEvent.click(screen.getByRole("button", { name: "Choose Priority" }))
        expect(onServiceTierChange).toHaveBeenLastCalledWith("priority")

        rerender(
            <OpenAIServiceTierSelector
                onServiceTierChange={onServiceTierChange}
                onServiceTierEnabledChange={onServiceTierEnabledChange}
                serviceTier="priority"
                serviceTierEnabled={true}
            />,
        )
        expect(screen.getByTestId("service-tier")).toHaveAttribute("data-value", "priority")
        expect(screen.getAllByTitle('Send service_tier: "priority", the API tier used by Codex Fast.')).toHaveLength(2)
        fireEvent.click(screen.getByRole("button", { name: "Choose Provider Default" }))
        expect(onServiceTierChange).toHaveBeenLastCalledWith(undefined)
    })

    it("shows Service Tier options only after explicit enablement", () => {
        const onServiceTierEnabledChange = vi.fn()
        const { rerender } = render(
            <OpenAIServiceTierSelector onServiceTierChange={vi.fn()} onServiceTierEnabledChange={onServiceTierEnabledChange} />,
        )

        const enableCheckbox = screen.getByRole("checkbox", { name: "Enable Service Tier" })
        expect(enableCheckbox).not.toBeChecked()
        expect(screen.queryByTestId("service-tier")).not.toBeInTheDocument()
        fireEvent.click(enableCheckbox)
        expect(onServiceTierEnabledChange).toHaveBeenCalledWith(true)

        rerender(
            <OpenAIServiceTierSelector
                onServiceTierChange={vi.fn()}
                onServiceTierEnabledChange={onServiceTierEnabledChange}
                serviceTierEnabled={true}
            />,
        )
        expect(screen.getByRole("checkbox", { name: "Enable Service Tier" })).toBeChecked()
        expect(screen.getByTestId("service-tier")).toBeInTheDocument()
    })
})
