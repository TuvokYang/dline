// @vitest-environment jsdom
import type { ModelInfo } from "@shared/proto/dline/models"
import { PricingDayRule } from "@shared/proto/dline/models/metadata"
import { AnthropicProviderConfig } from "@shared/proto/dline/provider/anthropic"
import { BaseProviderConfig } from "@shared/proto/dline/provider/common"
import { OpenAiProviderConfig } from "@shared/proto/dline/provider/openai"
import { flatMeteredPricing } from "@shared/providers/pricing-shape"
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react"
import { useState } from "react"
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest"
import { flushPendingDebouncedInputs } from "../utils/useDebouncedInput"
import { AnthropicProvider } from "./AnthropicProvider"
import { DeepSeekProvider } from "./DeepSeekProvider"
import { OpenAIProvider } from "./OpenAIProvider"
import type { ApiProfile } from "./ProviderProfile"

const model: ModelInfo = { id: "test-model", pricing: flatMeteredPricing(1, 2) }
const deepseekModel: ModelInfo = {
    id: "test-model",
    pricing: {
        currency: "CNY",
        strategy: {
            timeOfDay: {
                schedule: {
                    timezoneOffsetMinutes: 480,
                    dayRule: PricingDayRule.PRICING_DAY_RULE_WEEKDAYS,
                    defaultOnPublicHolidays: true,
                    holidayCalendar: "CN",
                },
                defaultPrices: { inputPrice: 1, outputPrice: 4, cacheReadPrice: 0.02 },
                timeWindows: [
                    { startMinute: 540, endMinute: 720, prices: { inputPrice: 9, outputPrice: 27, cacheReadPrice: 0.3 } },
                    { startMinute: 840, endMinute: 1080, prices: { inputPrice: 9, outputPrice: 27, cacheReadPrice: 0.3 } },
                ],
            },
        },
    },
}
vi.mock("./useProviderModelOptions", () => ({
    useProviderModelOptions: ({ providerId }: { providerId: string }) => {
        const selected = providerId === "deepseek" ? deepseekModel : model
        return {
            models: { "test-model": selected },
            options: { "test-model": selected },
            defaultModelId: "test-model",
            modelInfoSaneDefaults: selected,
            optionOrigins: {},
            refreshRemoteModels: vi.fn(),
        }
    },
}))
vi.mock("@/context/ExtensionStateContext", () => ({ useExtensionState: () => ({ remoteConfigSettings: {} }) }))
vi.mock("../common/ApiKeyField", () => ({ ApiKeyField: () => null }))
vi.mock("../common/ModelAutocomplete", () => ({ ModelAutocomplete: () => null }))
vi.mock("../common/RemotelyConfiguredInputWrapper", () => ({
    RemotelyConfiguredInputWrapper: ({ children }: { children: React.ReactNode }) => children,
}))
vi.mock("../ThinkingControl", () => ({ default: () => null }))
vi.mock("../OpenAIServiceTierSelector", () => ({ default: () => null }))
vi.mock("./shared/ClaudeCodeIdentitySection", () => ({ ClaudeCodeIdentitySection: () => null }))
vi.mock("./ProviderWebToolsSettings", () => ({ ProviderWebToolsSettings: () => null }))

// Only widgets are projected to native elements. The real Provider, model
// configuration, pricing editor, tier editor and Profile updates remain wired.
vi.mock("@vscode/webview-ui-toolkit/react", async () => {
    const { forwardRef } = await import("react")
    return {
        VSCodeButton: ({ children, onClick, disabled }: React.ComponentProps<"button">) => (
            <button disabled={disabled} onClick={onClick} type="button">
                {children}
            </button>
        ),
        VSCodeCheckbox: forwardRef<HTMLInputElement, React.ComponentProps<"input">>(
            ({ children, checked, onChange, disabled, className }, ref) => (
                <label className={className}>
                    <input checked={checked} disabled={disabled} onChange={onChange} ref={ref} type="checkbox" />
                    {children}
                </label>
            ),
        ),
        VSCodeTextField: forwardRef<HTMLInputElement, React.ComponentProps<"input">>(({ onInput, ...props }, ref) => (
            <input {...props} onChange={() => {}} onInput={onInput} ref={ref} />
        )),
    }
})

