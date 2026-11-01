import type { ModelPricing } from "@shared/proto/dline/models/metadata"
import { AnthropicProviderConfig } from "@shared/proto/dline/provider/anthropic"
import { flatMeteredPricing } from "@shared/providers/pricing-shape"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { useCallback, useState } from "react"
import { expect, userEvent, within } from "storybook/test"
import { createStorybookDecorator } from "@/config/StorybookDecorator"
import { AnthropicProvider } from "./AnthropicProvider"
import type { ApiProfile } from "./ProviderProfile"

/**
 * The Anthropic card renders the same Pricing selector through
 * `ModelConfiguration`, and persists through its own `handlePricingUpdate`.
 *
 * Anthropic publishes cache-write and cache-read rates, so these stories also
 * check that the cache slots survive a shape switch: a switch that dropped them
 * would silently change what a stored cache token costs.
 */

/** Claude-family rates, per 1M tokens in USD. */
const CATALOG_PRICING: ModelPricing = flatMeteredPricing(3, 15, 3.75, 0.3, "USD")

function profileWith(pricing?: ModelPricing): ApiProfile {
    return {
        id: "profile-anthropic-story",
        name: "Anthropic",
        provider: "anthropic",
        apiKey: "sk-ant-storybook00000000000000",
        modelId: "claude-storybook",
        anthropic: AnthropicProviderConfig.create({
            pricing,
            capabilities: { contextWindow: 200_000, maxTokens: 64_000, supportsPromptCache: true },
        }),
    } as ApiProfile
}

/** The card backed by real state, so a selector change is visible immediately. */
function CardFixture({ initialPricing }: { readonly initialPricing?: ModelPricing }) {
    const [profile, setProfile] = useState<ApiProfile>(() => profileWith(initialPricing))
    const onUpdate = useCallback((updates: Partial<ApiProfile>) => {
        setProfile((current) => ({ ...current, ...updates, anthropic: updates.anthropic ?? current.anthropic }))
    }, [])

    return (
        <div className="flex w-[420px] flex-col rounded-xs border border-editor-widget-border p-3">
            <span className="mb-2 text-sm font-medium text-foreground">Anthropic</span>
            <AnthropicProvider onUpdate={onUpdate} profile={profile} showModelOptions />
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
    title: "Settings/Providers/AnthropicProviderPricing",
    component: CardFixture,
    parameters: { layout: "fullscreen" },
    decorators: [createStorybookDecorator(undefined, "p-6")],
} satisfies Meta<typeof CardFixture>

export default meta
type Story = StoryObj<typeof meta>

/** Stored flat rates include Claude's separate cache-write and cache-read prices. */
export const Flat: Story = {
    args: { initialPricing: CATALOG_PRICING },
    play: async (context) => {
        await openModelConfiguration(context)
        const canvas = within(context.canvasElement)
        await expect(canvas.getByLabelText("Pricing Mode")).toHaveTextContent("Flat rate")
        await expect(canvas.getByLabelText("Input Price ($/1M tokens)")).toHaveValue("3")
        await expect(canvas.getByLabelText("Cache Writes ($/1M tokens)")).toHaveValue("3.75")
        await expect(canvas.getByLabelText("Cache Reads ($/1M tokens)")).toHaveValue("0.3")
    },
}

/**
 * Context pricing on Anthropic: the tier editor appears, and the flat rate slots
 * disappear because only one strategy may be declared.
 */
export const ContextWindow: Story = {
    args: { initialPricing: CATALOG_PRICING },
    play: async (context) => {
        await openModelConfiguration(context)
        const canvas = within(context.canvasElement)
        await userEvent.click(canvas.getByLabelText("Pricing Mode"))
        await userEvent.click(await canvas.findByRole("option", { name: "By context size" }))

        await expect(canvas.getByLabelText("Pricing Mode")).toHaveTextContent("By context size")
        await expect(canvas.getByText("Pricing Tiers")).toBeVisible()
        await expect(canvas.queryByLabelText("Cache Reads ($/1M tokens)")).toBeNull()
    },
}

/**
 * Time-of-day pricing on Anthropic: the default rate and the window editor
 * replace the flat rates, and the cache rates carry over rather than resetting.
 */
export const TimeOfDay: Story = {
    args: { initialPricing: CATALOG_PRICING },
    play: async (context) => {
        await openModelConfiguration(context)
        const canvas = within(context.canvasElement)
        await userEvent.click(canvas.getByLabelText("Pricing Mode"))
        await userEvent.click(await canvas.findByRole("option", { name: "By time of day" }))

        await expect(canvas.getByLabelText("Pricing Mode")).toHaveTextContent("By time of day")
        await expect(canvas.getByLabelText("Default Input ($/1M)")).toHaveValue("3")
        await expect(canvas.getByLabelText("Default Output ($/1M)")).toHaveValue("15")
        await expect(canvas.getByText("Time Windows")).toBeVisible()
    },
}

/**
 * Anthropic's long-context tier is a separate capability surface. Choosing a
 * pricing shape must not disturb the context tier editor, which stays available
 * independently of how the model bills.
 */
export const ShapeDoesNotTouchContextTiers: Story = {
    args: { initialPricing: CATALOG_PRICING },
    play: async (context) => {
        await openModelConfiguration(context)
        const canvas = within(context.canvasElement)
        await expect(canvas.getByText("Context Tiers")).toBeVisible()

        await userEvent.click(canvas.getByLabelText("Pricing Mode"))
        await userEvent.click(await canvas.findByRole("option", { name: "By time of day" }))

        await expect(canvas.getByText("Context Tiers")).toBeVisible()
        await expect(canvas.getByText("Pricing Tiers")).toBeNull()
    },
}

/** A profile that has never stored pricing starts from Anthropic's catalog rate. */
export const CatalogDefaults: Story = {
    play: async (context) => {
        await openModelConfiguration(context)
        const canvas = within(context.canvasElement)
        await expect(canvas.getByLabelText("Pricing Mode")).toHaveTextContent("Flat rate")
    },
}
