import {
    ClaudeCodeAuthStatus,
    ClaudeCodeAuthStatusResponse,
    OpenAiCodexAuthStatus,
    OpenAiCodexAuthStatusResponse,
} from "@shared/proto/dline/account"
import { AvailableModelsResponse, type ModelInfo } from "@shared/proto/dline/models"
import { ApiFormat, ServerTool } from "@shared/proto/dline/models/metadata"
import { ApiProfile } from "@shared/proto/dline/profile"
import { AnthropicProviderConfig } from "@shared/proto/dline/provider/anthropic"
import { ClaudeCodeProviderConfig } from "@shared/proto/dline/provider/claude_code"
import { OpenAiCodexProviderConfig } from "@shared/proto/dline/provider/openai_codex"
import { flatMeteredPricing } from "@shared/providers/pricing-shape"
import type { UiLanguage } from "@shared/UiLanguage"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { useCallback, useState } from "react"
import { expect, userEvent, waitFor, within } from "storybook/test"
import { createStorybookDecorator } from "@/config/StorybookDecorator"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import { AccountServiceClient, ModelsServiceClient } from "@/services/grpc-client"
import { AnthropicProvider } from "./AnthropicProvider"
import { ClaudeCodeProvider } from "./ClaudeCodeProvider"
import { OpenAiCodexProvider } from "./OpenAiCodexProvider"

type FixtureProvider = "openai-codex" | "anthropic" | "claude-code"

