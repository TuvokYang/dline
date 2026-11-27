import { describe, expect, it } from "vitest"
import {
    resolveOpenAIResponsesWebsocketUrl,
    shouldRetryOpenAIResponsesWebsocketWithFullContext,
} from "../openai-responses-websocket"

describe("openai-responses-websocket", () => {
    it.each([
        { baseUrl: undefined, expected: "wss://api.openai.com/v1/responses" },
        { baseUrl: "", expected: "wss://api.openai.com/v1/responses" },
        { baseUrl: "https://api.openai.com/v1/", expected: "wss://api.openai.com/v1/responses" },
        { baseUrl: "https://gateway.example.test/openai/v1", expected: "wss://gateway.example.test/openai/v1/responses" },
        { baseUrl: "http://127.0.0.1:8080/v1", expected: "ws://127.0.0.1:8080/v1/responses" },
        { baseUrl: "https://gateway.example.test/v1/responses/", expected: "wss://gateway.example.test/v1/responses" },
        { baseUrl: "wss://gateway.example.test/v1/responses", expected: "wss://gateway.example.test/v1/responses" },
        {
            baseUrl: "https://my-resource.openai.azure.com/openai/v1?api-version=2025-04-01-preview",
            expected: "wss://my-resource.openai.azure.com/openai/v1/responses?api-version=2025-04-01-preview",
        },
    ])("derives $expected from baseUrl $baseUrl", ({ baseUrl, expected }) => {
        expect(resolveOpenAIResponsesWebsocketUrl(baseUrl)).toBe(expected)
    })

    it("retries full context on previous_response_not_found only when a previous_response_id was sent", () => {
        const notFound = Object.assign(new Error("Previous response not found"), { code: "previous_response_not_found" })
        expect(shouldRetryOpenAIResponsesWebsocketWithFullContext(notFound, true, notFound.message)).toBe(true)
        expect(shouldRetryOpenAIResponsesWebsocketWithFullContext(notFound, false, notFound.message)).toBe(false)
        expect(
            shouldRetryOpenAIResponsesWebsocketWithFullContext(
                Object.assign(new Error("closed"), { code: "websocket_closed" }),
                false,
                "closed",
            ),
        ).toBe(true)
        expect(
            shouldRetryOpenAIResponsesWebsocketWithFullContext(
                Object.assign(new Error("busy"), { code: "websocket_concurrency_limit" }),
                true,
                "busy",
            ),
        ).toBe(false)
    })
})
