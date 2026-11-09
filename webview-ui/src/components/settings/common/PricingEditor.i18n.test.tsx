import { ModelPricing, PricingDayRule } from "@shared/proto/dline/models/metadata"
import { flatMeteredPricing } from "@shared/providers/pricing-shape"
import type { UiLanguage } from "@shared/UiLanguage"
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { UiLanguageProvider } from "@/i18n/UiLanguageProvider"
import { flushPendingDebouncedInputs } from "../utils/useDebouncedInput"
import { PricingEditor } from "./PricingEditor"

// Keep the real editors, debounce/parser and Radix controls; adapt only the toolkit host to jsdom.
vi.mock("@vscode/webview-ui-toolkit/react", async () => {
    const { forwardRef } = await import("react")
    return {
        VSCodeButton: ({ children, onClick, disabled }: React.ComponentProps<"button">) => (
            <button disabled={disabled} onClick={onClick} type="button">
                {children}
            </button>
        ),
        VSCodeCheckbox: ({ children, checked, onChange }: React.ComponentProps<"input">) => (
            <label>
                <input checked={checked} onChange={onChange} type="checkbox" />
                {children}
            </label>
        ),
        VSCodeTextField: forwardRef<HTMLInputElement, React.ComponentProps<"input">>(({ onInput, ...props }, ref) => (
            <input {...props} onChange={() => {}} onInput={onInput} ref={ref} />
        )),
    }
})

beforeEach(() => vi.useFakeTimers())
afterEach(() => {
    cleanup()
    vi.useRealTimers()
})
const flush = () => act(flushPendingDebouncedInputs)

function timePricing(): ModelPricing {
    return ModelPricing.create({
        currency: "CNY",
        strategy: {
            timeOfDay: {
                schedule: {
                    timezoneOffsetMinutes: 480,
                    dayRule: PricingDayRule.PRICING_DAY_RULE_WEEKDAYS,
                    defaultOnPublicHolidays: true,
                    holidayCalendar: "CN",
                },
                defaultPrices: { inputPrice: 0.000000000123, outputPrice: 2 },
                timeWindows: [{ startMinute: 540, endMinute: 720, prices: { inputPrice: 5, outputPrice: 6 } }],
            },
        },
    })
}

describe("pricing language changes", () => {
    it("keeps the same price input and uncommitted precision draft across en → zh-CN → en", async () => {
        const onChange = vi.fn()
        const pricing = flatMeteredPricing(1, 2)
        const tree = (language: UiLanguage) => (
            <UiLanguageProvider language={language}>
                <PricingEditor onChange={onChange} pricing={pricing} tiersEditable />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        const price = screen.getByLabelText("Input Price ($/1M tokens)")
        const id = price.id
        fireEvent.input(price, { target: { value: "0.000000000123" } })
        view.rerender(tree("zh-CN"))
        expect(screen.getByLabelText("输入价格（$/百万 Token）")).toBe(price)
        expect(screen.getByRole("heading", { name: "定价" })).toBeVisible()
        expect(price).toHaveValue("0.000000000123")
        view.rerender(tree("en"))
        expect(screen.getByLabelText("Input Price ($/1M tokens)")).toBe(price)
        expect(price.id).toBe(id)
        expect(price).toHaveValue("0.000000000123")
        expect(onChange).not.toHaveBeenCalled()
        await flush()
        expect(onChange).toHaveBeenCalledExactlyOnceWith(flatMeteredPricing(0.000000000123, 2))
    })

    it("retranslates an existing validation error without losing the invalid draft or changing the schedule", async () => {
        const onChange = vi.fn()
        const pricing = timePricing()
        const original = ModelPricing.toJSON(pricing)
        const tree = (language: UiLanguage) => (
            <UiLanguageProvider language={language}>
                <PricingEditor onChange={onChange} pricing={pricing} tiersEditable />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        const start = screen.getByRole("textbox", { name: "Window 1 Start (HH:MM, UTC+08:00)" })
        fireEvent.input(start, { target: { value: "25:00" } })
        await flush()
        expect(screen.getByRole("alert")).toHaveTextContent("Use HH:MM between 00:00 and 24:00")
        view.rerender(tree("zh-CN"))
        expect(screen.getByRole("textbox", { name: "窗口 1 开始（HH:MM，UTC+08:00）" })).toBe(start)
        expect(start).toHaveValue("25:00")
        expect(screen.getByRole("alert")).toHaveTextContent("时间窗口不可重叠")
        expect(screen.getByRole("textbox", { name: "卖方 UTC 偏移（分钟）" })).toHaveValue("480")
        expect(screen.getByText("窗口 1 · 09:00 – 12:00")).toBeVisible()
        expect(screen.getByRole("checkbox", { name: "中国公共假日使用默认费率" })).toBeChecked()
        view.rerender(tree("en"))
        expect(screen.getByRole("textbox", { name: "Window 1 Start (HH:MM, UTC+08:00)" })).toBe(start)
        expect(start).toHaveValue("25:00")
        expect(screen.getByRole("alert")).toHaveTextContent("Use HH:MM between 00:00 and 24:00")
        expect(onChange).not.toHaveBeenCalled()
        expect(ModelPricing.toJSON(pricing)).toEqual(original)
        fireEvent.input(start, { target: { value: "10:00" } })
        await flush()
        const saved: ModelPricing = onChange.mock.calls[0][0]
        expect(saved.currency).toBe("CNY")
        expect(saved.strategy?.timeOfDay?.schedule).toEqual(pricing.strategy?.timeOfDay?.schedule)
        expect(saved.strategy?.timeOfDay?.timeWindows[0]).toMatchObject({ startMinute: 600, endMinute: 720 })
        expect(saved.strategy?.timeOfDay?.defaultPrices?.inputPrice).toBe(0.000000000123)
    })

    it("keeps financial formatting and unpublished/zero distinction in both languages", () => {
        const pricing = ModelPricing.create({
            currency: "CNY",
            strategy: {
                flat: {
                    prices: {
                        inputPrice: 0.000000000123,
                        outputPrice: 0,
                    },
                },
            },
        })
        const tree = (language: UiLanguage) => (
            <UiLanguageProvider language={language}>
                <PricingEditor pricing={pricing} readOnly showCachePrices />
            </UiLanguageProvider>
        )
        const view = render(tree("en"))
        const prices = () => Array.from(view.container.querySelectorAll("[data-price-slot]"), (cell) => cell.textContent)
        expect(prices()).toEqual(["¥0.000000000123", "¥0", "Not published", "Not published"])
        view.rerender(tree("zh-CN"))
        expect(screen.getByText("CNY / 百万 Token")).toBeVisible()
        expect(prices()).toEqual(["¥0.000000000123", "¥0", "未公布", "未公布"])
        view.rerender(tree("en"))
        expect(prices()).toEqual(["¥0.000000000123", "¥0", "Not published", "Not published"])
    })
})
