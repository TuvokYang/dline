import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, within } from "storybook/test"
import { createStorybookDecorator } from "@/config/StorybookDecorator"
import { DeepSeekOffPeakPricing, type DeepSeekPricedModel } from "./DeepSeekOffPeakPricing"
import { buildDeepSeekSchedule, isDeepSeekOffPeak } from "./deepseekPricingSchedule"

/**
 * Peak prices straight from the DeepSeek pricing page.
 *
 * The card derives off-peak from the documented half-rate rule, so these are the
 * only published numbers a story has to state; a story that also spelled out
 * off-peak would not notice the rule being broken.
 */
const MODEL: DeepSeekPricedModel = {
    modelId: "deepseek-v4-pro",
    inputPeak: 1.32,
    cachedInputPeak: 0.044,
    outputPeak: 3.96,
    currency: "USD",
}

/**
 * Fixed instants, expressed in the machine's own zone on purpose.
 *
 * `resolveDeepSeekRateState` reads China Standard Time from the instant, so a
 * story that pinned a UTC string would render differently on a machine set to a
 * different zone. Constructing the local wall clock instead keeps the fixture
 * meaning the same thing wherever Storybook runs.
 */
function localInstant(year: number, month: number, day: number, hour: number, minute = 0): Date {
    return new Date(year, month - 1, day, hour, minute)
}

/** Monday 20:00 Beijing: inside the second peak window. */
const MID_PEAK = localInstant(2030, 1, 7, 20)
/** Monday 22:30 Beijing: after the peak window, before midnight. */
const AFTER_PEAK = localInstant(2030, 1, 7, 22, 30)
/** Saturday 10:00 Beijing: a weekend, so off-peak all day. */
const WEEKEND = localInstant(2030, 1, 12, 10)
/** Wednesday 15:00 Beijing, declared a holiday. */
const HOLIDAY = localInstant(2030, 1, 9, 15)

const HOLIDAY_DAYS = new Set(["2030-01-09"])
const isHoliday = (day: string) => HOLIDAY_DAYS.has(day)

function CardFixture({ now, holiday = false }: { readonly now: Date; readonly holiday?: boolean }) {
    return (
        <div className="flex w-[380px] flex-col gap-2 rounded-xs border border-editor-widget-border p-3">
            <span className="text-sm font-medium text-foreground">DeepSeek</span>
            <DeepSeekOffPeakPricing isHoliday={holiday ? isHoliday : undefined} model={MODEL} now={now} />
        </div>
    )
}

const withState = [createStorybookDecorator({}, "p-6")]

const meta = {
    title: "Settings/Providers/DeepSeekOffPeakPricing",
    component: CardFixture,
    parameters: { layout: "fullscreen" },
    decorators: withState,
} satisfies Meta<typeof CardFixture>

export default meta
type Story = StoryObj<typeof meta>

/** Inside a weekday peak window: the badge is peak and the countdown is to off-peak. */
export const Peak: Story = {
    args: { now: MID_PEAK },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)
        await expect(canvas.getByText("Peak", { selector: "[data-rate]" })).toBeVisible()
        await expect(canvas.getByText(/Peak now\. The off-peak rate starts in/)).toBeVisible()
    },
}

/** After the last peak window of a weekday: off-peak, counting down to tomorrow's peak. */
export const OffPeakEvening: Story = {
    args: { now: AFTER_PEAK },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)
        await expect(canvas.getByText("Off-peak", { selector: "[data-rate]" })).toBeVisible()
        await expect(canvas.getByText(/Off-peak now\. The peak rate starts in/)).toBeVisible()
    },
}

/**
 * A weekend: every request bills off-peak, so the card states the reason rather
 * than counting down to a peak that will not arrive today.
 */
export const Weekend: Story = {
    args: { now: WEEKEND },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)
        await expect(canvas.getByText(/Weekends bill at the off-peak rate all day\./)).toBeVisible()
    },
}

/**
 * A weekday declared a Chinese public holiday. The rate is off-peak even though
 * the timeline's weekday shape still shows a peak window, and the sentence is
 * what explains that difference.
 */
export const Holiday: Story = {
    args: { holiday: true, now: HOLIDAY },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)
        await expect(canvas.getByText(/Today is a Chinese public holiday/)).toBeVisible()
        await expect(canvas.getByText("Off-peak", { selector: "[data-rate]" })).toBeVisible()
    },
}

/**
 * The window boundaries the card has to get right.
 *
 * The half-hourly probe in the schedule builder means a boundary landing on a
 * half hour in the viewer's own zone still resolves, so the fixture checks the
 * edges instead of one comfortable mid-window instant.
 */
