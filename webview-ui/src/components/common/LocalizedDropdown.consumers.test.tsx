import { QwenApiRegions } from "@shared/api"
import type { McpServer } from "@shared/mcp"
import { ApiFormat } from "@shared/proto/dline/models/metadata"
import { ApiProfile } from "@shared/proto/dline/profile"
import { BedrockProviderConfig } from "@shared/proto/dline/provider/bedrock"
import { QwenProviderConfig } from "@shared/proto/dline/provider/qwen"
import VertexData from "@shared/providers/vertex.json"
import type { UiLanguage } from "@shared/UiLanguage"
import { act, fireEvent, type RenderResult, render } from "@testing-library/react"
import type { Dropdown, Option } from "@vscode/webview-ui-toolkit"
import type { ReactElement, ReactNode } from "react"
import { beforeEach, describe, expect, it, type Mock, vi } from "vitest"
import { ClineAccountView } from "@/components/account/AccountView"
import ServerRow from "@/components/mcp/configuration/tabs/installed/server-row/ServerRow"
import McpMarketplaceView from "@/components/mcp/configuration/tabs/marketplace/McpMarketplaceView"
import { ModelInfoView } from "@/components/settings/common/ModelInfoView"
import { ModelSelector } from "@/components/settings/common/ModelSelector"
import { BedrockProvider } from "@/components/settings/providers/BedrockProvider"
import { LMStudioProvider } from "@/components/settings/providers/LMStudioProvider"
import { OpenCodeProviderCard } from "@/components/settings/providers/OpenCodeProviderCard"
import { QwenProvider } from "@/components/settings/providers/QwenProvider"
import { VertexProvider } from "@/components/settings/providers/VertexProvider"
import BrowserSettingsSection from "@/components/settings/sections/BrowserSettingsSection"
import TerminalSettingsSection from "@/components/settings/sections/TerminalSettingsSection"
import { translateUi } from "@/i18n/messages"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"

