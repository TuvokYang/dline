import type { ModelInfo } from "@shared/proto/dline/models"
import type { PricingTimeWindow } from "@shared/proto/dline/models/metadata"
import {
    type ContextWindowBand,
    type ModelCapabilities,
    type ModelPricing,
    PricingDayRule,
} from "@shared/proto/dline/models/metadata"
import { flatMeteredPricing } from "@shared/providers/pricing-shape"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { expect, userEvent, within } from "storybook/test"
import { createStorybookDecorator } from "@/config/StorybookDecorator"
import { ModelConfiguration } from "./ModelConfiguration"

/**
 * The Pricing selector is the same control OpenAI and Anthropic render, so the
 * stories live with the shared component rather than with either provider card.
 *
 * Each story supplies the catalog defaults a real profile would receive and a
 * local state holder, because the selector only persists through
 * `onPricingUpdate` and a static prop could not show its own result.
 */

/** Rates an OpenAI-family catalog publishes for a flagship model, per 1M tokens. */
const CATALOG_PRICING: ModelPricing = flatMeteredPricing(2.5, 10, 3.75, 1.25, "USD")

/** The capability and pricing fields both provider cards ask this component to render. */
const PRICING_FIELDS: {
    capabilities: Array<"contextWindow" | "maxTokens" | "supportsImages" | "supportsPromptCache" | "supportsTools">
    pricing: Array<"inputPrice" | "outputPrice" | "cacheWritesPrice" | "cacheReadsPrice" | "pricingTiers">
} = {
    capabilities: ["contextWindow", "maxTokens", "supportsImages", "supportsPromptCache", "supportsTools"],
    pricing: ["inputPrice", "outputPrice", "cacheWritesPrice", "cacheReadsPrice", "pricingTiers"],
}

const CATALOG_DEFAULTS: Partial<ModelInfo> = {
    capabilities: { contextWindow: 400_000, maxTokens: 128_000, supportsPromptCache: true, supportsTools: true },
    pricing: CATALOG_PRICING,
}

interface FixtureProps {
    readonly profilePricing?: ModelPricing
    readonly profileCapabilities?: ModelCapabilities
    readonly tiersEnabled?: boolean
}

/**
 * A mounted Model Configuration section.
 *
 * `pricing` state starts from what the profile stores and takes every update the
 * component emits, which is what makes the shape selector observable: choosing
 * `By context size` must replace the flat editor with the tier editor.
 */
function ConfigurationFixture({ profileCapabilities, profilePricing, tiersEnabled = false }: FixtureProps) {
    const [pricing, setPricing] = useState<ModelPricing | undefined>(profilePricing)
    const [capabilities, setCapabilities] = useState<ModelCapabilities | undefined>(profileCapabilities)
    const [pricingTiersEnabled, setPricingTiersEnabled] = useState(tiersEnabled)

    return (
        <div className="flex w-[420px] flex-col rounded-xs border border-editor-widget-border p-3">
            <ModelConfiguration
                capabilities={capabilities}
                defaults={CATALOG_DEFAULTS}
                fields={PRICING_FIELDS}
                onCapabilitiesUpdate={(updates) => setCapabilities((current) => ({ ...current, ...updates }))}
                onPricingUpdate={(updates) => {
                    setPricing(updates)
                    if (updates.strategy?.contextWindow) setPricingTiersEnabled(true)
                }}
                pricing={pricing}
                pricingTiersEnabled={pricingTiersEnabled}
                tiersEditable
            />
        </div>
    )
}

/** The Model Configuration disclosure is collapsed by default, as in settings. */
const openConfiguration = async ({ canvasElement }: { canvasElement: HTMLElement }) => {
    const canvas = within(canvasElement)
    const disclosure = canvas.getByRole("button", { name: /Model Configuration/i })
    await userEvent.click(disclosure)
    await expect(disclosure).toHaveAttribute("aria-expanded", "true")
}

const meta = {
    title: "Settings/Common/ModelConfigurationPricing",
    component: ConfigurationFixture,
    parameters: { layout: "fullscreen" },
    decorators: [createStorybookDecorator(undefined, "p-6")],
} satisfies Meta<typeof ConfigurationFixture>

export default meta
type Story = StoryObj<typeof meta>