export const BoundaryCases: Story = {
    args: { now: MID_PEAK },
    render: () => {
        const cases: readonly { readonly label: string; readonly instant: Date; readonly offPeak: boolean }[] = [
            { label: "Mon 08:59 Beijing (before peak)", instant: localInstant(2030, 1, 7, 8, 59), offPeak: true },
            { label: "Mon 09:00 Beijing (peak starts)", instant: localInstant(2030, 1, 7, 9), offPeak: false },
            { label: "Mon 11:59 Beijing (peak ends)", instant: localInstant(2030, 1, 7, 11, 59), offPeak: false },
            { label: "Mon 12:00 Beijing (lunch off-peak)", instant: localInstant(2030, 1, 7, 12), offPeak: true },
            { label: "Mon 13:59 Beijing (before peak)", instant: localInstant(2030, 1, 7, 13, 59), offPeak: true },
            { label: "Mon 14:00 Beijing (peak starts)", instant: localInstant(2030, 1, 7, 14), offPeak: false },
            { label: "Mon 17:59 Beijing (peak ends)", instant: localInstant(2030, 1, 7, 17, 59), offPeak: false },
            { label: "Mon 18:00 Beijing (off-peak)", instant: localInstant(2030, 1, 7, 18), offPeak: true },
            { label: "Sat 10:00 Beijing (weekend)", instant: localInstant(2030, 1, 12, 10), offPeak: true },
            { label: "Sun 22:00 Beijing (Sunday night)", instant: localInstant(2030, 1, 13, 22), offPeak: true },
            { label: "Mon 09:30 Beijing (half-hour inside peak)", instant: localInstant(2030, 1, 7, 9, 30), offPeak: false },
        ]
        return (
            <div className="flex w-[460px] flex-col gap-2 rounded-xs border border-editor-widget-border p-3">
                <span className="text-sm font-medium text-foreground">Rate at each boundary</span>
                {cases.map((testCase) => {
                    const actual = isDeepSeekOffPeak(testCase.instant)
                    const matches = actual === testCase.offPeak
                    return (
                        <div
                            className="flex items-center justify-between gap-2 text-xs"
                            data-boundary={testCase.label}
                            data-matches={matches}
                            key={testCase.label}>
                            <span className="text-description">{testCase.label}</span>
                            <span
                                style={{
                                    color: matches ? "var(--vscode-charts-green, #22c55e)" : "var(--vscode-errorForeground)",
                                }}>
                                {actual ? "off-peak" : "peak"}
                            </span>
                        </div>
                    )
                })}
            </div>
        )
    },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)
        const rows = canvasElement.querySelectorAll("[data-matches]")
        await expect(rows.length).toBe(11)
        for (const row of rows) {
            await expect(row.getAttribute("data-matches")).toBe("true")
        }
    },
}

/**
 * A full day rendered at day granularity, so a review can confirm the two peak
 * windows land in the right hours without reading 48 half-hour cells.
 */
export const DaySchedule: Story = {
    args: { now: MID_PEAK },
    render: () => {
        const schedule = buildDeepSeekSchedule(new Date(2030, 0, 7))
        const hourly = schedule.filter((segment) => segment.minute === 0)
        return (
            <div className="flex w-[460px] flex-col gap-2 rounded-xs border border-editor-widget-border p-3">
                <span className="text-sm font-medium text-foreground">Monday, hour by hour (Beijing time)</span>
                <div className="grid grid-cols-6 gap-1 text-[11px]">
                    {hourly.map((segment) => (
                        <span
                            className="rounded-xs px-1 py-0.5 text-center"
                            data-hour={segment.hour}
                            data-off-peak={segment.offPeak}
                            key={segment.hour}
                            style={{
                                backgroundColor: segment.offPeak
                                    ? "color-mix(in srgb, var(--vscode-charts-green, #22c55e) 25%, transparent)"
                                    : "color-mix(in srgb, var(--vscode-charts-orange, #f59e0b) 45%, transparent)",
                            }}>
                            {String(segment.hour).padStart(2, "0")}
                        </span>
                    ))}
                </div>
            </div>
        )
    },
    play: async ({ canvasElement }) => {
        const cell = (hour: number) => canvasElement.querySelector(`[data-hour="${hour}"]`)
        // The published windows are 09-12 and 14-18 Beijing time.
        await expect(cell(9)?.getAttribute("data-off-peak")).toBe("false")
        await expect(cell(12)?.getAttribute("data-off-peak")).toBe("true")
        await expect(cell(14)?.getAttribute("data-off-peak")).toBe("false")
        await expect(cell(18)?.getAttribute("data-off-peak")).toBe("true")
    },
}
