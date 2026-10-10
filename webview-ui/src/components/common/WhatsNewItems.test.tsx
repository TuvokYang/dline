import whatsNew from "virtual:dline-whats-new"
import { render, screen, within } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import WhatsNewItems from "./WhatsNewItems"

describe("WhatsNewItems", () => {
    it("renders the build-time release with its bold, code, and changelog links", () => {
        render(<WhatsNewItems inlineCodeStyle={{}} />)

        const items = screen.getAllByRole("listitem")
        expect(items).toHaveLength(whatsNew.items.length)
        expect(whatsNew.items.length).toBeGreaterThan(0)

        whatsNew.items.forEach((runs, index) => {
            const item = items[index]
            expect(item.textContent).toBe(runs.map((run) => run.text).join(""))
            for (const run of runs) {
                if (run.kind === "strong") expect(within(item).getByText(run.text).tagName).toBe("STRONG")
                if (run.kind === "code") expect(within(item).getByText(run.text).tagName).toBe("CODE")
                if (run.kind === "link")
                    expect(within(item).getByRole("link", { name: run.text })).toHaveAttribute("href", run.href)
            }
        })

        expect(screen.getByRole("link", { name: "full changelog" })).toHaveAttribute(
            "href",
            "https://github.com/TuvokYang/Dline/blob/test-ref/docs/changelog/CHANGELOG_en.md",
        )
    })
})
