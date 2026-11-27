// @vitest-environment jsdom
import { ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"
import { ApiProfile } from "@shared/proto/dline/profile"
import type { UiLanguage } from "@shared/UiLanguage"
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { type ComponentProps, useState } from "react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import { AnthropicProvider } from "./AnthropicProvider"
import { OpenAIProvider } from "./OpenAIProvider"

const models = {
    alpha: { id: "alpha", capabilities: { supportsImages: true, supportsTools: true, supportsPromptCache: true } },
    beta: { id: "beta", capabilities: { supportsImages: false, supportsTools: false, supportsPromptCache: false } },
    denied: { id: "denied", capabilities: { tools: [] } },
}
vi.mock("./useProviderModelOptions", () => ({
    useProviderModelOptions: () => ({
        models,
        options: models,
        defaultModelId: "alpha",
        modelInfoSaneDefaults: models.alpha,
        refreshRemoteModels: vi.fn(),
    }),
}))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => ({ remoteConfigSettings: {} }) }))
vi.mock("../common/ApiKeyField", () => ({ ApiKeyField: () => null }))
vi.mock("../common/BaseUrlField", () => ({ BaseUrlField: () => null }))
vi.mock("../common/DebouncedTextField", () => ({ DebouncedTextField: () => null }))
vi.mock("../ThinkingControl", () => ({ default: () => null }))
vi.mock("../OpenAIServiceTierSelector", () => ({ default: () => null }))
vi.mock("../common/ModelAutocomplete", () => ({
    ModelAutocomplete: ({ onChange, selectedModelId }: { onChange: (id: string) => void; selectedModelId: string }) => (
        <select aria-label="Model" onChange={(event) => onChange(event.target.value)} value={selectedModelId}>
            {Object.keys(models).map((id) => (
                <option key={id}>{id}</option>
            ))}
        </select>
    ),
}))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
    VSCodeCheckbox: ({ checked, children, disabled, onChange }: ComponentProps<"input">) => (
        <label>
            <input checked={checked ?? false} disabled={disabled} onChange={onChange} type="checkbox" />
            {children}
        </label>
    ),
    VSCodeButton: ({ children, onClick }: ComponentProps<"button">) => (
        <button onClick={onClick} type="button">
            {children}
        </button>
    ),
}))
afterEach(cleanup)

function ProfileHost({
    provider = "openai",
    modelId = "alpha",
    language = "en",
}: {
    provider?: string
    modelId?: string
    language?: UiLanguage
}) {
    const [profile, setProfile] = useState(() =>
        ApiProfile.create({
            id: "editing",
            provider,
            modelId,
            openai: provider === "openai" ? { apiFormat: ApiFormat.OPENAI_RESPONSES } : undefined,
        }),
    )
    const update = (updates: Partial<ApiProfile>) => setProfile((current) => ({ ...current, ...updates }))
    return (
        <UiLanguageProvider language={language}>
            <button
                onClick={() => setProfile(ApiProfile.create({ id: "editing", provider: "anthropic", modelId: "alpha" }))}
                type="button">
                Switch Provider
            </button>
            {profile.provider === "openai" ? (
                <OpenAIProvider onUpdate={update} profile={profile} showModelOptions />
            ) : (
                <AnthropicProvider onUpdate={update} profile={profile} showModelOptions />
            )}
            <output data-testid="saved-profile">{JSON.stringify(ApiProfile.toJSON(profile))}</output>
        </UiLanguageProvider>
    )
}
const openConfig = () => fireEvent.click(screen.getByRole("button", { name: "Model Configuration" }))
const savedProfile = () => ApiProfile.fromJSON(JSON.parse(screen.getByTestId("saved-profile").textContent ?? "null"))
function expectCapability(label: string, enabled: boolean) {
    const row = screen.getByText(label, { exact: true }).parentElement!
    expect(within(row).getByText(enabled ? "Yes" : "No", { exact: true })).toBeVisible()
    expect(row.querySelector("svg")).not.toBeNull()
}

