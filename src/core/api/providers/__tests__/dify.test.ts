import { mockFetchForTesting } from "@shared/net"
import { ApiProfile } from "@shared/proto/dline/profile"
import {
    bindProviderAttemptScope,
    type ProviderAttemptObserver,
    type ProviderAttemptTerminalStatus,
} from "@shared/provider-attempt-observer"
import { describe, expect, it, vi } from "vitest"
import { DifyHandler } from "../dify"

function createObserver() {
    const statuses: ProviderAttemptTerminalStatus[] = []
    let nextHandle = 0
    const observer: ProviderAttemptObserver<number> = {
        beginAttempt: () => nextHandle++,
        finishAttempt: (_handle, status) => {
            statuses.push(status)
        },
    }
    return { observer, statuses }
}

describe("DifyHandler", () => {
    it("marks a Provider error event as a failed round", async () => {
        const handler = new DifyHandler({
            profile: ApiProfile.create({
                provider: "dify",
                apiKey: "test-api-key",
                baseUrl: "https://dify.example/v1",
            }),
            mode: "act",
        })
        const transport = vi
            .fn<typeof globalThis.fetch>()
            .mockResolvedValue(new Response('data: {"event":"error","message":"provider failed"}\n'))
        const { observer, statuses } = createObserver()

        await expect(
            mockFetchForTesting(transport, async () => {
                const stream = bindProviderAttemptScope(
                    handler.createMessage("system prompt", [{ role: "user", content: "Hello" }]),
                    observer,
                )
                for await (const _chunk of stream) {
                    // The Provider error is raised before a usable chunk is produced.
                }
            }),
        ).rejects.toThrow("Dify API error: provider failed")
        expect(statuses).toEqual(["failed"])
    })

    it("cancels the model response body when the consumer stops early", async () => {
        const handler = new DifyHandler({
            profile: ApiProfile.create({
                provider: "dify",
                apiKey: "test-api-key",
                baseUrl: "https://dify.example/v1",
            }),
            mode: "act",
        })
        const bodyCancelled = vi.fn()
        const body = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('data: {"event":"message","answer":"hello"}\n'))
            },
            cancel: bodyCancelled,
        })
        const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body))
        const { observer, statuses } = createObserver()

        await mockFetchForTesting(transport, async () => {
            const stream = bindProviderAttemptScope(
                handler.createMessage("system prompt", [{ role: "user", content: "Hello" }]),
                observer,
            )
            for await (const _chunk of stream) break
        })

        expect(bodyCancelled).toHaveBeenCalledTimes(1)
        expect(statuses).toEqual(["cancelled"])
    })

    it("drains the model response body to EOF after message_end", async () => {
        const handler = new DifyHandler({
            profile: ApiProfile.create({
                provider: "dify",
                apiKey: "test-api-key",
                baseUrl: "https://dify.example/v1",
            }),
            mode: "act",
        })
        const body = [
            'data: {"event":"message","answer":"hello","conversation_id":"conversation-1"}',
            'data: {"event":"message_end","usage":{"prompt_tokens":10,"completion_tokens":2}}',
            'data: {"event":"ping"}',
            "",
        ].join("\n")
        const transport = vi.fn<typeof globalThis.fetch>().mockResolvedValue(new Response(body))
        const { observer, statuses } = createObserver()
        const chunks: unknown[] = []

        await mockFetchForTesting(transport, async () => {
            const stream = bindProviderAttemptScope(
                handler.createMessage("system prompt", [{ role: "user", content: "Hello" }]),
                observer,
            )
            for await (const chunk of stream) chunks.push(chunk)
        })

        expect(transport).toHaveBeenCalledTimes(1)
        expect(chunks).toContainEqual({ type: "text", text: "hello" })
        expect(statuses).toEqual(["completed"])
    })
})
