import { render, screen } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import ChecklistRenderer from "./ChecklistRenderer"

function buildChecklist(itemCount: number): string {
    return [`# Plan`, ...Array.from({ length: itemCount }, (_, index) => `- [ ] Item ${index + 1}`)].join("\n")
}

describe("ChecklistRenderer", () => {
    it("keeps long checklists scrollable", () => {
        render(<ChecklistRenderer text={buildChecklist(12)} />)

        const firstItem = screen.getByText("Item 1")
        const container = firstItem.closest(".scrollable")

        expect(container).not.toBeNull()
        expect(container).toHaveClass("max-h-52", "overflow-y-auto")
    })

    it("centers each checklist icon with its text", () => {
        render(<ChecklistRenderer text={buildChecklist(1)} />)

        const text = screen.getByText("Item 1")
        const row = text.closest(".items-center")
        const iconWrapper = row?.querySelector("span")

        expect(row).toHaveClass("items-center")
        expect(row).not.toHaveClass("items-start")
        expect(iconWrapper).not.toHaveClass("mt-0.5")
    })
})
