import { AvailableModelsResponse } from "@shared/proto/dline/models"
import { ApiFormat, type ModelPricing, PricingDayRule, ServerTool } from "@shared/proto/dline/models/metadata"
import { ApiProfile as ProtoApiProfile } from "@shared/proto/dline/profile"
import { OpenAiProviderConfig } from "@shared/proto/dline/provider/openai"
import { flatMeteredPricing } from "@shared/providers/pricing-shape"
import type { UiLanguage } from "@shared/UiLanguage"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { useCallback, useState } from "react"
import { expect, userEvent, within } from "storybook/test"
import { createStorybookDecorator } from "@/config/StorybookDecorator"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import { ModelsServiceClient } from "@/services/grpc-client"
import { OpenAIProvider } from "./OpenAIProvider"
import type { ApiProfile } from "./ProviderProfile"

/**
 * The OpenAI card owns the Pricing selector end to end: `ModelConfiguration`
 * renders it, and `handlePricingUpdate` persists it through `mergePricing`.
 *
 * The story therefore drives the real card rather than the shared component
 * alone, so a regression in the provider's own update path shows up here.
 */

/** A flagship OpenAI-compatible catalog price, per 1M tokens in USD. */
const CATALOG_PRICING: ModelPricing = flatMeteredPricing(2.5, 10, 3.75, 1.25, "USD")

/** A local catalog, separate from the listing-only identities returned by the mock probe. */
const MODEL_CATALOG = AvailableModelsResponse.create({
    providers: [
        {
            provider: "openai",
            defaultModelId: "gpt-6-astra",
            models: [
                {
                    id: "gpt-6-astra",
                    name: "GPT-6 Astra",
                    apiFormats: [ApiFormat.OPENAI_RESPONSES],
                    capabilities: {
                        contextWindow: 1_050_000,
                        supportsPromptCache: true,
                        supportsReasoning: true,
                        tools: [ServerTool.WEB_SEARCH, ServerTool.IMAGE_GENERATION],
                        thinking: {
                            supported: true,
                            mode: "effort",
                            effortLevels: ["low", "medium", "high", "xhigh", "max"],
                            defaultEnabled: true,
                            canDisable: false,
                        },
                    },
                    pricing: CATALOG_PRICING,
                },
            ],
        },
    ],
})
let catalogVersion = 10_000

function remoteProfile(modelId = "remote-unknown-model", enabled?: boolean): ApiProfile {
    return ProtoApiProfile.create({
        id: "profile-remote-openai-story",
        name: "Remote OpenAI compatibility",
        provider: "openai",
        modelId,
        baseUrl: "https://gateway.invalid/v1",
        openai: OpenAiProviderConfig.create({
            apiFormat: ApiFormat.OPENAI_RESPONSES,
            ...(enabled === undefined ? {} : { reasoning: { enableThinking: enabled } }),
        }),
    })
}

function profileWith(pricing?: ModelPricing, apiFormat = ApiFormat.OPENAI_CHAT): ApiProfile {
    return {
        id: "profile-openai-story",
        name: "OpenAI",
        provider: "openai",
        apiKey: "sk-storybook0000000000000000",
        modelId: "gpt-storybook",
        baseUrl: "https://proxy.invalid/v1",
        openai: OpenAiProviderConfig.create({
            pricing,
            apiFormat,
            capabilities: { contextWindow: 400_000, maxTokens: 128_000, supportsPromptCache: true },
            streamIncludeUsage: true,
        }),
    } as ApiProfile
}

/**
 * The card backed by real state.
 *
 * `onUpdate` receives what the card would send to the host, and merging it back
 * into the profile is what makes the selector's result visible: the same round
 * trip the host performs, minus persistence.
 */
