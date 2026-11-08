import type { UiLanguage } from "@shared/UiLanguage"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import FeatureSettingsSection from "./FeatureSettingsSection"

const mockUpdateSetting = vi.fn()

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: vi.fn(() => ({
        enableCheckpointsSetting: true,
        hooksEnabled: false,
        showFeatureTips: false,
        showActiveTasksInEnvDetails: false,
        mcpDisplayMode: "rich",
        strictPlanModeEnabled: false,
        yoloModeToggled: false,
        useAutoCondense: false,
        subagentsEnabled: false,
        imageGenerationEnabled: false,
        clineWebToolsEnabled: false,
        localWebSearchEngine: "duckduckgo",
        searxngSearchUrl: undefined,
        worktreesEnabled: { user: true, featureFlag: true },
        focusChainSettings: { enabled: false, remindClineInterval: 6 },
        remoteConfigSettings: {},
        nativeToolCallSetting: false,
        enableParallelToolCalling: false,
        backgroundEditEnabled: false,
        doubleCheckCompletionEnabled: false,
    })),
}))

vi.mock("../utils/settingsHandlers", () => ({
    updateSetting: (...args: unknown[]) => mockUpdateSetting(...args),
}))

describe("FeatureSettingsSection", () => {
    it("updates feature metadata and search labels in the same tree while preserving raw drafts and engine values", () => {
        mockUpdateSetting.mockClear()
        const tree = (language: UiLanguage) => (
            <UiLanguageProvider language={language}>
                <FeatureSettingsSection renderSectionHeader={() => null} />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        const hooks = screen.getByRole("switch", { name: "Hooks" })
        const engine = screen.getByRole("combobox", { name: "Local Web Search engine" })
        fireEvent.change(engine, { target: { value: "searxng" } })
        const url = screen.getByRole("textbox", { name: "SearXNG URL" })
        const token = screen.getByLabelText("SearXNG token")
        fireEvent.change(url, { target: { value: "https://search.custom.test/raw-path" } })
        fireEvent.change(token, { target: { value: "uncommitted-token" } })
        const writes = mockUpdateSetting.mock.calls.length
        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("switch", { name: "钩子" })).toBe(hooks)
        expect(screen.getByRole("switch", { name: "功能提示" })).toBeVisible()
        expect(screen.getByText("在思考阶段轮换显示提示，帮助你发现 Dline 的功能。")).toBeVisible()
        expect(screen.getByRole("combobox", { name: "本地网页搜索引擎" })).toBe(engine)
        expect(screen.getByRole("option", { name: "浏览器 / DuckDuckGo" })).toHaveValue("duckduckgo")
        expect(screen.getByRole("option", { name: "浏览器 / Bing" })).toHaveValue("bing")
        expect(engine).toHaveValue("searxng")
        expect(screen.getByLabelText("SearXNG 令牌")).toBe(token)
        expect(token).toHaveValue("uncommitted-token")
        expect(url).toHaveValue("https://search.custom.test/raw-path")
        expect(mockUpdateSetting).toHaveBeenCalledTimes(writes)
        fireEvent.click(hooks)
        expect(mockUpdateSetting).toHaveBeenLastCalledWith("hooksEnabled", true)
        view.rerender(tree("en"))
        expect(screen.getByRole("switch", { name: "Hooks" })).toBe(hooks)
        expect(screen.getByRole("combobox", { name: "Local Web Search engine" })).toBe(engine)
        expect(screen.getByRole("textbox", { name: "SearXNG URL" })).toBe(url)
        expect(screen.getByLabelText("SearXNG token")).toBe(token)
        expect(token).toHaveValue("uncommitted-token")
        fireEvent.blur(url)
        expect(mockUpdateSetting).toHaveBeenLastCalledWith("searxngSearchUrl", "https://search.custom.test/raw-path")
        fireEvent.blur(token)
        expect(mockUpdateSetting).toHaveBeenLastCalledWith("searxngSearchToken", "uncommitted-token")
        expect(token).toHaveValue("")
    })

    it("renders Hooks feature toggle", () => {
        const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

        expect(screen.getByText("Hooks")).toBeTruthy()

        const advancedSection = container.querySelector("#advanced-features")
        const agentSection = container.querySelector("#agent-features")

        expect(advancedSection?.querySelector("#Hooks")).toBeTruthy()
        expect(agentSection?.querySelector("#Hooks")).toBeNull()
    })

    it("renders Feature Tips toggle in the Editor section", () => {
        const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

        expect(screen.getByText("Feature Tips")).toBeTruthy()
        expect(screen.getByRole("switch", { name: "Feature Tips" })).toBeTruthy()

        const editorSection = container.querySelector("#optional-features")
        const agentSection = container.querySelector("#agent-features")

        expect(editorSection?.querySelector('[id="Feature Tips"]')).toBeTruthy()
        expect(agentSection?.querySelector('[id="Feature Tips"]')).toBeNull()
    })

    it("renders Active Tasks toggle in the Agent section", () => {
        const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

        expect(screen.getByText("Active Tasks")).toBeTruthy()

        const agentSection = container.querySelector("#agent-features")
        const editorSection = container.querySelector("#optional-features")

        expect(agentSection?.querySelector('[id="Active Tasks"]')).toBeTruthy()
        expect(editorSection?.querySelector('[id="Active Tasks"]')).toBeNull()
    })

    it("calls updateSetting with hooksEnabled when toggled", () => {
        const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

        const hooksSwitch = container.querySelector("#Hooks")
        expect(hooksSwitch).toBeTruthy()

        fireEvent.click(hooksSwitch as Element)

        expect(mockUpdateSetting).toHaveBeenCalledWith("hooksEnabled", true)
    })

    it("calls updateSetting with showFeatureTips when toggled", () => {
        const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

        const featureTipsSwitch = container.querySelector('[id="Feature Tips"]')
        expect(featureTipsSwitch).toBeTruthy()

        fireEvent.click(featureTipsSwitch as Element)

        expect(mockUpdateSetting).toHaveBeenCalledWith("showFeatureTips", true)
    })

    it("calls updateSetting with showActiveTasksInEnvDetails when toggled", () => {
        const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

        const activeTasksSwitch = container.querySelector('[id="Active Tasks"]')
        expect(activeTasksSwitch).toBeTruthy()

        fireEvent.click(activeTasksSwitch as Element)

        expect(mockUpdateSetting).toHaveBeenCalledWith("showActiveTasksInEnvDetails", true)
    })

    it("renders Image Generation in the Agent section and persists its independent feature gate", () => {
        const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

        const imageGenerationSwitch = container.querySelector('[id="Enable Image Generation"]')
        const agentSection = container.querySelector("#agent-features")
        expect(imageGenerationSwitch).toBeTruthy()
        expect(agentSection?.querySelector('[id="Enable Image Generation"]')).toBeTruthy()

        fireEvent.click(imageGenerationSwitch as Element)

        expect(mockUpdateSetting).toHaveBeenCalledWith("imageGenerationEnabled", true)
    })

    it("always renders Web Tools in the Agent section and saves changes", () => {
        const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)

        expect(screen.getByText("Web Tools")).toBeTruthy()
        const webToolsSwitch = container.querySelector('[id="Web Tools"]')
        const agentSection = container.querySelector("#agent-features")
        const editorSection = container.querySelector("#optional-features")
        expect(webToolsSwitch).toBeTruthy()
        expect(agentSection?.querySelector('[id="Web Tools"]')).toBeTruthy()
        expect(editorSection?.querySelector('[id="Web Tools"]')).toBeNull()

        fireEvent.click(webToolsSwitch as Element)

        expect(mockUpdateSetting).toHaveBeenCalledWith("clineWebToolsEnabled", true)
    })

    it("configures only Dline local search engines from the Agent section", () => {
        const { container } = render(<FeatureSettingsSection renderSectionHeader={() => null} />)
        const agentSection = container.querySelector("#agent-features")
        const engineSelector = screen.getByRole("combobox", { name: "Local Web Search engine" }) as HTMLSelectElement

        expect(agentSection?.contains(engineSelector)).toBe(true)
        expect(engineSelector.value).toBe("duckduckgo")
        expect(Array.from(engineSelector.options).map((option) => option.text)).toEqual([
            "Browser / DuckDuckGo",
            "Browser / Bing",
            "SearXNG",
        ])
        expect(screen.queryByText(/Cline Cloud/i)).toBeNull()

        fireEvent.change(engineSelector, { target: { value: "bing" } })

        expect(mockUpdateSetting).toHaveBeenCalledWith("localWebSearchEngine", "bing")
    })

    it("shows write-only SearXNG settings only when SearXNG is selected", () => {
        render(<FeatureSettingsSection renderSectionHeader={() => null} />)
        const engineSelector = screen.getByRole("combobox", { name: "Local Web Search engine" })
        expect(screen.queryByRole("textbox", { name: "SearXNG URL" })).toBeNull()

        fireEvent.change(engineSelector, { target: { value: "searxng" } })

        const urlInput = screen.getByRole("textbox", { name: "SearXNG URL" })
        const tokenInput = screen.getByLabelText("SearXNG token") as HTMLInputElement
        expect(tokenInput.type).toBe("password")
        expect(tokenInput.value).toBe("")

        fireEvent.change(urlInput, { target: { value: "https://search.example.test" } })
        fireEvent.blur(urlInput)
        fireEvent.change(tokenInput, { target: { value: "private-token" } })
        fireEvent.blur(tokenInput)

        expect(mockUpdateSetting).toHaveBeenCalledWith("searxngSearchUrl", "https://search.example.test")
        expect(mockUpdateSetting).toHaveBeenCalledWith("searxngSearchToken", "private-token")
    })
})
