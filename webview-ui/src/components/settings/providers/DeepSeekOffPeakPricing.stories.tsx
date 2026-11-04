import { type ModelPricing, PricingDayRule } from "@shared/proto/dline/models/metadata"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { createStorybookDecorator } from "@/config/StorybookDecorator"
import { PricingEditor } from "../common/PricingEditor"

// Explicit declarations, not runtime pricing rules. Both rates are independently authored.
export const DEEPSEEK_STORY_PRICING: ModelPricing = {
    currency: "CNY",
    strategy: {
        timeOfDay: {
            schedule: {
                timezoneOffsetMinutes: 480,
                dayRule: PricingDayRule.PRICING_DAY_RULE_WEEKDAYS,
                defaultOnPublicHolidays: true,
                holidayCalendar: "CN",
            },
            defaultPrices: { inputPrice: 4.5, outputPrice: 13.5, cacheReadPrice: 0.15 },
            timeWindows: [
                { startMinute: 540, endMinute: 720, prices: { inputPrice: 9, outputPrice: 27, cacheReadPrice: 0.3 } },
                { startMinute: 840, endMinute: 1080, prices: { inputPrice: 9, outputPrice: 27, cacheReadPrice: 0.3 } },
            ],
        },
    },
}

function CardFixture({ pricing = DEEPSEEK_STORY_PRICING }: { pricing?: ModelPricing }) {
    return (
        <div className="flex w-[380px] flex-col gap-2 rounded-xs border border-editor-widget-border p-3">
            <span className="text-sm font-medium text-foreground">DeepSeek</span>
            <PricingEditor pricing={pricing} readOnly={true} showCachePrices />
        </div>
    )
}

const withState = [createStorybookDecorator({}, "p-6")]

const meta = {
    title: "Settings/Providers/DeepSeekOffPeakPricing",
    component: CardFixture,
    excludeStories: ["DEEPSEEK_STORY_PRICING"],
    parameters: { layout: "fullscreen" },
    decorators: withState,
} satisfies Meta<typeof CardFixture>

export default meta
type Story = StoryObj<typeof meta>

/** The configured weekday shape does not claim to be today's resolved calendar. */
export const PublishedWindows: Story = { args: { pricing: DEEPSEEK_STORY_PRICING } }

export const TimeAndContext: Story = {
    args: {
        pricing: {
            currency: "CNY",
            strategy: {
                timeOfDay: {
                    ...DEEPSEEK_STORY_PRICING.strategy!.timeOfDay!,
                    timeWindows: [
                        {
                            startMinute: 541,
                            endMinute: 719,
                            bands: {
                                bands: [
                                    { maxInputTokens: 128_000, prices: { inputPrice: 6, outputPrice: 18 } },
                                    { prices: { inputPrice: 10, outputPrice: 30, cacheReadPrice: 0 } },
                                ],
                            },
                        },
                    ],
                },
            },
        },
    },
}

export const MissingPricing: Story = { args: { pricing: {} } }