function CardFixture({
    initialPricing,
    apiFormat,
    initialProfile,
}: {
    readonly initialPricing?: ModelPricing
    readonly apiFormat?: ApiFormat
    readonly initialProfile?: ApiProfile
}) {
    const [profile, setProfile] = useState<ApiProfile>(() => initialProfile ?? profileWith(initialPricing, apiFormat))
    const [language, setLanguage] = useState<UiLanguage>("en")
    const onUpdate = useCallback((updates: Partial<ApiProfile>) => {
        setProfile((current) => ({
            ...current,
            ...updates,
            openai: updates.openai ?? current.openai,
        }))
    }, [])

    return (
        <UiLanguageProvider language={language}>
            <div className="flex w-[420px] flex-col rounded-xs border border-editor-widget-border p-3">
                <span className="mb-2 text-sm font-medium text-foreground">OpenAI</span>
                {initialProfile && (
                    <label className="mb-3 flex items-center justify-between gap-3">
                        Preview language
                        <select
                            aria-label="Preview language"
                            onChange={(event) => setLanguage(event.target.value === "zh-CN" ? "zh-CN" : "en")}
                            value={language}>
                            <option value="en">English</option>
                            <option value="zh-CN">简体中文</option>
                        </select>
                    </label>
                )}
                <OpenAIProvider onUpdate={onUpdate} profile={profile} showModelOptions />
                {initialProfile && (
                    <output aria-label="Saved reasoning" className="mt-3 break-words text-xs text-description">
                        {JSON.stringify(profile.openai?.reasoning ?? {})}
                    </output>
                )}
            </div>
        </UiLanguageProvider>
    )
}

const openModelConfiguration = async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement)
    const disclosure = canvas.getByRole("button", { name: /Model Configuration/i })
    await userEvent.click(disclosure)
    await expect(disclosure).toHaveAttribute("aria-expanded", "true")
}

const meta = {
    title: "Settings/Providers/OpenAIProviderPricing",
    component: CardFixture,
    parameters: { layout: "fullscreen" },
    decorators: [(Story) => createStorybookDecorator({ providersVersion: catalogVersion }, "p-6")(Story)],
    beforeEach: () => {
        // Install before React effects request the catalog. A new version makes
        // useProviderModels reload even when a different story populated its cache.
        catalogVersion += 1
        const getAvailableModels = ModelsServiceClient.getAvailableModels
        const refreshProviderModels = ModelsServiceClient.refreshProviderModels
        ModelsServiceClient.getAvailableModels = async () => MODEL_CATALOG
        ModelsServiceClient.refreshProviderModels = async () => ({ values: ["remote-unknown-model", "gpt-6.2-astra"] })
        return () => {
            ModelsServiceClient.getAvailableModels = getAvailableModels
            ModelsServiceClient.refreshProviderModels = refreshProviderModels
        }
    },
} satisfies Meta<typeof CardFixture>

export default meta
type Story = StoryObj<typeof meta>

/** A stored flat rate: the card shows one editable rate per slot. */
export const Flat: Story = {
    args: { initialPricing: CATALOG_PRICING },
    play: async (context) => {
        await openModelConfiguration(context)
        const canvas = within(context.canvasElement)
        await expect(canvas.getByLabelText("Pricing Mode")).toHaveTextContent("Flat rate")
        await expect(canvas.getByLabelText("Input Price ($/1M tokens)")).toHaveValue("2.5")
        await expect(canvas.getByLabelText("Output Price ($/1M tokens)")).toHaveValue("10")
    },
}

/**
 * Choosing `By context size` must persist a `contextWindow` strategy and swap
 * the rate fields for the tier editor. `OpenAIProvider` also flips
 * the legacy editing flag when bands appear. The declaration always keeps a
 * complete rate with an unbounded final band.
 */
export const ContextWindow: Story = {
    args: { initialPricing: CATALOG_PRICING },
    play: async (context) => {
        await openModelConfiguration(context)
        const canvas = within(context.canvasElement)
        await userEvent.click(canvas.getByLabelText("Pricing Mode"))
        await userEvent.click(
            await within(context.canvasElement.ownerDocument.body).findByRole("option", { name: "By context size" }),
        )

        await expect(canvas.getByLabelText("Pricing Mode")).toHaveTextContent("By context size")
        await expect(canvas.queryByLabelText("Input Price ($/1M tokens)")).toBeNull()
        await expect(canvas.getByText("Pricing Tiers")).toBeVisible()
    },
}

/**
 * Choosing `By time of day` opens the default rate and the window editor,
 * carrying the flat rate the profile published instead of resetting it to zero.
 */
