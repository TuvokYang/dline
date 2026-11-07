// @vitest-environment jsdom
import { ModelPricing, PricingDayRule } from "@shared/proto/dline/models/metadata"
import { flatMeteredPricing } from "@shared/providers/pricing-shape"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { afterEach, describe, expect, it, vi } from "vitest"
import { flushPendingDebouncedInputs } from "../utils/useDebouncedInput"
import { PricingEditor } from "./PricingEditor"

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

afterEach(cleanup)
const defaults = flatMeteredPricing(1, 2)
function input(label: string, value: string) {
    fireEvent.input(screen.getByLabelText(label), { target: { value } })
}
const flush = () => act(flushPendingDebouncedInputs)
function cardWithTitle(title: string) {
    const heading = screen.getByText(title, { selector: "strong" })
    expect(heading).toBeVisible()
    return heading.parentElement!
}
function expectScopedField(card: HTMLElement, scope: string, label: string, value: string) {
    const field = within(card).getByRole("textbox", { name: `${scope} ${label}` })
    const visibleLabel = within(card).getByText(label, { selector: "label" })
    expect(visibleLabel).toBeVisible()
    expect(visibleLabel).toHaveAttribute("for", field.id)
    expect(within(card).getByLabelText(label)).toBe(field)
    expect(field).toHaveValue(value)
}
const props = { defaults, tiersEditable: true, showCachePrices: true }
const timePricing = (): ModelPricing => ({
    currency: "CNY",
    strategy: {
        timeOfDay: {
            schedule: {
                timezoneOffsetMinutes: 480,
                dayRule: PricingDayRule.PRICING_DAY_RULE_WEEKDAYS,
                defaultOnPublicHolidays: false,
                holidayCalendar: "",
            },
            defaultBands: {
                bands: [
                    { maxInputTokens: 100, prices: { inputPrice: 1, outputPrice: 2 } },
                    { prices: { inputPrice: 3, outputPrice: 4 } },
                ],
            },
            timeWindows: [
                { startMinute: 540, endMinute: 720, prices: { inputPrice: 5, outputPrice: 6, cacheReadPrice: 0 } },
                { startMinute: 840, endMinute: 1080, prices: { inputPrice: 7, outputPrice: 8 } },
            ],
        },
    },
})

