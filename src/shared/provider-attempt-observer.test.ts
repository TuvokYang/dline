import OpenAI from "openai"
import { describe, expect, it, vi } from "vitest"
import { mockFetchForTesting, providerFetch } from "./net"
import {
    bindProviderAttemptScope,
    observeProviderCall,
    observeProviderResponse,
    observeProviderStream,
    type ProviderAttemptIdentity,
    type ProviderAttemptObserver,
    type ProviderAttemptTerminalStatus,
    providerAttemptIdentityFromEncodedRequest,
    withProviderAttemptIdentity,
} from "./provider-attempt-observer"

function createObserver() {
    const statuses: ProviderAttemptTerminalStatus[] = []
    const identities: Array<ProviderAttemptIdentity | undefined> = []
    let nextHandle = 0
    const observer: ProviderAttemptObserver<number> = {
        beginAttempt: vi.fn((identity) => {
            identities.push(identity)
            return nextHandle++
        }),
        finishAttempt: vi.fn((_handle, status) => {
            statuses.push(status)
        }),
    }
    return { observer, statuses, identities }
}

describe("provider attempt observer", () => {
    it("projects typed thinking from final SDK request objects without Profile inference", () => {
        expect(
            providerAttemptIdentityFromEncodedRequest("gemini", {
                model: "gemini-2.5-pro",
                config: { thinkingConfig: { thinkingBudget: 4096, includeThoughts: true } },
            }),
        ).toEqual({ provider: "gemini", modelId: "gemini-2.5-pro", thinking: 4096 })
        expect(
            providerAttemptIdentityFromEncodedRequest("gemini", {
                model: "gemini-3-pro",
                config: { thinkingConfig: { thinkingLevel: "HIGH", includeThoughts: true } },
            }),
        ).toEqual({ provider: "gemini", modelId: "gemini-3-pro", thinking: "level:HIGH" })
        expect(providerAttemptIdentityFromEncodedRequest("ollama", { model: "qwen", options: {} })).toEqual({
            provider: "ollama",
            modelId: "qwen",
            thinking: "state:disabled",
        })
        expect(providerAttemptIdentityFromEncodedRequest("gemini", { config: {} })).toBeUndefined()
    })

    it("freezes the encoder-bound provider model and typed thinking for each real send", async () => {
        const { observer, identities, statuses } = createObserver()
        const first: ProviderAttemptIdentity = {
            provider: "anthropic",
            modelId: "catalog:claude-opus-4-1",
            thinking: "level:high",
        }
        const second: ProviderAttemptIdentity = {
            provider: "anthropic",
            modelId: "catalog:claude-opus-4-1",
            thinking: 2048,
        }
        const source = (async function* () {
            yield await withProviderAttemptIdentity(first, () => observeProviderCall(async () => "first"))
            yield await withProviderAttemptIdentity(second, () => observeProviderCall(async () => "second"))
        })()

        const values: string[] = []
        for await (const value of bindProviderAttemptScope(source, observer)) values.push(value)

        expect(values).toEqual(["first", "second"])
        expect(identities).toEqual([first, second])
        expect(statuses).toEqual(["completed", "completed"])
    })

    it("settles a non-streaming SDK send when its promise resolves", async () => {
        const { observer, statuses } = createObserver()
        const source = (async function* () {
            yield await observeProviderCall(async () => "done")
        })()
        const values: string[] = []
        for await (const value of bindProviderAttemptScope(source, observer)) values.push(value)
        expect(values).toEqual(["done"])
        expect(statuses).toEqual(["completed"])
    })

    it("counts each SDK stream send and settles at iterator terminal", async () => {
        const { observer, statuses } = createObserver()
        const source = (async function* () {
            const first = await observeProviderStream(async function* () {
                yield "a"
            })
            for await (const value of first) yield value
            const second = await observeProviderStream(async function* () {
                yield "b"
            })
            for await (const value of second) yield value
        })()

        const values: string[] = []
        for await (const value of bindProviderAttemptScope(source, observer)) values.push(value)
        expect(values).toEqual(["a", "b"])
        expect(observer.beginAttempt).toHaveBeenCalledTimes(2)
        expect(statuses).toEqual(["completed", "completed"])
    })

    it("settles a fetch response only after its body is fully consumed", async () => {
        const { observer, statuses } = createObserver()
        const source = (async function* () {
            const response = await observeProviderResponse(async () => new Response("streamed"))
            expect(statuses).toEqual([])
            yield await response.text()
        })()

        const values: string[] = []
        for await (const value of bindProviderAttemptScope(source, observer)) values.push(value)
        expect(values).toEqual(["streamed"])
        expect(statuses).toEqual(["completed"])
    })

    it("classifies the OpenAI SDK DONE protocol terminal as completed", async () => {
        const { observer, statuses, identities } = createObserver()
        const transportCancelled = vi.fn()
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(
                    new TextEncoder().encode(
                        [
                            'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":0,"model":"test","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}',
                            "",
                            "data: [DONE]",
                            "",
                            "",
                        ].join("\n"),
                    ),
                )
            },
            cancel: transportCancelled,
        })
        const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
            new Response(body, {
                status: 200,
                headers: { "content-type": "text/event-stream" },
            }),
        )
        const chunks: unknown[] = []

        await mockFetchForTesting(transport, async () => {
            const source = (async function* () {
                const client = new OpenAI({
                    apiKey: "test-api-key",
                    baseURL: "https://openai.example/v1",
                    fetch: providerFetch,
                    maxRetries: 0,
                })
                const stream = await client.chat.completions.create({
                    model: "test-model",
                    messages: [{ role: "user", content: "Hello" }],
                    reasoning_effort: "high",
                    stream: true,
                })
                for await (const chunk of stream) yield chunk
            })()
            for await (const chunk of bindProviderAttemptScope(source, observer, { provider: "openai" })) chunks.push(chunk)
        })

        expect(chunks).toHaveLength(1)
        expect(transportCancelled).toHaveBeenCalledTimes(1)
        expect(identities).toEqual([{ provider: "openai", modelId: "test-model", thinking: "level:high" }])
        expect(statuses).toEqual(["completed"])
    })

    it("classifies OpenAI DONE as completed when CRLF is split across response body chunks", async () => {
        const { observer, statuses } = createObserver()
        const transportCancelled = vi.fn()
        const encoder = new TextEncoder()
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(
                    encoder.encode(
                        'data: {"id":"chatcmpl-1","object":"chat.completion.chunk","created":0,"model":"test","choices":[{"index":0,"delta":{"content":"hello"},"finish_reason":null}]}\r\n\r\ndata: [DONE]\r',
                    ),
                )
                controller.enqueue(encoder.encode("\n\r\n"))
            },
            cancel: transportCancelled,
        })
        const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(
            new Response(body, {
                status: 200,
                headers: { "content-type": "text/event-stream" },
            }),
        )
        const chunks: unknown[] = []

        await mockFetchForTesting(transport, async () => {
            const source = (async function* () {
                const client = new OpenAI({
                    apiKey: "test-api-key",
                    baseURL: "https://openai.example/v1",
                    fetch: providerFetch,
                    maxRetries: 0,
                })
                const stream = await client.chat.completions.create({
                    model: "test-model",
                    messages: [{ role: "user", content: "Hello" }],
                    stream: true,
                })
                for await (const chunk of stream) yield chunk
            })()
            for await (const chunk of bindProviderAttemptScope(source, observer)) chunks.push(chunk)
        })

        expect(chunks).toHaveLength(1)
        expect(transportCancelled).toHaveBeenCalledTimes(1)
        expect(statuses).toEqual(["completed"])
    })

    it("preserves cancellation when an in-flight response pull observes the cancelled reader as done", async () => {
        const { observer, statuses } = createObserver()
        const sourceBody = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode("first"))
            },
        })
        const source = (async function* () {
            const response = await observeProviderResponse(async () => new Response(sourceBody))
            const reader = response.body?.getReader()
            await reader?.read()
            const pendingRead = reader?.read()
            await reader?.cancel()
            await pendingRead
        })()

        for await (const _value of bindProviderAttemptScope(source, observer)) {
            // Drain the scoped lifecycle.
        }
        expect(statuses).toEqual(["cancelled"])
    })

    it("classifies response cancellation with an Error as failed", async () => {
        const { observer, statuses } = createObserver()
        const source = (async function* () {
            const response = await observeProviderResponse(async () => new Response("streamed"))
            await response.body?.cancel(new Error("consumer parsing failed"))
        })()

        for await (const _value of bindProviderAttemptScope(source, observer)) {
            // Drain the scoped lifecycle.
        }
        expect(statuses).toEqual(["failed"])
    })

    it("classifies HTTP failure, iterator cancellation and abort distinctly", async () => {
        const { observer, statuses } = createObserver()
        const controller = new AbortController()
        const source = (async function* () {
            const failed = await observeProviderResponse(async () => new Response("error", { status: 500 }))
            await failed.text()
            const cancelled = await observeProviderStream(async function* () {
                yield "first"
                yield "second"
            })
            for await (const value of cancelled) {
                yield value
                break
            }
            controller.abort()
            await expect(
                observeProviderStream(
                    async () => {
                        throw new DOMException("aborted", "AbortError")
                    },
                    { signal: controller.signal },
                ),
            ).rejects.toThrow(/aborted/i)
        })()

        for await (const _value of bindProviderAttemptScope(source, observer)) {
            // Drain the scoped lifecycle.
        }
        expect(statuses).toEqual(["failed", "cancelled", "aborted"])
    })
})