export const TimeOfDay: Story = {
    args: { initialPricing: CATALOG_PRICING },
    play: async (context) => {
        await openModelConfiguration(context)
        const canvas = within(context.canvasElement)
        await userEvent.click(canvas.getByLabelText("Pricing Mode"))
        await userEvent.click(
            await within(context.canvasElement.ownerDocument.body).findByRole("option", { name: "By time of day" }),
        )

        await expect(canvas.getByLabelText("Pricing Mode")).toHaveTextContent("By time of day")
        await expect(canvas.getByLabelText("Default Input Price ($/1M tokens)")).toHaveValue("2.5")
        await expect(canvas.getByLabelText("Default Output Price ($/1M tokens)")).toHaveValue("10")
        await expect(canvas.getByText("Time Windows")).toBeVisible()
        await expect(canvas.queryByText("Pricing Tiers")).toBeNull()
    },
}

/**
 * A profile with no pricing of its own. Switching shape must still produce a
 * usable structure rather than silently doing nothing.
 */
export const EmptyProfileSwitch: Story = {
    play: async (context) => {
        await openModelConfiguration(context)
        const canvas = within(context.canvasElement)
        await userEvent.click(canvas.getByLabelText("Pricing Mode"))
        await userEvent.click(
            await within(context.canvasElement.ownerDocument.body).findByRole("option", { name: "By context size" }),
        )
        await expect(canvas.getByLabelText("Pricing Mode")).toHaveTextContent("By context size")
    },
}

/** The Responses protocol renders the same pricing controls as Chat. */
export const ResponsesProtocol: Story = {
    args: {
        apiFormat: ApiFormat.OPENAI_RESPONSES,
        initialPricing: {
            currency: "USD",
            strategy: {
                timeOfDay: {
                    schedule: {
                        timezoneOffsetMinutes: 0,
                        dayRule: PricingDayRule.PRICING_DAY_RULE_ALL_DAYS,
                        defaultOnPublicHolidays: false,
                        holidayCalendar: "",
                    },
                    defaultPrices: { inputPrice: 2, outputPrice: 8 },
                    timeWindows: [{ startMinute: 0, endMinute: 360, prices: { inputPrice: 4, outputPrice: 16 } }],
                },
            },
        },
    },
    play: async (context) => {
        await openModelConfiguration(context)
        const canvas = within(context.canvasElement)
        await expect(canvas.getByLabelText("Pricing Mode")).toHaveTextContent("By time of day")
        await expect(canvas.getByLabelText("Default Output Price ($/1M tokens)")).toHaveValue("8")
        // The protocol picker is independent of pricing.
        await expect(canvas.getByLabelText("API Format")).toBeVisible()
    },
}

/** Verify the selected wire format rather than comparing a constant to itself. */
export const DefaultProtocolIsChat: Story = {
    args: { initialPricing: CATALOG_PRICING },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)
        await expect(canvas.getByRole("combobox", { name: "API Format" })).toHaveValue(String(ApiFormat.OPENAI_CHAT))
    },
}

/** Real Toolkit/ThinkingControl; selecting High updates Saved reasoning without a network request. */
export const RemoteUnknownThinking: Story = {
    args: { initialProfile: remoteProfile() },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)
        await expect(canvas.getByRole("checkbox", { name: "Enable Thinking" })).toBeChecked()
        await expect(canvas.getByText("Provider default")).toBeVisible()
        await expect(canvas.getByText(/The model does not declare reasoning levels/)).toBeVisible()
        await expect(canvas.getByLabelText("Saved reasoning")).toHaveTextContent("{}")
    },
}

export const RemoteThinkingOff: Story = {
    args: { initialProfile: remoteProfile("remote-unknown-model", false) },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)
        await expect(canvas.getByRole("checkbox", { name: "Enable Thinking" })).not.toBeChecked()
        await expect(canvas.queryByText("Reasoning Effort")).toBeNull()
    },
}

/** The catalog mock provides the ancestor; the selected minor has only its remote identity. */
export const RemoteAstraThinking: Story = {
    args: { initialProfile: remoteProfile("gpt-6.2-astra") },
}

export const RemoteUnsupportedThinking: Story = {
    args: {
        initialProfile: {
            ...remoteProfile(),
            modelInfo: { id: "remote-unknown-model", capabilities: { supportsReasoning: false, supportsPromptCache: false } },
        },
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)
        await expect(canvas.queryByRole("checkbox", { name: "Enable Thinking" })).toBeNull()
    },
}
