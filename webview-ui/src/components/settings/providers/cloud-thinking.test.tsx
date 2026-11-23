// @vitest-environment jsdom
import type { ModelInfo } from "@shared/proto/dline/models"
import { ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"
import { ApiProfile } from "@shared/proto/dline/profile"
import { flatMeteredPricing, readPriceSet } from "@shared/providers/pricing-shape"
import { fireEvent, render, screen } from "@testing-library/react"
import {
    type AnchorHTMLAttributes,
    type ButtonHTMLAttributes,
    Children,
    type InputHTMLAttributes,
    isValidElement,
    type ReactNode,
    type SelectHTMLAttributes,
    useState,
} from "react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import { AIhubmixProvider } from "./AihubmixProvider"
import { AnthropicProvider } from "./AnthropicProvider"
import { AskSageProvider } from "./AskSageProvider"
import { BasetenProvider } from "./BasetenProvider"
import { BedrockProvider } from "./BedrockProvider"
import { CerebrasProvider } from "./CerebrasProvider"
import { ClaudeCodeProvider } from "./ClaudeCodeProvider"
import { DeepSeekProvider } from "./DeepSeekProvider"
import { DoubaoProvider } from "./DoubaoProvider"
import { FireworksProvider } from "./FireworksProvider"
import { GeminiProvider } from "./GeminiProvider"
import { GroqProvider } from "./GroqProvider"
import { HicapProvider } from "./HicapProvider"
import { HuaweiCloudMaasProvider } from "./HuaweiCloudMaasProvider"
import { HuggingFaceProvider } from "./HuggingFaceProvider"
import { MinimaxProvider } from "./MiniMaxProvider"
import { MistralProvider } from "./MistralProvider"
import { MoonshotProvider } from "./MoonshotProvider"
import { NebiusProvider } from "./NebiusProvider"
import { NousResearchProvider } from "./NousresearchProvider"
import { OcaProvider } from "./OcaProvider"
import { OpenAIProvider } from "./OpenAIProvider"
import { OpenAiCodexProvider } from "./OpenAiCodexProvider"
import { QwenCodeProvider } from "./QwenCodeProvider"
import { QwenProvider } from "./QwenProvider"
import { RequestyProvider } from "./RequestyProvider"
import { SambanovaProvider } from "./SambanovaProvider"
import { SapAiCoreProvider } from "./SapAiCoreProvider"
import { TogetherProvider } from "./TogetherProvider"
import { VercelAIGatewayProvider } from "./VercelAIGatewayProvider"
import { VertexProvider } from "./VertexProvider"
import { WandbProvider } from "./WandbProvider"
import { XaiProvider } from "./XaiProvider"
import { ZAiProvider } from "./ZAiProvider"

const models: Record<string, ModelInfo> = {
    "effort-alias": {
        id: "effort-alias",
        capabilities: {
            thinking: {
                supported: true,
                mode: "effort",
                effortLevels: ["low"],
                defaultEffort: "low",
                defaultEnabled: true,
                canDisable: false,
            },
        },
    },
    "budget-alias": {
        id: "budget-alias",
        capabilities: { thinking: { supported: true, mode: "budget", maxBudget: 3000, defaultEnabled: true } },
    },
}

const codexModels: Record<string, ModelInfo> = {
    ...models,
    "gpt-6-codex": {
        id: "gpt-6-codex",
        apiFormats: [ApiFormat.OPENAI_CHAT],
        pricing: flatMeteredPricing(3, 15),
        capabilities: {
            contextWindow: 999_999,
            maxTokens: 1234,
            supportsTools: true,
            tools: [ServerTool.WEB_SEARCH],
            supportsPromptCache: false,
            supportsReasoning: true,
            thinking: {
                supported: true,
                mode: "effort",
                effortLevels: ["low", "high", "max"],
                defaultEffort: "high",
                defaultEnabled: true,
                canDisable: false,
            },
        },
    },
    "gpt-6.2-codex": {
        id: "gpt-6.2-codex",
        capabilities: {
            supportsPromptCache: false,
            thinking: {
                supported: true,
                mode: "effort",
                effortLevels: ["none", "low", "medium", "high"],
                defaultEnabled: true,
                canDisable: true,
            },
        },
    },
    "gpt-6.5-codex": { id: "gpt-6.5-codex", capabilities: { thinking: { supported: false } } },
}
const claudeModels: Record<string, ModelInfo> = {
    ...models,
    "claude-opus-6-1": {
        id: "claude-opus-6-1",
        capabilities: {
            thinking: { supported: true, mode: "effort", effortLevels: ["low"], defaultEffort: "low" },
        },
    },
    "claude-opus-6-2": {
        id: "claude-opus-6-2",
        apiFormats: [ApiFormat.ANTHROPIC_CHAT],
        pricing: flatMeteredPricing(3, 15),
        capabilities: {
            contextWindow: 999_999,
            maxTokens: 1234,
            supportsTools: true,
            tools: [ServerTool.WEB_SEARCH],
            supportsPromptCache: false,
            supportsReasoning: true,
            thinking: {
                supported: true,
                mode: "effort",
                effortLevels: ["low", "high", "max"],
                defaultEffort: "high",
                defaultEnabled: true,
                canDisable: false,
            },
        },
    },
    "claude-sonnet-6-1": {
        id: "claude-sonnet-6-1",
        capabilities: {
            supportsPromptCache: false,
            supportsReasoning: true,
            thinking: { supported: true, mode: "budget", minBudget: 17, maxBudget: 3000, defaultEnabled: true },
        },
    },
    "claude-opus-6-5": { id: "claude-opus-6-5", capabilities: { thinking: { supported: false } } },
}

function providerModels(providerId: string) {
    return providerId === "openai-codex"
        ? codexModels
        : providerId === "anthropic" || providerId === "claude-code"
          ? claudeModels
          : models
}

vi.mock("./useProviderModels", () => ({
    useProviderModels: (providerId: string) => ({
        models: providerModels(providerId),
        defaultModelId: "effort-alias",
        modelInfoSaneDefaults: models["effort-alias"],
    }),
}))
vi.mock("./useProviderModelOptions", () => ({
    useProviderModelOptions: ({ providerId }: { providerId: string }) => ({
        models: providerModels(providerId),
        defaultModelId: "effort-alias",
        modelInfoSaneDefaults: models["effort-alias"],
        options: providerModels(providerId),
        refreshRemoteModels: vi.fn(),
    }),
}))
vi.mock("./OpenAiCodexOAuthControl", () => ({ OpenAiCodexOAuthControl: () => null }))
vi.mock("./ClaudeCodeOAuthControl", () => ({ ClaudeCodeOAuthControl: () => null }))
vi.mock("../common/ModelAutocomplete", () => ({
    ModelAutocomplete: ({ onChange, selectedModelId }: { onChange: (value: string) => void; selectedModelId: string }) => (
        <input aria-label="Model" onChange={(event) => onChange(event.target.value)} value={selectedModelId} />
    ),
}))
vi.mock("../common/ModelConfiguration", () => ({ ModelConfiguration: () => null }))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => ({ remoteConfigSettings: {} }) }))
vi.mock("../ApiOptions", () => ({
    DROPDOWN_Z_INDEX: 1000,
    DropdownContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}))
