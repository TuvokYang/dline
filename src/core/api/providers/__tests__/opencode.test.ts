import type { ModelInfo } from "@shared/proto/dline/models"
import { ApiFormat, type ModelCapabilities } from "@shared/proto/dline/models/metadata"
import { ApiProfile } from "@shared/proto/dline/profile"
import { BaseProviderConfig } from "@shared/proto/dline/provider/common"
import { OpenCodeMode, OpenCodeProviderConfig } from "@shared/proto/dline/provider/opencode"
import { flatMeteredPricing } from "@shared/providers/pricing-shape"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { ClineErrorType } from "@/services/error"
import type { ClineStorageMessage } from "@/shared/messages/content"
import type { ClineTool } from "@/shared/tools"

const mocks = vi.hoisted(() => ({
    createOpenAIClient: vi.fn(),
    createAnthropicClient: vi.fn(),
    buildExternalBasicHeaders: vi.fn(() => ({ "x-dline-external": "external" })),
    fetch: vi.fn(),
}))

// The factory runs before the hoisted `mocks` binding is initialized, so the
// fetch spy is resolved at call time rather than captured at module load.
vi.mock("@/shared/net", () => ({
    createOpenAIClient: (...args: unknown[]) => mocks.createOpenAIClient(...args),
    fetch: (...args: unknown[]) => mocks.fetch(...args),
}))
vi.mock("@/services/EnvUtils", () => ({ buildExternalBasicHeaders: mocks.buildExternalBasicHeaders }))
vi.mock("../anthropic/client-factory", () => ({ createAnthropicClient: mocks.createAnthropicClient }))

const { OpenCodeHandler, parseOpenCodeUsage, readOpenCodeCost } = await import("../opencode")

/** Async iterable standing in for one provider stream. */
function streamOf(events: readonly unknown[]) {
    return {
        [Symbol.asyncIterator]: async function* () {
            yield* events
        },
    }
}

/** One local tool in the canonical shape every adapter receives. */
const readFileTool = {
    type: "function",
    function: {
        name: "read_file",
        description: "Read one workspace file",
        parameters: {
            type: "object",
            properties: { path: { type: "string" } },
            required: ["path"],
        },
    },
} as unknown as ClineTool

/** Build a handler whose stored Profile config carries the given model declaration. */
function createHandler(options: {
    apiFormat?: ApiFormat
    modelId?: string
    mode?: OpenCodeMode
    capabilities?: ModelCapabilities
    pricing?: ModelInfo["pricing"]
    reasoning?: { enableThinking?: boolean; effort?: string; thinkingBudget?: number }
}) {
    return new OpenCodeHandler({
        profile: ApiProfile.create({
            provider: "opencode",
            apiKey: "test-key",
            modelId: options.modelId ?? "gpt-6-sol",
            opencode: OpenCodeProviderConfig.create({
                mode: options.mode ?? OpenCodeMode.OPEN_CODE_MODE_CONSOLE,
                apiFormat: options.apiFormat,
                capabilities: options.capabilities,
                pricing: options.pricing,
                reasoning: options.reasoning,
            }),
        }),
        mode: "act",
    })
}

/** Point the OpenAI SDK surface at a fake client and return its two entry points. */
function mockOpenAIClient(handler: InstanceType<typeof OpenCodeHandler>) {
    const chatCreate = vi.fn()
    const responsesCreate = vi.fn()
    Object.assign(handler as unknown as { client: unknown }, {
        client: {
            chat: { completions: { create: chatCreate } },
            responses: { create: responsesCreate },
        },
    })
    return { chatCreate, responsesCreate }
}

/** Point the Anthropic client surface at a fake client. */
function mockAnthropicClient(handler: InstanceType<typeof OpenCodeHandler>) {
    const messagesCreate = vi.fn()
    Object.assign(handler as unknown as { anthropicClient: unknown }, {
        anthropicClient: { messages: { create: messagesCreate }, beta: { messages: { create: messagesCreate } } },
    })
    return messagesCreate
}

async function collect(stream: AsyncIterable<unknown>): Promise<unknown[]> {
    const chunks: unknown[] = []
    for await (const chunk of stream) chunks.push(chunk)
    return chunks
}

const userTurn: ClineStorageMessage[] = [{ role: "user", content: "hi" }]

