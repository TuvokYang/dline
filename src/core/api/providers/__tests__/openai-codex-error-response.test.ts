import { mockFetchForTesting } from "@shared/net"
import { ApiProfile } from "@shared/proto/dline/profile"
import { describe, expect, it, vi } from "vitest"
import { OpenAiCodexHandler } from "../openai-codex"

function createHandler(): OpenAiCodexHandler {
    return new OpenAiCodexHandler({
        profile: ApiProfile.create({ id: "codex-errors", provider: "openai-codex", modelId: "gpt-6-astra" }),
        mode: "act",
        workspaceId: "workspace-errors",
        ulid: "task-errors",
    })
}

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
    const chunks: unknown[] = []
    for await (const chunk of stream) chunks.push(chunk)
    return chunks
}

describe("OpenAiCodexHandler error responses", () => {
    it("preserves a structured HTTP error response for API error rendering", async () => {
        const handler = createHandler()
        const payload = {
            error: {
                message: "No tool output found for function call fc_missing_result.",
                type: "invalid_request_error",
                code: "missing_tool_output",
                param: "input",
            },
        }
        const responseBody = JSON.stringify(payload)
        const fetchMock = vi.fn().mockResolvedValue(
            new Response(responseBody, {
                status: 400,
                headers: { "content-type": "application/json" },
            }),
        )

        await mockFetchForTesting(fetchMock, async () => {
            await expect(
                collect(
                    (handler as any).makeCodexRequest(
                        {},
                        handler.getModel(),
                        {
                            accessToken: "access-token",
                            expires: 1_900_000_000_000,
                            accountId: "account-errors",
                        },
                        new AbortController().signal,
                    ),
                ),
            ).rejects.toMatchObject({
                message: payload.error.message,
                status: 400,
                code: payload.error.code,
                type: payload.error.type,
                param: payload.error.param,
                responseBody,
            })
        })
    })

    it("preserves a non-JSON HTTP response body as the error message", async () => {
        const handler = createHandler()
        const responseBody = "upstream rejected the native tool round"
        const fetchMock = vi.fn().mockResolvedValue(new Response(responseBody, { status: 400 }))

        await mockFetchForTesting(fetchMock, async () => {
            await expect(
                collect(
                    (handler as any).makeCodexRequest(
                        {},
                        handler.getModel(),
                        {
                            accessToken: "access-token",
                            expires: 1_900_000_000_000,
                        },
                        new AbortController().signal,
                    ),
                ),
            ).rejects.toMatchObject({ message: responseBody, status: 400, responseBody })
        })
    })

    it("keeps the original SDK error meaning and structured identity", () => {
        const handler = createHandler()
        const original = Object.assign(new Error("400 No tool output found for function call fc_sdk."), {
            status: 400,
            code: "missing_tool_output",
        })

        expect((handler as any).toProviderError(original)).toMatchObject({
            message: original.message,
            status: 400,
            code: "missing_tool_output",
        })
    })
})
