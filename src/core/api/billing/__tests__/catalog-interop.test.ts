import { ApiHandler } from "@core/api/ApiHandler"
import { readPerMillionPrice, readPositiveNumber } from "@core/model-registry/remote/model-listing-source"
import { OpenCodeModelSource } from "@core/model-registry/remote/vendors/opencode"
import { expect, it } from "vitest"
import { mockFetchForTesting } from "@/shared/net"
import { validateModelPricing } from "../index"

const { calculateUsageCost } = ApiHandler

it("keeps numeric and string zero prices distinct from absent rates without weakening model limits", () => {
    expect(readPerMillionPrice({ price: 0 }, "price")).toBe(0)
    expect(readPerMillionPrice({ price: "0" }, "price")).toBe(0)
    expect(readPerMillionPrice({ price: "0.0000025" }, "price")).toBe(2.5)
    expect(readPerMillionPrice({}, "price")).toBeUndefined()
    expect(readPerMillionPrice({ price: -1 }, "price")).toBeUndefined()
    expect(readPositiveNumber({ context: 0 }, "context")).toBeUndefined()
})

it("bills both sides of a remote catalog tier boundary with one unbounded tail", async () => {
    const models = await mockFetchForTesting(
        (async () =>
            new Response(
                JSON.stringify({
                    data: [
                        {
                            id: "tiered-model",
                            type: "chat",
                            modalities: { input: ["text"], output: ["text"] },
                            cost: {
                                text: {
                                    input: { price: 0.1, overrides: [{ when: { context: { gt: 100_000 } }, price: 0.5 }] },
                                    output: { price: 0.5, overrides: [{ when: { context: { gt: 100_000 } }, price: 2.5 }] },
                                },
                            },
                            api: { messages: { base_url: "https://opencode.ai/inference/anthropic/v1" } },
                        },
                    ],
                }),
                { status: 200 },
            )) as typeof fetch,
        () => new OpenCodeModelSource().fetchModels({ apiKey: "" }),
    )
    const pricing = models["tiered-model"].pricing
    expect(validateModelPricing(pricing)).toEqual([])
    expect(pricing?.strategy?.contextWindow?.bands.map((band) => band.maxInputTokens)).toEqual([100_000, undefined])
    expect(calculateUsageCost(pricing, { inputTokens: 100_000, outputTokens: 0 }, 0)).toEqual({
        kind: "calculated",
        amount: 0.01,
        currency: "USD",
    })
    expect(calculateUsageCost(pricing, { inputTokens: 100_001, outputTokens: 0 }, 0)).toEqual({
        kind: "calculated",
        amount: 0.0500005,
        currency: "USD",
    })
})