function Host({ provider }: { provider: "openai" | "anthropic" | "deepseek" }) {
    const [profile, setProfile] = useState<ApiProfile>(
        () =>
            ({
                id: `${provider}-profile`,
                provider,
                modelId: "test-model",
                modelInfo: model,
                ...(provider === "openai"
                    ? { openai: OpenAiProviderConfig.create() }
                    : provider === "anthropic"
                      ? { anthropic: AnthropicProviderConfig.create() }
                      : { deepseek: BaseProviderConfig.create() }),
            }) as unknown as ApiProfile,
    )
    const Provider = provider === "openai" ? OpenAIProvider : provider === "anthropic" ? AnthropicProvider : DeepSeekProvider
    return (
        <>
            <Provider
                onUpdate={(updates) => setProfile((current) => ({ ...current, ...updates }))}
                profile={profile}
                showModelOptions
            />
            <output data-testid="profile">{JSON.stringify(profile)}</output>
        </>
    )
}

const originalScrollIntoView = Object.getOwnPropertyDescriptor(HTMLElement.prototype, "scrollIntoView")
beforeAll(() => Object.defineProperty(HTMLElement.prototype, "scrollIntoView", { configurable: true, value: vi.fn() }))
afterAll(() => {
    if (originalScrollIntoView) Object.defineProperty(HTMLElement.prototype, "scrollIntoView", originalScrollIntoView)
    else Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView")
})
afterEach(() => {
    cleanup()
    vi.useRealTimers()
})

