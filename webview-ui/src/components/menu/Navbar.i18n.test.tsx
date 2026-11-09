import type { DlineFeatureSettings } from "@shared/DlineFeatureSettings"
import type { UiLanguage } from "@shared/UiLanguage"
import { act, fireEvent, render, screen, within } from "@testing-library/react"
import { type ReactNode, useState } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const extensionState = vi.hoisted(() => ({
    navigateToHistory: vi.fn(),
    navigateToSettings: vi.fn(),
    navigateToAccount: vi.fn(),
    navigateToMcp: vi.fn(),
    navigateToChat: vi.fn(),
    accountEnabled: { featureFlag: true, user: true } as DlineFeatureSettings | undefined,
}))

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => extensionState,
}))
vi.mock("@/services/grpc-client", () => ({
    TaskServiceClient: { clearTask: vi.fn().mockResolvedValue({}) },
}))

import { Navbar } from "@/components/menu/Navbar"
import { UiDocumentLanguage, UiLanguageProvider } from "@/i18n/UiLanguageProvider"

/**
 * Mount the real Provider and switch its controlled language in place.
 * The component under test is never remounted, so DOM identity and any local
 * state it holds must survive the switch.
 */
function Switcher({ children }: { children: ReactNode }) {
    const [language, setLanguage] = useState<UiLanguage>("en")
    return (
        <UiLanguageProvider language={language}>
            <UiDocumentLanguage />
            <button onClick={() => setLanguage(language === "en" ? "zh-CN" : "en")} type="button">
                switch-language
            </button>
            {children}
        </UiLanguageProvider>
    )
}

function switchLanguage() {
    fireEvent.click(screen.getByRole("button", { name: "switch-language" }))
}

describe("shell navigation language switching", () => {
    beforeEach(() => {
        extensionState.accountEnabled = { featureFlag: true, user: true }
    })

    it("updates tab accessible names and tooltips in both directions without remounting buttons", async () => {
        render(
            <Switcher>
                <Navbar />
            </Switcher>,
        )

        const historyTab = screen.getByTestId("tab-history")
        const settingsTab = screen.getByTestId("tab-settings")
        expect(screen.getByRole("button", { name: "History" })).toBe(historyTab)
        expect(screen.getByRole("button", { name: "New Task" })).toBe(screen.getByTestId("tab-chat"))

        await act(async () => switchLanguage())

        expect(screen.getByRole("button", { name: "历史" })).toBe(historyTab)
        expect(screen.getByRole("button", { name: "新建任务" })).toBe(screen.getByTestId("tab-chat"))
        expect(screen.getByRole("button", { name: "设置" })).toBe(settingsTab)
        expect(screen.getByRole("button", { name: "账户" })).toBe(screen.getByTestId("tab-account"))
        expect(document.documentElement.lang).toBe("zh-CN")

        await act(async () => switchLanguage())

        expect(screen.getByRole("button", { name: "History" })).toBe(historyTab)
        expect(document.documentElement.lang).toBe("en")
    })

    it("keeps the account tab gated by the feature rollout in every language", () => {
        extensionState.accountEnabled = { featureFlag: true, user: false }
        render(
            <Switcher>
                <Navbar />
            </Switcher>,
        )

        expect(screen.queryByTestId("tab-account")).toBeNull()
        act(() => switchLanguage())
        expect(screen.queryByTestId("tab-account")).toBeNull()
        expect(screen.getByTestId("tab-settings")).toBeTruthy()
    })

    it("keeps the tab order stable so arrow-key navigation does not depend on the language", () => {
        render(
            <Switcher>
                <Navbar />
            </Switcher>,
        )
        const order = () =>
            Array.from(document.querySelectorAll("nav button")).map((button) => button.getAttribute("data-testid"))

        expect(order()).toEqual(["tab-chat", "tab-mcp", "tab-history", "tab-account", "tab-settings"])
        act(() => switchLanguage())
        expect(order()).toEqual(["tab-chat", "tab-mcp", "tab-history", "tab-account", "tab-settings"])
    })

    it("translates the tooltip portal content, not only the aria label", async () => {
        render(
            <Switcher>
                <Navbar />
            </Switcher>,
        )

        act(() => switchLanguage())
        expect(screen.getByRole("button", { name: "历史" })).toBeTruthy()

        // The tooltip content renders in a portal and must read the same
        // translator as its trigger instead of a frozen English string.
        act(() => screen.getByRole("button", { name: "历史" }).focus())
        const tooltip = await screen.findByRole("tooltip")
        expect(tooltip).toHaveTextContent("历史")
        expect(within(tooltip).queryByText("History")).toBeNull()
    })
})