describe("pricing declaration drafts", () => {
    it("starts unpublished slots blank and edits only the supplied price", async () => {
        let saved: ModelPricing | undefined
        render(
            <PricingEditor
                onChange={(next) => {
                    saved = next
                }}
                tiersEditable={true}
            />,
        )
        expect(screen.getByLabelText("Input Price ($/1M tokens)")).toHaveValue("")
        expect(screen.getByLabelText("Output Price ($/1M tokens)")).toHaveValue("")
        input("Output Price ($/1M tokens)", "0")
        await flush()
        expect(saved?.strategy?.flat?.prices?.inputPrice).toBeUndefined()
        expect(saved?.strategy?.flat?.prices?.outputPrice).toBe(0)
    })

    it("merges simultaneous debounced slots without a host echo and preserves zero/absence", async () => {
        let saved: ModelPricing | undefined
        render(
            <PricingEditor
                {...props}
                onChange={(next) => {
                    saved = next
                }}
            />,
        )
        input("Input Price ($/1M tokens)", "0")
        input("Output Price ($/1M tokens)", "9")
        input("Cache Reads ($/1M tokens)", "0")
        await flush()
        expect(saved?.strategy?.flat?.prices).toEqual({ inputPrice: 0, outputPrice: 9, cacheReadPrice: 0 })
        input("Cache Reads ($/1M tokens)", "")
        await flush()
        expect(saved?.strategy?.flat?.prices).toEqual({ inputPrice: 0, outputPrice: 9, cacheReadPrice: undefined })
        const valid = saved
        input("Input Price ($/1M tokens)", "")
        await flush()
        expect(saved).toBe(valid)
        expect(screen.getByRole("alert")).toBeTruthy()
    })

    it("numbers window card titles, keeps linked labels short and saves edits to the matching window", async () => {
        let saved = timePricing()
        render(
            <PricingEditor
                {...props}
                onChange={(next) => {
                    saved = next
                }}
                pricing={saved}
            />,
        )
        const cards = [cardWithTitle("Window 1 · 09:00 – 12:00"), cardWithTitle("Window 2 · 14:00 – 18:00")]
        const fields = [
            ["Start (HH:MM, UTC+08:00)", ["09:00", "14:00"]],
            ["End (HH:MM, UTC+08:00)", ["12:00", "18:00"]],
            ["Input Price (¥/1M tokens)", ["5", "7"]],
            ["Output Price (¥/1M tokens)", ["6", "8"]],
            ["Cache Writes (¥/1M tokens)", ["", ""]],
            ["Cache Reads (¥/1M tokens)", ["0", ""]],
        ] as const
        cards.forEach((card, index) => {
            expect(Array.from(card.querySelectorAll("label"), (label) => label.textContent)).toEqual([
                fields[0][0],
                fields[1][0],
                "Rate",
                ...fields.slice(2).map(([label]) => label),
            ])
            fields.forEach(([label, values]) => expectScopedField(card, `Window ${index + 1}`, label, values[index]))
        })
        input("Window 1 Start (HH:MM, UTC+08:00)", "08:45")
        input("Window 1 Input Price (¥/1M tokens)", "11")
        input("Window 2 Input Price (¥/1M tokens)", "13")
        input("Window 2 Output Price (¥/1M tokens)", "12")
        await flush()
        expect(saved.strategy?.timeOfDay?.timeWindows).toEqual([
            { startMinute: 525, endMinute: 720, prices: { inputPrice: 11, outputPrice: 6, cacheReadPrice: 0 } },
            { startMinute: 840, endMinute: 1080, prices: { inputPrice: 13, outputPrice: 12 } },
        ])
        expectScopedField(cardWithTitle("Window 1 · 08:45 – 12:00"), "Window 1", "Input Price (¥/1M tokens)", "11")
        expectScopedField(cards[1], "Window 2", "Input Price (¥/1M tokens)", "13")
        const valid = saved
        input("Window 1 End (HH:MM, UTC+08:00)", "15:00")
        input("Window 2 End (HH:MM, UTC+08:00)", "24:30")
        await flush()
        expect(saved).toBe(valid)
        expect(screen.getAllByRole("alert")).toHaveLength(2)
    })

    it("adds a legal gap with the entire default bands rather than a zero rate or first band", async () => {
        let saved = timePricing()
        render(
            <PricingEditor
                {...props}
                onChange={(next) => {
                    saved = next
                }}
                pricing={saved}
            />,
        )
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Add Time Window" }))
        })
        expect(saved.strategy?.timeOfDay?.timeWindows.at(-1)).toEqual({
            startMinute: 0,
            endMinute: 60,
            bands: timePricing().strategy!.timeOfDay!.defaultBands,
        })
    })

    it("numbers tier card titles, keeps linked labels short and saves edits to the matching tier", async () => {
        let saved: ModelPricing = {
            currency: "USD",
            strategy: {
                contextWindow: {
                    bands: [
                        { maxInputTokens: 100, prices: { inputPrice: 1, outputPrice: 2 } },
                        { prices: { inputPrice: 3, outputPrice: 4 } },
                    ],
                },
            },
        }
        render(
            <PricingEditor
                {...props}
                onChange={(next) => {
                    saved = next
                }}
                pricing={saved}
            />,
        )
        const cards = [cardWithTitle("Tier 1 · 0 ≤ input tokens ≤ 100"), cardWithTitle("Tier 2 · Above 100 input tokens")]
        const fields = [
            ["Input Price ($/1M tokens)", ["1", "3"]],
            ["Output Price ($/1M tokens)", ["2", "4"]],
            ["Cache Writes ($/1M tokens)", ["", ""]],
            ["Cache Reads ($/1M tokens)", ["", ""]],
        ] as const
        cards.forEach((card, index) => {
            expect(Array.from(card.querySelectorAll("label"), (label) => label.textContent)).toEqual([
                ...(index === 0 ? ["Up To Input Tokens"] : []),
                ...fields.map(([label]) => label),
            ])
            fields.forEach(([label, values]) => expectScopedField(card, `Tier ${index + 1}`, label, values[index]))
        })
        input("Tier 1 Input Price ($/1M tokens)", "5")
        input("Tier 2 Input Price ($/1M tokens)", "7")
        input("Tier 2 Output Price ($/1M tokens)", "6")
        await flush()
        expect(saved.strategy?.contextWindow?.bands).toEqual([
            { maxInputTokens: 100, prices: { inputPrice: 5, outputPrice: 2 } },
            { prices: { inputPrice: 7, outputPrice: 6 } },
        ])
        expectScopedField(cards[0], "Tier 1", "Input Price ($/1M tokens)", "5")
        expectScopedField(cards[1], "Tier 2", "Input Price ($/1M tokens)", "7")
        input("Up To Input Tokens", "0")
        await flush()
        expect(saved.strategy?.contextWindow?.bands[0].maxInputTokens).toBe(100)
        expect(screen.getByRole("alert")).toBeTruthy()
    })

    it("flushes pending sibling edits before removing a window so input cannot move to its neighbour", async () => {
        let saved = timePricing()
        render(
            <PricingEditor
                {...props}
                onChange={(next) => {
                    saved = next
                }}
                pricing={saved}
            />,
        )
        input("Window 1 Input Price (¥/1M tokens)", "11")
        input("Window 2 Output Price (¥/1M tokens)", "12")
        await act(async () => {
            fireEvent.click(screen.getAllByRole("button", { name: "Remove Time Window" })[0])
        })
        await flush()
        expect(saved.strategy?.timeOfDay?.timeWindows).toEqual([
            { startMinute: 840, endMinute: 1080, prices: { inputPrice: 7, outputPrice: 12 } },
        ])
    })

    it("makes Reset the final action even with an unflushed input", async () => {
        const actions: string[] = []
        render(<PricingEditor {...props} onChange={() => actions.push("edit")} onReset={() => actions.push("reset")} />)
        input("Input Price ($/1M tokens)", "5")
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Reset Pricing" }))
        })
        await flush()
        expect(actions.at(-1)).toBe("reset")
    })

    it("uses the same complete rate structure in read-only mode without exposing mutations", () => {
        const onChange = vi.fn()
        const onReset = vi.fn()
        const pricing = timePricing()
        const view = render(<PricingEditor {...props} onChange={onChange} onReset={onReset} pricing={pricing} readOnly={true} />)
        expect(screen.queryAllByRole("textbox")).toHaveLength(0)
        expect(screen.queryAllByRole("combobox")).toHaveLength(0)
        expect(screen.queryAllByRole("button")).toHaveLength(0)
        const cardTitles = [
            "Tier 1 · 0 ≤ input tokens ≤ 100",
            "Tier 2 · Above 100 input tokens",
            "Window 1 · 09:00 – 12:00",
            "Window 2 · 14:00 – 18:00",
        ]
        const slotLabels = [
            ["inputPrice", "Input Price (¥/1M tokens)"],
            ["outputPrice", "Output Price (¥/1M tokens)"],
            ["cacheWritePrice", "Cache Writes (¥/1M tokens)"],
            ["cacheReadPrice", "Cache Reads (¥/1M tokens)"],
        ] as const
        cardTitles.forEach((title) => {
            const card = cardWithTitle(title)
            expect(card.querySelectorAll("[data-price-slot]")).toHaveLength(slotLabels.length)
            slotLabels.forEach(([slot, label]) => {
                const value = card.querySelector(`[data-price-slot="${slot}"]`)
                expect(value).toBeVisible()
                expect(value?.closest(".profile-field")?.firstElementChild?.textContent).toBe(label)
            })
        })
        const values = Array.from(view.container.querySelectorAll('[data-price-slot="inputPrice"]')).map((cell) =>
            Number.parseFloat(cell.textContent!.replace(/[^0-9.-]/g, "")),
        )
        expect(values).toEqual([1, 3, 5, 7])
        const bars = screen
            .getByRole("img", { name: "Configured pricing windows in seller time" })
            .querySelectorAll("[data-window-index]")
        expect(Array.from(bars).map((bar) => [Number(bar.getAttribute("x")), Number(bar.getAttribute("width"))])).toEqual([
            [540, 180],
            [840, 240],
        ])
        view.rerender(
            <PricingEditor {...props} onChange={onChange} onReset={onReset} pricing={flatMeteredPricing(0, 9)} readOnly={true} />,
        )
        expect(screen.queryByRole("img")).toBeNull()
        expect(view.container.querySelector('[data-price-slot="inputPrice"]')?.textContent).toBe("$0")
        expect(onChange).not.toHaveBeenCalled()
        expect(onReset).not.toHaveBeenCalled()
    })

    it("ignores intermediate host echoes and resets by deleting the override", async () => {
        const emitted: ModelPricing[] = []
        const onChange = (next: ModelPricing) => emitted.push(next)
        const reset = vi.fn()
        const view = render(<PricingEditor {...props} onChange={onChange} onReset={reset} />)
        input("Input Price ($/1M tokens)", "5")
        await flush()
        input("Output Price ($/1M tokens)", "6")
        await flush()
        view.rerender(<PricingEditor {...props} onChange={onChange} onReset={reset} pricing={emitted[0]} />)
        input("Cache Reads ($/1M tokens)", "7")
        await flush()
        expect(emitted.at(-1)?.strategy?.flat?.prices).toEqual({ inputPrice: 5, outputPrice: 6, cacheReadPrice: 7 })
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Reset Pricing" }))
        })
        expect(reset).toHaveBeenCalledOnce()
        expect(emitted).toHaveLength(3)
    })
})
