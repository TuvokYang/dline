import type { AccountUsageData } from "@shared/ExtensionMessage"
import { ApiFormat } from "@shared/proto/dline/models/metadata"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { expect, within } from "storybook/test"
import { createStorybookDecorator } from "@/config/StorybookDecorator"
import type { DeepSeekPricedModel } from "./DeepSeekOffPeakPricing"
import { type DeepSeekEffort, DeepSeekProviderCard, type DeepSeekProviderCardProps } from "./DeepSeekProviderCard"
import { type DeepSeekRateRule, isDeepSeekOffPeak } from "./deepseekPricingSchedule"
import { balanceUsageFixture } from "./usageStoryFixtures"

/** The two models DeepSeek currently publishes, at their peak prices in USD per 1M tokens. */
const PRICED_MODELS: readonly DeepSeekPricedModel[] = [
    { modelId: "deepseek-flash", inputPeak: 0.3, cachedInputPeak: 0.006, outputPeak: 1.2, currency: "USD" },
    { modelId: "deepseek-v4-pro", inputPeak: 1.32, cachedInputPeak: 0.044, outputPeak: 3.96, currency: "USD" },
]

const MODELS = ["deepseek-flash", "deepseek-v4-pro"] as const

/**
 * March 2030 starts on a Friday, and 4 March 2030 is a Monday — fixed instants
 * make the stories deterministic without depending on when they run.
 */
function localInstant(year: number, month: number, day: number, hour: number, minute = 0): Date {
    return new Date(year, month - 1, day, hour, minute)
}

/** Monday 20:00 Beijing: inside the second peak window. */
const PEAK = localInstant(2030, 3, 4, 20)
/** Monday 22:30 Beijing: after the peak window. */
const OFF_PEAK = localInstant(2030, 3, 4, 22, 30)
/** Saturday 10:00 Beijing. */
const WEEKEND = localInstant(2030, 3, 9, 10)
/** Wednesday 15:00 Beijing, declared a holiday. */
const HOLIDAY = localInstant(2030, 3, 6, 15)

const HOLIDAY_DAYS = new Set(["2030-03-06"])
const isHoliday = (day: string) => HOLIDAY_DAYS.has(day)

type CardProps = Partial<Omit<DeepSeekProviderCardProps, "pricedModel" | "profileId" | "models">>

/**
 * The card framed like the Provider section it sits in.
 *
 * Both the direct and the gateway rule are rendered through the same component;
 * `rule` is what differs, so a review can compare the two footnotes directly.
 */
function CardFixture({
    now = PEAK,
    rateRule = "deepseek-direct",
    apiFormat = ApiFormat.OPENAI_CHAT,
    enableThinking = false,
    effort,
    modelId = "deepseek-flash",
    holiday = false,
}: CardProps & { readonly now?: Date; readonly holiday?: boolean }) {
    // Only the selected model's prices reach the card, exactly as the Profile
    // resolves it: handing the card the whole catalog would render a rate sheet
    // instead of the single line that applies to this Profile.
    const pricedModel = PRICED_MODELS.find((model) => model.modelId === modelId)
    return (
        <div className="flex w-[400px] flex-col rounded-xs border border-editor-widget-border p-3">
            <span className="mb-2 text-sm font-medium text-foreground">DeepSeek</span>
            <DeepSeekProviderCard
                apiFormat={apiFormat}
                apiKey="sk-storybook0000000000000000"
                effort={effort}
                enableThinking={enableThinking}
                isHoliday={holiday ? isHoliday : undefined}
                modelId={modelId}
                models={MODELS}
                now={now}
                onApiFormatChange={() => undefined}
                onApiKeyChange={() => undefined}
                onEffortChange={() => undefined}
                onEnableThinkingChange={() => undefined}
                onModelChange={() => undefined}
                pricedModel={pricedModel}
                profileId="profile-story"
                rateRule={rateRule}
            />
        </div>
    )
}

const withUsage = (accountUsage: AccountUsageData = balanceUsageFixture) => [createStorybookDecorator({ accountUsage }, "p-6")]

const meta = {
    title: "Settings/Providers/DeepSeekProviderCard",
    component: CardFixture,
    parameters: { layout: "fullscreen" },
    decorators: withUsage(),
} satisfies Meta<typeof CardFixture>

export default meta
type Story = StoryObj<typeof meta>

/**
 * The complete Profile surface on the direct API: key, model, protocol,
 * reasoning, usage, and the time-of-day price table with its holiday exclusion.
 */
export const DeepSeekDirect: Story = {
    args: { now: PEAK },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)
        await expect(canvas.getByText("Peak", { selector: "[data-rate]" })).toBeVisible()
        await expect(canvas.getByText(/excluding Chinese public holidays/)).toBeVisible()
        // Half of $0.30 input / $1.20 output, derived rather than restated.
        await expect(canvas.getByText("$0.15")).toBeVisible()
        await expect(canvas.getByText("$0.60")).toBeVisible()
    },
}

/**
 * The same models through the OpenCode gateway. Its published rule drops the
 * holiday exclusion, so the card must say so instead of borrowing DeepSeek's
 * wording.
 */
export const OpenCodeGateway: Story = {
    args: { now: PEAK, rateRule: "opencode-go" },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)
        await expect(canvas.getByText(/Chinese public holidays still bill at the peak rate here\./)).toBeVisible()
        await expect(canvas.queryByText(/excluding Chinese public holidays/)).toBeNull()
    },
}

/** After the last peak window: off-peak, counting down to tomorrow's first peak. */
export const OffPeakEvening: Story = {
    args: { now: OFF_PEAK },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)
        await expect(canvas.getByText("Off-peak", { selector: "[data-rate]" })).toBeVisible()
        await expect(canvas.getByText(/Off-peak now\. The peak rate starts in/)).toBeVisible()
    },
}

