import { strict as assert } from "node:assert"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/config", () => import("./SubagentRunner.config.fixture"))

import * as coreApi from "@core/api"
import * as skills from "@core/context/instructions/user-instructions/skills"
import type { SystemPromptContext } from "@core/prompts/system-prompt/context"
import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { ApiFormat, ServerTool } from "@/shared/proto/dline/models/metadata"
import { DlineDefaultTool } from "@/shared/tools"
import { SubagentRunner } from "../SubagentRunner"
import {
    createTaskConfig,
    initializeHostProvider,
    SUBAGENT_REQUEST_ID,
    stubApiHandler,
    stubSystemPrompt,
    type TestConversationMessage,
    useSubagentRunnerTestLifecycle,
} from "./SubagentRunner.fixtures"

/** Native tools a hosted-web subagent declares: no local tool besides completion. */
const HOSTED_WEB_NATIVE_TOOLS = [DlineDefaultTool.ATTEMPT]

/** Stubs a handler whose model declares and whose adapter carries the given hosted tools. */
function stubHostedToolsApiHandler(createMessage: ReturnType<typeof vi.fn>, tools: readonly ServerTool[]) {
    vi.spyOn(coreApi, "buildApiHandler").mockReturnValue({
        abort: vi.fn(),
        getProviderId: () => "anthropic",
        supportsServerTool: (tool: ServerTool) => tools.includes(tool),
        getModel: () => ({
            id: "anthropic/claude-sonnet-4.5",
            info: {
                contextWindow: 200_000,
                apiFormats: [ApiFormat.ANTHROPIC_CHAT],
                supportsPromptCache: true,
                capabilities: {
                    contextWindow: 200_000,
                    supportsImages: false,
                    supportsPromptCache: true,
                    supportsTools: true,
                    tools: [...tools],
                },
            },
        }),
        createMessage,
    } as never)
}

/** Collect every text block the runner sent as conversation on a given request. */
function conversationTextForCall(createMessage: ReturnType<typeof vi.fn>, callIndex: number): string {
    const conversation = (createMessage.mock.calls[callIndex]?.[1] ?? []) as TestConversationMessage[]
    return conversation
        .flatMap((message) => message.content)
        .filter((block) => block.type === "text")
        .map((block) => block.text)
        .join("\n")
}