vi.mock("../common/ModelSelector", () => ({
    DropdownContainer: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    ModelSelector: ({
        onChange,
        selectedModelId,
    }: {
        onChange: React.ChangeEventHandler<HTMLInputElement>
        selectedModelId: string
    }) => <input aria-label="Model" onChange={onChange} value={selectedModelId} />,
}))
vi.mock("../common/ModelInfoView", () => ({
    ModelInfoView: ({ modelInfo }: { modelInfo: ModelInfo }) => (
        <>
            <span data-testid="model-id">{modelInfo.id}</span>
            <span data-testid="model-info">{JSON.stringify(modelInfo)}</span>
        </>
    ),
}))
vi.mock("../common/DebouncedTextField", () => ({ DebouncedTextField: () => <div /> }))
vi.mock("../common/ApiKeyField", () => ({ ApiKeyField: () => <div /> }))
vi.mock("../common/BaseUrlField", () => ({ BaseUrlField: () => <div /> }))
vi.mock("../common/RemotelyConfiguredInputWrapper", () => ({
    RemotelyConfiguredInputWrapper: ({ children }: { children: ReactNode }) => <>{children}</>,
    LockIcon: () => <span />,
}))
vi.mock("@/components/ui/tooltip", () => ({
    Tooltip: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipTrigger: ({ children }: { children: ReactNode }) => <>{children}</>,
    TooltipContent: () => null,
}))
vi.mock("@vscode/webview-ui-toolkit/react", () => ({
    VSCodeButton: ({ children, ...props }: ButtonHTMLAttributes<HTMLButtonElement>) => (
        <button type="button" {...props}>
            {children}
        </button>
    ),
    VSCodeCheckbox: ({ children, ...props }: InputHTMLAttributes<HTMLInputElement>) => (
        <label>
            <input {...props} type="checkbox" />
            {children}
        </label>
    ),
    VSCodeDropdown: ({ children, ...props }: SelectHTMLAttributes<HTMLSelectElement>) => (
        <select {...props}>
            {Children.toArray(children).filter(
                (child) => !isValidElement<{ slot?: string }>(child) || child.props.slot !== "selected-value",
            )}
        </select>
    ),
    VSCodeOption: ({ children, value }: { children: ReactNode; value: string }) => <option value={value}>{children}</option>,
    VSCodeRadioGroup: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    VSCodeRadio: ({ children }: { children: ReactNode }) => <span>{children}</span>,
    VSCodeTextField: ({ children: _children, ...props }: InputHTMLAttributes<HTMLInputElement>) => <input {...props} />,
    VSCodeLink: (props: AnchorHTMLAttributes<HTMLAnchorElement>) => <a {...props} />,
}))

for (const [provider, Panel] of [
    ["openai", OpenAIProvider],
    ["openai-codex", OpenAiCodexProvider],
    ["qwen", QwenProvider],
    ["deepseek", DeepSeekProvider],
] as const) {
    it(`${provider} preserves a profile-carried model identity before resolving thinking`, () => {
        const onUpdate = vi.fn()
        const profile = ApiProfile.create({
            provider,
            modelInfo: {
                id: "carried-thinking",
                capabilities: { supportsReasoning: false, thinking: { supported: false, effortLevels: [] } },
            },
        })
        render(<Panel onUpdate={onUpdate} profile={profile} showModelOptions={true} />)
        expect(screen.getByRole("textbox", { name: "Model" })).toHaveValue("carried-thinking")
        expect(screen.getByTestId("model-id")).toHaveTextContent("carried-thinking")
        expect(JSON.parse(screen.getByTestId("model-info").textContent ?? "null").capabilities.thinking).toEqual({
            supported: false,
            effortLevels: [],
        })
        expect(screen.queryByRole("checkbox", { name: "Enable Thinking" })).not.toBeInTheDocument()
        expect(onUpdate).not.toHaveBeenCalled()
    })
}