describe.each(["openai", "anthropic"] as const)("%s custom URL pricing", (provider) => {
    it("gates price editing by the URL switch rather than custom model ID or URL contents", () => {
        render(<Host provider={provider} />)
        fireEvent.click(screen.getByRole("button", { name: "Model Configuration" }))
        expect(screen.queryByLabelText("Pricing Mode")).toBeNull()
        expect(screen.queryByRole("button", { name: "Add Pricing Tier" })).toBeNull()

        fireEvent.click(screen.getByRole("checkbox", { name: "Use custom model ID" }))
        expect(screen.queryByRole("button", { name: "Add Pricing Tier" })).toBeNull()
        fireEvent.click(screen.getByRole("checkbox", { name: "Use custom base URL" }))
        expect(screen.getByLabelText("Pricing Mode")).toBeTruthy()
        expect(screen.getByRole("button", { name: "Add Pricing Tier" })).toBeTruthy()
        const saved = JSON.parse(screen.getByTestId("profile").textContent ?? "null")
        expect(saved.baseUrl).toBeUndefined()
    })

    it("isolates the empty URL switch and pricing drafts across Profiles and models", async () => {
        const Provider = provider === "openai" ? OpenAIProvider : AnthropicProvider
        const onUpdate = vi.fn()
        const profile = (id: string, modelId: string, price: number): ApiProfile =>
            ({
                id,
                provider,
                modelId,
                modelInfo: { id: modelId, pricing: flatMeteredPricing(1, 2) },
                [provider]:
                    provider === "openai"
                        ? OpenAiProviderConfig.create({ pricing: flatMeteredPricing(price, 2) })
                        : AnthropicProviderConfig.create({ pricing: flatMeteredPricing(price, 2) }),
            }) as unknown as ApiProfile
        const first = profile("first", "test-model", 1)
        const view = render(<Provider onUpdate={onUpdate} profile={first} showModelOptions />)
        fireEvent.click(screen.getByRole("checkbox", { name: "Use custom base URL" }))
        fireEvent.click(screen.getByRole("button", { name: "Model Configuration" }))
        fireEvent.input(screen.getByLabelText("Input Price ($/1M tokens)"), { target: { value: "3" } })
        await act(flushPendingDebouncedInputs)
        expect(onUpdate.mock.lastCall?.[0][provider].pricing.strategy.flat.prices.inputPrice).toBe(3)

        view.rerender(<Provider onUpdate={onUpdate} profile={profile("second", "test-model", 8)} showModelOptions />)
        expect((screen.getByRole("checkbox", { name: "Use custom base URL" }) as HTMLInputElement).checked).toBe(false)
        fireEvent.click(screen.getByRole("checkbox", { name: "Use custom base URL" }))
        fireEvent.click(screen.getByRole("button", { name: "Model Configuration" }))
        expect((screen.getByLabelText("Input Price ($/1M tokens)") as HTMLInputElement).value).toBe("8")

        view.rerender(<Provider onUpdate={onUpdate} profile={profile("second", "other-model", 12)} showModelOptions />)
        fireEvent.click(screen.getByRole("button", { name: "Model Configuration" }))
        expect((screen.getByLabelText("Input Price ($/1M tokens)") as HTMLInputElement).value).toBe("12")
        fireEvent.input(screen.getByLabelText("Output Price ($/1M tokens)"), { target: { value: "7" } })
        await act(flushPendingDebouncedInputs)
        expect(onUpdate.mock.lastCall?.[0][provider].pricing.strategy.flat.prices).toEqual({ inputPrice: 12, outputPrice: 7 })
    })

    it("edits time windows and their nested context tiers through the real mode controls", async () => {
        render(<Host provider={provider} />)
        fireEvent.click(screen.getByRole("checkbox", { name: "Use custom base URL" }))
        fireEvent.click(screen.getByRole("button", { name: "Model Configuration" }))
        const choose = async (label: string, option: string) => {
            await act(async () => {
                fireEvent.keyDown(screen.getByRole("combobox", { name: label }), { key: "Enter" })
            })
            await act(async () => {
                fireEvent.click(screen.getByRole("option", { name: option }))
            })
        }
        await choose("Pricing Mode", "By time of day")
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Add Time Window" }))
        })
        fireEvent.input(screen.getByLabelText("Window 1 End (HH:MM, UTC+00:00)"), { target: { value: "00:30" } })
        await act(flushPendingDebouncedInputs)
        await choose("Rate", "By context size")
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Add Pricing Tier" }))
        })
        fireEvent.input(screen.getByLabelText("Tier 2 Input Price ($/1M tokens)"), { target: { value: "7" } })
        await act(flushPendingDebouncedInputs)
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Add Time Window" }))
        })
        const saved = JSON.parse(screen.getByTestId("profile").textContent ?? "null")[provider].pricing.strategy
        expect(saved.flat).toBeUndefined()
        expect(saved.contextWindow).toBeUndefined()
        expect(saved.timeOfDay.timeWindows).toEqual([
            {
                startMinute: 0,
                endMinute: 30,
                bands: {
                    bands: [
                        { maxInputTokens: 128_000, prices: { inputPrice: 1, outputPrice: 2 } },
                        { prices: { inputPrice: 7, outputPrice: 2 } },
                    ],
                },
            },
            { startMinute: 30, endMinute: 90, prices: { inputPrice: 1, outputPrice: 2 } },
        ])
        await act(async () => {
            fireEvent.click(screen.getAllByRole("button", { name: "Remove Time Window" })[0])
        })
        const remaining = JSON.parse(screen.getByTestId("profile").textContent ?? "null")[provider].pricing.strategy.timeOfDay
            .timeWindows
        expect(remaining).toEqual([{ startMinute: 30, endMinute: 90, prices: { inputPrice: 1, outputPrice: 2 } }])
    })

    it("makes Add tier work from flat pricing and retains a sole unbounded tail", async () => {
        render(<Host provider={provider} />)
        fireEvent.click(screen.getByRole("checkbox", { name: "Use custom base URL" }))
        fireEvent.click(screen.getByRole("button", { name: "Model Configuration" }))
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Add Pricing Tier" }))
        })
        await act(async () => {
            fireEvent.click(screen.getByRole("button", { name: "Add Pricing Tier" }))
        })
        const saved = JSON.parse(screen.getByTestId("profile").textContent ?? "null")
        const strategy = saved[provider].pricing.strategy
        expect(strategy.flat).toBeUndefined()
        expect(strategy.contextWindow.bands).toEqual([
            { maxInputTokens: 128_000, prices: { inputPrice: 1, outputPrice: 2 } },
            { maxInputTokens: 256_000, prices: { inputPrice: 1, outputPrice: 2 } },
            { prices: { inputPrice: 1, outputPrice: 2 } },
        ])
        await act(async () => {
            fireEvent.click(screen.getAllByRole("button", { name: "Remove Pricing Tier" }).at(-1)!)
        })
        const afterRemoval = JSON.parse(screen.getByTestId("profile").textContent ?? "null")
        expect(afterRemoval[provider].pricing.strategy.contextWindow.bands).toEqual([
            { maxInputTokens: 128_000, prices: { inputPrice: 1, outputPrice: 2 } },
            { prices: { inputPrice: 1, outputPrice: 2 } },
        ])
        fireEvent.click(screen.getByRole("checkbox", { name: "Use custom base URL" }))
        expect(screen.queryByRole("button", { name: "Add Pricing Tier" })).toBeNull()
        const afterClose = JSON.parse(screen.getByTestId("profile").textContent ?? "null")
        expect(afterClose[provider].pricing).toEqual(afterRemoval[provider].pricing)
    })
})

