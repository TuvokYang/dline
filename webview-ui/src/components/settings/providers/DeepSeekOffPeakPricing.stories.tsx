import { type ModelPricing, PricingDayRule } from "@shared/proto/dline/models/metadata"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { expect, userEvent, within } from "storybook/test"
import { createStorybookDecorator } from "@/config/StorybookDecorator"
import { PricingEditor } from "../common/PricingEditor"

// Explicit rates; the real PricingEditor resolves the injected seller-day instant.
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

function CardFixture({
    pricing = DEEPSEEK_STORY_PRICING,
    atMs = Date.parse("2026-11-03T01:00:00Z"),
}: {
    pricing?: ModelPricing
    atMs?: number
}) {
    return (
        <div className="flex w-[380px] flex-col gap-2 rounded-xs border border-editor-widget-border p-3">
            <span className="text-sm font-medium text-foreground">DeepSeek</span>
            <PricingEditor atMs={atMs} peakOffPeakLabels pricing={pricing} readOnly={true} showCachePrices />
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

export const Weekday: Story = {
    args: { atMs: Date.parse("2026-11-03T01:00:00Z") },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)
        const chart = canvas.getByRole("img", { name: "Pricing windows for 2026-11-03 (UTC+08:00)" })
        await expect(
            Array.from(chart.querySelectorAll("[data-rate-kind]"), (bar) => [
                bar.getAttribute("data-rate-kind"),
                Number(bar.getAttribute("x")),
                Number(bar.getAttribute("width")),
            ]),
        ).toEqual([
            ["offPeak", 0, 540],
            ["peak", 540, 180],
            ["offPeak", 720, 120],
            ["peak", 840, 240],
            ["offPeak", 1080, 360],
        ])
        await expect(
            canvas
                .getByRole("region", { name: "Peak window · 09:00 – 12:00, 14:00 – 18:00" })
                .querySelector('[data-price-slot="inputPrice"]'),
        ).toHaveTextContent("¥9")
        await expect(
            canvas.getByRole("region", { name: "Off-peak window · Other times" }).querySelector('[data-price-slot="inputPrice"]'),
        ).toHaveTextContent("¥4.5")
        await expect(canvas.getAllByRole("region")).toHaveLength(2)
    },
}

async function expectFullDayOffPeak(canvasElement: HTMLElement, day: string) {
    const canvas = within(canvasElement)
    const chart = canvas.getByRole("img", { name: `Pricing windows for ${day} (UTC+08:00)` })
    await expect(chart.querySelectorAll('[data-rate-kind="peak"]')).toHaveLength(0)
    await expect(chart.querySelectorAll('[data-rate-kind="offPeak"]')).toHaveLength(1)
    await expect(chart.querySelector('[data-rate-kind="offPeak"]')).toHaveAttribute("width", "1440")
    await expect(canvas.queryByRole("region", { name: /^Peak window/ })).toBeNull()
    await expect(
        canvas.getByRole("region", { name: "Off-peak window · 00:00 – 24:00" }).querySelector('[data-price-slot="inputPrice"]'),
    ).toHaveTextContent("¥4.5")
}

export const Weekend: Story = {
    args: { atMs: Date.parse("2026-11-08T05:20:00Z") },
    play: ({ canvasElement }) => expectFullDayOffPeak(canvasElement, "2026-11-08"),
}

export const PublicHoliday: Story = {
    args: { atMs: Date.parse("2026-10-01T02:00:00Z") },
    play: ({ canvasElement }) => expectFullDayOffPeak(canvasElement, "2026-10-01"),
}

function DayTransition() {
    const [atMs, setAtMs] = useState(Date.parse("2026-11-08T15:59:59Z"))
    return (
        <>
            <button onClick={() => setAtMs(Date.parse("2026-11-08T16:00:00Z"))} type="button">
                Next seller day
            </button>
            <CardFixture atMs={atMs} />
        </>
    )
}

export const SundayToMonday: Story = {
    render: () => <DayTransition />,
    play: async ({ canvasElement }) => {
        await expectFullDayOffPeak(canvasElement, "2026-11-08")
        const canvas = within(canvasElement)
        await userEvent.click(canvas.getByRole("button", { name: "Next seller day" }))
        const chart = canvas.getByRole("img", { name: "Pricing windows for 2026-11-09 (UTC+08:00)" })
        await expect(chart.querySelectorAll('[data-rate-kind="peak"]')).toHaveLength(2)
    },
}

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
