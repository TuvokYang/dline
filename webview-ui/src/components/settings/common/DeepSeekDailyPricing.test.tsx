// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import { deepSeekModels } from "../../../../../src/core/api/providers/models/deepseek"
import { PricingEditor } from "./PricingEditor"

vi.mock("@vscode/webview-ui-toolkit/react", () => ({
    VSCodeButton: ({ children }: React.ComponentProps<"button">) => <button type="button">{children}</button>,
    VSCodeCheckbox: () => null,
    VSCodeTextField: () => null,
}))

afterEach(() => {
    cleanup()
    vi.useRealTimers()
})

function showAt(at: string, id = "deepseek-flash") {
    vi.useFakeTimers()
    vi.setSystemTime(new Date(at))
    return render(<PricingEditor peakOffPeakLabels pricing={deepSeekModels[id].pricing} readOnly showCachePrices />)
}

function intervals() {
    return Array.from(screen.getByRole("img").querySelectorAll("[data-rate-kind]"), (bar) => [
        bar.getAttribute("data-rate-kind"),
        Number(bar.getAttribute("x")),
        Number(bar.getAttribute("width")),
    ])
}

function card(title: string) {
    return screen.getByRole("heading", { level: 3, name: title }).parentElement!
}

function prices(element: HTMLElement) {
    return Array.from(element.querySelectorAll("[data-price-slot]"), (cell) => cell.textContent)
}

const weekdayIntervals = [
    ["offPeak", 0, 540],
    ["peak", 540, 180],
    ["offPeak", 720, 120],
    ["peak", 840, 240],
    ["offPeak", 1080, 360],
]