it("renders actual DeepSeek weekday intervals and keeps price edits scoped to their stored rates", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-11-03T01:00:00Z"))
    const view = render(<Host provider="deepseek" />)
    const values = () =>
        Array.from(view.container.querySelectorAll('[data-price-slot="inputPrice"]')).map((cell) =>
            Number.parseFloat(cell.textContent!.replace(/[^0-9.-]/g, "")),
        )
    expect(values()).toEqual([9, 1])
    expect(screen.getAllByRole("region")).toHaveLength(2)
    const offPeak = screen.getByRole("region", { name: "Off-peak window · Other times" })
    expect(offPeak.querySelector('[data-price-slot="inputPrice"]')).toHaveTextContent("¥1")
    const peak = screen.getByRole("region", { name: "Peak window · 09:00 – 12:00, 14:00 – 18:00" })
    expect(peak.querySelector('[data-price-slot="inputPrice"]')).toHaveTextContent("¥9")
    const bars = screen.getByRole("img").querySelectorAll('[data-rate-kind="peak"]')
    expect(Array.from(bars).map((bar) => [Number(bar.getAttribute("x")), Number(bar.getAttribute("width"))])).toEqual([
        [540, 180],
        [840, 240],
    ])
    fireEvent.click(screen.getByRole("button", { name: "Model Configuration" }))
    expect(screen.queryByLabelText("Pricing Mode")).toBeNull()
    expect(screen.queryByRole("button", { name: "Add Time Window" })).toBeNull()
    fireEvent.input(screen.getByLabelText("Off-peak Input Price (¥/1M tokens)"), { target: { value: "5" } })
    fireEvent.input(screen.getByLabelText("Peak window 09:00 – 12:00 Output Price (¥/1M tokens)"), { target: { value: "29" } })
    await act(flushPendingDebouncedInputs)
    const saved = JSON.parse(screen.getByTestId("profile").textContent ?? "null")
    expect(saved.deepseek.pricing.strategy.timeOfDay.defaultPrices.inputPrice).toBe(5)
    expect(saved.deepseek.pricing.strategy.timeOfDay.timeWindows[0].prices.outputPrice).toBe(29)
    expect(saved.deepseek.pricing.strategy.timeOfDay.timeWindows[1].prices.outputPrice).toBe(27)
    expect(saved.deepseek.pricing.strategy.timeOfDay.schedule).toEqual(deepseekModel.pricing!.strategy!.timeOfDay!.schedule)
    expect(values()).toEqual([9, 9, 5])
    await act(async () => {
        fireEvent.click(screen.getByRole("button", { name: "Reset Pricing" }))
    })
    expect(JSON.parse(screen.getByTestId("profile").textContent ?? "null").deepseek.pricing).toBeUndefined()
    expect(values()).toEqual([9, 1])
})

it("renders the real DeepSeek weekend as all-day off-peak while preserving the editable peak configuration", async () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date("2026-11-08T05:20:00Z"))
    render(<Host provider="deepseek" />)
    const chart = screen.getByRole("img", { name: "Pricing windows for 2026-11-08 (UTC+08:00)" })
    expect(chart.querySelectorAll('[data-rate-kind="peak"]')).toHaveLength(0)
    const offPeak = screen.getByRole("region", { name: "Off-peak window · 00:00 – 24:00" })
    expect(offPeak.querySelector('[data-price-slot="inputPrice"]')).toHaveTextContent("¥1")
    expect(screen.queryByRole("region", { name: /^Peak window/ })).toBeNull()
    const before = JSON.parse(screen.getByTestId("profile").textContent ?? "null")
    expect(before.deepseek.pricing).toBeUndefined()
    fireEvent.click(screen.getByRole("button", { name: "Model Configuration" }))
    expect(screen.getByLabelText("Peak window 09:00 – 12:00 Output Price (¥/1M tokens)")).toHaveValue("27")
    fireEvent.input(screen.getByLabelText("Off-peak Input Price (¥/1M tokens)"), { target: { value: "5" } })
    await act(flushPendingDebouncedInputs)
    const saved = JSON.parse(screen.getByTestId("profile").textContent ?? "null")
    expect(saved.deepseek.pricing.strategy.timeOfDay.timeWindows).toEqual(deepseekModel.pricing!.strategy!.timeOfDay!.timeWindows)
    expect(within(offPeak).getByText("¥5")).toBeVisible()
    expect(chart.querySelectorAll('[data-rate-kind="peak"]')).toHaveLength(0)
})
