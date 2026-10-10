import { ApiFormat } from "@shared/proto/dline/models/metadata"
import { ApiProfile } from "@shared/proto/dline/profile"
import { OpenAiProviderConfig } from "@shared/proto/dline/provider/openai"
import { expect } from "chai"
import type OpenAI from "openai"
import { afterEach, describe, it, vi } from "vitest"
import { OpenAiHandler } from "../openai"

const createAsyncIterable = () => ({
    [Symbol.asyncIterator]: async function* () {},
})

describe("OpenAI Task-scoped prompt cache keys", () => {
    afterEach(() => {
        vi.restoreAllMocks()
    })

    it("isolates automatic Chat cache keys by Task while preserving appended-turn stability", async () => {
        const handler = new OpenAiHandler({
            profile: ApiProfile.create({
                provider: "openai",
                apiKey: "test-api-key",
                modelId: "gpt-5.6-sol",
                openai: OpenAiProviderConfig.create({ apiFormat: ApiFormat.OPENAI_CHAT }),
            }),
            mode: "act",
            workspaceId: "dline_workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ulid: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        })
        const create = vi.fn().mockResolvedValue(createAsyncIterable())
        vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
            chat: { completions: { create } },
        })

        for await (const _chunk of handler.createMessage("frozen system", [{ role: "user", content: "first turn" }], undefined, {
            taskNamespace: "task-a",
        })) {
        }
        for await (const _chunk of handler.createMessage(
            "frozen system",
            [
                { role: "user", content: "first turn" },
                { role: "assistant", content: "response" },
                { role: "user", content: "second turn" },
            ],
            undefined,
            { taskNamespace: "task-a" },
        )) {
        }
        for await (const _chunk of handler.createMessage("frozen system", [{ role: "user", content: "first turn" }], undefined, {
            taskNamespace: "task-b",
        })) {
        }

        const first = create.mock.calls[0]?.[0] as OpenAI.Chat.ChatCompletionCreateParamsStreaming
        const appended = create.mock.calls[1]?.[0] as OpenAI.Chat.ChatCompletionCreateParamsStreaming
        const otherTask = create.mock.calls[2]?.[0] as OpenAI.Chat.ChatCompletionCreateParamsStreaming
        const firstOptions = create.mock.calls[0]?.[1] as { headers?: Record<string, string> }
        const appendedOptions = create.mock.calls[1]?.[1] as { headers?: Record<string, string> }
        const otherTaskOptions = create.mock.calls[2]?.[1] as { headers?: Record<string, string> }
        expect(first.prompt_cache_key).to.match(/^dline_cache_[0-9a-f]{32}$/)
        expect(appended.prompt_cache_key).to.equal(first.prompt_cache_key)
        expect(otherTask.prompt_cache_key).not.to.equal(first.prompt_cache_key)
        expect(first.prompt_cache_options).to.equal(undefined)
        expect(firstOptions.headers).to.deep.include({
            "session-id": "dline_workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "thread-id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "x-client-request-id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        })
        expect(appendedOptions.headers).to.deep.equal(firstOptions.headers)
        expect(otherTaskOptions.headers).to.deep.equal(firstOptions.headers)
        expect(JSON.stringify(first.messages)).not.to.contain("prompt_cache_breakpoint")
    })

    it("keeps Task session affinity stable across handler rebuilds and API transports", async () => {
        const workspaceId = "dline_workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
        const otherWorkspaceId = "dline_workspace_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
        const taskUlid = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
        const otherTaskUlid = "01ARZ3NDEKTSV4RRFFQ69G5FAW"
        const chatHandler = new OpenAiHandler({
            profile: ApiProfile.create({
                provider: "openai",
                apiKey: "test-api-key",
                modelId: "gpt-5.6-sol",
                openai: OpenAiProviderConfig.create({ apiFormat: ApiFormat.OPENAI_CHAT }),
            }),
            mode: "act",
            workspaceId,
            ulid: taskUlid,
        })
        const responsesHandler = new OpenAiHandler({
            profile: ApiProfile.create({
                provider: "openai",
                apiKey: "test-api-key",
                modelId: "gpt-5.6-sol",
                openai: OpenAiProviderConfig.create({ apiFormat: ApiFormat.OPENAI_RESPONSES }),
            }),
            mode: "act",
            workspaceId,
            ulid: taskUlid,
        })
        const otherTaskHandler = new OpenAiHandler({
            profile: ApiProfile.create({
                provider: "openai",
                apiKey: "test-api-key",
                modelId: "gpt-5.6-sol",
                openai: OpenAiProviderConfig.create({ apiFormat: ApiFormat.OPENAI_CHAT }),
            }),
            mode: "act",
            workspaceId,
            ulid: otherTaskUlid,
        })
        const chatCreate = vi.fn().mockResolvedValue(createAsyncIterable())
        const responsesCreate = vi.fn().mockResolvedValue(createAsyncIterable())
        const otherTaskCreate = vi.fn().mockResolvedValue(createAsyncIterable())
        vi.spyOn(chatHandler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
            chat: { completions: { create: chatCreate } },
        })
        vi.spyOn(responsesHandler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
            responses: { create: responsesCreate },
        })
        vi.spyOn(otherTaskHandler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
            chat: { completions: { create: otherTaskCreate } },
        })

        for await (const _chunk of chatHandler.createMessage(
            "frozen system",
            [{ role: "user", content: "first turn" }],
            undefined,
            {
                taskNamespace: "task-a",
            },
        )) {
        }
        for await (const _chunk of responsesHandler.createMessage(
            "frozen system",
            [{ role: "user", content: "first turn" }],
            undefined,
            { taskNamespace: "task-a" },
        )) {
        }
        for await (const _chunk of otherTaskHandler.createMessage(
            "frozen system",
            [{ role: "user", content: "first turn" }],
            undefined,
            { taskNamespace: "task-a" },
        )) {
        }

        const chatRequest = chatCreate.mock.calls[0]?.[0] as OpenAI.Chat.ChatCompletionCreateParamsStreaming
        const responsesRequest = responsesCreate.mock.calls[0]?.[0] as OpenAI.Responses.ResponseCreateParamsStreaming
        const otherTaskRequest = otherTaskCreate.mock.calls[0]?.[0] as OpenAI.Chat.ChatCompletionCreateParamsStreaming
        const chatOptions = chatCreate.mock.calls[0]?.[1] as { headers?: Record<string, string> }
        const responsesOptions = responsesCreate.mock.calls[0]?.[1] as { headers?: Record<string, string> }
        const otherTaskOptions = otherTaskCreate.mock.calls[0]?.[1] as { headers?: Record<string, string> }

        expect(chatOptions.headers).to.deep.include({
            "session-id": workspaceId,
            "thread-id": taskUlid,
            "x-client-request-id": taskUlid,
        })
        expect(responsesOptions.headers).to.deep.equal(chatOptions.headers)
        expect(otherTaskOptions.headers).to.deep.include({
            "session-id": workspaceId,
            "thread-id": otherTaskUlid,
            "x-client-request-id": otherTaskUlid,
        })
        expect(otherTaskOptions.headers?.["session-id"]).to.equal(chatOptions.headers?.["session-id"])
        expect(otherTaskOptions.headers?.["thread-id"]).not.to.equal(chatOptions.headers?.["thread-id"])
        expect(chatRequest.prompt_cache_key).to.equal(responsesRequest.prompt_cache_key)
        expect(otherTaskRequest.prompt_cache_key).to.equal(chatRequest.prompt_cache_key)
        expect(chatOptions.headers?.["session-id"]).not.to.equal(chatRequest.prompt_cache_key)

        const otherWorkspaceHandler = new OpenAiHandler({
            profile: ApiProfile.create({
                provider: "openai",
                apiKey: "test-api-key",
                modelId: "gpt-5.6-sol",
                openai: OpenAiProviderConfig.create({ apiFormat: ApiFormat.OPENAI_CHAT }),
            }),
            mode: "act",
            workspaceId: otherWorkspaceId,
            ulid: taskUlid,
        })
        const otherWorkspaceCreate = vi.fn().mockResolvedValue(createAsyncIterable())
        vi.spyOn(otherWorkspaceHandler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
            chat: { completions: { create: otherWorkspaceCreate } },
        })
        for await (const _chunk of otherWorkspaceHandler.createMessage(
            "frozen system",
            [{ role: "user", content: "first turn" }],
            undefined,
            { taskNamespace: "task-a" },
        )) {
        }
        const otherWorkspaceRequest = otherWorkspaceCreate.mock.calls[0]?.[0] as OpenAI.Chat.ChatCompletionCreateParamsStreaming
        const otherWorkspaceOptions = otherWorkspaceCreate.mock.calls[0]?.[1] as { headers?: Record<string, string> }
        expect(otherWorkspaceOptions.headers?.["session-id"]).to.equal(otherWorkspaceId)
        expect(otherWorkspaceOptions.headers?.["thread-id"]).to.equal(taskUlid)
        expect(otherWorkspaceRequest.prompt_cache_key).to.equal(chatRequest.prompt_cache_key)
    })

    it("keeps the Task session ID stable across a Responses transport retry", async () => {
        const taskUlid = "01ARZ3NDEKTSV4RRFFQ69G5FAV"
        const handler = new OpenAiHandler({
            profile: ApiProfile.create({
                provider: "openai",
                apiKey: "test-api-key",
                modelId: "gpt-5.6-sol",
                openai: OpenAiProviderConfig.create({ apiFormat: ApiFormat.OPENAI_RESPONSES }),
            }),
            mode: "act",
            workspaceId: "dline_workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ulid: taskUlid,
        })
        const upstreamError = Object.assign(new Error("upstream unavailable"), { status: 502 })
        const create = vi.fn().mockRejectedValueOnce(upstreamError).mockResolvedValueOnce(createAsyncIterable())
        vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
            responses: { create },
        })

        for await (const _chunk of handler.createMessage("frozen system", [{ role: "user", content: "first turn" }], undefined, {
            taskNamespace: "task-a",
        })) {
        }

        expect(create.mock.calls).to.have.length(2)
        const firstOptions = create.mock.calls[0]?.[1] as { headers?: Record<string, string> }
        const retryOptions = create.mock.calls[1]?.[1] as { headers?: Record<string, string> }
        expect(firstOptions.headers).to.deep.include({
            "session-id": "dline_workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "thread-id": taskUlid,
            "x-client-request-id": taskUlid,
        })
        expect(retryOptions.headers).to.deep.equal(firstOptions.headers)
    })

    it("projects partial routing identities without synthesizing missing headers", async () => {
        const workspaceOnlyHandler = new OpenAiHandler({
            profile: ApiProfile.create({
                provider: "openai",
                apiKey: "test-api-key",
                modelId: "gpt-5.6-sol",
                openai: OpenAiProviderConfig.create({ apiFormat: ApiFormat.OPENAI_CHAT }),
            }),
            mode: "act",
            workspaceId: "dline_workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        })
        const anonymousHandler = new OpenAiHandler({
            profile: ApiProfile.create({
                provider: "openai",
                apiKey: "test-api-key",
                modelId: "gpt-5.6-sol",
                openai: OpenAiProviderConfig.create({ apiFormat: ApiFormat.OPENAI_CHAT }),
            }),
            mode: "act",
        })
        const workspaceCreate = vi.fn().mockResolvedValue(createAsyncIterable())
        const anonymousCreate = vi.fn().mockResolvedValue(createAsyncIterable())
        vi.spyOn(workspaceOnlyHandler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
            chat: { completions: { create: workspaceCreate } },
        })
        vi.spyOn(anonymousHandler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
            chat: { completions: { create: anonymousCreate } },
        })

        for await (const _chunk of workspaceOnlyHandler.createMessage("system", [{ role: "user", content: "hello" }])) {
        }
        for await (const _chunk of anonymousHandler.createMessage("system", [{ role: "user", content: "hello" }])) {
        }

        const workspaceOptions = workspaceCreate.mock.calls[0]?.[1] as { headers?: Record<string, string> }
        const anonymousOptions = anonymousCreate.mock.calls[0]?.[1] as { headers?: Record<string, string> }
        expect(workspaceOptions.headers).to.deep.equal({
            "session-id": "dline_workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        })
        expect(anonymousOptions.headers).to.equal(undefined)
    })

    it("isolates automatic Responses cache keys by Task without adding breakpoint controls", async () => {
        const handler = new OpenAiHandler({
            profile: ApiProfile.create({
                provider: "openai",
                apiKey: "test-api-key",
                modelId: "gpt-5.6-sol",
                openai: OpenAiProviderConfig.create({ apiFormat: ApiFormat.OPENAI_RESPONSES }),
            }),
            mode: "act",
            workspaceId: "dline_workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            ulid: "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        })
        const create = vi.fn().mockResolvedValue(createAsyncIterable())
        vi.spyOn(handler as unknown as { ensureClient: () => unknown }, "ensureClient").mockReturnValue({
            responses: { create },
        })

        for await (const _chunk of handler.createMessage("frozen system", [{ role: "user", content: "first turn" }], undefined, {
            taskNamespace: "task-a",
        })) {
        }
        for await (const _chunk of handler.createMessage("frozen system", [{ role: "user", content: "first turn" }], undefined, {
            taskNamespace: "task-b",
        })) {
        }

        const first = create.mock.calls[0]?.[0] as OpenAI.Responses.ResponseCreateParamsStreaming
        const otherTask = create.mock.calls[1]?.[0] as OpenAI.Responses.ResponseCreateParamsStreaming
        const firstOptions = create.mock.calls[0]?.[1] as { headers?: Record<string, string> }
        const otherTaskOptions = create.mock.calls[1]?.[1] as { headers?: Record<string, string> }
        expect(first.prompt_cache_key).to.match(/^dline_cache_[0-9a-f]{32}$/)
        expect(otherTask.prompt_cache_key).not.to.equal(first.prompt_cache_key)
        expect(first.prompt_cache_options).to.equal(undefined)
        expect(firstOptions.headers).to.deep.include({
            "session-id": "dline_workspace_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "thread-id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
            "x-client-request-id": "01ARZ3NDEKTSV4RRFFQ69G5FAV",
        })
        expect(otherTaskOptions.headers).to.deep.equal(firstOptions.headers)
        expect(JSON.stringify(first.input)).not.to.contain("prompt_cache_breakpoint")
    })
})