for (const [provider, configKey, Panel] of [
    ["baseten", "baseten", BasetenProvider],
    ["groq", "groq", GroqProvider],
    ["huawei-cloud-maas", "huaweiCloudMaas", HuaweiCloudMaasProvider],
    ["minimax", "minimax", MinimaxProvider],
    ["aihubmix", "aihubmix", AIhubmixProvider],
    ["fireworks", "fireworks", FireworksProvider],
    ["doubao", "doubao", DoubaoProvider],
    ["cerebras", "cerebras", CerebrasProvider],
    ["huggingface", "huggingface", HuggingFaceProvider],
    ["asksage", "asksage", AskSageProvider],
    ["zai", "zai", ZAiProvider],
    ["xai", "xai", XaiProvider],
    ["wandb", "wandb", WandbProvider],
    ["together", "together", TogetherProvider],
    ["sapaicore", "sapaicore", SapAiCoreProvider],
    ["sambanova", "sambanova", SambanovaProvider],
    ["requesty", "requesty", RequestyProvider],
    ["nousResearch", "nousResearch", NousResearchProvider],
    ["qwen-code", "qwenCode", QwenCodeProvider],
    ["nebius", "nebius", NebiusProvider],
    ["moonshot", "moonshot", MoonshotProvider],
    ["mistral", "mistral", MistralProvider],
    ["hicap", "hicap", HicapProvider],
] as const) {
    describe(`${provider} effective information projection`, () => {
        beforeEach(() => {
            if (provider === "asksage") {
                vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ response: [] }) }))
            }
        })
        afterEach(() => vi.unstubAllGlobals())

        it("rejects stale metadata and default capabilities for an explicit unknown selection", () => {
            const onUpdate = vi.fn()
            const profile = ApiProfile.create({ provider, modelId: "unknown-ui", modelInfo: models["effort-alias"] })
            render(<Panel onUpdate={onUpdate} profile={profile} showModelOptions={true} />)
            expect(JSON.parse(screen.getByTestId("model-info").textContent ?? "null")).toEqual({
                id: "unknown-ui",
                capabilities: { supportsPromptCache: true },
            })
            expect(screen.getByRole("textbox", { name: "Model" })).toHaveValue("unknown-ui")
            expect(onUpdate).not.toHaveBeenCalled()
        })

        it("keeps profile-carried identity and full declarations aligned with the picker", () => {
            const onUpdate = vi.fn()
            const profile = ApiProfile.create({
                provider,
                modelInfo: {
                    id: "opaque-ui",
                    capabilities: { supportsReasoning: false, thinking: { supported: false, effortLevels: [], maxBudget: 0 } },
                    pricing: flatMeteredPricing(0, 0),
                },
            })
            render(<Panel onUpdate={onUpdate} profile={profile} showModelOptions={true} />)
            const projected = JSON.parse(screen.getByTestId("model-info").textContent ?? "null")
            expect(projected).toEqual({
                id: "opaque-ui",
                capabilities: {
                    supportsPromptCache: true,
                    supportsReasoning: false,
                    thinking: { supported: false, effortLevels: [], maxBudget: 0 },
                },
                pricing: flatMeteredPricing(0, 0),
            })
            // The carried price set survives as a readable rate, not an empty shell.
            expect(readPriceSet(projected.pricing.strategy.flat.prices).inputPrice).toBe(0)
            expect(screen.getByRole("textbox", { name: "Model" })).toHaveValue("opaque-ui")
            expect(onUpdate).not.toHaveBeenCalled()
        })

        it("displays catalog overrides but persists raw selected metadata rather than the effective clone", () => {
            const onUpdate = vi.fn()
            const profile = ApiProfile.create({
                provider,
                modelId: "effort-alias",
                modelInfo: models["budget-alias"],
                [configKey]: {
                    capabilities: { supportsReasoning: false, thinking: { supported: false, effortLevels: [], maxBudget: 0 } },
                    pricing: flatMeteredPricing(0, 0),
                },
            })
            render(<Panel onUpdate={onUpdate} profile={profile} showModelOptions={true} />)
            const catalogProjection = JSON.parse(screen.getByTestId("model-info").textContent ?? "null")
            expect(catalogProjection).toMatchObject({
                id: "effort-alias",
                capabilities: {
                    supportsReasoning: false,
                    thinking: { supported: false, mode: "effort", effortLevels: [], defaultEffort: "low", maxBudget: 0 },
                },
            })
            // The override's carried rates reach the projection as real prices.
            expect(readPriceSet(catalogProjection.pricing.strategy.flat.prices)).toEqual({
                inputPrice: 0,
                outputPrice: 0,
                cacheWritePrice: 0,
                cacheReadPrice: 0,
            })
            expect(onUpdate).not.toHaveBeenCalled()
            fireEvent.change(screen.getByRole("textbox", { name: "Model" }), { target: { value: "budget-alias" } })
            expect(onUpdate).toHaveBeenCalledWith({ modelId: "budget-alias", modelInfo: models["budget-alias"] })
        })
    })
}