describe("DeepSeek seller-day pricing", () => {
    it.each([
        ["2026-11-07T01:00:00Z", "2026-11-07"],
        ["2026-11-08T05:20:00Z", "2026-11-08"],
        ["2026-10-01T02:00:00Z", "2026-10-01"],
    ])("renders only one full-day off-peak window at %s", (at, day) => {
        showAt(at)
        expect(screen.getByRole("img", { name: `Pricing windows for ${day} (UTC+08:00)` })).toBeVisible()
        expect(intervals()).toEqual([["offPeak", 0, 1440]])
        expect(screen.getAllByRole("heading", { level: 3, name: /^(Peak|Off-peak) window/ })).toHaveLength(1)
        expect(prices(card("Off-peak window · 00:00 – 24:00"))).toEqual(["¥1", "¥4", "Not published", "¥0.02"])
        expect(screen.queryByRole("heading", { name: /^Peak window/ })).toBeNull()
    })

    it("keeps five timeline intervals but aggregates weekday prices into peak then off-peak", () => {
        showAt("2026-11-03T01:00:00Z")
        expect(intervals()).toEqual(weekdayIntervals)
        const sections = screen.getAllByRole("region")
        expect(sections).toHaveLength(2)
        expect(sections.map((section) => section.getAttribute("aria-label"))).toEqual([
            "Peak window · 09:00 – 12:00, 14:00 – 18:00",
            "Off-peak window · Other times",
        ])
        expect(prices(sections[0])).toEqual(["¥2", "¥8", "Not published", "¥0.04"])
        expect(prices(sections[1])).toEqual(["¥1", "¥4", "Not published", "¥0.02"])
        for (const [index, kind] of ["peak", "offPeak"].entries()) {
            const heading = sections[index].querySelector("h3")!
            const bar = screen.getByRole("img").querySelector(`[data-rate-kind="${kind}"]`)!
            expect(heading.getAttribute("style")).toContain(bar.getAttribute("fill"))
        }
    })

    it("uses the selected model's prices rather than a Flash-specific table", () => {
        showAt("2026-11-08T05:20:00Z", "deepseek-v4-pro")
        expect(prices(card("Off-peak window · 00:00 – 24:00"))).toEqual(["¥4.5", "¥13.5", "Not published", "¥0.15"])
    })

    it("refreshes across seller midnight without rewriting the price declaration", () => {
        const pricing = deepSeekModels["deepseek-flash"].pricing!
        const before = JSON.stringify(pricing)
        showAt("2026-11-08T15:59:59Z")
        expect(intervals()).toEqual([["offPeak", 0, 1440]])
        act(() => vi.advanceTimersByTime(1000))
        expect(screen.getByRole("img", { name: "Pricing windows for 2026-11-09 (UTC+08:00)" })).toBeVisible()
        expect(intervals()).toEqual(weekdayIntervals)
        expect(JSON.stringify(pricing)).toBe(before)
    })

    it("refreshes after the hidden view resumes on a different seller day", () => {
        showAt("2026-11-08T05:20:00Z")
        vi.setSystemTime(new Date("2026-11-09T02:00:00Z"))
        fireEvent.focus(window)
        expect(intervals()).toEqual(weekdayIntervals)
    })

    it("switches grouped headings without changing the day, values or section identity", () => {
        const pricing = deepSeekModels["deepseek-flash"].pricing
        const tree = (language: "en" | "zh-CN") => (
            <UiLanguageProvider language={language}>
                <PricingEditor
                    atMs={Date.parse("2026-11-09T02:00:00Z")}
                    peakOffPeakLabels
                    pricing={pricing}
                    readOnly
                    showCachePrices
                />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        const sections = screen.getAllByRole("region")
        view.rerender(tree("zh-CN"))
        expect(screen.getAllByRole("region")).toEqual(sections)
        expect(sections[0]).toHaveAccessibleName("高峰窗口 · 09:00 – 12:00, 14:00 – 18:00")
        expect(sections[1]).toHaveAccessibleName("低峰窗口 · 其它时间")
        expect(prices(sections[0])).toEqual(["¥2", "¥8", "未公布", "¥0.04"])
        expect(prices(sections[1])).toEqual(["¥1", "¥4", "未公布", "¥0.02"])
        expect(intervals()).toEqual(weekdayIntervals)
        view.rerender(tree("en"))
        expect(screen.getAllByRole("region")).toEqual(sections)
        expect(sections[1]).toHaveAccessibleName("Off-peak window · Other times")
    })

    it("does not deduplicate an explicit zero rate with an unpublished rate", () => {
        const pricing = structuredClone(deepSeekModels["deepseek-flash"].pricing!)
        const windows = pricing.strategy!.timeOfDay!.timeWindows
        windows[0].prices = { inputPrice: 2, outputPrice: 8, cacheReadPrice: 0 }
        windows[1].prices = { inputPrice: 2, outputPrice: 8 }
        render(
            <PricingEditor
                atMs={Date.parse("2026-11-09T02:00:00Z")}
                peakOffPeakLabels
                pricing={pricing}
                readOnly
                showCachePrices
            />,
        )
        expect(screen.getAllByRole("region")).toHaveLength(2)
        expect(prices(card("Peak window · 09:00 – 12:00, 14:00 – 18:00"))).toEqual([
            "¥2",
            "¥8",
            "Not published",
            "¥0",
            "¥2",
            "¥8",
            "Not published",
            "Not published",
        ])
    })

    it("keeps different context thresholds visible inside the single peak group", () => {
        const pricing = structuredClone(deepSeekModels["deepseek-flash"].pricing!)
        const time = pricing.strategy!.timeOfDay!
        time.timeWindows = time.timeWindows.map((window, index) => ({
            ...window,
            prices: undefined,
            bands: {
                bands: [
                    { maxInputTokens: index === 0 ? 128_000 : 256_000, prices: { inputPrice: 0, outputPrice: 3 } },
                    { prices: { inputPrice: 6, outputPrice: 9 } },
                ],
            },
        }))
        render(
            <PricingEditor
                atMs={Date.parse("2026-11-09T02:00:00Z")}
                peakOffPeakLabels
                pricing={pricing}
                readOnly
                showCachePrices
            />,
        )
        const peak = card("Peak window · 09:00 – 12:00, 14:00 – 18:00")
        expect(screen.getAllByRole("region")).toHaveLength(2)
        expect(within(peak).getByText("Tier 1 · 0 ≤ input tokens ≤ 128,000")).toBeVisible()
        expect(within(peak).getByText("Tier 1 · 0 ≤ input tokens ≤ 256,000")).toBeVisible()
        expect(peak.querySelectorAll("[data-price-slot]")).toHaveLength(16)
    })

    it("preserves default context bands on an off-peak-only day", () => {
        const pricing = structuredClone(deepSeekModels["deepseek-flash"].pricing!)
        const time = pricing.strategy!.timeOfDay!
        time.defaultPrices = undefined
        time.defaultBands = {
            bands: [
                { maxInputTokens: 128_000, prices: { inputPrice: 0, outputPrice: 3, cacheReadPrice: 0 } },
                { prices: { inputPrice: 6, outputPrice: 9 } },
            ],
        }
        render(
            <PricingEditor
                atMs={Date.parse("2026-11-08T02:00:00Z")}
                peakOffPeakLabels
                pricing={pricing}
                readOnly
                showCachePrices
            />,
        )
        expect(intervals()).toEqual([["offPeak", 0, 1440]])
        expect(screen.getAllByRole("region")).toHaveLength(1)
        expect(prices(card("Off-peak window · 00:00 – 24:00"))).toEqual([
            "¥0",
            "¥3",
            "Not published",
            "¥0",
            "¥6",
            "¥9",
            "Not published",
            "Not published",
        ])
    })

    it("preserves nested context bands and explicit zero prices within the active day", () => {
        const pricing = structuredClone(deepSeekModels["deepseek-flash"].pricing!)
        pricing.strategy!.timeOfDay!.timeWindows[0] = {
            startMinute: 540,
            endMinute: 720,
            bands: {
                bands: [
                    { maxInputTokens: 128_000, prices: { inputPrice: 0, outputPrice: 3 } },
                    { prices: { inputPrice: 6, outputPrice: 9, cacheReadPrice: 0 } },
                ],
            },
        }
        vi.useFakeTimers()
        vi.setSystemTime(new Date("2026-11-03T01:00:00Z"))
        render(<PricingEditor peakOffPeakLabels pricing={pricing} readOnly showCachePrices />)
        const peak = card("Peak window · 09:00 – 12:00, 14:00 – 18:00")
        expect(within(peak).getByText("Tier 1 · 0 ≤ input tokens ≤ 128,000")).toBeVisible()
        expect(screen.getAllByRole("region")).toHaveLength(2)
        expect(prices(peak)).toEqual([
            "¥0",
            "¥3",
            "Not published",
            "Not published",
            "¥6",
            "¥9",
            "Not published",
            "¥0",
            "¥2",
            "¥8",
            "Not published",
            "¥0.04",
        ])
        expect(within(peak).getByText("09:00 – 12:00")).toBeVisible()
        expect(within(peak).getByText("14:00 – 18:00")).toBeVisible()
    })
})
