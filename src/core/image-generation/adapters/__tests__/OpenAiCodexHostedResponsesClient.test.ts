import { afterEach, describe, expect, it, vi } from "vitest"
import { openAiCodexOAuthManager } from "@/integrations/openai-codex/oauth"
import { ExtensionRegistryInfo } from "@/registry"
import { mockFetchForTesting } from "@/shared/net"
import { OpenAiCodexHostedResponsesClient } from "../OpenAiCodexHostedResponsesClient"

describe("OpenAiCodexHostedResponsesClient", () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("uses Profile OAuth with stable workspace and Task routing headers", async () => {
        vi.spyOn(openAiCodexOAuthManager, "getCredentialContext").mockResolvedValue({
            accessToken: "access-a",
            expires: 1_900_000_000_000,
            accountId: "account-a",
        })
        let requestHeaders: Headers | undefined

        await mockFetchForTesting(
            async (_input: RequestInfo | URL, init?: RequestInit) => {
                requestHeaders = new Headers(init?.headers)
                return new Response("data: [DONE]\n\n", {
                    status: 200,
                    headers: { "content-type": "text/event-stream" },
                })
            },
            async () => {
                const client = new OpenAiCodexHostedResponsesClient({
                    profileId: "profile-a",
                    workspaceId: "workspace-a",
                    threadId: "task-a",
                })
                await client.responses.create({
                    model: "gpt-5",
                    input: "test",
                    stream: true,
                })
            },
        )

        expect(requestHeaders?.get("Authorization")).toBe("Bearer access-a")
        expect(requestHeaders?.get("ChatGPT-Account-Id")).toBe("account-a")
        expect(requestHeaders?.get("session-id")).toBe("workspace-a")
        expect(requestHeaders?.get("session_id")).toBeNull()
        expect(requestHeaders?.get("thread-id")).toBe("task-a")
        expect(requestHeaders?.get("x-client-request-id")).toBe("task-a")
        expect(requestHeaders?.get("conversation_id")).toBeNull()
        expect(requestHeaders?.get("User-Agent")).toBe(`Dline/${ExtensionRegistryInfo.version}`)
    })
})