for (const [provider, configKey, Panel] of [
    ["vertex", "vertex", VertexProvider],
    ["bedrock", "bedrock", BedrockProvider],
    ["gemini", "gemini", GeminiProvider],
    ["vercel-ai-gateway", "vercelAiGateway", VercelAIGatewayProvider],
    ["openai", "openai", OpenAIProvider],
    ["openai-codex", "openaiCodex", OpenAiCodexProvider],
] as const) {
    describe(`${provider} thinking controls`, () => {
        it("uses an opaque model's declared effort, default and disable constraint", () => {
            const profile = ApiProfile.create({ provider, modelId: "effort-alias" })
            render(<Panel onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)
            const checkbox = screen.getByRole("checkbox", { name: "Enable Thinking" })
            expect(checkbox).toBeChecked()
            expect(checkbox).toBeDisabled()
            expect(screen.getAllByRole("combobox").filter((item) => item.textContent === "Low")).toHaveLength(1)
            expect(screen.queryByRole("slider")).not.toBeInTheDocument()
        })

        it("applies the provider's unknown-model policy without borrowing stale thinking metadata", () => {
            const profile = ApiProfile.create({
                provider,
                modelId: "claude-opus-4-7-unknown",
                modelInfo: models["effort-alias"],
                [configKey]: { reasoning: { enableThinking: true, effort: "high", thinkingBudget: 2000 } },
            })
            render(<Panel onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)
            if (provider === "openai" || provider === "openai-codex") {
                expect(screen.getByRole("checkbox", { name: "Enable Thinking" })).toBeChecked()
                const info = JSON.parse(screen.getByTestId("model-info").textContent ?? "null")
                expect(info.capabilities.thinking.effortLevels).toEqual([
                    "none",
                    "minimal",
                    "low",
                    "medium",
                    "high",
                    "xhigh",
                    "max",
                    "ultra",
                ])
                expect(info.capabilities.thinking.canDisable).toBe(true)
                expect(screen.queryByRole("slider")).not.toBeInTheDocument()
            } else {
                expect(screen.queryByRole("checkbox", { name: "Enable Thinking" })).not.toBeInTheDocument()
            }
            expect(screen.getByTestId("model-id")).toHaveTextContent("claude-opus-4-7-unknown")
        })

        it("does not derive a budget mode from a declared maximum or coarse reasoning flag", () => {
            const profile = ApiProfile.create({
                provider,
                modelId: "opaque-no-mode",
                modelInfo: {
                    id: "opaque-no-mode",
                    capabilities: { supportsReasoning: true, thinking: { supported: true, maxBudget: 3000 } },
                },
                [configKey]: { reasoning: { enableThinking: true, effort: "low", thinkingBudget: 2000 } },
            })
            render(<Panel onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)
            if (provider === "openai" || provider === "openai-codex") {
                expect(screen.getByRole("checkbox", { name: "Enable Thinking" })).toBeChecked()
                expect(screen.queryByRole("slider")).not.toBeInTheDocument()
                const info = JSON.parse(screen.getByTestId("model-info").textContent ?? "null")
                expect(info.capabilities.thinking.mode).toBe("effort")
                expect(info.capabilities.thinking.effortLevels).toEqual([
                    "none",
                    "minimal",
                    "low",
                    "medium",
                    "high",
                    "xhigh",
                    "max",
                    "ultra",
                ])
            } else {
                expect(screen.queryByRole("checkbox", { name: "Enable Thinking" })).not.toBeInTheDocument()
            }
        })

        it("keeps an explicit empty effort list instead of offering a provider-wide whitelist", () => {
            const profile = ApiProfile.create({
                provider,
                modelId: "effort-alias",
                [configKey]: { capabilities: { thinking: { effortLevels: [] } } },
            })
            render(<Panel onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)
            expect(screen.getByRole("checkbox", { name: "Enable Thinking" })).toBeChecked()
            expect(screen.queryByText("Reasoning Effort")).not.toBeInTheDocument()
            expect(screen.queryByText("Thinking Mode")).not.toBeInTheDocument()
            expect(screen.queryByRole("slider")).not.toBeInTheDocument()
        })

        it("honors an explicit false capability override", () => {
            const profile = ApiProfile.create({
                provider,
                modelId: "effort-alias",
                [configKey]: { capabilities: { thinking: { supported: false } } },
            })
            render(<Panel onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)
            expect(screen.queryByRole("checkbox", { name: "Enable Thinking" })).not.toBeInTheDocument()
        })

        it("uses the effective minimum override rather than a provider constant", () => {
            const onUpdate = vi.fn()
            const profile = ApiProfile.create({
                provider,
                modelId: "budget-alias",
                [configKey]: { capabilities: { thinking: { minBudget: 17 } }, reasoning: { thinkingBudget: 1500 } },
            })
            render(<Panel onUpdate={onUpdate} profile={profile} showModelOptions={true} />)
            const slider = screen.getByRole("slider")
            expect(slider).toHaveAttribute("min", "17")
            fireEvent.change(slider, { target: { value: "3" } })
            fireEvent.mouseUp(slider)
            expect(onUpdate.mock.calls[0][0][configKey].reasoning.thinkingBudget).toBe(17)
        })

        it("persists a bounded budget edit with the existing display preference", () => {
            const onUpdate = vi.fn()
            const profile = ApiProfile.create({
                provider,
                modelId: "budget-alias",
                [configKey]: { reasoning: { thinkingBudget: 1500, display: "omitted" } },
            })
            render(<Panel onUpdate={onUpdate} profile={profile} showModelOptions={true} />)
            const slider = screen.getByRole("slider")
            expect(slider).toHaveAttribute("max", "3000")
            fireEvent.change(slider, { target: { value: "2400" } })
            fireEvent.mouseUp(slider)
            expect(onUpdate).toHaveBeenCalledWith({
                [configKey]: {
                    ...profile[configKey],
                    reasoning: { enableThinking: true, effort: undefined, thinkingBudget: 2400, display: "omitted" },
                },
            })
        })
    })
}

for (const [provider, configKey, Panel] of [
    ["openai", "openai", OpenAIProvider],
    ["openai-codex", "openaiCodex", OpenAiCodexProvider],
] as const) {
    describe(`${provider} selected metadata`, () => {
        it("retains a matching complete Profile declaration instead of rereading catalog thinking", () => {
            const profile = ApiProfile.create({
                provider,
                modelId: "effort-alias",
                modelInfo: { id: "effort-alias", capabilities: { thinking: { supported: false } } },
                [configKey]: { reasoning: { enableThinking: true, effort: "low" } },
            })
            render(<Panel onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)
            expect(screen.queryByRole("checkbox", { name: "Enable Thinking" })).not.toBeInTheDocument()
        })

        it("edits a declared minimum without inventing an upper bound", () => {
            const onUpdate = vi.fn()
            const profile = ApiProfile.create({
                provider,
                modelId: "unbounded-budget",
                modelInfo: {
                    id: "unbounded-budget",
                    capabilities: { thinking: { supported: true, mode: "budget", minBudget: 17, defaultEnabled: true } },
                },
                [configKey]: { reasoning: { thinkingBudget: 23 } },
            })
            render(<Panel onUpdate={onUpdate} profile={profile} showModelOptions={true} />)
            const input = screen.getByRole("spinbutton", { name: "Thinking Budget" })
            expect(input).toHaveAttribute("min", "17")
            expect(input).not.toHaveAttribute("max")
            fireEvent.change(input, { target: { value: "3" } })
            fireEvent.blur(input)
            expect(onUpdate.mock.calls[0][0][configKey].reasoning.thinkingBudget).toBe(17)
        })
    })
}