describe("OpenCodeHandler", () => {
    describe("OPENAI_CHAT", () => {
        it("streams text, reasoning, tool calls, and cache-aware usage", async () => {
            const handler = createHandler({ apiFormat: ApiFormat.OPENAI_CHAT })
            const { chatCreate } = mockOpenAIClient(handler)
            chatCreate.mockResolvedValue(
                streamOf([
                    { choices: [{ index: 0, delta: { content: "Answer" } }] },
                    { choices: [{ index: 0, delta: { reasoning_content: "Because" } }] },
                    {
                        choices: [
                            {
                                index: 0,
                                delta: {
                                    tool_calls: [
                                        {
                                            index: 0,
                                            id: "call_1",
                                            type: "function",
                                            function: { name: "read_file", arguments: '{"path":"a.ts"}' },
                                        },
                                    ],
                                },
                            },
                        ],
                    },
                    {
                        choices: [],
                        usage: {
                            prompt_tokens: 1_000,
                            completion_tokens: 120,
                            prompt_tokens_details: { cached_tokens: 800 },
                            completion_tokens_details: { reasoning_tokens: 90 },
                        },
                    },
                ]),
            )

            const chunks = await collect(handler.createMessage("system", userTurn))

            expect(chunks).to.deep.include({ type: "text", text: "Answer" })
            expect(chunks).to.deep.include({ type: "reasoning", reasoning: "Because" })
            expect(chunks).to.deep.include({
                type: "tool_calls",
                function_id: "call_1",
                tool_index: 0,
                tool_call: { function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
            })
            const usage = chunks.find((chunk) => (chunk as { type: string }).type === "usage") as Record<string, unknown>
            // prompt_tokens already includes the cached share, so the uncached input must be split out.
            expect(usage).to.include({ inputTokens: 200, outputTokens: 120, cacheReadTokens: 800 })
            expect(usage.thoughtsTokenCount).to.equal(90)
        })

        it("sends the declared tool schema and the profile max output tokens", async () => {
            const handler = createHandler({
                apiFormat: ApiFormat.OPENAI_CHAT,
                capabilities: { maxTokens: 4_096, supportsTools: true },
            })
            const { chatCreate } = mockOpenAIClient(handler)
            chatCreate.mockResolvedValue(streamOf([]))

            await collect(handler.createMessage("system", userTurn, [readFileTool]))

            const body = chatCreate.mock.calls[0]?.[0] as Record<string, unknown>
            expect(body.model).to.equal("gpt-6-sol")
            expect(body.stream).to.equal(true)
            expect(body.max_tokens).to.equal(4_096)
            expect(body.tools).to.deep.equal([readFileTool])
            const messages = body.messages as Array<Record<string, unknown>>
            expect(messages[0]).to.deep.equal({ role: "system", content: "system" })
        })
    })

    describe("OPENAI_RESPONSES", () => {
        it("reports usage from response.completed and streams reasoning and text", async () => {
            // Prices come from the Profile, never from the seed catalog, so the
            // cost assertion below needs a declaration to price against.
            const handler = createHandler({
                apiFormat: ApiFormat.OPENAI_RESPONSES,
                pricing: flatMeteredPricing(3, 15, 3.75, 0.3),
            })
            const { responsesCreate } = mockOpenAIClient(handler)
            responsesCreate.mockResolvedValue(
                streamOf([
                    { type: "response.reasoning_summary_text.delta", item_id: "rs_1", delta: "Thinking" },
                    { type: "response.output_text.delta", item_id: "msg_1", delta: "Hello" },
                    {
                        type: "response.completed",
                        response: {
                            id: "resp_1",
                            status: "completed",
                            usage: {
                                input_tokens: 1_000,
                                output_tokens: 200,
                                total_tokens: 1_200,
                                input_tokens_details: { cached_tokens: 600 },
                                output_tokens_details: { reasoning_tokens: 80 },
                            },
                        },
                    },
                ]),
            )

            const chunks = await collect(handler.createMessage("system", userTurn))

            expect(chunks).to.deep.include({ type: "text", provider_metadata: { response_id: "msg_1" }, text: "Hello" })
            expect(chunks).to.deep.include({
                type: "reasoning",
                provider_metadata: { response_id: "rs_1" },
                reasoning: "Thinking",
            })
            const usage = chunks.find((chunk) => (chunk as { type: string }).type === "usage") as Record<string, unknown>
            // The only usage this protocol reports lives on response.completed.
            expect(usage).to.include({ inputTokens: 400, outputTokens: 200, cacheReadTokens: 600, thoughtsTokenCount: 80 })
            // The shared Responses handler prices the request from the same usage event.
            expect(usage.totalCost).to.be.a("number").and.to.be.greaterThan(0)
        })

        it("declares the same function tool to Responses as to Chat", async () => {
            const handler = createHandler({
                apiFormat: ApiFormat.OPENAI_RESPONSES,
                capabilities: { maxTokens: 2_048, supportsTools: true },
            })
            const { responsesCreate } = mockOpenAIClient(handler)
            responsesCreate.mockResolvedValue(streamOf([]))

            await collect(handler.createMessage("system", userTurn, [readFileTool]))

            const body = responsesCreate.mock.calls[0]?.[0] as Record<string, unknown>
            expect(body.instructions).to.equal("system")
            expect(body.max_output_tokens).to.equal(2_048)
            expect(body.store).to.equal(false)
            // Responses spells the same function tool flat and always states
            // `strict`, so the gateway never receives the nested Chat shape.
            expect(body.tools).to.deep.equal([
                {
                    type: "function",
                    name: "read_file",
                    description: "Read one workspace file",
                    parameters: {
                        type: "object",
                        properties: { path: { type: "string" } },
                        required: ["path"],
                    },
                    strict: true,
                },
            ])
            expect((body.tools as Array<Record<string, unknown>>)[0]).not.to.have.property("function")
        })

        it("replays a tool round with Responses call identities rather than Chat message shapes", async () => {
            const handler = createHandler({ apiFormat: ApiFormat.OPENAI_RESPONSES })
            const { responsesCreate } = mockOpenAIClient(handler)
            responsesCreate.mockResolvedValue(streamOf([]))
            const history: ClineStorageMessage[] = [
                ...userTurn,
                {
                    role: "assistant",
                    content: [
                        {
                            type: "tool_use",
                            function_id: "call_read_1",
                            dline_tid: "tid_1",
                            name: "read_file",
                            input: { path: "a.ts" },
                        },
                    ],
                },
                {
                    role: "user",
                    content: [{ type: "tool_result", function_id: "call_read_1", dline_tid: "tid_1", content: "file body" }],
                },
            ]

            await collect(handler.createMessage("system", history, [readFileTool]))

            expect(responsesCreate.mock.calls[0][0].input).toEqual([
                { role: "user", content: [{ type: "input_text", text: "hi" }] },
                { type: "function_call", call_id: "call_read_1", name: "read_file", arguments: '{"path":"a.ts"}' },
                { type: "function_call_output", call_id: "call_read_1", output: "file body" },
            ])
            expect(responsesCreate.mock.calls[0][0]).not.toHaveProperty("previous_response_id")
        })

        it("keeps a truncated tool result as user content instead of sending an orphan Responses output", async () => {
            const handler = createHandler({ apiFormat: ApiFormat.OPENAI_RESPONSES })
            const { responsesCreate } = mockOpenAIClient(handler)
            responsesCreate.mockResolvedValue(streamOf([]))
            await collect(
                handler.createMessage("system", [
                    {
                        role: "user",
                        content: [
                            {
                                type: "tool_result",
                                function_id: "missing_call",
                                dline_tid: "tid_missing",
                                content: "retained output",
                            },
                        ],
                    },
                ]),
            )

            expect(responsesCreate.mock.calls[0][0].input).toEqual([
                { role: "user", content: [{ type: "input_text", text: "retained output" }] },
            ])
        })

        it("omits tools entirely when the conversation declares none", async () => {
            const handler = createHandler({ apiFormat: ApiFormat.OPENAI_RESPONSES })
            const { responsesCreate } = mockOpenAIClient(handler)
            responsesCreate.mockResolvedValue(streamOf([]))

            await collect(handler.createMessage("system", userTurn))

            const body = responsesCreate.mock.calls[0]?.[0] as Record<string, unknown>
            expect(body).not.toHaveProperty("tools")
        })
    })

    describe("ANTHROPIC_CHAT", () => {
        it("streams text, thinking, tool calls, and disjoint input/cache usage", async () => {
            const handler = createHandler({ apiFormat: ApiFormat.ANTHROPIC_CHAT })
            const messagesCreate = mockAnthropicClient(handler)
            messagesCreate.mockResolvedValue(
                streamOf([
                    {
                        type: "message_start",
                        message: {
                            id: "msg_1",
                            usage: {
                                input_tokens: 300,
                                output_tokens: 0,
                                cache_read_input_tokens: 700,
                                cache_creation_input_tokens: 100,
                            },
                        },
                    },
                    { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
                    { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } },
                    { type: "content_block_stop", index: 0 },
                    { type: "content_block_start", index: 1, content_block: { type: "thinking", thinking: "" } },
                    { type: "content_block_delta", index: 1, delta: { type: "thinking_delta", thinking: "Plan" } },
                    { type: "content_block_stop", index: 1 },
                    {
                        type: "content_block_start",
                        index: 2,
                        content_block: { type: "tool_use", id: "toolu_1", name: "read_file", input: {} },
                    },
                    {
                        type: "content_block_delta",
                        index: 2,
                        delta: { type: "input_json_delta", partial_json: '{"path":"a.ts"}' },
                    },
                    { type: "content_block_stop", index: 2 },
                    { type: "message_delta", delta: { stop_reason: "tool_use" }, usage: { output_tokens: 42 } },
                    { type: "message_stop" },
                ]),
            )

            const chunks = await collect(handler.createMessage("system", userTurn))

            expect(chunks).to.deep.include({ type: "text", text: "Hi" })
            expect(chunks).to.deep.include({ type: "reasoning", reasoning: "Plan" })
            expect(chunks).to.deep.include({
                type: "tool_calls",
                function_id: "toolu_1",
                tool_call: { function: { name: "read_file", arguments: '{"path":"a.ts"}' } },
            })
            const usages = chunks.filter((chunk) => (chunk as { type: string }).type === "usage") as Record<string, unknown>[]
            // The endpoint reports one cumulative snapshot per upstream usage event:
            // `message_start` carries the prompt side, `message_delta` the output side.
            expect(usages).to.have.length(2)
            // Anthropic reports input and cache disjointly, so nothing is subtracted.
            expect(usages[0]).to.include({ inputTokens: 300, cacheReadTokens: 700, cacheWriteTokens: 100 })
            expect(usages[1]).to.include({ inputTokens: 300, outputTokens: 42, stopReason: "tool_use" })
        })

        it("passes the native Anthropic tool shape without a second conversion", async () => {
            const handler = createHandler({ apiFormat: ApiFormat.ANTHROPIC_CHAT })
            const messagesCreate = mockAnthropicClient(handler)
            messagesCreate.mockResolvedValue(streamOf([{ type: "message_stop" }]))

            await collect(handler.createMessage("system", userTurn, [readFileTool]))

            const body = messagesCreate.mock.calls[0]?.[0] as Record<string, unknown>
            expect(body.tools).to.deep.equal([readFileTool])
        })
    })

    it.each([
        ApiFormat.OPENAI_CHAT,
        ApiFormat.OPENAI_RESPONSES,
        ApiFormat.ANTHROPIC_CHAT,
    ])("aborts an in-flight SDK request for protocol %s", async (apiFormat) => {
        const handler = createHandler({ apiFormat })
        const { chatCreate, responsesCreate } = mockOpenAIClient(handler)
        const messagesCreate = mockAnthropicClient(handler)
        const create =
            apiFormat === ApiFormat.ANTHROPIC_CHAT
                ? messagesCreate
                : apiFormat === ApiFormat.OPENAI_RESPONSES
                  ? responsesCreate
                  : chatCreate
        let signal: AbortSignal | undefined
        create.mockImplementation((_body, options) => {
            signal = options?.signal
            if (!signal) return Promise.resolve(streamOf([]))
            return new Promise((_resolve, reject) =>
                signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true }),
            )
        })
        const settled = collect(handler.createMessage("system", userTurn)).then(
            () => false,
            () => true,
        )
        await vi.waitFor(() => expect(create).toHaveBeenCalledTimes(1))
        handler.abort()

        expect(signal?.aborted).toBe(true)
        expect(await settled).toBe(true)
    })

    it.each([
        [ApiFormat.OPENAI_CHAT, { reasoning_effort: "high" }],
        [ApiFormat.OPENAI_RESPONSES, { reasoning: { effort: "high", summary: "auto" } }],
        [ApiFormat.ANTHROPIC_CHAT, { thinking: { type: "adaptive" }, output_config: { effort: "high" } }],
    ] as const)("encodes saved reasoning controls for protocol %s", async (apiFormat, expected) => {
        const handler = createHandler({
            apiFormat,
            capabilities: {
                supportsReasoning: true,
                thinking: { supported: true, mode: "effort", effortLevels: ["low", "high"] },
            },
            reasoning: { enableThinking: true, effort: "high" },
        })
        const { chatCreate, responsesCreate } = mockOpenAIClient(handler)
        const messagesCreate = mockAnthropicClient(handler)
        const create =
            apiFormat === ApiFormat.ANTHROPIC_CHAT
                ? messagesCreate
                : apiFormat === ApiFormat.OPENAI_CHAT
                  ? chatCreate
                  : responsesCreate
        create.mockResolvedValue(streamOf([]))

        await collect(handler.createMessage("system", userTurn))

        expect(create.mock.calls[0][0]).toMatchObject(expected)
        // An omitted timeout inherits the SDK's bounded default, not an explicit undefined.
        expect(create.mock.calls[0][1]).not.toHaveProperty("timeout")
    })

    it.each([
        [ApiFormat.OPENAI_CHAT, "max_tokens"],
        [ApiFormat.OPENAI_RESPONSES, "max_output_tokens"],
        [ApiFormat.ANTHROPIC_CHAT, "max_tokens"],
    ] as const)("carries the request-owned compaction budget for protocol %s", async (apiFormat, field) => {
        const handler = createHandler({ apiFormat, capabilities: { maxTokens: 4096 } })
        const { chatCreate, responsesCreate } = mockOpenAIClient(handler)
        const messagesCreate = mockAnthropicClient(handler)
        const create =
            apiFormat === ApiFormat.ANTHROPIC_CHAT
                ? messagesCreate
                : apiFormat === ApiFormat.OPENAI_RESPONSES
                  ? responsesCreate
                  : chatCreate
        create.mockResolvedValue(streamOf([]))

        await collect(
            handler.createMessage("system", userTurn, undefined, { generation: { purpose: "compaction", maxOutputTokens: 256 } }),
        )

        expect(create.mock.calls[0][0][field]).toBe(256)
    })

    describe("protocol selection", () => {
        it("rejects Gemini instead of silently downgrading to another protocol", () => {
            const handler = createHandler({ apiFormat: ApiFormat.GEMINI_CHAT })

            expect(() => handler.getSelectedApiFormat()).to.throw(/cannot carry the selected protocol/)
        })

        it("honors a stored protocol and reports it back to the runtime", () => {
            const handler = createHandler({ apiFormat: ApiFormat.ANTHROPIC_CHAT })

            expect(handler.getSelectedApiFormat()).to.equal(ApiFormat.ANTHROPIC_CHAT)
            expect(handler.getModel().info.apiFormats?.[0]).to.equal(ApiFormat.ANTHROPIC_CHAT)
        })

        it("fails before building any request when the protocol is not accepted", async () => {
            const handler = createHandler({ apiFormat: ApiFormat.GEMINI_CHAT })
            const { chatCreate, responsesCreate } = mockOpenAIClient(handler)

            await expect(collect(handler.createMessage("system", userTurn))).rejects.toThrow(/cannot carry the selected protocol/)
            expect(chatCreate).not.toHaveBeenCalled()
            expect(responsesCreate).not.toHaveBeenCalled()
        })
    })

    describe("Go mode", () => {
        it("appends the Go path to the OpenAI endpoint and declares one session identity", async () => {
            const handler = new OpenCodeHandler({
                profile: ApiProfile.create({
                    provider: "opencode",
                    apiKey: "test-key",
                    modelId: "gpt-6-sol",
                    opencode: OpenCodeProviderConfig.create({
                        mode: OpenCodeMode.OPEN_CODE_MODE_GO,
                        // This case pins the Go endpoint, not the protocol default, so
                        // the protocol is stated explicitly.
                        model: BaseProviderConfig.create({ apiFormat: ApiFormat.OPENAI_CHAT }),
                    }),
                }),
                mode: "act",
            })
            mocks.createOpenAIClient.mockReturnValue({
                chat: { completions: { create: vi.fn().mockResolvedValue(streamOf([])) } },
            })

            await collect(handler.createMessage("system", userTurn, undefined, { taskNamespace: "task-abc" } as never))

            // The subscription mode moves both the catalog and the endpoint base; a
            // Console URL with a Go catalog would answer 404 on every request.
            const options = mocks.createOpenAIClient.mock.calls.at(-1)?.[0] as {
                baseURL: string
                defaultHeaders: Record<string, string>
            }
            expect(options.baseURL).to.equal("https://opencode.ai/inference/go/openai/v1")
            expect(options.defaultHeaders["x-opencode-session"]).to.equal("task-abc")
        })

        it("appends the Go path to the Anthropic endpoint as well", async () => {
            const handler = new OpenCodeHandler({
                profile: ApiProfile.create({
                    provider: "opencode",
                    apiKey: "test-key",
                    modelId: "gpt-6-sol",
                    opencode: OpenCodeProviderConfig.create({
                        mode: OpenCodeMode.OPEN_CODE_MODE_GO,
                        model: BaseProviderConfig.create({ apiFormat: ApiFormat.ANTHROPIC_CHAT }),
                    }),
                }),
                mode: "act",
            })
            mocks.createAnthropicClient.mockReturnValue({
                messages: { create: vi.fn().mockResolvedValue(streamOf([{ type: "message_stop" }])) },
                beta: { messages: { create: vi.fn() } },
            })

            await collect(handler.createMessage("system", userTurn, undefined, { taskNamespace: "task-abc" } as never))

            const options = mocks.createAnthropicClient.mock.calls.at(-1)?.[1] as {
                baseUrl: string
                defaultHeaders: Record<string, string>
            }
            // The SDK appends /v1/messages to this base; the E2E asserts the final wire path.
            expect(options.baseUrl).to.equal("https://opencode.ai/inference/go/anthropic")
            // A continuation must keep the same conversation identity as the first request.
            expect(options.defaultHeaders["x-opencode-session"]).to.equal("task-abc")
        })
    })

    describe("pricing", () => {
        it("bills cached input at the declared cache-read rate, not the uncached rate", async () => {
            // An unlisted model has no registry price, so the Profile's own rate is
            // the only price and the arithmetic is fully determined here.
            const handler = createHandler({
                modelId: "custom-price-model",
                apiFormat: ApiFormat.OPENAI_CHAT,
                pricing: flatMeteredPricing(10, 50, 0, 2),
            })
            const { chatCreate } = mockOpenAIClient(handler)
            chatCreate.mockResolvedValue(
                streamOf([
                    {
                        choices: [],
                        usage: {
                            prompt_tokens: 1_000_000,
                            completion_tokens: 0,
                            prompt_tokens_details: { cached_tokens: 1_000_000 },
                        },
                    },
                ]),
            )

            const chunks = await collect(handler.createMessage("system", userTurn))

            const usage = chunks.find((chunk) => (chunk as { type: string }).type === "usage") as Record<string, unknown>
            // 1M cached input tokens at 2/M, and no uncached input at 10/M.
            expect(usage.totalCost).toBeCloseTo(2, 6)
            expect(usage).to.include({ inputTokens: 0, cacheReadTokens: 1_000_000 })
        })
    })

    describe("billing", () => {
        it("uses the amount the gateway charged instead of a local estimate", async () => {
            // The published price table cannot see peak-hour or long-context
            // pricing, so a reported charge always wins over an estimate.
            const handler = createHandler({
                apiFormat: ApiFormat.OPENAI_CHAT,
                pricing: flatMeteredPricing(3, 15),
            })
            const { chatCreate } = mockOpenAIClient(handler)
            chatCreate.mockResolvedValue(
                streamOf([
                    {
                        choices: [],
                        usage: {
                            prompt_tokens: 1_000,
                            completion_tokens: 200,
                            cost: 0.00412,
                            opencode: {
                                billing_source: "balance",
                                list_cost: 0.00412,
                                tokens: { input: 1_000, output: 200, cache_read: 0 },
                            },
                        },
                    },
                ]),
            )

            const chunks = await collect(handler.createMessage("system", userTurn))
            const usage = chunks.find((chunk) => (chunk as { type: string }).type === "usage") as Record<string, unknown>

            expect(usage.totalCost).to.equal(0.00412)
        })

        it("reports a Go request that costs nothing as zero task cost", async () => {
            const handler = createHandler({
                apiFormat: ApiFormat.OPENAI_CHAT,
                mode: OpenCodeMode.OPEN_CODE_MODE_GO,
                pricing: flatMeteredPricing(3, 15),
            })
            const { chatCreate } = mockOpenAIClient(handler)
            chatCreate.mockResolvedValue(
                streamOf([
                    {
                        choices: [],
                        usage: {
                            prompt_tokens: 500,
                            completion_tokens: 100,
                            cost: 0,
                            opencode: { billing_source: "go", allowance: 0.0034 },
                        },
                    },
                ]),
            )

            const chunks = await collect(handler.createMessage("system", userTurn))
            const usage = chunks.find((chunk) => (chunk as { type: string }).type === "usage") as Record<string, unknown>

            // A Go request inside the plan costs nothing, so the task cost is
            // zero. The plan's own accounting is a separate concern and is not
            // read from this response.
            expect(usage.totalCost).to.equal(0)
        })

        it("treats an absent charge as unknown rather than free", () => {
            // A model with no price omits `cost`. Reporting 0 would render the
            // request as free, which is a different fact.
            expect(readOpenCodeCost({ prompt_tokens: 10, completion_tokens: 2 })).to.equal(undefined)
            // A negative or non-numeric amount cannot be a charge either.
            expect(readOpenCodeCost({ cost: -1 })).to.equal(undefined)
            expect(readOpenCodeCost({ cost: "0.01" })).to.equal(undefined)
        })

        it("keeps a zero charge, which is a real reading for a free model", () => {
            expect(readOpenCodeCost({ cost: 0 })).to.equal(0)
        })
    })

    describe("account usage", () => {
        beforeEach(() => {
            // Every case here installs its own response; a leftover mock from a
            // previous case would make a rejected read look like a successful one.
            mocks.fetch.mockReset()
        })

        /** Build a handler for one billing mode, which is what decides whether usage exists. */
        function handlerForMode(mode: OpenCodeMode) {
            return new OpenCodeHandler({
                profile: ApiProfile.create({
                    provider: "opencode",
                    apiKey: "oc_sk_test",
                    modelId: "glm-5.3",
                    opencode: OpenCodeProviderConfig.create({ mode }),
                }),
                mode: "act",
            })
        }

        it("turns the Go windows into quota readings whose percent is the used share", () => {
            // `percent` is how much of each window is used, so each reading is a
            // share of 100 rather than a remaining balance.
            const quotas = parseOpenCodeUsage({
                usage: {
                    rolling: { status: "ok", percent: 12.5, resetsAt: "2026-11-01T05:00:00.000Z" },
                    weekly: { status: "ok", percent: 40, resetsAt: 1762400000 },
                    monthly: { status: "ok", percent: 3, resetsAt: 1764547200000 },
                },
            })

            expect(quotas).to.deep.equal([
                {
                    type: "rolling-5h",
                    label: "5 Hour",
                    shortLabel: "5h",
                    used: 12.5,
                    limit: 100,
                    windowSeconds: 18_000,
                    resetAt: "2026-11-01T05:00:00.000Z",
                },
                {
                    type: "weekly",
                    label: "Weekly",
                    shortLabel: "week",
                    used: 40,
                    limit: 100,
                    windowSeconds: 604_800,
                    // Epoch seconds are widened to milliseconds.
                    resetAt: new Date(1_762_400_000 * 1000).toISOString(),
                },
                {
                    type: "monthly",
                    label: "Monthly",
                    shortLabel: "month",
                    used: 3,
                    limit: 100,
                    windowSeconds: 2_592_000,
                    resetAt: new Date(1_764_547_200_000).toISOString(),
                },
            ])
        })

        it("reports the console as the only source for a pay-as-you-go Profile and never calls the endpoint", async () => {
            const usage = await handlerForMode(OpenCodeMode.OPEN_CODE_MODE_CONSOLE).getAccountUsage()

            expect(mocks.fetch).not.toHaveBeenCalled()
            // A balance Provider must not claim a zero balance it never read.
            expect(usage).to.include({ isAvailable: false, providerId: "opencode" })
            expect(usage?.quotas).to.equal(undefined)
        })

        it("reads the windows without the usage wrapper the vendor may omit", () => {
            const quotas = parseOpenCodeUsage({ monthly: { percent: 61 } })

            expect(quotas).to.deep.equal([
                { type: "monthly", label: "Monthly", shortLabel: "month", used: 61, limit: 100, windowSeconds: 2_592_000 },
            ])
        })

        it("keeps an overshooting window, which is a real reading while Extra Usage runs", () => {
            // Go keeps serving past a window once Extra Usage is on, so 140% of
            // the 5-hour allowance is a fact about the account, not a bad parse.
            const quotas = parseOpenCodeUsage({ usage: { rolling: { percent: 140 }, weekly: { percent: 25 } } })

            expect(quotas).to.deep.equal([
                { type: "rolling-5h", label: "5 Hour", shortLabel: "5h", used: 140, limit: 100, windowSeconds: 18_000 },
                { type: "weekly", label: "Weekly", shortLabel: "week", used: 25, limit: 100, windowSeconds: 604_800 },
            ])
        })

        it("drops a window whose percentage cannot be a share instead of rendering it as zero", () => {
            const quotas = parseOpenCodeUsage({
                usage: {
                    // A negative share is impossible, so the window says nothing.
                    rolling: { percent: -1, resetsAt: "2026-11-01T05:00:00.000Z" },
                    weekly: { percent: "25" },
                    monthly: { percent: 12 },
                },
            })

            expect(quotas).to.deep.equal([
                { type: "monthly", label: "Monthly", shortLabel: "month", used: 12, limit: 100, windowSeconds: 2_592_000 },
            ])
        })

        it("reports nothing to show when the endpoint rejects the credential", async () => {
            mocks.fetch.mockResolvedValue({ ok: false, status: 401, json: async () => ({}) })

            const usage = await handlerForMode(OpenCodeMode.OPEN_CODE_MODE_GO).getAccountUsage()

            // A rejected read is not a reading: the surface keeps showing its
            // previous snapshot rather than a fresh "unavailable".
            expect(usage).to.equal(undefined)
        })

        it("cancels an in-flight usage read when the turn is aborted", async () => {
            let observed: AbortSignal | undefined
            mocks.fetch.mockImplementation(
                (_url: string, init: { signal?: AbortSignal }) =>
                    new Promise((_resolve, reject) => {
                        observed = init.signal
                        init.signal?.addEventListener("abort", () => reject(new Error("aborted")))
                    }),
            )
            const handler = handlerForMode(OpenCodeMode.OPEN_CODE_MODE_GO)

            const pending = handler.getAccountUsage()
            handler.abort()

            expect(observed?.aborted).to.equal(true)
            await expect(pending).resolves.to.equal(undefined)
        })

        it("polls Go usage on the shared timer", () => {
            // The shared Controller timer is what decides whether this surfaces
            // without the user pressing refresh.
            expect(handlerForMode(OpenCodeMode.OPEN_CODE_MODE_GO).supportsAccountUsagePolling).not.toBe(false)
        })
    })

    describe("error classification", () => {
        /** The refusal the user actually received from the gateway. */
        const countryRefusal = {
            status: 403,
            message: "403 This model is not available in your country",
        }

        it("reports a country refusal as a region limit, not as a client or plan problem", () => {
            const parsed = createHandler({}).parseError(countryRefusal, "crouton-alpha-free")

            // The gateway named the reason, so the classification must repeat it
            // rather than substitute the client-only explanation.
            expect(parsed._error.code).to.equal("OPENCODE_MODEL_REGION_RESTRICTED")
            expect(parsed._error.message).to.include("country or region")
            // Stating the reason is not licence to explain it: how the gateway
            // decides a country, and whether a purchase would change the answer,
            // are not things the response said.
            expect(parsed._error.message).not.to.include("Go plan")
            expect(parsed._error.message).not.to.include("only available inside")
            expect(parsed._error.message).not.to.match(/account|network|IP address/i)
            expect(parsed._error.message).not.to.match(/switching plans|switch the plan|does not change/i)
        })

        it("keeps the gateway message, status and provider identity on a region refusal", () => {
            const parsed = createHandler({}).parseError({ ...countryRefusal, request_id: "req-42" }, "crouton-alpha-free")

            const serialized = JSON.parse(parsed.serialize())
            expect(serialized).to.include({ status: 403, request_id: "req-42", providerId: "opencode" })
            expect(serialized.details.providerMessage).to.equal(countryRefusal.message)
        })

        it("classifies a stated client restriction as one", () => {
            const parsed = createHandler({}).parseError({
                status: 403,
                message:
                    "This model is only available inside the OpenCode client. Choose a paid OpenCode model, or use the OpenCode Go plan.",
            })

            expect(parsed._error.code).to.equal("OPENCODE_MODEL_CLIENT_RESTRICTED")
            expect(parsed._error.message).to.include("inside its own client")
        })

        it("stays neutral for a 403 whose reason it cannot read", () => {
            const parsed = createHandler({}).parseError({ status: 403, message: "Forbidden" })

            // An unexplained refusal is not evidence about the credential or the
            // plan; guessing one would send the user to the wrong fix.
            expect(parsed._error.code).to.equal("OPENCODE_REQUEST_FORBIDDEN")
            expect(parsed._error.code).not.to.equal("OPENCODE_MODEL_RESTRICTED")
            expect(parsed._error.message).not.to.include("Go plan")
        })

        it("stays neutral for a 403 that carries no message at all", () => {
            const parsed = createHandler({}).parseError({ status: 403 })

            expect(parsed._error.code).to.equal("OPENCODE_REQUEST_FORBIDDEN")
            expect(parsed._error.details.providerMessage).to.equal("")
        })

        it("reads a refusal nested in the error body instead of the placeholder message", () => {
            const parsed = createHandler({}).parseError({
                status: 403,
                message: "Request failed with status code 403",
                error: { message: "This model is not available in your region" },
            })

            expect(parsed._error.code).to.equal("OPENCODE_MODEL_REGION_RESTRICTED")
        })

        it("does not state a mode cause for a 404, which can also mean a stale model or base URL", () => {
            const parsed = createHandler({}).parseError({ status: 404, message: "404 page not found" })

            expect(parsed._error.code).to.equal("OPENCODE_REQUEST_NOT_FOUND")
            expect(parsed._error.message).to.include("base URL")
            expect(parsed._error.message).not.to.include("switch the mode")
        })

        it("keeps 401 on the shared auth classification", () => {
            const parsed = createHandler({}).parseError({ status: 401, message: "Unauthorized" })

            expect(parsed.isErrorType(ClineErrorType.Auth)).to.equal(true)
        })
    })
})
