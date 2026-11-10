import { EventEmitter } from "node:events"
import type { ServerResponse } from "node:http"
import * as path from "node:path"
import { ApiHandler, type ProviderAttemptTerminalStatus } from "@core/api"
import { OpenAiHandler } from "@core/api/providers/openai"
import type { ApiStreamUsageChunk } from "@core/api/transform/stream"
import { ProviderUsageIncrements } from "@core/task/executors/provider/service/ProviderUsageIncrements"
import { mockFetchForTesting } from "@shared/net"
import { ApiProfile } from "@shared/proto/dline/profile"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { writeProviderResponse } from "./e2e/fixtures/server/provider-response"
import { E2E_PROFILE_NAMES, prepareE2EState } from "./e2e/utils/api-profile"

const io = vi.hoisted(() => ({ files: new Map<string, string>(), reads: [] as string[] }))

// The real fixture generator runs, but every filesystem operation stays in memory.
vi.mock("node:fs/promises", () => ({
    mkdir: async () => undefined,
    rm: async () => undefined,
    writeFile: async (file: string, body: string) => {
        io.files.set(file, body)
    },
    readFile: async (file: string) => {
        io.reads.push(file)
        throw new Error("The mock Profile path must not read a local credential or configuration")
    },
    cp: async () => {
        throw new Error("The mock Profile path must not copy local data")
    },
    stat: async () => {
        throw new Error("The mock Profile path must not inspect local data")
    },
}))

class MemoryResponse extends EventEmitter {
    destroyed = false
    writableEnded = false
    readonly chunks: string[] = []

    writeHead(): void {}

    write(chunk: string): void {
        this.chunks.push(chunk)
    }

    end(chunk?: string): void {
        if (chunk) this.write(chunk)
        this.writableEnded = true
    }
}

async function profileFor(name: string): Promise<ApiProfile> {
    const dlineDir = path.join(process.cwd(), "tmp", "virtual-pricing-fixture")
    await prepareE2EState({
        dlineDir,
        sourceDataDir: path.join(process.cwd(), "tmp", "virtual-unused-profile-source"),
        profileMode: "mock",
        mockBaseUrl: "https://pricing.example.invalid",
        env: {},
    })
    const file = io.files.get(path.join(dlineDir, "data", "settings", "api_profiles.json"))
    if (!file) throw new Error("The generator did not write its Profile catalog")
    const raw = (JSON.parse(file) as Record<string, unknown>[]).find((item) => item.name === name)
    if (!raw) throw new Error("The generated mock Profile is missing")
    // The Profile protocol consumes the actual serialized fixture, not a copied price object.
    return ApiProfile.fromJSON({ ...raw, apiKey: "test-fixture-api-key" })
}

describe("mock fixture pricing through the real SDK stream", () => {
    beforeEach(() => {
        io.files.clear()
        io.reads.length = 0
    })

    for (const [name, protocol, endpoint] of [
        [E2E_PROFILE_NAMES.mockOpenAi, "openai-chat", "/chat/completions"],
        [E2E_PROFILE_NAMES.mockOpenAiResponses, "openai-responses", "/responses"],
    ] as const) {
        it.each([true, false])(`${protocol} keeps priced=%s amounts distinct from unpriced usage`, async (priced) => {
            const profile = await profileFor(name)
            if (!profile.openai) throw new Error("The fixture has no OpenAI configuration")
            if (!priced) profile.openai.pricing = undefined
            const handler = new OpenAiHandler({ profile, mode: "act" })
            const response = new MemoryResponse()
            await writeProviderResponse({
                res: response as unknown as ServerResponse,
                sendJson: () => {
                    throw new Error("A streaming fixture must not use a JSON response")
                },
                scriptedResponse: { type: "message", text: "PRICED_FIXTURE_BODY" },
                usage: { inputTokens: 1200, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 100 },
                generationId: "fixture-generation",
                model: profile.modelId,
                protocol,
                stream: true,
            })
            const requests: { url: string; body: Record<string, unknown> }[] = []
            const transport: typeof globalThis.fetch = async (input, init) => {
                const request = new Request(input, init)
                request.signal.throwIfAborted()
                requests.push({ url: request.url, body: JSON.parse(await request.text()) })
                return new Response(response.chunks.join(""), { headers: { "Content-Type": "text/event-stream" } })
            }
            const usage: ApiStreamUsageChunk[] = []
            const text: string[] = []
            const statuses: ProviderAttemptTerminalStatus[] = []
            await mockFetchForTesting(transport, async () => {
                const stream = ApiHandler.bindProviderAttemptScope(
                    handler.createMessage("system", [{ role: "user", content: "price this request" }]),
                    {
                        beginAttempt: () => 1,
                        finishAttempt: (_handle, status) => {
                            statuses.push(status)
                        },
                    },
                )
                for await (const chunk of stream) {
                    if (chunk.type === "usage") usage.push(chunk)
                    if (chunk.type === "text") text.push(chunk.text)
                }
            })

            expect(requests).toHaveLength(1)
            expect(new URL(requests[0].url).pathname.endsWith(endpoint)).toBe(true)
            expect(requests[0].body.stream).toBe(true)
            expect(text.join("")).toBe("PRICED_FIXTURE_BODY")
            expect(statuses).toEqual(["completed"])
            expect(usage).toHaveLength(1)
            expect(usage[0]).toMatchObject({ inputTokens: 1200, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 100 })
            const increments = new ProviderUsageIncrements()
            const settled = increments.next(usage[0])
            if (priced) {
                // Independent oracle: (1200*1 + 200*2 + 300*0.1 + 100*1.25) / 1e6.
                expect(usage[0].totalCost).toBeCloseTo(0.001755, 12)
                expect(usage[0].currency).toBe("USD")
                expect(settled.totalCost).toBeCloseTo(0.001755, 12)
                expect(settled.costUsageReported).toBe(1)
                expect(increments.currency).toBe("USD")
            } else {
                expect(usage[0].totalCost).toBeUndefined()
                expect(usage[0].currency).toBeUndefined()
                expect(settled.costUsageReported).toBe(0)
                expect(increments.currency).toBeUndefined()
            }
            expect(io.reads).toEqual([])
        })
    }
})