for (const [provider, configKey, Panel] of [
    ["qwen", "qwen", QwenProvider],
    ["oca", "oca", OcaProvider],
] as const) {
    describe(`${provider} matched budget controls`, () => {
        it("edits the effective minimum and preserves the existing display preference", () => {
            const onUpdate = vi.fn()
            const profile = ApiProfile.create({
                provider,
                modelId: "budget-alias",
                modelInfo: models["budget-alias"],
                [configKey]: {
                    capabilities: { thinking: { minBudget: 17 } },
                    reasoning: { thinkingBudget: 1500, display: "omitted" },
                },
            })
            render(<Panel onUpdate={onUpdate} profile={profile} showModelOptions={true} />)
            const slider = screen.getByRole("slider")
            expect(slider).toHaveAttribute("min", "17")
            fireEvent.change(slider, { target: { value: "3" } })
            fireEvent.mouseUp(slider)
            expect(onUpdate.mock.calls[0][0][configKey].reasoning).toEqual({
                enableThinking: true,
                effort: undefined,
                thinkingBudget: 17,
                display: "omitted",
            })
        })

        it.each(["stale", "unsupported", "missing-mode"])("does not manufacture controls for %s metadata", (state) => {
            const profile = ApiProfile.create({
                provider,
                modelId: "qwen3-32b",
                modelInfo: {
                    id: state === "stale" ? "another-model" : "qwen3-32b",
                    capabilities: {
                        thinking: {
                            supported: state !== "unsupported",
                            mode: state === "missing-mode" ? undefined : "budget",
                            maxBudget: 101,
                        },
                    },
                },
                [configKey]: { reasoning: { thinkingBudget: 23 } },
            })
            render(<Panel onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)
            expect(screen.queryByRole("checkbox", { name: /Enable Thinking/i })).not.toBeInTheDocument()
        })

        it("keeps required thinking on without persisting a fabricated budget", () => {
            const onUpdate = vi.fn()
            const profile = ApiProfile.create({
                provider,
                modelId: "required-budget",
                modelInfo: {
                    id: "required-budget",
                    capabilities: { thinking: { supported: true, mode: "budget", minBudget: 17, canDisable: false } },
                },
                [configKey]: { reasoning: { enableThinking: false, thinkingBudget: 0 } },
            })
            render(<Panel onUpdate={onUpdate} profile={profile} showModelOptions={true} />)
            expect(screen.getByRole("checkbox", { name: "Enable Thinking" })).toBeChecked()
            expect(screen.getByRole("checkbox", { name: "Enable Thinking" })).toBeDisabled()
            expect(onUpdate).not.toHaveBeenCalled()
        })
    })
}

function projectedModel(): ModelInfo {
    return JSON.parse(screen.getByTestId("model-info").textContent ?? "null")
}

describe("Anthropic manual thinking", () => {
    function renderProfile(
        initialProfile = ApiProfile.create({ id: "manual", provider: "anthropic", modelId: "opaque-manual" }),
    ) {
        const onUpdate = vi.fn()
        function Fixture() {
            const [profile, setProfile] = useState(initialProfile)
            return (
                <AnthropicProvider
                    onUpdate={(updates) => {
                        onUpdate(updates)
                        setProfile((current) => ({ ...current, ...updates }))
                    }}
                    profile={profile}
                    showModelOptions
                />
            )
        }
        render(<Fixture />)
        return onUpdate
    }

    function selectMode(mode: "Effort" | "Budget") {
        fireEvent.click(screen.getByRole("combobox", { name: "Thinking Mode" }))
        fireEvent.click(screen.getByRole("option", { name: mode, exact: true }))
    }

    it("exposes the existing manual controls without inferring or saving a mode", () => {
        const onUpdate = renderProfile()
        expect(screen.getByRole("checkbox", { name: "Enable Thinking" })).not.toBeChecked()
        expect(projectedModel().capabilities?.thinking).toBeUndefined()
        expect(onUpdate).not.toHaveBeenCalled()
        fireEvent.click(screen.getByRole("checkbox", { name: "Enable Thinking" }))
        expect(screen.getByRole("combobox", { name: "Thinking Mode" })).toHaveTextContent("Choose a thinking mode")
        expect(screen.queryByRole("combobox", { name: "Adaptive Thinking" })).not.toBeInTheDocument()
        expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument()
        expect(projectedModel().capabilities?.thinking).toBeUndefined()
        expect(onUpdate.mock.calls.at(-1)?.[0].anthropic.reasoning).toMatchObject({ enableThinking: true })
        expect(onUpdate.mock.calls.at(-1)?.[0].anthropic.reasoning.effort).toBeUndefined()
        expect(onUpdate.mock.calls.at(-1)?.[0].anthropic.reasoning.thinkingBudget).toBeUndefined()
    })

    it("saves a manually selected effort as a Profile override without fabricating a level", () => {
        const onUpdate = renderProfile()
        fireEvent.click(screen.getByRole("checkbox", { name: "Enable Thinking" }))
        selectMode("Effort")
        expect(screen.getByRole("combobox", { name: "Thinking Mode" })).toHaveTextContent("Effort")
        expect(screen.getByRole("combobox", { name: "Adaptive Thinking" })).toHaveTextContent("Provider default")
        expect(projectedModel().capabilities?.thinking).toMatchObject({ supported: true, mode: "effort" })
        expect(projectedModel().capabilities?.thinking?.defaultEffort).toBeUndefined()
        expect(onUpdate.mock.calls.at(-1)?.[0].anthropic.reasoning.effort).toBeUndefined()
        fireEvent.click(screen.getByRole("combobox", { name: "Adaptive Thinking" }))
        fireEvent.click(screen.getByRole("option", { name: "High", exact: true }))
        const saved = onUpdate.mock.calls.at(-1)?.[0].anthropic
        expect(saved.capabilities.thinking).toMatchObject({ supported: true, mode: "effort" })
        expect(saved.reasoning).toMatchObject({ enableThinking: true, effort: "high" })
        expect(saved.reasoning.thinkingBudget).toBeUndefined()
        expect(onUpdate.mock.calls.every(([patch]) => !Object.hasOwn(patch, "modelInfo"))).toBe(true)
    })

    it("keeps Budget selected before entering tokens and clears inactive values when switching modes", () => {
        const onUpdate = renderProfile(
            ApiProfile.create({
                id: "manual-budget",
                provider: "anthropic",
                modelId: "opaque-manual",
                anthropic: { reasoning: { display: "omitted" } },
            }),
        )
        fireEvent.click(screen.getByRole("checkbox", { name: "Enable Thinking" }))
        selectMode("Budget")
        expect(screen.getByRole("combobox", { name: "Thinking Mode" })).toHaveTextContent("Budget")
        const budget = screen.getByRole("spinbutton")
        expect(budget).not.toHaveAttribute("max")
        expect(onUpdate.mock.calls.at(-1)?.[0].anthropic.reasoning.thinkingBudget).toBeUndefined()
        fireEvent.change(budget, { target: { value: "4096" } })
        fireEvent.blur(budget)
        expect(onUpdate.mock.calls.at(-1)?.[0].anthropic.reasoning).toEqual({
            enableThinking: true,
            effort: undefined,
            thinkingBudget: 4096,
            display: "omitted",
        })
        selectMode("Effort")
        expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument()
        const saved = onUpdate.mock.calls.at(-1)?.[0].anthropic
        expect(saved.capabilities.thinking.mode).toBe("effort")
        expect(saved.reasoning.thinkingBudget).toBeUndefined()
        expect(saved.reasoning.effort).toBeUndefined()
        expect(saved.reasoning.display).toBe("omitted")
        fireEvent.click(screen.getByRole("checkbox", { name: "Enable Thinking" }))
        expect(onUpdate.mock.calls.at(-1)?.[0].anthropic.reasoning.enableThinking).toBe(false)
        expect(screen.queryByRole("combobox", { name: "Thinking Mode" })).not.toBeInTheDocument()
    })
})