/** A profile that has not overridden pricing shows the catalog's flat rates. */
export const CatalogFlat: Story = {
    play: async (context) => {
        await openConfiguration(context)
        const canvas = within(context.canvasElement)
        await expect(canvas.getByLabelText("Pricing Mode")).toBeVisible()
        await expect(canvas.getByLabelText("Input Price ($/1M tokens)")).toHaveValue("2.5")
    },
}

/**
 * Switching to context pricing must replace the single rate with the tier
 * editor, and the tier editor must start from the rate that was published.
 */
export const SwitchToContextWindow: Story = {
    play: async (context) => {
        await openConfiguration(context)
        const canvas = within(context.canvasElement)
        await userEvent.click(canvas.getByLabelText("Pricing Mode"))
        await userEvent.click(
            await within(context.canvasElement.ownerDocument.body).findByRole("option", { name: "By context size" }),
        )

        await expect(canvas.queryByLabelText("Input Price ($/1M tokens)")).toBeNull()
        await expect(canvas.getByText("Pricing Tiers")).toBeVisible()
        await expect(canvas.getByLabelText("Pricing Mode")).toHaveTextContent("By context size")
    },
}

/**
 * Switching to a schedule opens the default rate and the window editor. The
 * default starts from the flat rate the profile published, because a switch must
 * not silently reset a price to zero, and a new window can then be added.
 */
export const SwitchToTimeOfDay: Story = {
    play: async (context) => {
        await openConfiguration(context)
        const canvas = within(context.canvasElement)
        await userEvent.click(canvas.getByLabelText("Pricing Mode"))
        await userEvent.click(
            await within(context.canvasElement.ownerDocument.body).findByRole("option", { name: "By time of day" }),
        )

        await expect(canvas.getByLabelText("Default Input Price ($/1M tokens)")).toHaveValue("2.5")
        await expect(canvas.getByLabelText("Default Output Price ($/1M tokens)")).toHaveValue("10")
        await expect(canvas.getByText("Time Windows")).toBeVisible()
        await userEvent.click(canvas.getByRole("button", { name: "Add Time Window" }))
        await expect(canvas.getByRole("button", { name: "Remove Time Window" })).toBeVisible()
    },
}

/** A Profile without an override inherits the catalog declaration. */
export const EmptyProfile: Story = {
    play: async (context) => {
        await openConfiguration(context)
        const canvas = within(context.canvasElement)
        await expect(canvas.getByLabelText("Input Price ($/1M tokens)")).toHaveValue("2.5")
        await expect(canvas.getByLabelText("Pricing Mode")).toHaveTextContent("Flat rate")
    },
}

/**
 * A schedule the profile already stores: one discount window over a default
 * rate. The selector reports the stored shape instead of defaulting to flat, and
 * the window editor shows the stored bounds and rate.
 */
const storedWindow: PricingTimeWindow = {
    startMinute: 60,
    endMinute: 300,
    prices: { inputPrice: 1.5, outputPrice: 7.5, cacheWritePrice: 3.75, cacheReadPrice: 0.3 },
}

const storedSchedule: ModelPricing = {
    currency: "USD",
    strategy: {
        timeOfDay: {
            schedule: {
                timezoneOffsetMinutes: 480,
                dayRule: PricingDayRule.PRICING_DAY_RULE_WEEKDAYS,
                defaultOnPublicHolidays: true,
                holidayCalendar: "CN",
            },
            defaultPrices: { inputPrice: 3, outputPrice: 15, cacheWritePrice: 3.75, cacheReadPrice: 0.3 },
            timeWindows: [storedWindow],
        },
    },
}

export const StoredTimeOfDay: Story = {
    args: { profilePricing: storedSchedule },
    play: async (context) => {
        await openConfiguration(context)
        const canvas = within(context.canvasElement)
        await expect(canvas.getByLabelText("Pricing Mode")).toHaveTextContent("By time of day")
        await expect(canvas.getByLabelText("Default Input Price ($/1M tokens)")).toHaveValue("3")
        await expect(canvas.getByLabelText(/Window 1 Start/)).toHaveValue("01:00")
        await expect(canvas.getByLabelText(/Window 1 End/)).toHaveValue("05:00")
        await expect(canvas.getByLabelText("Window 1 Input Price ($/1M tokens)")).toHaveValue("1.5")
        // The windows are clock times in the seller's published offset, so the
        // editor must state that offset instead of implying the reader's zone.
        await expect(canvas.getByText(/Times are read as UTC\+08:00/)).toBeVisible()
    },
}

