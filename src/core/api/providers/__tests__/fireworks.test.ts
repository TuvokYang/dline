import "should"
import { ApiProfile } from "@shared/proto/dline/profile"
import { afterEach, describe, it, vi } from "vitest"
import { FireworksHandler } from "../fireworks"

describe("FireworksHandler", () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    const createAsyncIterable = (data: any[] = []) => ({
        [Symbol.asyncIterator]: async function* () {
            yield* data
        },
    })

    it("should handle usage-only chunks when delta is missing", async () => {
        const handler = new FireworksHandler({
            profile: ApiProfile.create({
                provider: "fireworks",
                apiKey: "test-api-key",
                modelId: "accounts/fireworks/models/llama-v3p1-8b-instruct",
            }),
            mode: "act",
        })
        const fakeClient = {
            chat: {
                completions: {
                    create: vi.fn().mockResolvedValue(
                        createAsyncIterable([
                            {
                                choices: [{}],
                                usage: {
                                    prompt_tokens: 19,
                                    completion_tokens: 4,
                                },
                            },
                        ]),
                    ),
                },
            },
        }
        vi.spyOn(handler as any, "ensureClient").mockReturnValue(fakeClient as any)

        const chunks: any[] = []
        for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
            chunks.push(chunk)
        }

        chunks.should.deepEqual([
            {
                type: "usage",
                inputTokens: 19,
                outputTokens: 4,
                cacheReadTokens: 0,
                cacheWriteTokens: 0,
            },
        ])
    })

    it("should split cache subsets out of the total prompt token count", async () => {
        const handler = new FireworksHandler({
            profile: ApiProfile.create({
                provider: "fireworks",
                apiKey: "test-api-key",
                modelId: "accounts/fireworks/models/llama-v3p1-8b-instruct",
            }),
            mode: "act",
        })
        const fakeClient = {
            chat: {
                completions: {
                    create: vi.fn().mockResolvedValue(
                        createAsyncIterable([
                            {
                                choices: [{}],
                                usage: {
                                    prompt_tokens: 60,
                                    completion_tokens: 12,
                                    prompt_tokens_details: { cached_tokens: 20 },
                                    prompt_cache_miss_tokens: 40,
                                },
                            },
                        ]),
                    ),
                },
            },
        }
        vi.spyOn(handler as any, "ensureClient").mockReturnValue(fakeClient as any)

        const chunks: any[] = []
        for await (const chunk of handler.createMessage("system", [{ role: "user", content: "hi" }])) {
            chunks.push(chunk)
        }

        chunks.should.deepEqual([
            {
                type: "usage",
                inputTokens: 0,
                outputTokens: 12,
                cacheReadTokens: 20,
                cacheWriteTokens: 40,
            },
        ])
    })
})