describe("Codex compatible inheritance", () => {
    it("enables opaque thinking without saving or selecting medium", () => {
        const onUpdate = vi.fn()
        const profile = ApiProfile.create({
            id: "codex-opaque",
            provider: "openai-codex",
            modelId: "opaque-ui",
            modelInfo: codexModels["gpt-6-codex"],
        })
        render(<OpenAiCodexProvider onUpdate={onUpdate} profile={profile} showModelOptions />)
        expect(screen.getByRole("checkbox", { name: "Enable Thinking" })).toBeChecked()
        expect(screen.getByRole("combobox", { name: "Reasoning Effort" })).toHaveTextContent("Provider default")
        expect(screen.getByText(/The model does not declare reasoning levels/)).toBeInTheDocument()
        expect(projectedModel().capabilities?.thinking).toEqual({
            supported: true,
            mode: "effort",
            effortLevels: ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"],
            defaultEnabled: true,
            canDisable: true,
        })
        expect(onUpdate).not.toHaveBeenCalled()
    })

    it.each([
        ["gpt-6.1-codex", ["low", "high", "max"], "high"],
        ["gpt-6.2-codex", ["none", "low", "medium", "high"], "high"],
        ["gpt-6.3-codex", ["none", "low", "medium", "high"], undefined],
        ["gpt-6.1-codex-fast", ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"], undefined],
        ["gpt-7.1-codex", ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"], undefined],
        ["gpt-6.1", ["none", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"], undefined],
    ])("resolves %s only within the Codex major and exact variant", (modelId, effortLevels, defaultEffort) => {
        const profile = ApiProfile.create({ provider: "openai-codex", modelId })
        render(<OpenAiCodexProvider onUpdate={vi.fn()} profile={profile} showModelOptions />)
        expect(projectedModel().capabilities?.thinking?.effortLevels).toEqual(effortLevels)
        expect(projectedModel().capabilities?.thinking?.defaultEffort).toBe(defaultEffort)
    })

    it("keeps inherited explicit levels out of the compatibility explanation even when they match its choices", () => {
        const profile = ApiProfile.create({ provider: "openai-codex", modelId: "gpt-6.3-codex" })
        render(<OpenAiCodexProvider onUpdate={vi.fn()} profile={profile} showModelOptions />)
        expect(projectedModel().capabilities?.supportsPromptCache).toBe(false)
        expect(screen.queryByText(/The model does not declare reasoning levels/)).not.toBeInTheDocument()
    })

    it("does not copy an ancestor's prices, context, tools or protocol", () => {
        const profile = ApiProfile.create({ provider: "openai-codex", modelId: "gpt-6.1-codex" })
        render(<OpenAiCodexProvider onUpdate={vi.fn()} profile={profile} showModelOptions />)
        expect(projectedModel()).toEqual({
            id: "gpt-6.1-codex",
            capabilities: {
                supportsPromptCache: false,
                supportsReasoning: true,
                thinking: codexModels["gpt-6-codex"].capabilities?.thinking,
            },
        })
        expect(screen.getByRole("combobox", { name: "API Format" })).toHaveValue(String(ApiFormat.OPENAI_RESPONSES))
    })
})

for (const [provider, configKey, Panel] of [
    ["anthropic", "anthropic", AnthropicProvider],
    ["claude-code", "claudeCode", ClaudeCodeProvider],
] as const) {
    describe(`${provider} Claude inheritance`, () => {
        it.each(["claude-opus-6-3", "claude-opus-6.3"])("inherits the nearest older effort declaration for %s", (modelId) => {
            const onUpdate = vi.fn()
            const profile = ApiProfile.create({ provider, modelId, modelInfo: models["budget-alias"] })
            render(<Panel onUpdate={onUpdate} profile={profile} showModelOptions />)
            expect(screen.getByRole("checkbox", { name: "Enable Thinking" })).toBeChecked()
            expect(screen.getByRole("checkbox", { name: "Enable Thinking" })).toBeDisabled()
            expect(screen.getByRole("combobox", { name: "Adaptive Thinking" })).toHaveTextContent("High")
            expect(projectedModel().capabilities?.thinking?.effortLevels).toEqual(["low", "high", "max"])
            expect(onUpdate).not.toHaveBeenCalled()
        })

        it("inherits a native budget declaration and persists a bounded edit", () => {
            const onUpdate = vi.fn()
            const profile = ApiProfile.create({
                provider,
                modelId: "claude-sonnet-6-2",
                [configKey]: { reasoning: { thinkingBudget: 1500, display: "omitted" } },
            })
            render(<Panel onUpdate={onUpdate} profile={profile} showModelOptions />)
            const slider = screen.getByRole("slider")
            expect(slider).toHaveAttribute("min", "17")
            expect(slider).toHaveAttribute("max", "3000")
            expect(screen.queryByRole("combobox", { name: "Adaptive Thinking" })).not.toBeInTheDocument()
            fireEvent.change(slider, { target: { value: "2400" } })
            fireEvent.mouseUp(slider)
            expect(onUpdate.mock.calls[0][0][configKey].reasoning).toEqual({
                enableThinking: true,
                effort: undefined,
                thinkingBudget: 2400,
                display: "omitted",
            })
        })

        it.each([
            "claude-opus-6-0",
            "claude-opus-7-1",
            "claude-haiku-6-3",
            "claude-opus-6-3:fast",
            "claude-opus-6-3-20261119",
            "claude-opus-6-20261119",
            "claude-sonnet-6-20261119",
            "opaque-ui",
        ])("does not invent a mode or borrow stale metadata for %s", (modelId) => {
            const onUpdate = vi.fn()
            const profile = ApiProfile.create({
                provider,
                modelId,
                modelInfo: claudeModels["claude-opus-6-2"],
                [configKey]: { reasoning: { enableThinking: true, effort: "high", thinkingBudget: 1500 } },
            })
            render(<Panel onUpdate={onUpdate} profile={profile} showModelOptions />)
            expect(projectedModel()).toEqual({ id: modelId, capabilities: { supportsPromptCache: true } })
            if (provider === "anthropic") {
                expect(screen.getByRole("checkbox", { name: "Enable Thinking" })).toBeChecked()
                expect(screen.getByRole("combobox", { name: "Thinking Mode" })).toHaveTextContent("Choose a thinking mode")
                expect(screen.queryByRole("combobox", { name: "Adaptive Thinking" })).not.toBeInTheDocument()
                expect(screen.queryByRole("spinbutton")).not.toBeInTheDocument()
            } else {
                expect(screen.queryByRole("checkbox", { name: "Enable Thinking" })).not.toBeInTheDocument()
            }
            expect(onUpdate).not.toHaveBeenCalled()
        })

        it.each([
            { supportsReasoning: false },
            { thinking: { supported: false } },
        ])("honors an explicit negative base declaration %j", (capabilities) => {
            const profile = ApiProfile.create({
                provider,
                modelId: "claude-opus-6-3",
                modelInfo: { id: "claude-opus-6-3", capabilities },
            })
            render(<Panel onUpdate={vi.fn()} profile={profile} showModelOptions />)
            expect(screen.queryByRole("checkbox", { name: "Enable Thinking" })).not.toBeInTheDocument()
        })

        it("keeps a base empty effort list and user override above inherited declarations", () => {
            const profile = ApiProfile.create({
                provider,
                modelId: "claude-opus-6-3",
                modelInfo: { id: "claude-opus-6-3", capabilities: { thinking: { effortLevels: [] } } },
                [configKey]: { capabilities: { supportsPromptCache: true, thinking: { canDisable: true } } },
            })
            render(<Panel onUpdate={vi.fn()} profile={profile} showModelOptions />)
            expect(screen.getByRole("checkbox", { name: "Enable Thinking" })).toBeChecked()
            expect(screen.getByRole("checkbox", { name: "Enable Thinking" })).not.toBeDisabled()
            expect(screen.queryByRole("combobox", { name: "Adaptive Thinking" })).not.toBeInTheDocument()
            expect(projectedModel().capabilities).toMatchObject({
                supportsPromptCache: true,
                thinking: { effortLevels: [], canDisable: true, mode: "effort" },
            })
        })

        it("keeps a user negative override above an inherited declaration", () => {
            const profile = ApiProfile.create({
                provider,
                modelId: "claude-opus-6-3",
                [configKey]: { capabilities: { thinking: { supported: false } } },
            })
            render(<Panel onUpdate={vi.fn()} profile={profile} showModelOptions />)
            expect(projectedModel().capabilities?.thinking?.supported).toBe(false)
            expect(screen.queryByRole("checkbox", { name: "Enable Thinking" })).not.toBeInTheDocument()
        })

        it("does not copy an ancestor's prices, context, tools or protocol", () => {
            const profile = ApiProfile.create({ provider, modelId: "claude-opus-6-3" })
            render(<Panel onUpdate={vi.fn()} profile={profile} showModelOptions />)
            expect(projectedModel()).toEqual({
                id: "claude-opus-6-3",
                capabilities: {
                    supportsPromptCache: false,
                    supportsReasoning: true,
                    thinking: claudeModels["claude-opus-6-2"].capabilities?.thinking,
                },
            })
        })

        it("preserves the provider's existing base priority", () => {
            const profile = ApiProfile.create({
                provider,
                modelId: "claude-opus-6-2",
                modelInfo: { id: "claude-opus-6-2", capabilities: { thinking: { supported: false } } },
            })
            render(<Panel onUpdate={vi.fn()} profile={profile} showModelOptions />)
            expect(projectedModel().capabilities?.thinking?.supported).toBe(provider === "anthropic")
        })
    })
}

for (const [provider, configKey, Panel, modelId] of [
    ["openai-codex", "openaiCodex", OpenAiCodexProvider, "gpt-6.1-codex"],
    ["anthropic", "anthropic", AnthropicProvider, "claude-opus-6-3"],
    ["claude-code", "claudeCode", ClaudeCodeProvider, "claude-opus-6-3"],
] as const) {
    describe(`${provider} inherited state isolation`, () => {
        it("persists only the raw selected metadata, never the inherited projection", () => {
            const onUpdate = vi.fn()
            const profile = ApiProfile.create({ provider, modelId })
            const view = render(<Panel onUpdate={onUpdate} profile={profile} showModelOptions />)
            const catalog = providerModels(provider)
            fireEvent.change(screen.getByRole("textbox", { name: "Model" }), { target: { value: "budget-alias" } })
            expect(onUpdate).toHaveBeenLastCalledWith({ modelId: "budget-alias", modelInfo: catalog["budget-alias"] })
            expect(onUpdate.mock.calls.at(-1)?.[0].modelInfo).toBe(catalog["budget-alias"])
            view.rerender(
                <Panel
                    onUpdate={onUpdate}
                    profile={{ ...profile, modelId: "budget-alias", modelInfo: catalog["budget-alias"] }}
                    showModelOptions
                />,
            )
            fireEvent.change(screen.getByRole("textbox", { name: "Model" }), { target: { value: modelId } })
            expect(onUpdate).toHaveBeenLastCalledWith({ modelId, modelInfo: undefined })
            expect(onUpdate.mock.calls.at(-1)?.[0]).toHaveProperty("modelInfo", undefined)
            view.rerender(
                <Panel onUpdate={onUpdate} profile={{ ...profile, modelInfo: catalog["budget-alias"] }} showModelOptions />,
            )
            expect(projectedModel().capabilities?.thinking?.mode).toBe("effort")
        })

        it("does not leak the old Profile's override or reasoning into a new Profile", () => {
            const onUpdate = vi.fn()
            const profile = ApiProfile.create({
                id: "old-profile",
                provider,
                modelId,
                [configKey]: { capabilities: { thinking: { supported: false } }, reasoning: { effort: "low" } },
            })
            const view = render(<Panel onUpdate={onUpdate} profile={profile} showModelOptions />)
            expect(screen.queryByRole("checkbox", { name: "Enable Thinking" })).not.toBeInTheDocument()
            view.rerender(
                <Panel
                    onUpdate={onUpdate}
                    profile={ApiProfile.create({ id: "new-profile", provider, modelId })}
                    showModelOptions
                />,
            )
            expect(screen.getByRole("checkbox", { name: "Enable Thinking" })).toBeChecked()
            expect(
                screen.getByRole("combobox", { name: provider === "openai-codex" ? "Reasoning Effort" : "Adaptive Thinking" }),
            ).toHaveTextContent("High")
            expect(onUpdate).not.toHaveBeenCalled()
        })

        it("saves a real effort and preserves raw reasoning through English/Chinese switches", () => {
            const onUpdate = vi.fn()
            let profile = ApiProfile.create({
                id: "language-profile",
                provider,
                modelId,
                [configKey]: { reasoning: { display: "omitted" } },
            })
            const tree = (language: "en" | "zh-CN") => (
                <UiLanguageProvider language={language}>
                    <Panel onUpdate={onUpdate} profile={profile} showModelOptions />
                </UiLanguageProvider>
            )
            const view = render(tree("en"))
            fireEvent.click(
                screen.getByRole("combobox", { name: provider === "openai-codex" ? "Reasoning Effort" : "Adaptive Thinking" }),
            )
            fireEvent.click(screen.getByRole("option", { name: "Max" }))
            const saved = onUpdate.mock.calls[0][0][configKey]
            expect(saved.reasoning).toEqual({
                enableThinking: true,
                effort: "max",
                thinkingBudget: undefined,
                display: "omitted",
            })
            profile = { ...profile, [configKey]: saved }
            view.rerender(tree("zh-CN"))
            const selector = screen.getByRole("combobox", { name: provider === "openai-codex" ? "推理强度" : "自适应思考" })
            expect(selector).toHaveTextContent("Max")
            view.rerender(tree("en"))
            expect(
                screen.getByRole("combobox", { name: provider === "openai-codex" ? "Reasoning Effort" : "Adaptive Thinking" }),
            ).toBe(selector)
            expect(selector).toHaveTextContent("Max")
            expect(profile[configKey]?.reasoning?.effort).toBe("max")
            expect(onUpdate).toHaveBeenCalledTimes(1)
        })
    })
}

describe("Bedrock custom base thinking", () => {
    it("uses only the explicitly selected base declaration while preserving the custom ARN", () => {
        const profile = ApiProfile.create({
            provider: "bedrock",
            modelId: "arn:custom",
            bedrock: { awsBedrockCustomSelected: true, awsBedrockCustomModelBaseId: "effort-alias" },
        })
        render(<BedrockProvider onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)
        expect(screen.getByRole("checkbox", { name: "Enable Thinking" })).toBeDisabled()
        expect(screen.getByTestId("model-id")).toHaveTextContent("arn:custom")
    })

    it("does not borrow the provider default for an unknown explicit base", () => {
        const profile = ApiProfile.create({
            provider: "bedrock",
            modelId: "arn:custom",
            bedrock: { awsBedrockCustomSelected: true, awsBedrockCustomModelBaseId: "unknown-base" },
        })
        render(<BedrockProvider onUpdate={vi.fn()} profile={profile} showModelOptions={true} />)
        expect(screen.queryByRole("checkbox", { name: "Enable Thinking" })).not.toBeInTheDocument()
    })
})
