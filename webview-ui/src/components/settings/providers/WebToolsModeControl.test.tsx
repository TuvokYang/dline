// @vitest-environment jsdom
import { WebToolsMode } from "@shared/proto/dline/provider/common"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { WebToolsModeControl } from "./WebToolsModeControl"

describe("WebToolsModeControl", () => {
    it("defaults legacy profiles to Auto and exposes all four routing modes", () => {
        render(<WebToolsModeControl onChange={vi.fn()} />)

        const control = screen.getByRole("combobox", { name: "Web Tools mode" })
        expect(control).toHaveValue(String(WebToolsMode.WEB_TOOLS_MODE_AUTO))
        expect(control).toHaveClass("min-h-7", "w-full", "text-sm")
        expect(screen.getByText("Web Tools")).toHaveClass("text-sm", "font-medium")
        expect(screen.getAllByRole("option").map((option) => option.textContent)).toEqual([
            "Auto",
            "Local only",
            "Off",
            "Hosted only",
        ])
    })

    it.each([
        ["Auto", WebToolsMode.WEB_TOOLS_MODE_AUTO],
        ["Local only", WebToolsMode.WEB_TOOLS_MODE_FORCE_LOCAL],
        ["Off", WebToolsMode.WEB_TOOLS_MODE_FORCE_OFF],
        ["Hosted only", WebToolsMode.WEB_TOOLS_MODE_FORCE_REMOTE],
    ])("reports %s immediately", (_label, mode) => {
        const onChange = vi.fn()
        render(<WebToolsModeControl onChange={onChange} value={WebToolsMode.WEB_TOOLS_MODE_AUTO} />)

        fireEvent.change(screen.getByRole("combobox", { name: "Web Tools mode" }), {
            target: { value: String(mode) },
        })

        expect(onChange).toHaveBeenCalledWith(mode)
    })
})