const effortModel: ModelInfo = {
    id: "claude-opus-6-1",
    apiFormats: [ApiFormat.ANTHROPIC_CHAT],
    capabilities: {
        contextWindow: 999_999,
        maxTokens: 1234,
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
    pricing: flatMeteredPricing(3, 15),
}
const budgetModel: ModelInfo = {
    id: "claude-sonnet-6-1",
    capabilities: {
        supportsReasoning: true,
        thinking: { supported: true, mode: "budget", minBudget: 17, maxBudget: 3000, defaultEnabled: true },
    },
}
const claudeModels = [effortModel, budgetModel, { id: "claude-opus-6-2" }, { id: "claude-sonnet-6-2" }, { id: "claude-opus-7-1" }]
const catalog = AvailableModelsResponse.create({
    providers: [
        {
            provider: "openai-codex",
            defaultModelId: "gpt-6-codex",
            models: [{ ...effortModel, id: "gpt-6-codex", apiFormats: [ApiFormat.OPENAI_RESPONSES] }, { id: "gpt-6.1-codex" }],
        },
        { provider: "anthropic", defaultModelId: effortModel.id, models: claudeModels },
        { provider: "claude-code", defaultModelId: effortModel.id, models: claudeModels },
    ],
})
let catalogVersion = 20_000

function makeProfile(provider: FixtureProvider, modelId: string): ApiProfile {
    return ApiProfile.create({
        id: `inheritance-${provider}`,
        name: "Offline inheritance fixture",
        provider,
        modelId,
        apiKey: "sk-fake-storybook-only",
        baseUrl: "https://provider.invalid/v1",
    })
}

/** The real provider card, Toolkit and ThinkingControl, with host saves echoed in memory. */
function InheritanceFixture({ initialProfile }: { initialProfile: ApiProfile }) {
    const [profile, setProfile] = useState(initialProfile)
    const [language, setLanguage] = useState<UiLanguage>("en")
    const onUpdate = useCallback((updates: Partial<ApiProfile>) => {
        setProfile((current) => ({ ...current, ...updates }))
    }, [])
    const config = profile.provider === "openai-codex" ? profile.openaiCodex : (profile.anthropic ?? profile.claudeCode)
    const Panel =
        profile.provider === "openai-codex"
            ? OpenAiCodexProvider
            : profile.provider === "anthropic"
              ? AnthropicProvider
              : ClaudeCodeProvider

    return (
        <UiLanguageProvider language={language}>
            <div className="flex w-full max-w-[420px] flex-col gap-3 rounded-xs border border-editor-widget-border p-3">
                <h2 className="text-sm font-medium">{profile.provider} · offline inheritance</h2>
                <label className="flex items-center justify-between gap-3">
                    Preview language
                    <select
                        aria-label="Preview language"
                        onChange={(event) => setLanguage(event.target.value === "zh-CN" ? "zh-CN" : "en")}
                        value={language}>
                        <option value="en">English</option>
                        <option value="zh-CN">简体中文</option>
                    </select>
                </label>
                <Panel onUpdate={onUpdate} profile={profile} showModelOptions />
                <output aria-label="Saved reasoning" className="break-words text-xs text-description">
                    {JSON.stringify(config?.reasoning ?? {})}
                </output>
                <output aria-label="Saved model" className="break-words text-xs text-description">
                    {JSON.stringify({ modelId: profile.modelId, modelInfo: profile.modelInfo ?? null })}
                </output>
            </div>
        </UiLanguageProvider>
    )
}

/** Exercise a real Radix portal and an in-place language switch without inventing an effort. */
async function saveEffort({ canvasElement }: { canvasElement: HTMLElement }, label = "Max") {
    const canvas = within(canvasElement)
    const selector = await canvas.findByRole("combobox", { name: /Reasoning Effort|Adaptive Thinking/ })
    await userEvent.click(selector)
    await userEvent.click(await within(canvasElement.ownerDocument.body).findByRole("option", { name: label }))
    await expect(canvas.getByLabelText("Saved reasoning")).toHaveTextContent(`"effort":"${label.toLowerCase()}"`)
    await userEvent.selectOptions(canvas.getByLabelText("Preview language"), "zh-CN")
    await expect(canvas.getByRole("combobox", { name: /推理强度|自适应思考/ })).toBe(selector)
    await expect(selector).toHaveTextContent(label)
    await expect(canvas.getByLabelText("Saved reasoning")).toHaveTextContent(`"effort":"${label.toLowerCase()}"`)
    await userEvent.selectOptions(canvas.getByLabelText("Preview language"), "en")
    await expect(canvas.getByRole("combobox", { name: /Reasoning Effort|Adaptive Thinking/ })).toBe(selector)
}

const meta = {
    title: "Settings/Providers/ModelInheritance",
    component: InheritanceFixture,
    parameters: { layout: "fullscreen" },
    decorators: [(Story) => createStorybookDecorator({ providersVersion: catalogVersion }, "p-6")(Story)],
    beforeEach: () => {
        // Install before effects, and invalidate useProviderModels' cross-story catalog cache.
        catalogVersion += 1
        const getAvailableModels = ModelsServiceClient.getAvailableModels
        const refreshProviderModels = ModelsServiceClient.refreshProviderModels
        const getCodexStatus = AccountServiceClient.getOpenAiCodexAuthStatus
        const getClaudeStatus = AccountServiceClient.getClaudeCodeAuthStatus
        const accountRequest = AccountServiceClient.makeUnaryRequest
        ModelsServiceClient.getAvailableModels = async () => catalog
        ModelsServiceClient.refreshProviderModels = async ({ providerId }) => ({
            values: providerId === "openai-codex" ? ["opaque-ui", "gpt-6.1-codex"] : ["claude-opus-6-2", "claude-sonnet-6-2"],
        })
        AccountServiceClient.getOpenAiCodexAuthStatus = async ({ profileId }) =>
            OpenAiCodexAuthStatusResponse.create({ profileId, status: OpenAiCodexAuthStatus.OPEN_AI_CODEX_AUTH_STATUS_MISSING })
        AccountServiceClient.getClaudeCodeAuthStatus = async ({ profileId }) =>
            ClaudeCodeAuthStatusResponse.create({ profileId, status: ClaudeCodeAuthStatus.CLAUDE_CODE_AUTH_STATUS_MISSING })
        // Even accidental sign-in/usage actions cannot reach the host or an external service.
        AccountServiceClient.makeUnaryRequest = async () => {
            throw new Error("Authentication is disabled in this offline Storybook fixture.")
        }
        return () => {
            ModelsServiceClient.getAvailableModels = getAvailableModels
            ModelsServiceClient.refreshProviderModels = refreshProviderModels
            AccountServiceClient.getOpenAiCodexAuthStatus = getCodexStatus
            AccountServiceClient.getClaudeCodeAuthStatus = getClaudeStatus
            AccountServiceClient.makeUnaryRequest = accountRequest
        }
    },
} satisfies Meta<typeof InheritanceFixture>

export default meta
type Story = StoryObj<typeof meta>

export const CodexUnknown: Story = {
    args: { initialProfile: makeProfile("openai-codex", "opaque-ui") },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)
        await expect(canvas.getByRole("checkbox", { name: "Enable Thinking" })).toBeChecked()
        await expect(canvas.getByRole("combobox", { name: "Reasoning Effort" })).toHaveTextContent("Provider default")
        await expect(canvas.getByLabelText("Saved reasoning")).toHaveTextContent("{}")
        await saveEffort({ canvasElement }, "High")
    },
}

export const CodexMinor: Story = {
    args: { initialProfile: makeProfile("openai-codex", "gpt-6.1-codex") },
    play: async (context) => {
        const canvas = within(context.canvasElement)
        await waitFor(() => expect(canvas.getByRole("combobox", { name: "Reasoning Effort" })).toHaveTextContent("High"))
        await expect(canvas.getByRole("checkbox", { name: "Enable Thinking" })).toBeDisabled()
        await saveEffort(context)
    },
}

