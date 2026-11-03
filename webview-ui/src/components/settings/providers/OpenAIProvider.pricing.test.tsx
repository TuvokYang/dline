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
    const flat = pricing.metered?.strategy?.flat
    if (!flat) {
        throw new Error("flat metered pricing expected")
    }
    return {
        metered: {
            ...pricing.metered,
            strategy: { ...pricing.metered?.strategy, flat: { prices: { ...flat.prices, thinkingOutputPrice } } },
        },
    }
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
        await typePrice("Cache Writes ($/M)", "0.75")
        await typePrice("Cache Reads ($/M)", "0.25")

        // Let every pending echo arrive before reading the summary.
        await act(async () => {
            await vi.advanceTimersByTimeAsync(ECHO_DELAY_MS * 4)
        })

        // The declared contract is that every typed rate survives round-trip, so
        // read the persisted profile rather than rendered text.
        const persisted = JSON.parse(screen.getByTestId("persisted-profile").textContent ?? "null")
        expect(readPriceSet(persisted.openai.pricing.metered.strategy.flat.prices)).toEqual({
            inputPrice: 1.25,
            outputPrice: 2.5,
            cacheWritePrice: 0.75,
            cacheReadPrice: 0.25,
        })
    })
})

describe("ModelInfoView thinking output pricing", () => {
    it.each<[string, ModelCapabilities, string]>([
        ["maximum without mode", { thinking: { supported: true, maxBudget: 100 } }, "$2/M"],
        ["coarse veto", { supportsReasoning: false, thinking: { supported: true, mode: "budget", maxBudget: 100 } }, "$2/M"],
        ["nested veto", { thinking: { supported: false, mode: "budget", maxBudget: 100 } }, "$2/M"],
        ["missing support", { supportsReasoning: true, thinking: { mode: "budget", maxBudget: 100 } }, "$2/M"],
        ["effort mode", { thinking: { supported: true, mode: "effort", maxBudget: 100 } }, "$2/M"],
        ["inverted bounds", { thinking: { supported: true, mode: "budget", minBudget: 17, maxBudget: 8 } }, "$2/M"],
        ["fractional maximum", { thinking: { supported: true, mode: "budget", maxBudget: 10.5 } }, "$2/M"],
        ["zero maximum", { thinking: { supported: true, mode: "budget", maxBudget: 0 } }, "$2/M"],
        ["unbounded budget", { thinking: { supported: true, mode: "budget", minBudget: 17 } }, "$7/M"],
        ["both mode", { thinking: { supported: true, mode: "both", maxBudget: 100 } }, "$7/M"],
    ])("renders the declared output price for %s", (_label, capabilities, expected) => {
        const modelInfo: ModelInfo = { id: "opaque-price", capabilities, pricing: thinkingPricing(2, 7) }
        render(<ModelInfoView modelInfo={modelInfo} selectedModelId={modelInfo.id} />)
        expect(screen.getByText(expected)).toBeInTheDocument()
        expect(screen.queryByText(expected === "$7/M" ? "$2/M" : "$7/M")).not.toBeInTheDocument()
    })

    it("uses the model billing currency and displays output limits and declared capabilities", () => {
        const modelInfo: ModelInfo = {
            id: "deepseek-cny-display",
            capabilities: {
                contextWindow: 1_000_000,
                maxTokens: 384_000,
                supportsTools: true,
                supportsReasoning: true,
                supportsPromptCache: true,
            },
            pricing: flatMeteredPricing(3, 6, 3, 0.025, "CNY"),
        }

        render(<ModelInfoView modelInfo={modelInfo} selectedModelId={modelInfo.id} />)

        expect(screen.getByText("384K")).toBeInTheDocument()
        expect(screen.getAllByText("¥3/M")).toHaveLength(2)
        expect(screen.getByText("¥6/M")).toBeInTheDocument()
        expect(screen.getByText("¥0.03/M")).toBeInTheDocument()
        expect(screen.getByText("Native Tool Calls").parentElement).toHaveTextContent("Yes")
        expect(screen.getByText("Reasoning").parentElement).toHaveTextContent("Yes")
        expect(screen.queryByText("$3/M")).not.toBeInTheDocument()
    })

    it("renders no price row for a model whose only thinking rate is zero", () => {
        const modelInfo: ModelInfo = {
            id: "opaque-free-thinking",
            capabilities: { thinking: { supported: true, mode: "budget" } },
            pricing: thinkingPricing(2, 0),
        }
        render(<ModelInfoView modelInfo={modelInfo} selectedModelId={modelInfo.id} />)
        // A zero rate is not printed: an unlisted price reads as "no charge",
        // while a printed "Free" made a published zero look like a claim.
        expect(screen.queryByText("Free")).not.toBeInTheDocument()
        expect(screen.queryByText("$0/M")).not.toBeInTheDocument()
        expect(screen.getByText("$2/M")).toBeInTheDocument()
    })

    it("renders no stray figure when a cache-capable model publishes zero cache rates", () => {
        // Both cache rates are published as 0, so the cache section has nothing
        // to show while caching itself is declared. A boolean guard that leaks
        // the value (`... && (a || b)`) yields the number 0, which React prints
        // as a bare "0" under the capability rows.
        const modelInfo: ModelInfo = {
            id: "deepseek-cache-zero",
            capabilities: {
                contextWindow: 1_000_000,
                maxTokens: 384_000,
                supportsTools: true,
                supportsReasoning: true,
                supportsPromptCache: true,
            },
            pricing: flatMeteredPricing(0, 0, 0, 0),
        }
        const { container } = render(<ModelInfoView modelInfo={modelInfo} selectedModelId={modelInfo.id} />)

        // The rendered text must not contain a standalone zero anywhere.
        expect(container.textContent).not.toMatch(/(^|\D)0(\D|$)/)
        expect(screen.queryByText("Cache Reads")).not.toBeInTheDocument()
        expect(screen.queryByText("Cache Writes")).not.toBeInTheDocument()
    })
})