/** A weekend bills off-peak all day, whatever the hour. */
export const Weekend: Story = {
    args: { now: WEEKEND },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)
        await expect(canvas.getByText(/Weekends bill at the off-peak rate all day\./)).toBeVisible()
    },
}

/**
 * A weekday holiday on the direct API. The rate is off-peak even though the
 * timeline's weekday shape still shows a peak window, and the sentence explains
 * the difference.
 */
export const HolidayDirect: Story = {
    args: { now: HOLIDAY, holiday: true },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)
        await expect(canvas.getByText(/Today is a Chinese public holiday/)).toBeVisible()
        await expect(canvas.getByText("Off-peak", { selector: "[data-rate]" })).toBeVisible()
    },
}

/**
 * The same holiday through the gateway. Without the holiday exclusion this must
 * still bill at the peak rate, which is the whole reason the rule is explicit.
 */
export const HolidayButGatewayBillsPeak: Story = {
    args: { now: HOLIDAY, holiday: true, rateRule: "opencode-go" },
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)
        await expect(canvas.getByText("Peak", { selector: "[data-rate]" })).toBeVisible()
        await expect(canvas.queryByText(/Today is a Chinese public holiday/)).toBeNull()
    },
}

/** Anthropic Messages and Responses render the same prices: only the wire format changes. */
export const ResponsesProtocol: Story = {
    args: { apiFormat: ApiFormat.OPENAI_RESPONSES, now: OFF_PEAK },
    decorators: withUsage({ ...balanceUsageFixture, remainingBalance: 42.18 }),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)
        await expect(canvas.getByText(/the choice changes the wire format, not the price/)).toBeVisible()
    },
}

/**
 * The rule boundary, asserted rather than eyeballed.
 *
 * The two sellers share their peak hours but not their holiday handling, so the
 * same holiday instant must resolve differently under each rule. A component
 * that ignored `rule` would make every row here agree.
 */
export const RuleComparison: Story = {
    play: async ({ canvasElement }) => {
        const holidayWeekday = localInstant(2030, 3, 6, 15)
        const holidayWeekend = localInstant(2030, 3, 9, 15)
        const cases: readonly {
            readonly label: string
            readonly instant: Date
            readonly rule: DeepSeekRateRule
            readonly offPeak: boolean
        }[] = [
            { label: "Holiday, direct API", instant: holidayWeekday, rule: "deepseek-direct", offPeak: true },
            { label: "Holiday, gateway", instant: holidayWeekday, rule: "opencode-go", offPeak: false },
            { label: "Weekend holiday, direct API", instant: holidayWeekend, rule: "deepseek-direct", offPeak: true },
            { label: "Weekend holiday, gateway", instant: holidayWeekend, rule: "opencode-go", offPeak: true },
        ]
        const rows = canvasElement.querySelectorAll("[data-rule-case]")
        await expect(rows.length).toBe(cases.length)
        for (const testCase of cases) {
            await expect(isDeepSeekOffPeak(testCase.instant, isHoliday, testCase.rule)).toBe(testCase.offPeak)
        }
    },
    render: () => (
        <div className="flex w-[460px] flex-col gap-2 rounded-xs border border-editor-widget-border p-3">
            <span className="text-sm font-medium text-foreground">Holiday handling per rule</span>
            {[
                { label: "Holiday, direct API", rule: "deepseek-direct", instant: HOLIDAY },
                { label: "Holiday, gateway", rule: "opencode-go", instant: HOLIDAY },
                { label: "Weekend holiday, direct API", rule: "deepseek-direct", instant: WEEKEND },
                { label: "Weekend holiday, gateway", rule: "opencode-go", instant: WEEKEND },
            ].map((row) => {
                const offPeak = isDeepSeekOffPeak(row.instant, isHoliday, row.rule as DeepSeekRateRule)
                return (
                    <div
                        className="flex items-center justify-between gap-2 text-xs"
                        data-rule="case"
                        data-rule-case={row.label}
                        key={row.label}>
                        <span className="text-description">{row.label}</span>
                        <span
                            style={{
                                color: offPeak ? "var(--vscode-charts-green, #22c55e)" : "var(--vscode-charts-orange, #f59e0b)",
                            }}>
                            {offPeak ? "off-peak" : "peak"}
                        </span>
                    </div>
                )
            })}
        </div>
    ),
}

/**
 * Thinking is a Profile choice, not something the model id implies.
 *
 * With the checkbox off the card must show no level selector at all, matching
 * `DeepSeekProvider`: the stored preference is off, so there is nothing to pick.
 */
export const ThinkingDisabled: Story = {
    args: { enableThinking: false, now: PEAK },
    decorators: withUsage({ ...balanceUsageFixture, remainingBalance: 7.4 }),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)
        await expect(canvas.getByRole("checkbox", { name: "Enable Thinking" })).not.toBeChecked()
        await expect(canvas.queryByText("Thinking Level")).toBeNull()
    },
}

/**
 * Thinking enabled with a stored level: the checkbox is on and exactly that
 * level is selected, because the Profile round-tripped a real preference.
 */
export const ThinkingEnabled: Story = {
    args: { enableThinking: true, effort: "high" satisfies DeepSeekEffort, now: PEAK },
    decorators: withUsage({ ...balanceUsageFixture, remainingBalance: 7.4 }),
    play: async ({ canvasElement }) => {
        const canvas = within(canvasElement)
        await expect(canvas.getByRole("checkbox", { name: "Enable Thinking" })).toBeChecked()
        await expect(canvas.getByText("Thinking Level")).toBeVisible()
        await expect(canvas.getByText("High")).toBeVisible()
    },
}
