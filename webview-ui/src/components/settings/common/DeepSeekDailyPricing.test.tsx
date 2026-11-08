// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
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

    it("renders five actual weekday intervals with the matching Flash rates", () => {
        showAt("2026-11-03T01:00:00Z")
        expect(intervals()).toEqual(weekdayIntervals)
        const expected = [
            ["Off-peak window · 00:00 – 09:00", ["¥1", "¥4", "Not published", "¥0.02"]],
            ["Peak window · 09:00 – 12:00", ["¥2", "¥8", "Not published", "¥0.04"]],
            ["Off-peak window · 12:00 – 14:00", ["¥1", "¥4", "Not published", "¥0.02"]],
            ["Peak window · 14:00 – 18:00", ["¥2", "¥8", "Not published", "¥0.04"]],
            ["Off-peak window · 18:00 – 24:00", ["¥1", "¥4", "Not published", "¥0.02"]],
        ] as const
        expect(
            screen.getAllByRole("heading", { level: 3, name: /^(Peak|Off-peak) window/ }).map((heading) => heading.textContent),
        ).toEqual(expected.map(([title]) => title))
        for (const [title, amounts] of expected) expect(prices(card(title))).toEqual(amounts)
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
        const peak = card("Peak window · 09:00 – 12:00")
        expect(within(peak).getByText("Tier 1 · 0 ≤ input tokens ≤ 128,000")).toBeVisible()
        expect(prices(peak)).toEqual(["¥0", "¥3", "Not published", "Not published", "¥6", "¥9", "Not published", "¥0"])
    })
})