const mocks = vi.hoisted(() => ({
    updateSetting: vi.fn(),
    detectedChrome: vi.fn(),
    refreshMarketplace: vi.fn(),
    setCatalog: vi.fn(),
    updateTimeout: vi.fn(),
    setServers: vi.fn(),
    userCredits: vi.fn(),
    organizationCredits: vi.fn(),
    setOrganization: vi.fn(),
    refreshModels: vi.fn(),
}))
const catalog = { models: { "raw/model": { id: "raw/model" } }, defaultModelId: "raw/model" }
const state = {
    shellIntegrationTimeout: 4000,
    terminalReuseEnabled: true,
    defaultTerminalProfile: "default",
    availableTerminalProfiles: [{ id: "default", name: "Raw shell" }],
    vscodeTerminalExecutionMode: "backgroundExec",
    browserSettings: { viewport: { width: 900, height: 600 }, remoteBrowserEnabled: false },
    remoteConfigSettings: {} as Record<string, unknown>,
    environment: "production",
    mcpMarketplaceCatalog: { items: [{ mcpId: "raw/category", category: "Raw Category" }] },
    mcpServers: [],
    setMcpMarketplaceCatalog: mocks.setCatalog,
    setMcpServers: mocks.setServers,
}
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => state }))
vi.mock("@/context/PlatformContext", () => ({ usePlatform: () => ({ type: 0 }) }))
vi.mock("@/context/ClineAuthContext", () => ({ handleSignOut: vi.fn() }))
vi.mock("@/services/grpc-client", () => ({
    BrowserServiceClient: { getDetectedChromePath: mocks.detectedChrome },
    AccountServiceClient: {
        getUserCredits: mocks.userCredits,
        getOrganizationCredits: mocks.organizationCredits,
        setUserOrganization: mocks.setOrganization,
    },
    McpServiceClient: { refreshMcpMarketplace: mocks.refreshMarketplace, updateMcpTimeout: mocks.updateTimeout },
}))
vi.mock("@/components/settings/utils/settingsHandlers", () => ({ updateSetting: mocks.updateSetting }))
vi.mock("@/components/settings/providers/useProviderModels", () => ({ useProviderModels: () => catalog }))
vi.mock("@/components/settings/providers/useProviderModelOptions", () => ({
    useProviderModelOptions: () => ({ ...catalog, options: catalog.models, refreshRemoteModels: mocks.refreshModels }),
}))
vi.mock("@/components/settings/providers/useModelProbe", () => ({
    useModelProbe: () => ({ models: catalog.models, refresh: mocks.refreshModels }),
}))
vi.mock("@/components/settings/ApiOptions", () => ({
    DROPDOWN_Z_INDEX: 1000,
    DropdownContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock("@/components/settings/common/ApiKeyField", () => ({ ApiKeyField: () => null }))
vi.mock("@/components/settings/common/BaseUrlField", () => ({ BaseUrlField: () => null }))
vi.mock("@/components/settings/common/DebouncedTextField", () => ({ DebouncedTextField: () => null }))
vi.mock("@/components/settings/common/PricingEditor", () => ({ PricingEditor: () => null }))
vi.mock("@/components/settings/ThinkingControl", () => ({ default: () => null }))
vi.mock("@/components/settings/UseCustomPromptCheckbox", () => ({ default: () => null }))
vi.mock("@/components/settings/TerminalCommandTimeoutSetting", () => ({ default: () => null }))
vi.mock("@/components/settings/TerminalHandoffSecondsSetting", () => ({ default: () => null }))
vi.mock("@/components/settings/TerminalOutputLineLimitSlider", () => ({ default: () => null }))
vi.mock("@/components/account/CreditBalance", () => ({ CreditBalance: () => null }))
vi.mock("@/components/account/CreditsHistoryTable", () => ({ default: () => null }))
vi.mock("@/components/account/RemoteConfigToggle", () => ({ RemoteConfigToggle: () => null }))
vi.mock("@/components/mcp/configuration/tabs/marketplace/McpMarketplaceCard", () => ({ default: () => null }))
vi.mock("@/components/mcp/configuration/tabs/marketplace/McpSubmitCard", () => ({ default: () => null }))

async function flushToolkit() {
    await act(async () => {
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()))
    })
}

/** Real toolkit throughout: inspect assigned shadow-slot content, not the stale SDK fallback text. */
async function checkSwitches(
    element: ReactElement,
    selector: string,
    value: string,
    labels: (language: UiLanguage) => readonly (readonly [string, string])[],
    prepare?: () => void,
    observers: readonly Mock[] = [],
): Promise<{ host: Dropdown; view: RenderResult }> {
    const tree = (language: UiLanguage) => <UiLanguageProvider language={language}>{element}</UiLanguageProvider>
    const view = render(tree("en"))
    prepare?.()
    await flushToolkit()
    const host = view.container.querySelector<Dropdown>(selector)!
    expect(host?.tagName).toBe("VSCODE-DROPDOWN")
    expect(host.shadowRoot).not.toBeNull()
    const hostIndex = Array.from(view.container.querySelectorAll("vscode-dropdown")).indexOf(host)
    const options = Array.from(host.querySelectorAll<Option>("vscode-option"))
    const span = host.querySelector('[slot="selected-value"]')!
    const disabled = host.disabled
    const observedMocks = [...Object.values(mocks), ...observers]
    const callsBefore = observedMocks.map((mock) => mock.mock.calls.length)
    for (const language of ["en", "zh-CN", "en"] as const) {
        view.rerender(tree(language))
        await flushToolkit()
        expect(view.container.querySelectorAll("vscode-dropdown")[hostIndex]).toBe(host)
        expect(host.value).toBe(value)
        expect(host.disabled).toBe(disabled)
        expect(host.querySelector('[slot="selected-value"]')).toBe(span)
        const slot = host.shadowRoot!.querySelector<HTMLSlotElement>('slot[name="selected-value"]')!
        expect(slot.assignedNodes()).toEqual([span])
        expect(span.textContent).toBe(labels(language).find(([optionValue]) => optionValue === value)?.[1])
        expect(Array.from(host.querySelectorAll("vscode-option"))).toEqual(options)
        expect(options.map((option) => [option.value, option.textContent, option.getAttribute("aria-label")])).toEqual(
            labels(language).map(([optionValue, label]) => [optionValue, label, label]),
        )
        expect(observedMocks.map((mock) => mock.mock.calls.length)).toEqual(callsBefore)
    }
    return { host, view }
}

function change(host: Dropdown, value: string) {
    act(() => {
        host.value = value
    })
    fireEvent(host, new Event("change", { bubbles: true }))
}

beforeEach(() => {
    vi.clearAllMocks()
    state.remoteConfigSettings = {}
    mocks.detectedChrome.mockResolvedValue({ path: "", isBundled: false })
    mocks.refreshMarketplace.mockResolvedValue(state.mcpMarketplaceCatalog)
    mocks.updateTimeout.mockResolvedValue({ mcpServers: [] })
    mocks.userCredits.mockResolvedValue({ balance: { currentBalance: 0 }, usageTransactions: [], paymentTransactions: [] })
    mocks.organizationCredits.mockResolvedValue({ balance: { currentBalance: 0 }, usageTransactions: [] })
    mocks.setOrganization.mockResolvedValue({})
})

describe("production LocalizedDropdown consumers (actual toolkit)", () => {
    it("keeps terminal mode values and its update event", async () => {
        const { host } = await checkSwitches(
            <TerminalSettingsSection renderSectionHeader={() => null} />,
            "#terminal-execution-mode",
            "backgroundExec",
            (language) => [
                ["vscodeTerminal", translateUi(language, "settings.ui.terminal.vscode")],
                ["backgroundExec", translateUi(language, "settings.ui.terminal.background")],
            ],
        )
        expect(mocks.updateSetting).not.toHaveBeenCalled()
        change(host, "vscodeTerminal")
        expect(mocks.updateSetting).toHaveBeenCalledExactlyOnceWith("vscodeTerminalExecutionMode", "vscodeTerminal")
    })

    it("keeps the browser preset business keys and original dimensions payload", async () => {
        const { host } = await checkSwitches(
            <BrowserSettingsSection renderSectionHeader={() => null} />,
            "vscode-dropdown",
            "Small Desktop (900x600)",
            (language) => [
                ["Large Desktop (1280x800)", translateUi(language, "settings.ui.browser.largeDesktop")],
                ["Small Desktop (900x600)", translateUi(language, "settings.ui.browser.smallDesktop")],
                ["Tablet (768x1024)", translateUi(language, "settings.ui.browser.tablet")],
                ["Mobile (360x640)", translateUi(language, "settings.ui.browser.mobile")],
            ],
        )
        expect(mocks.detectedChrome).toHaveBeenCalledTimes(1)
        change(host, "Mobile (360x640)")
        expect(mocks.updateSetting).toHaveBeenCalledExactlyOnceWith("browserSettings", { viewport: { width: 360, height: 640 } })
    })

    it("keeps the empty model placeholder separate from raw ids", async () => {
        const onChange = vi.fn()
        const { host } = await checkSwitches(
            <ModelSelector models={catalog.models} onChange={onChange} selectedModelId="" />,
            "vscode-dropdown",
            "",
            (language) => [
                ["", translateUi(language, "settings.ui.selectModel")],
                ["raw/model", "raw/model"],
            ],
        )
        expect(onChange).not.toHaveBeenCalled()
        change(host, "raw/model")
        expect(onChange).toHaveBeenCalledTimes(1)
        expect(onChange.mock.calls[0][0].target.value).toBe("raw/model")
    })

    it.each([
        "",
        "price",
        "throughput",
        "latency",
    ])("keeps OpenRouter routing %s display reactive without extra changes", async (providerSorting) => {
        const onChange = vi.fn()
        const { host } = await checkSwitches(
            <ModelInfoView
                modelInfo={{ id: "raw/model" }}
                onProviderSortingChange={onChange}
                providerSorting={providerSorting}
                selectedModelId="raw/model"
                showProviderRouting
            />,
            "vscode-dropdown",
            providerSorting,
            (language) => [
                ["", translateUi(language, "settings.ui.default")],
                ["price", translateUi(language, "settings.ui.price")],
                ["throughput", translateUi(language, "settings.ui.throughput")],
                ["latency", translateUi(language, "settings.ui.latency")],
            ],
        )
        expect(onChange).not.toHaveBeenCalled()
        change(host, "price")
        expect(onChange).toHaveBeenCalledExactlyOnceWith("price")
    })

    it("keeps Vertex's empty locked region and its raw region options", async () => {
        state.remoteConfigSettings = { vertexRegion: "" }
        const onUpdate = vi.fn()
        const { host } = await checkSwitches(
            <VertexProvider onUpdate={onUpdate} profile={ApiProfile.create({ provider: "vertex" })} showModelOptions={false} />,
            "#vertex-region-dropdown",
            "",
            (language) => [
                ["", translateUi(language, "settings.ui.selectRegion")],
                ...VertexData.regions.map((region) => [region, region] as const),
            ],
        )
        expect(host.disabled).toBe(true)
        expect(onUpdate).not.toHaveBeenCalled()
    })

    it.each([
        QwenApiRegions.CHINA,
        QwenApiRegions.INTERNATIONAL,
    ])("keeps Qwen region %s and one original catalog-switch update", async (line) => {
        const onUpdate = vi.fn()
        const profile = ApiProfile.create({
            provider: "qwen",
            modelId: "raw/model",
            qwen: QwenProviderConfig.create({ qwenApiLine: line }),
        })
        const { host } = await checkSwitches(
            <QwenProvider onUpdate={onUpdate} profile={profile} showModelOptions={false} />,
            "#qwen-line-provider",
            line,
            (language) =>
                Object.values(QwenApiRegions).map(
                    (region) =>
                        [
                            region,
                            translateUi(
                                language,
                                region === QwenApiRegions.CHINA
                                    ? "settings.ui.qwen.chinaApi"
                                    : "settings.ui.qwen.internationalApi",
                            ),
                        ] as const,
                ),
        )
        expect(onUpdate).not.toHaveBeenCalled()
        const next = line === QwenApiRegions.CHINA ? QwenApiRegions.INTERNATIONAL : QwenApiRegions.CHINA
        change(host, next)
        expect(onUpdate).toHaveBeenCalledExactlyOnceWith({
            qwen: { ...profile.qwen, qwenApiLine: next },
            modelId: "raw/model",
            modelInfo: { id: "raw/model" },
        })
    })

    it("keeps LM Studio's empty placeholder, discovery trigger and model event", async () => {
        const onUpdate = vi.fn()
        const { host } = await checkSwitches(
            <LMStudioProvider
                onUpdate={onUpdate}
                profile={ApiProfile.create({ provider: "lmstudio" })}
                showModelOptions={false}
            />,
            "#lmstudio-model",
            "",
            (language) => [
                ["", translateUi(language, "settings.ui.selectModel")],
                ["raw/model", "raw/model"],
            ],
        )
        expect(onUpdate).not.toHaveBeenCalled()
        expect(mocks.refreshModels).not.toHaveBeenCalled()
        fireEvent.focus(host)
        expect(mocks.refreshModels).toHaveBeenCalledTimes(1)
        change(host, "raw/model")
        expect(onUpdate).toHaveBeenCalledExactlyOnceWith({ modelId: "raw/model" })
    })

    it.each([
        "#bedrock-model-dropdown",
        "#bedrock-base-model-dropdown",
    ])("keeps Bedrock custom/base labels and values in %s", async (selector) => {
        const onUpdate = vi.fn()
        const profile = ApiProfile.create({
            provider: "bedrock",
            modelId: "custom/model",
            bedrock: BedrockProviderConfig.create({ awsBedrockCustomSelected: true, awsBedrockCustomModelBaseId: "raw/model" }),
        })
        const { host } = await checkSwitches(
            <BedrockProvider onUpdate={onUpdate} profile={profile} showModelOptions />,
            selector,
            selector === "#bedrock-model-dropdown" ? "custom" : "raw/model",
            (language) => [
                ["", translateUi(language, "settings.ui.selectModel")],
                ["raw/model", "raw/model"],
                ...(selector === "#bedrock-model-dropdown"
                    ? [["custom", translateUi(language, "settings.ui.customBadge")] as const]
                    : []),
            ],
            undefined,
            [onUpdate],
        )
        // The real radio group already emits authentication initialization on mount.
        // checkSwitches asserts that translation adds no calls beyond that baseline.
        const callsAtMount = onUpdate.mock.calls.length
        change(host, "raw/model")
        expect(onUpdate).toHaveBeenCalledTimes(callsAtMount + 1)
        expect(onUpdate.mock.lastCall?.[0]).toEqual(
            selector === "#bedrock-model-dropdown"
                ? {
                      modelId: "raw/model",
                      modelInfo: { id: "raw/model" },
                      bedrock: { ...profile.bedrock, awsBedrockCustomSelected: false, awsBedrockCustomModelBaseId: "" },
                  }
                : { modelInfo: undefined, bedrock: { ...profile.bedrock, awsBedrockCustomModelBaseId: "raw/model" } },
        )
    })

    it.each(["plan", "budget"])("keeps OpenCode %s display and its callback payload", async (picker) => {
        const onPlanChange = vi.fn()
        const onThinkingBudgetChange = vi.fn()
        const element = (
            <OpenCodeProviderCard
                apiFormat={ApiFormat.OPENAI_CHAT}
                apiKey=""
                capabilities={{
                    supportsReasoning: true,
                    thinking: { supported: true, mode: "budget", minBudget: 1024, maxBudget: 2048 },
                }}
                enableThinking
                modelId="raw/model"
                models={["raw/model"]}
                onApiFormatChange={vi.fn()}
                onApiKeyChange={vi.fn()}
                onModelChange={vi.fn()}
                onPlanChange={onPlanChange}
                onThinkingBudgetChange={onThinkingBudgetChange}
                plan="balance"
                profileId="profile"
                thinkingBudget={2048}
            />
        )
        const { host } = await checkSwitches(
            element,
            picker === "plan" ? 'vscode-dropdown[aria-label="Plan"]' : 'vscode-dropdown[aria-label="Thinking Budget"]',
            picker === "plan" ? "balance" : "2048",
            (language) =>
                picker === "plan"
                    ? [
                          ["balance", translateUi(language, "settings.ui.opencode.balance")],
                          ["go", "OpenCode Go"],
                          ["go-plus", "OpenCode Go Plus"],
                          ["go-teams", "OpenCode Go Teams"],
                      ]
                    : [1024, 2048].map(
                          (value) =>
                              [
                                  String(value),
                                  translateUi(language, "settings.ui.tokens", { count: value.toLocaleString() }),
                              ] as const,
                      ),
        )
        expect(onPlanChange).not.toHaveBeenCalled()
        expect(onThinkingBudgetChange).not.toHaveBeenCalled()
        change(host, picker === "plan" ? "go" : "1024")
        if (picker === "plan") expect(onPlanChange).toHaveBeenCalledExactlyOnceWith("go")
        else expect(onThinkingBudgetChange).toHaveBeenCalledExactlyOnceWith(1024)
    })

    it.each(["personal", "environment"])("keeps account %s currentValue and credit/settings RPC counts", async (picker) => {
        const organization = { active: false, memberId: "member", organizationId: "org", name: "Raw Organization", roles: [] }
        const element = (
            <ClineAccountView
                activeOrganization={null}
                clineEnv="Staging"
                clineUser={{ uid: "user", email: "tester@cline.bot", displayName: "Raw User" }}
                userOrganizations={[organization]}
            />
        )
        const { host } = await checkSwitches(
            element,
            picker === "personal" ? "vscode-dropdown" : 'vscode-dropdown[aria-label="Dline Environment"]',
            picker === "personal" ? "user" : "Staging",
            (language) =>
                picker === "personal"
                    ? [
                          ["user", translateUi(language, "shell.account.personal")],
                          ["org", "Raw Organization"],
                      ]
                    : [
                          ["Production", translateUi(language, "shell.chrome.environment.production")],
                          ["Staging", translateUi(language, "shell.chrome.environment.staging")],
                          ["Local", translateUi(language, "shell.chrome.environment.local")],
                      ],
        )
        expect(mocks.userCredits).toHaveBeenCalledTimes(1)
        expect(mocks.organizationCredits).not.toHaveBeenCalled()
        expect(mocks.setOrganization).not.toHaveBeenCalled()
        expect(mocks.updateSetting).not.toHaveBeenCalled()
        change(host, picker === "personal" ? "org" : "Local")
        await flushToolkit()
        if (picker === "personal") {
            expect(mocks.setOrganization).toHaveBeenCalledExactlyOnceWith({ organizationId: "org" })
            expect(mocks.organizationCredits).toHaveBeenCalledTimes(1)
        } else expect(mocks.updateSetting).toHaveBeenCalledExactlyOnceWith("clineEnv", "local")
    })

    it("keeps marketplace's all-categories label and raw filter without refetching", async () => {
        const { host } = await checkSwitches(<McpMarketplaceView />, "vscode-dropdown", "", (language) => [
            ["", translateUi(language, "capabilities.mcp.marketplace.allCategories")],
            ["Raw Category", "Raw Category"],
        ])
        expect(mocks.refreshMarketplace).toHaveBeenCalledTimes(1)
        change(host, "Raw Category")
        await flushToolkit()
        expect(host.value).toBe("Raw Category")
        expect(host.querySelector('[slot="selected-value"]')).toHaveTextContent("Raw Category")
        expect(mocks.refreshMarketplace).toHaveBeenCalledTimes(1)
    })

    it("keeps the MCP timeout draft and sends one numeric RPC only on selection", async () => {
        const server: McpServer = { name: "Raw Server", source: "settings", config: '{"timeout":60}', status: "connected" }
        const { host } = await checkSwitches(
            <ServerRow server={server} />,
            "vscode-dropdown",
            "60",
            (language) => [
                ["30", translateUi(language, "capabilities.mcp.timeout.30")],
                ["60", translateUi(language, "capabilities.mcp.timeout.60")],
                ["300", translateUi(language, "capabilities.mcp.timeout.300")],
                ["600", translateUi(language, "capabilities.mcp.timeout.600")],
                ["1800", translateUi(language, "capabilities.mcp.timeout.1800")],
                ["3600", translateUi(language, "capabilities.mcp.timeout.3600")],
            ],
            () => fireEvent.click(document.querySelector(".flex-1")!),
        )
        expect(mocks.updateTimeout).not.toHaveBeenCalled()
        change(host, "300")
        await flushToolkit()
        expect(mocks.updateTimeout).toHaveBeenCalledExactlyOnceWith({ serverName: "Raw Server", timeout: 300 })
        expect(mocks.setServers).toHaveBeenCalledTimes(1)
    })

    it.each([
        undefined,
        "unknown/raw",
    ])("does not invent a selected label for unmatched ModelSelector value %s", async (selectedModelId) => {
        const tree = (language: UiLanguage) => (
            <UiLanguageProvider language={language}>
                <ModelSelector models={catalog.models} onChange={vi.fn()} selectedModelId={selectedModelId} />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        await flushToolkit()
        const host = view.container.querySelector("vscode-dropdown")!
        for (const language of ["zh-CN", "en"] as const) {
            view.rerender(tree(language))
            await flushToolkit()
            expect(view.container.querySelector("vscode-dropdown")).toBe(host)
            expect(host.querySelector('[slot="selected-value"]')).toBeNull()
        }
    })
})