describe("SubagentRunner hosted tools", () => {
    useSubagentRunnerTestLifecycle()

    it("does not give the default subagent hosted Web Search outside its tool allowlist", async () => {
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield {
                type: "tool_calls",
                function_id: "complete-without-search",
                tool_call: {
                    function: {
                        name: DlineDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "done" }),
                    },
                },
            }
        })
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage, 200_000, true)
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(false, { clineWebToolsEnabled: true })).run(
            "Do not search remotely",
            () => {},
        )

        assert.equal(result.status, "completed", result.error)
        expect(createMessage.mock.calls[0][3]).toStrictEqual({
            serverTools: [],
            taskNamespace: "task-1",
            retryOwner: "subagent",
            telemetryRole: "subagent",
            telemetryRequestId: expect.stringMatching(SUBAGENT_REQUEST_ID),
            telemetryAttempt: 0,
        })
    })

    it("uses the request-frozen Web Tools switch when the live setting changes", async () => {
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield {
                type: "tool_calls",
                function_id: "complete-with-frozen-search",
                tool_call: {
                    function: {
                        name: DlineDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "done" }),
                    },
                },
            }
        })
        stubSystemPrompt(true, undefined, HOSTED_WEB_NATIVE_TOOLS)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage, 200_000, true)
        initializeHostProvider()
        const config = createTaskConfig(true, { clineWebToolsEnabled: false, webToolsEnabled: true })

        const result = await new SubagentRunner(config, "web-researcher", {
            name: "web-researcher",
            description: "Researches current information on the web.",
            tools: [DlineDefaultTool.WEB_SEARCH, DlineDefaultTool.ATTEMPT],
            systemPrompt: "",
        }).run("Use the frozen request gate", () => {})

        assert.equal(result.status, "completed", result.error)
        expect(createMessage.mock.calls[0][3]).toStrictEqual({
            serverTools: [ServerTool.WEB_SEARCH],
            taskNamespace: "task-1",
            retryOwner: "subagent",
            telemetryRole: "subagent",
            telemetryRequestId: expect.stringMatching(SUBAGENT_REQUEST_ID),
            telemetryAttempt: 0,
        })
    })

    it("reports hosted Web Search lifecycle when the subagent allowlist explicitly enables it", async () => {
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield {
                type: "server_tool",
                function_id: "srv-search-1",
                tool: ServerTool.WEB_SEARCH,
                phase: "started",
                input: { query: "latest Dline docs" },
            }
            yield {
                type: "server_tool",
                function_id: "srv-search-1",
                tool: ServerTool.WEB_SEARCH,
                phase: "completed",
                result: [{ title: "Dline docs" }],
            }
            yield {
                type: "tool_calls",
                function_id: "complete-after-search",
                tool_call: {
                    function: {
                        name: DlineDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "done" }),
                    },
                },
            }
        })
        stubSystemPrompt(true, undefined, HOSTED_WEB_NATIVE_TOOLS)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage, 200_000, true)
        initializeHostProvider()
        const config = createTaskConfig(true, { clineWebToolsEnabled: true })
        const progress = vi.fn()

        const result = await new SubagentRunner(config, "web-researcher", {
            name: "web-researcher",
            description: "Researches current information on the web.",
            tools: [DlineDefaultTool.WEB_SEARCH, DlineDefaultTool.ATTEMPT],
            systemPrompt: "",
        }).run("Search remotely", progress)

        assert.equal(result.status, "completed", result.error)
        expect(createMessage.mock.calls[0][3]).toStrictEqual({
            serverTools: [ServerTool.WEB_SEARCH],
            taskNamespace: "task-1",
            retryOwner: "subagent",
            telemetryRole: "subagent",
            telemetryRequestId: expect.stringMatching(SUBAGENT_REQUEST_ID),
            telemetryAttempt: 0,
        })
        const hostedEvents = progress.mock.calls
            .map(([update]) => update.event)
            .filter((event) => event?.toolName === "web_search")
        assert.equal(hostedEvents.length, 2)
        assert.equal(hostedEvents[0].kind, "tool_call")
        assert.equal(hostedEvents[1].kind, "tool_result")
        assert.equal(hostedEvents[1].toolStatus, "completed")
        expect(config.coordinator.getHandler).not.toHaveBeenCalledWith(DlineDefaultTool.WEB_SEARCH)
    })

    it("routes Web Search to the local XML tool when tools are offered as XML", async () => {
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield {
                type: "tool_calls",
                function_id: "complete-xml",
                tool_call: {
                    function: { name: DlineDefaultTool.ATTEMPT, arguments: JSON.stringify({ result: "done" }) },
                },
            }
        })
        const contexts: SystemPromptContext[] = []
        stubSystemPrompt(false, (context) => contexts.push(context))
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage, 200_000, true)
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(false, { clineWebToolsEnabled: true }), "web-researcher", {
            name: "web-researcher",
            description: "Researches current information on the web.",
            tools: [DlineDefaultTool.WEB_SEARCH, DlineDefaultTool.ATTEMPT],
            systemPrompt: "",
        }).run("Search with XML tools", vi.fn())

        assert.equal(result.status, "completed", result.error)
        // The model-hosted search would be declared natively, which an XML prompt never teaches.
        expect(createMessage.mock.calls[0][3]).toMatchObject({ serverTools: [] })
        expect(contexts[0]).toMatchObject({ webSearchRoutingPlan: { route: "local", localToolEnabled: true } })
    })

    describe("hosted tool replay", () => {
        const hostedReplay = {
            type: "hosted_tool",
            protocol: "anthropic_messages",
            blocks: [
                { type: "server_tool_use", id: "srvtoolu_1", name: "web_search", input: { query: "latest Dline docs" } },
                { type: "web_search_tool_result", tool_use_id: "srvtoolu_1", content: [{ title: "Dline docs" }] },
            ],
        }

        /** First request searches and answers without a tool call; the second completes. */
        function searchThenComplete() {
            return vi
                .fn()
                .mockImplementationOnce(async function* () {
                    yield {
                        type: "server_tool",
                        function_id: "srv-search-replay",
                        tool: ServerTool.WEB_SEARCH,
                        phase: "started",
                        input: { query: "latest Dline docs" },
                    }
                    yield {
                        type: "server_tool",
                        function_id: "srv-search-replay",
                        tool: ServerTool.WEB_SEARCH,
                        phase: "completed",
                        result: [{ title: "Dline docs" }],
                        replay: hostedReplay,
                    }
                    yield { type: "text", text: "The docs say X." }
                })
                .mockImplementation(async function* () {
                    yield {
                        type: "tool_calls",
                        function_id: "complete-after-replay",
                        tool_call: {
                            function: { name: DlineDefaultTool.ATTEMPT, arguments: JSON.stringify({ result: "done" }) },
                        },
                    }
                })
        }

        async function runWithReplayProtocol(createMessage: ReturnType<typeof vi.fn>, protocol: string | undefined) {
            stubSystemPrompt(false)
            vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
            vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
            vi.spyOn(coreApi, "buildApiHandler").mockReturnValue({
                abort: vi.fn(),
                getProviderId: () => "anthropic",
                supportsServerTool: (tool: ServerTool) => tool === ServerTool.WEB_SEARCH,
                getHostedToolReplayProtocol: () => protocol,
                getModel: () => ({
                    id: "anthropic/claude-sonnet-4.5",
                    info: {
                        contextWindow: 200_000,
                        apiFormats: [ApiFormat.ANTHROPIC_CHAT],
                        supportsPromptCache: true,
                        capabilities: {
                            contextWindow: 200_000,
                            supportsImages: false,
                            supportsPromptCache: true,
                            supportsTools: true,
                            tools: [ServerTool.WEB_SEARCH],
                        },
                    },
                }),
                createMessage,
            } as never)
            initializeHostProvider()
            return new SubagentRunner(createTaskConfig(false, { clineWebToolsEnabled: true }), "web-researcher", {
                name: "web-researcher",
                description: "Researches current information on the web.",
                tools: [DlineDefaultTool.WEB_SEARCH, DlineDefaultTool.ATTEMPT],
                systemPrompt: "",
            }).run("Search remotely", () => {})
        }

        function assistantBlocksOfLaterRequest(createMessage: ReturnType<typeof vi.fn>) {
            const messages = createMessage.mock.calls[1][1] as Array<{ role: string; content: unknown }>
            return messages
                .filter((message) => message.role === "assistant" && Array.isArray(message.content))
                .flatMap((message) => message.content as Array<{ type: string }>)
        }

        it("replays the completed hosted search to the endpoint that ran it, before the answer text", async () => {
            const createMessage = searchThenComplete()

            const result = await runWithReplayProtocol(createMessage, "anthropic_messages")

            assert.equal(result.status, "completed", result.error)
            const blocks = assistantBlocksOfLaterRequest(createMessage)
            const hostedIndex = blocks.findIndex((block) => block.type === "hosted_tool")
            const textIndex = blocks.findIndex(
                (block) => block.type === "text" && (block as { text?: string }).text === "The docs say X.",
            )
            expect(blocks[hostedIndex]).toEqual(hostedReplay)
            expect(textIndex).toBeGreaterThan(hostedIndex)
        })

        it("drops hosted blocks for an endpoint that cannot replay their protocol", async () => {
            const createMessage = searchThenComplete()

            const result = await runWithReplayProtocol(createMessage, undefined)

            assert.equal(result.status, "completed", result.error)
            const blocks = assistantBlocksOfLaterRequest(createMessage)
            expect(blocks.some((block) => block.type === "hosted_tool")).toBe(false)
            expect(blocks.some((block) => block.type === "text" && (block as { text?: string }).text === "The docs say X.")).toBe(
                true,
            )
        })

        describe("deferred hosted calls", () => {
            const deferredCall = { type: "server_tool_use", id: "srvtoolu_deferred", name: "web_search", input: { query: "q" } }
            const deferredResult = { type: "web_search_tool_result", tool_use_id: "srvtoolu_deferred", content: [{ title: "Q" }] }
            const searchChunk = { type: "server_tool", function_id: "srvtoolu_deferred", tool: ServerTool.WEB_SEARCH } as const
            const listFiles = {
                type: "tool_calls",
                function_id: "toolu_list",
                tool_call: { function: { name: DlineDefaultTool.LIST_FILES, arguments: JSON.stringify({ path: "." }) } },
            }
            const complete = {
                type: "tool_calls",
                function_id: "toolu_complete",
                tool_call: { function: { name: DlineDefaultTool.ATTEMPT, arguments: JSON.stringify({ result: "done" }) } },
            }

            async function* deferSearchBehind(clientTool: object) {
                yield { ...searchChunk, phase: "started", input: { query: "q" } }
                yield {
                    ...searchChunk,
                    phase: "deferred",
                    input: { query: "q" },
                    replay: { type: "hosted_tool", protocol: "anthropic_messages", segment: "call", blocks: [deferredCall] },
                }
                yield clientTool
            }

            // Anthropic only defers a hosted call behind native client tool calls, whose results come back as tool_result.
            async function runDeferral(createMessage: ReturnType<typeof vi.fn>) {
                stubSystemPrompt(true)
                vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
                vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
                vi.spyOn(coreApi, "buildApiHandler").mockReturnValue({
                    abort: vi.fn(),
                    getProviderId: () => "anthropic",
                    supportsServerTool: (tool: ServerTool) => tool === ServerTool.WEB_SEARCH,
                    getHostedToolReplayProtocol: () => "anthropic_messages",
                    getModel: () => ({
                        id: "anthropic/claude-sonnet-4.5",
                        info: {
                            contextWindow: 200_000,
                            apiFormats: [ApiFormat.ANTHROPIC_CHAT],
                            supportsPromptCache: true,
                            capabilities: {
                                contextWindow: 200_000,
                                supportsImages: false,
                                supportsPromptCache: true,
                                supportsTools: true,
                                tools: [ServerTool.WEB_SEARCH],
                            },
                        },
                    }),
                    createMessage,
                } as never)
                initializeHostProvider()
                const progress = vi.fn()
                const result = await new SubagentRunner(
                    createTaskConfig(true, { clineWebToolsEnabled: true }),
                    "web-researcher",
                    {
                        name: "web-researcher",
                        description: "Researches current information on the web.",
                        tools: [DlineDefaultTool.WEB_SEARCH, DlineDefaultTool.LIST_FILES, DlineDefaultTool.ATTEMPT],
                        systemPrompt: "",
                    },
                ).run("Search and list", progress)
                const searchEvents = progress.mock.calls
                    .map(([update]) => update.event)
                    .filter((event) => event?.toolName === "web_search")
                return { result, searchEvents }
            }

            it("completes the deferred search in the next request under one tool call", async () => {
                const createMessage = vi
                    .fn()
                    .mockImplementationOnce(() => deferSearchBehind(listFiles))
                    .mockImplementationOnce(async function* () {
                        yield {
                            ...searchChunk,
                            phase: "completed",
                            result: [{ title: "Q" }],
                            replay: {
                                type: "hosted_tool",
                                protocol: "anthropic_messages",
                                segment: "result",
                                blocks: [deferredResult],
                            },
                        }
                        yield { type: "text", text: "Found Q." }
                        yield complete
                    })

                const { result, searchEvents } = await runDeferral(createMessage)

                assert.equal(result.status, "completed", result.error)
                expect(new Set(searchEvents.map((event) => event.toolCallId)).size).toBe(1)
                expect(searchEvents.at(-1)).toMatchObject({ kind: "tool_result", toolStatus: "completed" })
                expect(searchEvents.some((event) => event.toolStatus === "failed")).toBe(false)
                const resumedTurn = (createMessage.mock.calls[1][1] as Array<{ role: string; content: unknown }>).at(-1)
                expect(resumedTurn?.role).toBe("user")
            })

            it("stores the resumed result first in the assistant turn that carries it", async () => {
                const createMessage = vi
                    .fn()
                    .mockImplementationOnce(() => deferSearchBehind(listFiles))
                    .mockImplementationOnce(async function* () {
                        yield { type: "reasoning", reasoning: "thinking about Q" }
                        yield {
                            ...searchChunk,
                            phase: "completed",
                            result: [{ title: "Q" }],
                            replay: {
                                type: "hosted_tool",
                                protocol: "anthropic_messages",
                                segment: "result",
                                blocks: [deferredResult],
                            },
                        }
                        yield { type: "text", text: "Found Q." }
                        yield listFiles
                    })
                    .mockImplementation(async function* () {
                        yield complete
                    })

                const { result } = await runDeferral(createMessage)

                assert.equal(result.status, "completed", result.error)
                const assistants = (createMessage.mock.calls[2][1] as Array<{ role: string; content: unknown }>).filter(
                    (message) => message.role === "assistant",
                )
                const resumedTurn = assistants.at(-1)?.content as Array<{ type: string; segment?: string }>
                expect(resumedTurn[0]).toMatchObject({ type: "hosted_tool", segment: "result" })
            })

            it("fails a deferred search when the run ends before any request could resume it", async () => {
                const createMessage = vi.fn().mockImplementationOnce(() => deferSearchBehind(complete))

                const { result, searchEvents } = await runDeferral(createMessage)

                assert.equal(result.status, "completed", result.error)
                expect(searchEvents.at(-1)).toMatchObject({ kind: "tool_result", toolStatus: "failed" })
            })
        })
    })

    it.each([
        { allowed: [DlineDefaultTool.WEB_FETCH], serverTools: [ServerTool.WEB_FETCH] },
        { allowed: [DlineDefaultTool.WEB_SEARCH], serverTools: [ServerTool.WEB_SEARCH] },
    ])("declares only the hosted web tools in the allowlist $allowed", async ({ allowed, serverTools }) => {
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield {
                type: "tool_calls",
                function_id: "complete-with-allowed-web-tools",
                tool_call: {
                    function: {
                        name: DlineDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "done" }),
                    },
                },
            }
        })
        stubSystemPrompt(true, undefined, HOSTED_WEB_NATIVE_TOOLS)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubHostedToolsApiHandler(createMessage, [ServerTool.WEB_SEARCH, ServerTool.WEB_FETCH])
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(true, { clineWebToolsEnabled: true }), "web-researcher", {
            name: "web-researcher",
            description: "Researches current information on the web.",
            tools: [...allowed, DlineDefaultTool.ATTEMPT],
            systemPrompt: "",
        }).run("Use only the allowed web tool", () => {})

        assert.equal(result.status, "completed", result.error)
        expect(createMessage.mock.calls[0][3]).toStrictEqual({
            serverTools,
            taskNamespace: "task-1",
            retryOwner: "subagent",
            telemetryRole: "subagent",
            telemetryRequestId: expect.stringMatching(SUBAGENT_REQUEST_ID),
            telemetryAttempt: 0,
        })
    })

    it("keeps hosted web tools when the web ceiling reserves local tools for manual approval", async () => {
        // Hosted capabilities are Provider declarations rather than Dline-owned tool
        // executions, so the local web approval ceiling must not rewrite their route.
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield {
                type: "tool_calls",
                function_id: "complete-without-hosted-web",
                tool_call: {
                    function: {
                        name: DlineDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "done" }),
                    },
                },
            }
        })
        stubSystemPrompt(true, undefined, HOSTED_WEB_NATIVE_TOOLS)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubHostedToolsApiHandler(createMessage, [ServerTool.WEB_SEARCH, ServerTool.WEB_FETCH])
        initializeHostProvider()
        const config = createTaskConfig(true, { clineWebToolsEnabled: true })
        config.autoApprovalSettings = {
            ...DEFAULT_AUTO_APPROVAL_SETTINGS,
            actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, useWeb: true },
            ceilings: { web: "manual_only" },
        }

        const result = await new SubagentRunner(config, "web-researcher", {
            name: "web-researcher",
            description: "Researches current information on the web.",
            tools: [DlineDefaultTool.WEB_SEARCH, DlineDefaultTool.WEB_FETCH, DlineDefaultTool.ATTEMPT],
            systemPrompt: "",
        }).run("Use the allowed hosted web tools", () => {})

        assert.equal(result.status, "completed", result.error)
        expect(createMessage.mock.calls[0][3]).toStrictEqual({
            serverTools: [ServerTool.WEB_SEARCH, ServerTool.WEB_FETCH],
            taskNamespace: "task-1",
            retryOwner: "subagent",
            telemetryRole: "subagent",
            telemetryRequestId: expect.stringMatching(SUBAGENT_REQUEST_ID),
            telemetryAttempt: 0,
        })
    })

    it("does not replay the provider request after a hosted Web Search chunk was yielded", async () => {
        const createMessage = vi.fn()
        createMessage.mockImplementationOnce(async function* () {
            yield {
                type: "server_tool",
                function_id: "hosted-search-before-stream-error",
                tool: ServerTool.WEB_SEARCH,
                phase: "started",
                input: { query: "Dline retry boundary" },
            }
            throw new Error("stream failed after hosted search started")
        })
        createMessage.mockImplementationOnce(async function* () {
            yield { type: "text", text: "" }
            yield {
                type: "tool_calls",
                function_id: "fc-done",
                dline_tid: "tid-done",
                tool_call: { function: { name: "attempt_completion", arguments: '{"result":"Reported the failure."}' } },
            }
        })
        stubSystemPrompt(true, undefined, HOSTED_WEB_NATIVE_TOOLS)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage, 200_000, true)
        initializeHostProvider()
        const progress = vi.fn()
        const runner = new SubagentRunner(createTaskConfig(true, { clineWebToolsEnabled: true }), "web-researcher", {
            name: "web-researcher",
            description: "Researches current information on the web.",
            tools: [DlineDefaultTool.WEB_SEARCH, DlineDefaultTool.ATTEMPT],
            systemPrompt: "",
        })

        const result = await runner.run("Search once", progress)

        // The failed attempt is never replayed: the second call is a new turn that
        // carries the failure notice, not a retry of the same request.
        assert.equal(createMessage.mock.calls.length, 2)
        assert.equal(result.status, "completed")
        const hostedStartedEvents = progress.mock.calls
            .map(([update]) => update.event)
            .filter((event) => event?.kind === "tool_call" && event.toolName === "web_search" && event.toolStatus === "started")
        assert.equal(hostedStartedEvents.length, 1)
    })

    it("hands a failed hosted call back to the subagent instead of ending the run", async () => {
        const createMessage = vi.fn()
        createMessage.mockImplementationOnce(async function* () {
            yield {
                type: "server_tool",
                function_id: "hosted-search-recoverable",
                tool: ServerTool.WEB_SEARCH,
                phase: "started",
                input: { query: "Dline recovery boundary" },
            }
            throw new Error("stream failed after hosted search started")
        })
        createMessage.mockImplementationOnce(async function* () {
            yield {
                type: "tool_calls",
                function_id: "fc-recovered",
                dline_tid: "tid-recovered",
                tool_call: {
                    function: { name: "attempt_completion", arguments: '{"result":"Proceeded without the search."}' },
                },
            }
        })
        stubSystemPrompt(true, undefined, HOSTED_WEB_NATIVE_TOOLS)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage, 200_000, true)
        initializeHostProvider()
        const runner = new SubagentRunner(createTaskConfig(true, { clineWebToolsEnabled: true }), "web-researcher", {
            name: "web-researcher",
            description: "Researches current information on the web.",
            tools: [DlineDefaultTool.WEB_SEARCH, DlineDefaultTool.ATTEMPT],
            systemPrompt: "",
        })

        const result = await runner.run("Search once", vi.fn())

        assert.equal(result.status, "completed")
        assert.equal(result.result, "Proceeded without the search.")
        // The model must be told what failed, with the attempted query, so it can
        // decide whether to retry differently or continue without the result.
        const secondTurnText = conversationTextForCall(createMessage, 1)
        assert.match(secondTurnText, /Provider-hosted web search for "Dline recovery boundary" failed/i)
        assert.match(secondTurnText, /cannot be recovered automatically/i)
    })

    it("stops recovering once a run exhausts its hosted failure budget", async () => {
        const failingTurn = async function* () {
            yield {
                type: "server_tool",
                function_id: "hosted-search-always-failing",
                tool: ServerTool.WEB_SEARCH,
                phase: "started",
                input: { query: "never succeeds" },
            }
            throw new Error("stream failed after hosted search started")
        }
        const createMessage = vi.fn().mockImplementation(failingTurn)
        stubSystemPrompt(true, undefined, HOSTED_WEB_NATIVE_TOOLS)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage, 200_000, true)
        initializeHostProvider()
        const runner = new SubagentRunner(createTaskConfig(true, { clineWebToolsEnabled: true }), "web-researcher", {
            name: "web-researcher",
            description: "Researches current information on the web.",
            tools: [DlineDefaultTool.WEB_SEARCH, DlineDefaultTool.ATTEMPT],
            systemPrompt: "",
        })

        const result = await runner.run("Search forever", vi.fn())

        // Recovery is bounded: a provider failing every attempt must end the run
        // rather than loop until the turn budget is exhausted.
        assert.equal(result.status, "failed")
        assert.equal(createMessage.mock.calls.length, 3)
        assert.match(result.error || "", /stream failed after hosted search started/i)
    })

    it("keeps propagating a stream failure when no hosted call was involved", async () => {
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield { type: "usage", inputTokens: 10, outputTokens: 2, totalCost: 0.25, currency: "CNY" }
            yield { type: "text", text: "partial" }
            throw new Error("plain stream failure")
        })
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage, 200_000, true)
        initializeHostProvider()
        const runner = new SubagentRunner(createTaskConfig(false, { clineWebToolsEnabled: true }), "web-researcher", {
            name: "web-researcher",
            description: "Researches current information on the web.",
            tools: [DlineDefaultTool.WEB_SEARCH, DlineDefaultTool.ATTEMPT],
            systemPrompt: "",
        })

        const result = await runner.run("Do not search", vi.fn())

        assert.equal(result.status, "failed")
        assert.match(result.error || "", /plain stream failure/i)
        assert.equal(result.stats.totalCost, 0.25)
        assert.equal(result.stats.currency, "CNY")
    })
})
