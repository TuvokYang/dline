import type { UiLanguagePreference } from "@shared/UiLanguage"
import { act, fireEvent, render, screen } from "@testing-library/react"
import { type ReactNode, useState } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"

const rpc = vi.hoisted(() => ({ update: vi.fn(async (_request: unknown) => ({})) }))
vi.mock("@/services/grpc-client", () => ({ StateServiceClient: { updateSettings: rpc.update, resetState: vi.fn() } }))
vi.mock("@/context/ExtensionStateContext", async () => {
    const { createContext, useContext } = await import("react")
    const context = createContext({})
    return {
        ExtensionStateContext: context,
        ExtensionStateContextProvider: ({ children }: { children: ReactNode }) => children,
        useExtensionState: () => useContext(context),
    }
})
vi.mock("@/context/ClineAuthContext", async () => {
    const { createContext } = await import("react")
    return {
        ClineAuthContext: createContext({ activeOrganization: null }),
        ClineAuthProvider: ({ children }: { children: ReactNode }) => children,
        useClineAuth: () => ({ activeOrganization: null }),
    }
})
vi.mock("./sections/ApiConfigurationSection", () => ({
    default: function DraftSection({ renderSectionHeader }: { renderSectionHeader: (id: string) => ReactNode }) {
        const [draft, setDraft] = useState("unsaved profile")
        return (
            <>
                {renderSectionHeader("api-config")}
                <input aria-label="Profile draft" onChange={(event) => setDraft(event.target.value)} value={draft} />
                <details>
                    <summary>Profile details</summary>Details
                </details>
            </>
        )
    },
}))
vi.mock("./sections/AboutSection", () => ({ default: () => null }))
vi.mock("./sections/BrowserSettingsSection", () => ({ default: () => null }))
vi.mock("./sections/DebugSection", () => ({ default: () => null }))
vi.mock("./sections/FeatureSettingsSection", () => ({ default: () => null }))
vi.mock("./sections/RemoteConfigSection", () => ({ RemoteConfigSection: () => null }))
vi.mock("./sections/TerminalSettingsSection", () => ({ default: () => null }))

import { createStorybookDecorator } from "@/config/StorybookDecorator"
import { ExtensionStateContext, type ExtensionStateContextType } from "@/context/ExtensionStateContext"
import { UiLanguageBridge } from "@/i18n/UiLanguageBridge"
import { UiDocumentLanguage, useUiTranslation } from "@/i18n/UiLanguageProvider"
import SettingsView from "./SettingsView"

function state(uiLanguage: UiLanguagePreference, hostDisplayLanguage = "zh-CN"): ExtensionStateContextType {
    // Only the Settings/bridge consumers are mounted; unrelated sections are isolated above.
    return {
        uiLanguage,
        hostDisplayLanguage,
        version: "test",
        environment: "production",
        preferredLanguage: "English",
        chatInputSendShortcut: "enter",
        aggressiveRendering: { featureFlag: true, user: "none" },
    } as ExtensionStateContextType
}
function view(preference: UiLanguagePreference, targetSection = "api-config") {
    return (
        <ExtensionStateContext.Provider value={state(preference)}>
            <UiLanguageBridge>
                <SettingsView onDone={() => {}} targetSection={targetSection} />
            </UiLanguageBridge>
        </ExtensionStateContext.Provider>
    )
}
function PreviewProbe() {
    const { t } = useUiTranslation()
    return (
        <>
            <UiDocumentLanguage />
            <button>{t("settings.done")}</button>
        </>
    )
}

