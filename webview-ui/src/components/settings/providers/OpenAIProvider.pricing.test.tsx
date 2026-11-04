// @vitest-environment jsdom
import type { ModelInfo } from "@shared/proto/dline/models"
import type { ModelCapabilities, ModelPricing } from "@shared/proto/dline/models/metadata"
import { OpenAiProviderConfig } from "@shared/proto/dline/provider/openai"
import { flatMeteredPricing, readPriceSet } from "@shared/providers/pricing-shape"
import { act, render, screen } from "@testing-library/react"
import { useState } from "react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ModelInfoView } from "../common/ModelInfoView"
import { OpenAIProvider } from "./OpenAIProvider"
import type { ApiProfile } from "./ProviderProfile"

/** Registry metadata whose prices differ from the ones typed in the test. */
/** Approximates how long the extension host takes to echo a saved profile. */
const ECHO_DELAY_MS = 500

/**
 * A flat metered price that also publishes a separate thinking-output rate.
 *
 * The summary reads `thinkingOutputPrice` from the same flat price slot as the
 * plain rates, so a model that charges extra for reasoning tokens declares it
 * there rather than in a sibling field.
 */
function thinkingPricing(outputPrice: number, thinkingOutputPrice: number): ModelPricing {
    const pricing = flatMeteredPricing(0, outputPrice)
    const flat = pricing.strategy?.flat
    if (!flat) {
        throw new Error("Flat pricing expected")
    }
    return { currency: pricing.currency, strategy: { flat: { prices: { ...flat.prices, thinkingOutputPrice } } } }
}

const registryModel: ModelInfo = {
    id: "gpt-custom",
    name: "Registry GPT",
    capabilities: { contextWindow: 128_000, maxTokens: 4096 } as ModelCapabilities,
    pricing: flatMeteredPricing(1, 2),
}

vi.mock("./useProviderModelOptions", () => ({
    useProviderModelOptions: () => ({
        options: { "gpt-custom": registryModel },
        refreshRemoteModels: vi.fn(),
        models: { "gpt-custom": registryModel },
        defaultModelId: "gpt-custom",
        modelInfoSaneDefaults: registryModel,
        loading: false,
    }),
}))

vi.mock("../common/ApiKeyField", () => ({ ApiKeyField: () => <div /> }))
vi.mock("../common/BaseUrlField", () => ({ BaseUrlField: () => <div /> }))
vi.mock("../common/ModelAutocomplete", () => ({ ModelAutocomplete: () => <div /> }))
vi.mock("../ThinkingControl", () => ({ default: () => <div /> }))
vi.mock("../OpenAIServiceTierSelector", () => ({ default: () => <div /> }))
vi.mock("@/services/grpc-client", () => ({ ModelsServiceClient: { refreshOpenAiModels: vi.fn() } }))

/**
 * Holds the profile the way the settings list does: each update replaces the
 * stored profile and re-renders the provider with the new value.
 */
function ProfileHost() {
    const [profile, setProfile] = useState<ApiProfile>(
        () =>
            ({
                id: "profile-1",
                provider: "openai",
                modelId: "gpt-custom",
                baseUrl: "https://proxy.invalid/v1",
                openai: OpenAiProviderConfig.create({ customModelEnabled: false }),
            }) as unknown as ApiProfile,
    )

    return (
        <>
            <OpenAIProvider
                onUpdate={(updates) => {
                    // The real profile round-trips through the extension host, so the
                    // prop lags behind the edit that produced it.
                    setTimeout(() => {
                        setProfile((current) => ({ ...current, ...updates }))
                    }, ECHO_DELAY_MS)
                }}
                profile={profile}
                showModelOptions={true}
            />
            {/* The host state the settings list would persist, readable by tests. */}
            <div data-testid="persisted-profile" hidden>
                {JSON.stringify(profile)}
            </div>
        </>
    )
}

