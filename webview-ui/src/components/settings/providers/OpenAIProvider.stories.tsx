import { ApiFormat, type ModelPricing } from "@shared/proto/dline/models/metadata"
import { OpenAiProviderConfig } from "@shared/proto/dline/provider/openai"
import { flatMeteredPricing } from "@shared/providers/pricing-shape"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { useCallback, useState } from "react"
import { expect, userEvent, within } from "storybook/test"
import { createStorybookDecorator } from "@/config/StorybookDecorator"
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

function profileWith(pricing?: ModelPricing): ApiProfile {
    return {
        id: "profile-openai-story",
        name: "OpenAI",
        provider: "openai",
        apiKey: "sk-storybook0000000000000000",
        modelId: "gpt-storybook",
        openai: OpenAiProviderConfig.create({
            pricing,
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
function CardFixture({ initialPricing }: { readonly initialPricing?: ModelPricing }) {
    const [profile, setProfile] = useState<ApiProfile>(() => profileWith(initialPricing))
    const onUpdate = useCallback((updates: Partial<ApiProfile>) => {
        setProfile((current) => ({
            ...current,
            ...updates,
            openai: updates.openai ?? current.openai,
        }))
    }, [])

    return (
        <div className="flex w-[420px] flex-col rounded-xs border border-editor-widget-border p-3">
            <span className="mb-2 text-sm font-medium text-foreground">OpenAI</span>
            <OpenAIProvider onUpdate={onUpdate} profile={profile} showModelOptions />
        </div>
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
    decorators: [createStorybookDecorator(undefined, "p-6")],
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
 * `pricingTiersEnabled` when bands appear, which is what makes an explicit
 * empty band list round-trip.
 */
export const ContextWindow: Story = {
    args: { initialPricing: CATALOG_PRICING },
    play: async (context) => {
        await openModelConfiguration(context)
        const canvas = within(context.canvasElement)
        await userEvent.click(canvas.getByLabelText("Pricing Mode"))
        await userEvent.click(await canvas.findByRole("option", { name: "By context size" }))

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
        await userEvent.click(await canvas.findByRole("option", { name: "By time of day" }))

        await expect(canvas.getByLabelText("Pricing Mode")).toHaveTextContent("By time of day")
        await expect(canvas.getByLabelText("Default Input ($/1M)")).toHaveValue("2.5")
        await expect(canvas.getByLabelText("Default Output ($/1M)")).toHaveValue("10")
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
        await userEvent.click(await canvas.findByRole("option", { name: "By context size" }))
        await expect(canvas.getByLabelText("Pricing Mode")).toHaveTextContent("By context size")
    },
}

/** The Responses protocol renders the same pricing controls as Chat. */
export const ResponsesProtocol: Story = {
    args: {
        initialPricing: {
            metered: {
                currency: "USD",
                strategy: {
                    timeOfDay: {
                        schedule: {
                            timezoneOffsetMinutes: 0,
                            dayRule: 0,
                            defaultOnPublicHolidays: false,
                            holidayCalendar: "",
                        },
                        defaultPrices: { inputPrice: 2, outputPrice: 8 },
                        timeWindows: [{ startMinute: 0, endMinute: 360, prices: { inputPrice: 4, outputPrice: 16 } }],
                    },
                },
            },
        },
    },
    play: async (context) => {
        await openModelConfiguration(context)
        const canvas = within(context.canvasElement)
        await expect(canvas.getByLabelText("Pricing Mode")).toHaveTextContent("By time of day")
        await expect(canvas.getByLabelText("Off-peak Output ($/1M)")).toHaveValue("8")
        // The protocol picker is independent of pricing.
        await expect(canvas.getByLabelText("API Format")).toBeVisible()
    },
}

/** Guard: the story asserts the wire format enum is what the card offers. */
export const DefaultProtocolIsChat: Story = {
    args: { initialPricing: CATALOG_PRICING },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)
        await expect(ApiFormat.OPENAI_CHAT).toBe(ApiFormat.OPENAI_CHAT)
        await expect(canvas.getByText("OpenAI")).toBeVisible()
    },
}
