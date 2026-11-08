import type { UiLanguage } from "@shared/UiLanguage"
import { render, screen } from "@testing-library/react"
import type { ReactNode } from "react"
import { describe, expect, it, vi } from "vitest"

vi.mock("virtual:dline-whats-new", async () => {
    const english = { version: "9.9.9", items: [[{ kind: "text", text: "English highlight" }]] as const }
    const chinese = { version: "9.9.9", items: [[{ kind: "text", text: "中文亮点" }]] as const }
    return { localizedReleases: { en: english, "zh-CN": chinese }, default: english }
})

import WhatsNewItems from "@/components/common/WhatsNewItems"
import WhatsNewModal from "@/components/common/WhatsNewModal"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"

function localized(language: UiLanguage, children: ReactNode) {
    return <UiLanguageProvider language={language}>{children}</UiLanguageProvider>
}

describe("What's New localized release", () => {
    it("shows the release items of the active edition and switches them in place", () => {
        const modal = <WhatsNewModal onClose={vi.fn()} open version="9.9.9" />
        const { rerender } = render(localized("en", modal))
        const dialog = screen.getByRole("dialog")
        const item = screen.getByRole("listitem")
        expect(item).toHaveTextContent("English highlight")
        expect(screen.getByRole("heading", { name: "🎉 New in v9.9.9" })).toBeTruthy()

        rerender(localized("zh-CN", modal))

        expect(screen.getByRole("dialog")).toBe(dialog)
        expect(screen.getByRole("listitem")).toBe(item)
        expect(item).toHaveTextContent("中文亮点")
        expect(screen.getByRole("heading", { name: "🎉 v9.9.9 新功能" })).toBeTruthy()
        expect(screen.getByText("完整更新日志")).toBeTruthy()
        expect(screen.getByRole("button", { name: "关闭" })).toBeTruthy()

        rerender(localized("en", modal))
        expect(screen.getByRole("listitem")).toBe(item)
        expect(item).toHaveTextContent("English highlight")
    })

    it("keeps the release version identity out of the translated items", () => {
        const modal = <WhatsNewModal onClose={vi.fn()} open version="1.2.3" />
        const { rerender } = render(localized("en", modal))
        const heading = screen.getByRole("heading", { name: /1\.2\.3/ })

        rerender(localized("zh-CN", modal))

        // Only the wrapper is translated; the version reported by the extension is unchanged.
        expect(screen.getByRole("heading", { name: /1\.2\.3/ })).toBe(heading)
        expect(screen.queryByRole("heading", { name: /9\.9\.9/ })).toBeNull()
    })

    it("switches the changelog destination with the active edition without replacing its link", () => {
        const items = <WhatsNewItems inlineCodeStyle={{}} />
        const { rerender } = render(localized("en", items))

        const englishLink = screen.getByRole("link", { name: "full changelog" })
        const englishHref = englishLink.getAttribute("href")
        const englishUrl = new URL(englishHref!)
        expect(englishUrl.pathname).toMatch(/\/docs\/changelog\/CHANGELOG_en\.md$/)

        rerender(localized("zh-CN", items))

        const chineseLink = screen.getByRole("link", { name: "完整更新日志" })
        expect(chineseLink).toBe(englishLink)
        const chineseUrl = new URL(chineseLink.getAttribute("href")!)
        expect(chineseUrl.origin).toBe(englishUrl.origin)
        expect(chineseUrl.pathname).toBe(englishUrl.pathname.replace(/\/docs\/changelog\/CHANGELOG_en\.md$/, "/CHANGELOG.md"))
        expect(chineseLink).toHaveAttribute("target", "_blank")
        expect(chineseLink).toHaveAttribute("rel", "noopener noreferrer")

        rerender(localized("en", items))
        expect(screen.getByRole("link", { name: "full changelog" })).toBe(englishLink)
        expect(englishLink).toHaveAttribute("href", englishHref)
    })

    it("translates the star call to action without changing its destination", () => {
        const { rerender } = render(
            <UiLanguageProvider language="en">
                <WhatsNewModal onClose={vi.fn()} open version="9.9.9" />
            </UiLanguageProvider>,
        )
        const starLink = screen.getByRole("link", { name: "Star us on GitHub" })
        const href = starLink.getAttribute("href")

        rerender(
            <UiLanguageProvider language="zh-CN">
                <WhatsNewModal onClose={vi.fn()} open version="9.9.9" />
            </UiLanguageProvider>,
        )
        const chineseStars = screen.getAllByRole("link", { name: "在 GitHub 上为我们加星" })
        expect(chineseStars).toHaveLength(2)
        for (const link of chineseStars) {
            expect(link).toHaveAttribute("href", href)
            expect(link).toHaveAttribute("target", "_blank")
            expect(link).toHaveAttribute("rel", "noopener noreferrer")
        }
        expect(chineseStars).toContain(starLink)
        expect(screen.queryByText("Star us on GitHub")).toBeNull()
    })
})