async function typePrice(label: string, value: string): Promise<void> {
    // jsdom does not upgrade the toolkit element, so it exposes no textbox role.
    const field = document.querySelector<HTMLElement>(`vscode-text-field[aria-label="${label}"]`)
    if (!field) {
        throw new Error(`missing price field: ${label}`)
    }

    await act(async () => {
        // The toolkit field reports edits through `input`, matching real typing.
        ;(field as unknown as { value: string }).value = value
        field.dispatchEvent(new Event("input", { bubbles: true }))
    })
    // Let the host echo this edit before typing the next one, as real typing does.
    await act(async () => {
        await vi.advanceTimersByTimeAsync(ECHO_DELAY_MS + 100)
    })
}

describe("OpenAIProvider pricing round trip", () => {
    beforeEach(() => {
        vi.clearAllMocks()
        vi.useFakeTimers()
    })

    it("keeps every price entered in sequence", async () => {
        render(<ProfileHost />)

        // Pricing fields only mount once the disclosure is open, as in the UI.
        await act(async () => {
            screen.getByRole("button", { name: "Model Configuration" }).click()
        })

        await typePrice("Input Price ($/1M tokens)", "1.25")
        await typePrice("Output Price ($/1M tokens)", "2.5")
        await typePrice("Cache Writes ($/1M tokens)", "0.75")
        await typePrice("Cache Reads ($/1M tokens)", "0.25")

        // Let every pending echo arrive before reading the summary.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(ECHO_DELAY_MS * 4)
        })

        // The declared contract is that every typed rate survives round-trip, so
        // read the persisted profile rather than rendered text.
        const persisted = JSON.parse(screen.getByTestId("persisted-profile").textContent ?? "null")
        expect(readPriceSet(persisted.openai.pricing.strategy.flat.prices)).toEqual({
            inputPrice: 1.25,
            outputPrice: 2.5,
            cacheWritePrice: 0.75,
            cacheReadPrice: 0.25,
        })
    })
})

describe("ModelInfoView complete pricing declaration", () => {
    const displayedRates = (container: HTMLElement) =>
        Object.fromEntries(
            Array.from(container.querySelectorAll<HTMLElement>("[data-price-slot]")).map((cell) => [
                cell.dataset.priceSlot,
                Number.parseFloat(cell.textContent!.replace(/[^0-9.-]/g, "")),
            ]),
        )

    it.each([false, true])("keeps standard output and thinking rates distinct with reasoning support %s", (supported) => {
        const modelInfo: ModelInfo = {
            id: "opaque-price",
            capabilities: { supportsReasoning: supported },
            pricing: thinkingPricing(2, 7),
        }
        const { container } = render(<ModelInfoView modelInfo={modelInfo} selectedModelId={modelInfo.id} />)
        expect(displayedRates(container)).toEqual({ inputPrice: 0, outputPrice: 2, thinkingOutputPrice: 7 })
        expect(screen.queryAllByRole("textbox")).toHaveLength(0)
    })

    it("preserves published currency precision and optional prices", () => {
        const modelInfo: ModelInfo = { id: "cny-display", pricing: flatMeteredPricing(3, 6, 3, 0.025, "CNY") }
        const { container } = render(<ModelInfoView modelInfo={modelInfo} selectedModelId={modelInfo.id} />)
        expect(displayedRates(container)).toEqual({ inputPrice: 3, outputPrice: 6, cacheWritePrice: 3, cacheReadPrice: 0.025 })
        for (const cell of container.querySelectorAll("[data-price-slot]")) expect(cell.textContent?.charAt(0)).toBe("¥")
    })

    it("does not suppress published zero prices or substitute unpublished cache prices", () => {
        const zero = thinkingPricing(2, 0)
        const { container } = render(
            <ModelInfoView
                modelInfo={{ id: "zero", pricing: zero, capabilities: { supportsPromptCache: true } }}
                selectedModelId="zero"
            />,
        )
        expect(displayedRates(container)).toEqual({
            inputPrice: 0,
            outputPrice: 2,
            thinkingOutputPrice: 0,
            cacheWritePrice: Number.NaN,
            cacheReadPrice: Number.NaN,
        })
    })
})