/**
 * Stored context bands include one final unbounded band. The strategy determines
 * the editor; the historical editing flag does not change the pricing declaration.
 */
const storedBands: readonly ContextWindowBand[] = [
    { maxInputTokens: 128_000, prices: { inputPrice: 2.5, outputPrice: 10 } },
    { prices: { inputPrice: 5, outputPrice: 20 } },
]

export const StoredContextWindow: Story = {
    args: {
        profilePricing: { currency: "USD", strategy: { contextWindow: { bands: [...storedBands] } } },
        tiersEnabled: true,
    },
    play: async (context) => {
        await openConfiguration(context)
        const canvas = within(context.canvasElement)
        await expect(canvas.getByLabelText("Pricing Mode")).toHaveTextContent("By context size")
        await expect(canvas.getByText("Pricing Tiers")).toBeVisible()
    },
}

/**
 * Two daily windows over one default rate, which is how a seller publishes two
 * peak periods. The selector reads the strategy, not the schedule, so this must
 * still report time of day even though the schedule carries day rules.
 */
export const TwoWindowsOverOneDefault: Story = {
    args: {
        profilePricing: {
            currency: "USD",
            strategy: {
                timeOfDay: {
                    schedule: {
                        timezoneOffsetMinutes: 480,
                        dayRule: PricingDayRule.PRICING_DAY_RULE_WEEKDAYS,
                        defaultOnPublicHolidays: true,
                        holidayCalendar: "CN",
                    },
                    defaultPrices: { inputPrice: 2, outputPrice: 8 },
                    timeWindows: [
                        { startMinute: 540, endMinute: 720, prices: { inputPrice: 4, outputPrice: 16 } },
                        { startMinute: 840, endMinute: 1080, prices: { inputPrice: 5, outputPrice: 20 } },
                    ],
                },
            },
        },
    },
    play: async (context) => {
        await openConfiguration(context)
        const canvas = within(context.canvasElement)
        await expect(canvas.getByLabelText("Pricing Mode")).toHaveTextContent("By time of day")
        await expect(canvas.getByLabelText("Default Input Price ($/1M tokens)")).toHaveValue("2")
        await expect(canvas.getByLabelText(/Window 1 Start/)).toHaveValue("09:00")
        await expect(canvas.getByLabelText(/Window 2 Start/)).toHaveValue("14:00")
        await expect(canvas.getByLabelText("Window 2 Output Price ($/1M tokens)")).toHaveValue("20")
    },
}

/**
 * A window priced by its own token bands, which is the second rate shape a
 * window can carry. Switching the window to bands must reveal the tier editor
 * instead of the four single-rate fields.
 */
export const WindowWithContextBands: Story = {
    args: {
        profilePricing: {
            currency: "USD",
            strategy: {
                timeOfDay: {
                    schedule: {
                        timezoneOffsetMinutes: 0,
                        dayRule: PricingDayRule.PRICING_DAY_RULE_ALL_DAYS,
                        defaultOnPublicHolidays: false,
                        holidayCalendar: "",
                    },
                    defaultPrices: { inputPrice: 1, outputPrice: 4 },
                    timeWindows: [
                        {
                            startMinute: 0,
                            endMinute: 360,
                            bands: {
                                bands: [
                                    { maxInputTokens: 128_000, prices: { inputPrice: 2, outputPrice: 8 } },
                                    { prices: { inputPrice: 4, outputPrice: 16 } },
                                ],
                            },
                        },
                    ],
                },
            },
        },
    },
    play: async (context) => {
        await openConfiguration(context)
        const canvas = within(context.canvasElement)
        await expect(canvas.getByLabelText("Rate")).toHaveTextContent("By context size")
        await expect(canvas.getByText("Pricing Tiers")).toBeVisible()
        await expect(canvas.queryByLabelText("Window 1 Input Price ($/1M tokens)")).toBeNull()
    },
}
