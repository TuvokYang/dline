import { strict as assert } from "node:assert"
import { describe, it, vi } from "vitest"

vi.mock("@/config", () => import("./SubagentRunner.config.fixture"))

import * as skills from "@core/context/instructions/user-instructions/skills"
import { DlineDefaultTool } from "@/shared/tools"
import { SubagentRunner } from "../SubagentRunner"
import {
    createTaskConfig,
    initializeHostProvider,
    stubApiHandler,
    stubSystemPrompt,
    type TestConversationMessage,
    useSubagentRunnerTestLifecycle,
} from "./SubagentRunner.fixtures"

describe("SubagentRunner native and XML protocol", () => {
    useSubagentRunnerTestLifecycle()

    it("emits native tool blocks with matching canonical identities across turns", async () => {
        const createMessage = vi.fn()
        createMessage.mockImplementationOnce(async function* () {
            yield {
                type: "tool_calls",
                function_id: "toolu_subagent_1",
                tool_index: 0,
                tool_call: {
                    function: {
                        name: DlineDefaultTool.LIST_FILES,
                        arguments: JSON.stringify({ path: ".", recursive: false }),
                    },
                },
            }
        })
        createMessage.mockImplementationOnce(async function* (_s: string, c: unknown[]) {
            const am = c[1] as TestConversationMessage
            assert.equal(am.role, "assistant")
            const tu = am.content.find((block) => block.type === "tool_use")
            assert.ok(tu)
            assert.equal(tu.function_id, "toolu_subagent_1")
            assert.ok(tu.dline_tid)
            assert.equal("id" in tu, false)
            assert.equal("call_id" in tu, false)
            const um = c[2] as TestConversationMessage
            assert.equal(um.role, "user")
            const tr = um.content.find((block) => block.type === "tool_result")
            assert.ok(tr)
            assert.equal(tr.function_id, tu.function_id)
            assert.equal(tr.dline_tid, tu.dline_tid)
            assert.equal("tool_use_id" in tr, false)
            assert.equal("call_id" in tr, false)
            yield {
                type: "tool_calls",
                function_id: "toolu_subagent_complete_1",
                tool_index: 0,
                tool_call: {
                    function: {
                        name: DlineDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "done" }),
                    },
                },
            }
        })
        stubSystemPrompt(true)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()
        const runner = new SubagentRunner(createTaskConfig(true))
        const progress = vi.fn()
        const result = await runner.run("List files", progress)
        assert.equal(result.status, "completed", result.error)
        assert.equal(result.result, "done")
        assert.equal(createMessage.mock.calls.length, 2)
        const completedToolEvents = progress.mock.calls
            .map(([update]) => update.event)
            .filter((event) => event?.kind === "tool_call" && event.toolStatus === "completed")
        assert.deepEqual(
            completedToolEvents.map((event) => ({ toolName: event.toolName, summary: event.summary })),
            [
                { toolName: DlineDefaultTool.LIST_FILES, summary: "list_files(path=., recursive=false)" },
                { toolName: DlineDefaultTool.ATTEMPT, summary: "attempt_completion(result=done)" },
            ],
        )
        assert.equal(new Set(completedToolEvents.map((event) => event.toolCallId)).size, 2)
        assert.ok(completedToolEvents.every((event) => event.toolCallId?.startsWith("dline_tid_")))
    })

    it("replays provider reasoning with its final signature before native tool use", async () => {
        const createMessage = vi.fn()
        let secondConversation: unknown[] = []
        createMessage.mockImplementationOnce(async function* () {
            yield { type: "reasoning", reasoning: "Inspecting the workspace" }
            yield { type: "reasoning", reasoning: "", signature: "provider-signature" }
            yield {
                type: "tool_calls",
                function_id: "provider-read",
                tool_index: 0,
                tool_call: {
                    function: {
                        name: DlineDefaultTool.LIST_FILES,
                        arguments: JSON.stringify({ path: ".", recursive: false }),
                    },
                },
            }
        })
        createMessage.mockImplementationOnce(async function* (_systemPrompt: string, conversation: unknown[]) {
            secondConversation = conversation
            yield {
                type: "tool_calls",
                function_id: "provider-complete",
                tool_index: 0,
                tool_call: {
                    function: {
                        name: DlineDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "done" }),
                    },
                },
            }
        })
        stubSystemPrompt(true)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(true)).run("Inspect files", () => {})

        assert.equal(result.status, "completed", result.error)
        assert.equal(result.result, "done")
        assert.equal(createMessage.mock.calls.length, 2)
        const assistant = secondConversation[1] as { content: Array<Record<string, unknown>>; role: string }
        assert.equal(assistant.role, "assistant")
        assert.deepEqual(assistant.content[0], {
            type: "thinking",
            thinking: "Inspecting the workspace",
            signature: "provider-signature",
            summary: [],
            provider_metadata: undefined,
        })
        assert.equal(assistant.content[1]?.type, "tool_use")
        assert.equal(assistant.content[1]?.function_id, "provider-read")
    })

    it("discards reasoning from a failed replayable attempt before retrying", async () => {
        const createMessage = vi.fn()
        let nextRoundConversation: unknown[] = []
        createMessage.mockImplementationOnce(async function* () {
            yield {
                type: "reasoning",
                reasoning: "Failed attempt reasoning",
                provider_metadata: { response_id: "failed-reasoning" },
            }
            yield { type: "reasoning", reasoning: "", signature: "failed-signature" }
            throw Object.assign(new Error("stream_read_error"), {
                code: "stream_read_error",
                error: { code: "stream_read_error", message: "stream_read_error", type: "upstream_error" },
            })
        })
        createMessage.mockImplementationOnce(async function* () {
            yield {
                type: "reasoning",
                reasoning: "Successful attempt reasoning",
                provider_metadata: { response_id: "successful-reasoning" },
            }
            yield { type: "reasoning", reasoning: "", signature: "successful-signature" }
            yield {
                type: "tool_calls",
                function_id: "provider-read-after-retry",
                tool_index: 0,
                tool_call: {
                    function: {
                        name: DlineDefaultTool.LIST_FILES,
                        arguments: JSON.stringify({ path: ".", recursive: false }),
                    },
                },
            }
        })
        createMessage.mockImplementationOnce(async function* (_systemPrompt: string, conversation: unknown[]) {
            nextRoundConversation = conversation
            yield {
                type: "tool_calls",
                function_id: "provider-complete-after-retry",
                tool_index: 0,
                tool_call: {
                    function: {
                        name: DlineDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "done" }),
                    },
                },
            }
        })
        vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
            queueMicrotask(callback)
            return {} as NodeJS.Timeout
        }) as typeof setTimeout)
        stubSystemPrompt(true)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(true)).run("Inspect files", () => {})

        assert.equal(result.status, "completed", result.error)
        const assistant = nextRoundConversation[1] as {
            content: Array<Record<string, unknown>>
            provider_metadata?: { response_id?: string }
        }
        assert.deepEqual(assistant.content[0], {
            type: "thinking",
            thinking: "Successful attempt reasoning",
            signature: "successful-signature",
            summary: [],
            provider_metadata: { response_id: "successful-reasoning" },
        })
        assert.equal(assistant.provider_metadata?.response_id, "successful-reasoning")
    })

    it("preserves a reasoning-only turn before appending user feedback", async () => {
        const createMessage = vi.fn()
        let nextRoundConversation: unknown[] = []
        createMessage.mockImplementationOnce(async function* () {
            yield { type: "reasoning", reasoning: "Reasoning without a response", signature: "reasoning-only-signature" }
        })
        createMessage.mockImplementationOnce(async function* (_systemPrompt: string, conversation: unknown[]) {
            nextRoundConversation = conversation
            yield {
                type: "tool_calls",
                function_id: "provider-complete-after-reasoning-only",
                tool_index: 0,
                tool_call: {
                    function: {
                        name: DlineDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "done" }),
                    },
                },
            }
        })
        stubSystemPrompt(true)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(true)).run("Inspect files", () => {})

        assert.equal(result.status, "completed", result.error)
        assert.equal(nextRoundConversation.length, 3)
        const assistant = nextRoundConversation[1] as { role: string; content: Array<Record<string, unknown>> }
        assert.equal(assistant.role, "assistant")
        assert.deepEqual(assistant.content[0], {
            type: "thinking",
            thinking: "Reasoning without a response",
            signature: "reasoning-only-signature",
            summary: [],
            provider_metadata: undefined,
        })
        const user = nextRoundConversation[2] as { role: string; content: Array<{ type: string; text?: string }> }
        assert.equal(user.role, "user")
        const feedback = user.content.map((block) => block.text ?? "").join("\n")
        assert.match(feedback, /contained only internal reasoning/)
        assert.doesNotMatch(feedback, /Consecutive failed responses/)
        assert.match(feedback, /Do not restart or repeat earlier analysis/)
        assert.doesNotMatch(JSON.stringify(nextRoundConversation), /I did not provide a response/)
    })

    it("preserves redacted thinking continuity before appending user feedback", async () => {
        const createMessage = vi.fn()
        let nextRoundConversation: unknown[] = []
        createMessage.mockImplementationOnce(async function* () {
            yield {
                type: "reasoning",
                reasoning: "[Redacted thinking block]",
                redacted_data: "opaque-anthropic-thinking",
                redacted_phase: "final",
            }
        })
        createMessage.mockImplementationOnce(async function* (_systemPrompt: string, conversation: unknown[]) {
            nextRoundConversation = conversation
            yield {
                type: "tool_calls",
                function_id: "provider-complete-after-redacted-thinking",
                tool_index: 0,
                tool_call: {
                    function: {
                        name: DlineDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "done" }),
                    },
                },
            }
        })
        stubSystemPrompt(true)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(true)).run("Inspect files", () => {})

        assert.equal(result.status, "completed", result.error)
        assert.equal(nextRoundConversation.length, 3)
        const assistant = nextRoundConversation[1] as { role: string; content: Array<Record<string, unknown>> }
        assert.equal(assistant.role, "assistant")
        assert.deepEqual(assistant.content[0], {
            type: "redacted_thinking",
            data: "opaque-anthropic-thinking",
            provider_metadata: undefined,
        })
        const user = nextRoundConversation[2] as { role: string; content: Array<{ type: string; text?: string }> }
        assert.equal(user.role, "user")
        assert.match(user.content.map((block) => block.text ?? "").join("\n"), /contained only internal reasoning/)
    })

    it("records structured tool calls received while non-native mode is enabled", async () => {
        const createMessage = vi.fn()
        let nextRoundConversation: unknown[] = []
        createMessage.mockImplementationOnce(async function* () {
            yield { type: "reasoning", reasoning: "Inspecting through a structured fallback" }
            yield {
                type: "tool_calls",
                function_id: "provider-structured-fallback-read",
                tool_index: 0,
                tool_call: {
                    function: {
                        name: DlineDefaultTool.LIST_FILES,
                        arguments: JSON.stringify({ path: ".", recursive: false }),
                    },
                },
            }
        })
        createMessage.mockImplementationOnce(async function* (_systemPrompt: string, conversation: unknown[]) {
            nextRoundConversation = conversation
            yield {
                type: "tool_calls",
                function_id: "provider-structured-fallback-complete",
                tool_index: 0,
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
        stubApiHandler(createMessage)
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(false)).run("Inspect files", () => {})

        assert.equal(result.status, "completed", result.error)
        const assistant = nextRoundConversation[1] as {
            content: Array<Record<string, unknown>>
            provider_metadata?: { response_id?: string }
        }
        assert.equal(assistant.content[0]?.type, "thinking")
        assert.deepEqual(assistant.content[1], {
            type: "text",
            text: "Tool calls: list_files",
        })
        assert.equal(assistant.provider_metadata, undefined)
    })

    it("allocates unique identities for non-native tools across provider rounds", async () => {
        const createMessage = vi.fn()
        createMessage.mockImplementationOnce(async function* () {
            yield {
                type: "text",
                text: "<list_files>\n<path>.</path>\n<recursive>false</recursive>\n</list_files>",
            }
        })
        createMessage.mockImplementationOnce(async function* () {
            yield {
                type: "text",
                text: "<list_files>\n<path>src</path>\n<recursive>false</recursive>\n</list_files>",
            }
        })
        createMessage.mockImplementationOnce(async function* () {
            yield {
                type: "text",
                text: "<attempt_completion>\n<result>done</result>\n</attempt_completion>",
            }
        })
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()
        const progress = vi.fn()

        const result = await new SubagentRunner(createTaskConfig(false)).run("Inspect files", progress)

        assert.equal(result.status, "completed", result.error)
        assert.equal(result.result, "done")
        const completedToolEvents = progress.mock.calls
            .map(([update]) => update.event)
            .filter((event) => event?.kind === "tool_call" && event.toolStatus === "completed")
        assert.equal(completedToolEvents.length, 3)
        assert.equal(new Set(completedToolEvents.map((event) => event.toolCallId)).size, 3)
    })

    it("falls back to non-native result blocks if structured tool calls appear while native mode is disabled", async () => {
        const createMessage = vi.fn()
        createMessage.mockImplementationOnce(async function* () {
            yield {
                type: "tool_calls",
                function_id: "toolu_subagent_2",
                tool_call: {
                    function: {
                        name: DlineDefaultTool.LIST_FILES,
                        arguments: JSON.stringify({ path: ".", recursive: false }),
                    },
                },
            }
        })
        createMessage.mockImplementationOnce(async function* (_s: string, c: unknown[]) {
            const lm = c[c.length - 1] as TestConversationMessage
            assert.equal(lm.role, "user")
            assert.ok(lm.content.every((block) => block.type === "text"))
            yield {
                type: "tool_calls",
                function_id: "toolu_subagent_complete_2",
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
        stubApiHandler(createMessage)
        initializeHostProvider()
        const runner = new SubagentRunner(createTaskConfig(false))
        const result = await runner.run("List files", () => {})
        assert.equal(result.status, "completed")
        assert.equal(result.result, "done")
        assert.equal(createMessage.mock.calls.length, 2)
    })
})