describe("model capability editing", () => {
    it.each(["openai", "anthropic"])("lets an undeclared %s model opt into Search and clears it on model change", (provider) => {
        const { rerender } = render(<ProfileHost provider={provider} />)
        openConfig()
        const search = screen.getByRole("checkbox", { name: /Use hosted Web Search/ })
        expect(search).toBeEnabled()
        expect(search).not.toBeChecked()
        fireEvent.click(search)
        expect(screen.getByRole("checkbox", { name: /Use hosted Web Search/ })).toBeChecked()
        expect(savedProfile().modelInfo).toMatchObject({ id: "alpha", capabilities: { tools: [ServerTool.WEB_SEARCH] } })
        fireEvent.click(screen.getByRole("checkbox", { name: /Use hosted Web Search/ }))
        expect(savedProfile()[provider === "openai" ? "openai" : "anthropic"]?.disabledServerTools).toContain(
            ServerTool.WEB_SEARCH,
        )
        fireEvent.click(screen.getByRole("checkbox", { name: /Use hosted Web Search/ }))
        expect(savedProfile()[provider === "openai" ? "openai" : "anthropic"]?.disabledServerTools).not.toContain(
            ServerTool.WEB_SEARCH,
        )
        rerender(<ProfileHost language="zh-CN" provider={provider} />)
        expect(screen.getByRole("checkbox", { name: /使用托管网页搜索/ })).toBeChecked()
        rerender(<ProfileHost provider={provider} />)
        fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: "beta" } })
        openConfig()
        expect(screen.getByRole("checkbox", { name: /Use hosted Web Search/ })).toBeEnabled()
        expect(screen.getByRole("checkbox", { name: /Use hosted Web Search/ })).not.toBeChecked()
        expect(savedProfile().modelInfo?.capabilities?.tools).toBeUndefined()
    })

    it("does not replace an explicitly empty tools declaration", () => {
        render(<ProfileHost modelId="denied" />)
        openConfig()
        expect(screen.getByRole("checkbox", { name: /Use hosted Web Search/ })).toBeDisabled()
    })

    it.each([
        "openai",
        "anthropic",
    ])("keeps %s checkboxes and capability rows in sync across edits and model switches", (provider) => {
        render(<ProfileHost provider={provider} />)
        openConfig()
        for (const [check, row] of [
            ["Supports Images", "Images"],
            ["Supports Native Tool Calls", "Native Tool Calls"],
            ["Supports Prompt Cache", "Prompt Caching"],
        ]) {
            expect(screen.getByRole("checkbox", { name: check })).toBeChecked()
            expectCapability(row, true)
            fireEvent.click(screen.getByRole("checkbox", { name: check }))
            expect(screen.getByRole("checkbox", { name: check })).not.toBeChecked()
            expectCapability(row, false)
        }
        fireEvent.change(screen.getByRole("combobox", { name: "Model" }), { target: { value: "beta" } })
        openConfig()
        expect(screen.getByRole("checkbox", { name: "Supports Images" })).not.toBeChecked()
        expectCapability("Images", false)
        fireEvent.click(screen.getByRole("button", { name: "Switch Provider" }))
        openConfig()
        expect(screen.getByRole("checkbox", { name: "Supports Images" })).toBeChecked()
        expectCapability("Images", true)
        expectCapability("Native Tool Calls", true)
        expectCapability("Prompt Caching", true)
    })

    it("uses the explicit browser setting instead of hosted Search or image heuristics", () => {
        render(<ProfileHost provider="anthropic" />)
        openConfig()
        expect(screen.getByRole("checkbox", { name: "Supports Browser Actions" })).toBeChecked()
        fireEvent.click(screen.getByRole("checkbox", { name: "Supports Browser Actions" }))
        expectCapability("Browser", false)
        expectCapability("Images", true)
        fireEvent.click(screen.getByRole("checkbox", { name: /Use hosted Web Search/ }))
        expectCapability("Browser", false)
    })
})