describe("Settings language assembly", () => {
    beforeEach(() => rpc.update.mockClear())

    it("updates navigation, Done and the memoized active heading without replacing drafts or DOM identity", () => {
        const { container, rerender } = render(view("en"))
        const input = screen.getByRole("textbox", { name: "Profile draft" }) as HTMLInputElement
        const tab = screen.getByRole("tab", { name: "API Configuration" })
        const details = container.querySelector("details")!
        fireEvent.change(input, { target: { value: "keep this draft" } })
        input.focus()
        input.setSelectionRange(2, 6)
        details.open = true
        rerender(view("zh-CN"))
        expect(screen.getByRole("tab", { name: "API 配置" })).toBe(tab)
        expect(tab).toHaveAttribute("aria-selected", "true")
        expect(screen.getByRole("heading", { name: "API 配置" })).toBeInTheDocument()
        expect(screen.getByRole("button", { name: "完成" })).toBeInTheDocument()
        expect(screen.getByRole("textbox", { name: "Profile draft" })).toBe(input)
        expect(input).toHaveValue("keep this draft")
        expect(input).toHaveFocus()
        expect([input.selectionStart, input.selectionEnd]).toEqual([2, 6])
        expect(details.open).toBe(true)
        expect(document.documentElement.lang).toBe("zh-CN")
        rerender(view("en"))
        expect(screen.getByRole("tab", { name: "API Configuration" })).toBe(tab)
        expect(screen.getByRole("heading", { name: "API Configuration" })).toBeInTheDocument()
        expect(screen.getByRole("button", { name: "Done" })).toBeInTheDocument()
        expect(input).toHaveValue("keep this draft")
        expect(input).toHaveFocus()
        expect(details.open).toBe(true)
    })

    it("translates General and accessible controls in both directions while saving only the UI preference", async () => {
        const { container, rerender } = render(view("en", "general"))
        const dropdown = screen.getByRole("combobox", { name: "Interface language" })
        Object.defineProperty(dropdown, "value", { configurable: true, value: "auto", writable: true })
        await act(async () => fireEvent.change(dropdown))
        expect(rpc.update).toHaveBeenCalledTimes(1)
        expect(rpc.update.mock.calls[0][0]).toMatchObject({ uiLanguage: "auto" })
        expect(rpc.update.mock.calls[0][0]).not.toHaveProperty("preferredLanguage")
        rerender(view("auto", "general"))
        expect(screen.getByRole("heading", { name: "通用设置" })).toBeInTheDocument()
        expect(screen.getByRole("combobox", { name: "界面语言" })).toBe(dropdown)
        expect(screen.getByRole("combobox", { name: "模型沟通语言" })).toBeInTheDocument()
        expect(screen.getByRole("combobox", { name: "发送消息快捷键" })).toBeInTheDocument()
        expect(screen.getByRole("combobox", { name: "对话折叠" })).toBeInTheDocument()
        expect(container.querySelector("#preferred-language-dropdown")).toHaveAttribute("current-value", "English")
        rerender(view("en", "general"))
        expect(screen.getByRole("heading", { name: "General Settings" })).toBeInTheDocument()
        expect(screen.getByRole("combobox", { name: "Interface language" })).toBe(dropdown)
        expect(screen.getByRole("combobox", { name: "Model response language" })).toBeInTheDocument()
        expect(rpc.update).toHaveBeenCalledTimes(1)
    })

    it("resolves Storybook language inside the final override and lets the leaf own document language", () => {
        const chinese = createStorybookDecorator({ uiLanguage: "auto", hostDisplayLanguage: "zh-CN" })
        const english = createStorybookDecorator({ uiLanguage: "en", hostDisplayLanguage: "zh-CN" })
        const { rerender } = render(
            <ExtensionStateContext.Provider value={state("en", "en")}>{chinese(PreviewProbe)}</ExtensionStateContext.Provider>,
        )
        const button = screen.getByRole("button", { name: "完成" })
        expect(document.documentElement.lang).toBe("zh-CN")
        rerender(
            <ExtensionStateContext.Provider value={state("zh-CN", "en")}>{english(PreviewProbe)}</ExtensionStateContext.Provider>,
        )
        expect(screen.getByRole("button", { name: "Done" })).toBe(button)
        expect(document.documentElement.lang).toBe("en")
    })
})