export const CodexOff: Story = {
    args: {
        initialProfile: {
            ...makeProfile("openai-codex", "opaque-ui"),
            openaiCodex: OpenAiCodexProviderConfig.create({ reasoning: { enableThinking: false } }),
        },
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)
        await expect(canvas.getByRole("checkbox", { name: "Enable Thinking" })).not.toBeChecked()
        await expect(canvas.queryByRole("combobox", { name: "Reasoning Effort" })).toBeNull()
    },
}

export const CodexUnsupported: Story = {
    args: {
        initialProfile: {
            ...makeProfile("openai-codex", "opaque-ui"),
            modelInfo: { id: "opaque-ui", capabilities: { supportsReasoning: false } },
        },
    },
    play: async ({ canvasElement }) => {
        await expect(within(canvasElement).queryByRole("checkbox", { name: "Enable Thinking" })).toBeNull()
    },
}

export const AnthropicEffort: Story = {
    args: { initialProfile: makeProfile("anthropic", "claude-opus-6-2") },
    play: async (context) => saveEffort(context),
}

export const AnthropicBudget: Story = {
    args: {
        initialProfile: {
            ...makeProfile("anthropic", "claude-sonnet-6-2"),
            anthropic: AnthropicProviderConfig.create({
                reasoning: { enableThinking: true, thinkingBudget: 1500, display: "omitted" },
            }),
        },
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)
        const slider = await canvas.findByRole("slider")
        await expect(slider).toHaveAttribute("min", "17")
        await expect(slider).toHaveAttribute("max", "3000")
        await expect(canvas.queryByRole("combobox", { name: "Adaptive Thinking" })).toBeNull()
    },
}

export const AnthropicUnknown: Story = {
    args: { initialProfile: makeProfile("anthropic", "claude-opus-7-1") },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)
        const toggle = await canvas.findByRole("checkbox", { name: "Enable Thinking" })
        await expect(toggle).not.toBeChecked()
        await expect(canvas.getByLabelText("Saved reasoning")).toHaveTextContent("{}")
        await userEvent.click(toggle)
        const mode = canvas.getByRole("combobox", { name: "Thinking Mode" })
        await expect(mode).toHaveTextContent("Choose a thinking mode")
        await expect(canvas.queryByRole("combobox", { name: "Adaptive Thinking" })).toBeNull()
        await userEvent.click(mode)
        await userEvent.click(await within(canvasElement.ownerDocument.body).findByRole("option", { name: "Effort" }))
        await expect(canvas.getByRole("combobox", { name: "Adaptive Thinking" })).toHaveTextContent("Provider default")
        await saveEffort({ canvasElement }, "High")
    },
}

export const ClaudeEffort: Story = {
    args: { initialProfile: makeProfile("claude-code", "claude-opus-6-2") },
    play: async (context) => saveEffort(context),
}

export const ClaudeBudget: Story = {
    args: {
        initialProfile: {
            ...makeProfile("claude-code", "claude-sonnet-6-2"),
            claudeCode: ClaudeCodeProviderConfig.create({
                reasoning: { enableThinking: true, thinkingBudget: 1500, display: "omitted" },
            }),
        },
    },
    play: AnthropicBudget.play,
}

export const ClaudeUnknown: Story = {
    args: { initialProfile: makeProfile("claude-code", "claude-opus-7-1") },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)
        await expect(canvas.queryByRole("checkbox", { name: "Enable Thinking" })).toBeNull()
        await expect(canvas.getByLabelText("Saved reasoning")).toHaveTextContent("{}")
    },
}

export const AnthropicSnapshot: Story = {
    args: { initialProfile: makeProfile("anthropic", "claude-opus-6-20261119") },
    play: AnthropicUnknown.play,
}

export const ClaudeSnapshot: Story = {
    args: { initialProfile: makeProfile("claude-code", "claude-opus-6-20261119") },
    play: ClaudeUnknown.play,
}

export const ClaudeEmpty: Story = {
    args: {
        initialProfile: {
            ...makeProfile("claude-code", "claude-opus-6-2"),
            claudeCode: ClaudeCodeProviderConfig.create({ capabilities: { thinking: { effortLevels: [] } } }),
        },
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)
        await expect(await canvas.findByRole("checkbox", { name: "Enable Thinking" })).toBeDisabled()
        await expect(canvas.queryByRole("combobox", { name: "Adaptive Thinking" })).toBeNull()
    },
}
