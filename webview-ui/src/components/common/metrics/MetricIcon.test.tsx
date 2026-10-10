import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { MetricIcon } from "./MetricIcon"

const KINDS = ["tpm", "rpm", "tokens", "bar", "line", "history"] as const

describe("MetricIcon", () => {
    it.each(KINDS)("renders the %s icon as a decorative SVG by default", (kind) => {
        const { container } = render(<MetricIcon kind={kind} />)
        const icon = container.querySelector("svg")

        expect(icon).toBeInTheDocument()
        expect(icon).toHaveAttribute("aria-hidden", "true")
        expect(icon).toHaveAttribute("focusable", "false")
        expect(icon).not.toHaveAttribute("role")
    })

    it("renders an accessible label when the icon is not decorative", () => {
        render(<MetricIcon decorative={false} kind="tokens" />)

        expect(screen.getByRole("img", { name: "Token consumption" })).toBeInTheDocument()
    })

    it("allows callers to override the accessible label and size", () => {
        const { container } = render(<MetricIcon ariaLabel="Selected metric" decorative={false} kind="tpm" size={18} />)
        const icon = container.querySelector("svg")

        expect(icon).toHaveAttribute("aria-label", "Selected metric")
        expect(icon).toHaveAttribute("width", "18")
        expect(icon).toHaveAttribute("height", "18")
    })
})
