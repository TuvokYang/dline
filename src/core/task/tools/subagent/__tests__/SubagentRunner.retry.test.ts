import { strict as assert } from "node:assert"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/config", () => import("./SubagentRunner.config.fixture"))

import * as skills from "@core/context/instructions/user-instructions/skills"
import { PromptProfile } from "@core/prompts/profiles/types"
import * as systemPromptFacade from "@core/prompts/system-prompt"
import { DlineDefaultTool } from "@/shared/tools"
import { SubagentRunner } from "../SubagentRunner"
import {
    assertFinishTurnReusesRequestShape,
    createTaskConfig,
    initializeHostProvider,
    SUBAGENT_REQUEST_ID,
    stubApiHandler,
    stubSystemPrompt,
    useSubagentRunnerTestLifecycle,
} from "./SubagentRunner.fixtures"

describe("SubagentRunner transport retry", () => {
    useSubagentRunnerTestLifecycle()

    it("retries initial stream failures before failing", async () => {
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield* []
            throw new Error('{"code":"stream_initialization_failed","message":"Failed to create stream"}')
        })
        vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
            queueMicrotask(callback)
            return {} as NodeJS.Timeout
        }) as typeof setTimeout)
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()
        const runner = new SubagentRunner(createTaskConfig(false))
        const result = await runner.run("List files", () => {})
        assert.equal(result.status, "failed")
        assert.equal(result.retryable, true)
        assert.equal(createMessage.mock.calls.length, 6)
        assert.match(result.error || "", /stream_initialization_failed/i)
    })

    it("retries the literal Upstream HTTP/2 stream failed transport error in the same run", async () => {
        const createMessage = vi
            .fn()
            .mockImplementationOnce(async function* () {
                yield* []
                throw new Error("Upstream HTTP/2 stream failed")
            })
            .mockImplementationOnce(async function* () {
                yield {
                    type: "tool_calls",
                    function_id: "fn-complete",
                    dline_tid: "tid-complete",
                    tool_call: { function: { name: "attempt_completion", arguments: '{"result":"recovered"}' } },
                    phase: "completed",
                }
            })
        vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
            queueMicrotask(callback)
            return {} as NodeJS.Timeout
        }) as typeof setTimeout)
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const progressEvents: Array<Record<string, unknown>> = []
        const result = await new SubagentRunner(createTaskConfig(false)).run("Recover transport", (update) => {
            if (update.event) progressEvents.push(update.event as unknown as Record<string, unknown>)
        })

        assert.equal(result.status, "completed")
        assert.equal(result.result, "recovered")
        assert.equal(createMessage.mock.calls.length, 2)
        assert.deepEqual(
            progressEvents.filter((event) => event.kind === "retry"),
            [{ kind: "retry", retryAttempt: 1, maxRetries: 5, delayMs: 5_000, cumulativeDelayMs: 5_000 }],
        )
        assert.equal(progressEvents.filter((event) => event.kind === "tool_call").length, 1)
    })

    it("discards a native tool call from an HTTP/2-failed attempt before retrying the same request", async () => {
        const createMessage = vi
            .fn()
            .mockImplementationOnce(async function* () {
                yield { type: "usage", inputTokens: 999, outputTokens: 0 }
                yield {
                    type: "tool_calls",
                    function_id: "abandoned-call",
                    tool_index: 0,
                    tool_call: { function: { name: DlineDefaultTool.LIST_FILES, arguments: '{"path":".' } },
                }
                throw Object.assign(new Error("Upstream HTTP/2 stream failed"), {
                    code: "upstream_http2_stream_error",
                    status: 502,
                    error: { code: "upstream_http2_stream_error", type: "upstream_error" },
                })
            })
            .mockImplementationOnce(async function* () {
                yield { type: "usage", inputTokens: 10, outputTokens: 1 }
                yield {
                    type: "tool_calls",
                    function_id: "successful-completion",
                    tool_index: 0,
                    tool_call: { function: { name: DlineDefaultTool.ATTEMPT, arguments: '{"result":"rec' } },
                }
                yield {
                    type: "tool_calls",
                    function_id: "successful-completion",
                    tool_index: 0,
                    tool_call: { function: { name: DlineDefaultTool.ATTEMPT, arguments: 'overed"}' } },
                }
            })
        const setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
            queueMicrotask(callback)
            return {} as NodeJS.Timeout
        }) as typeof setTimeout)
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const progressEvents: Array<Record<string, unknown>> = []
        const result = await new SubagentRunner(createTaskConfig(false)).run("Recover a partial native tool call", (update) => {
            if (update.event) progressEvents.push(update.event as unknown as Record<string, unknown>)
        })

        assert.equal(result.status, "completed", result.error)
        assert.equal(result.result, "recovered")
        assert.equal(result.stats.inputTokens, 10)
        assert.equal(result.stats.toolCalls, 1)
        assert.equal(createMessage.mock.calls.length, 2)
        assert.deepEqual(
            createMessage.mock.calls.map((call) => call.slice(0, 3)),
            [createMessage.mock.calls[0].slice(0, 3), createMessage.mock.calls[0].slice(0, 3)],
        )
        assert.deepEqual(
            setTimeoutSpy.mock.calls.map(([, timeout]) => timeout),
            [5_000],
        )
        assert.deepEqual(
            progressEvents.filter((event) => event.kind === "retry"),
            [{ kind: "retry", retryAttempt: 1, maxRetries: 5, delayMs: 5_000, cumulativeDelayMs: 5_000 }],
        )
        assert.deepEqual(
            progressEvents.filter((event) => event.kind === "tool_call").map((event) => event.toolName),
            [DlineDefaultTool.ATTEMPT],
        )
    })

    it("retries retryable initial API failures five times with cumulative progress events", async () => {
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield* []
            throw new Error('{"code":"stream_initialization_failed","message":"Temporary provider failure"}')
        })
        const setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
            queueMicrotask(callback)
            return {} as NodeJS.Timeout
        }) as typeof setTimeout)
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const runner = new SubagentRunner(createTaskConfig(false))
        const progressEvents: Array<Record<string, unknown>> = []
        const result = await runner.run("Retry the provider request", (update) => {
            if (update.event) progressEvents.push(update.event as unknown as Record<string, unknown>)
        })

        assert.equal(result.status, "failed")
        assert.equal(result.retryable, true)
        assert.equal(createMessage.mock.calls.length, 6)
        assert.deepEqual(
            setTimeoutSpy.mock.calls.map(([, timeout]) => timeout),
            [5_000, 8_000, 11_000, 14_000, 17_000],
        )
        assert.deepEqual(progressEvents, [
            { kind: "retry", retryAttempt: 1, maxRetries: 5, delayMs: 5_000, cumulativeDelayMs: 5_000 },
            { kind: "retry", retryAttempt: 2, maxRetries: 5, delayMs: 8_000, cumulativeDelayMs: 13_000 },
            { kind: "retry", retryAttempt: 3, maxRetries: 5, delayMs: 11_000, cumulativeDelayMs: 24_000 },
            { kind: "retry", retryAttempt: 4, maxRetries: 5, delayMs: 14_000, cumulativeDelayMs: 38_000 },
            { kind: "retry", retryAttempt: 5, maxRetries: 5, delayMs: 17_000, cumulativeDelayMs: 55_000 },
        ])
        assert.match(result.error || "", /stream_initialization_failed|Temporary provider failure/i)
    })

    it.each([408, 409, 425])("retries HTTP %s before returning a retryable failure", async (status) => {
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield* []
            throw Object.assign(new Error(`${status} Temporary provider failure`), { status })
        })
        const setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
            queueMicrotask(callback)
            return {} as NodeJS.Timeout
        }) as typeof setTimeout)
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(false)).run("Retry the provider request", () => {})

        assert.equal(result.status, "failed")
        assert.equal(result.retryable, true)
        assert.equal(createMessage.mock.calls.length, 6)
        assert.deepEqual(
            setTimeoutSpy.mock.calls.map(([, timeout]) => timeout),
            [5_000, 8_000, 11_000, 14_000, 17_000],
        )
    })

    // BUGFIX-022: the real gateway payload observed in the field. `sequence_number: 0`
    // proves the failure happened before any semantic chunk, so the whole backoff
    // sequence should run. The previous allow-list classifier rejected it outright.
    it("retries an upstream stream_read_error reported as an SSE error event", async () => {
        const providerError = {
            error: { code: "stream_read_error", message: "stream_read_error", type: "upstream_error" },
            sequence_number: 0,
            type: "error",
        }
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield* []
            throw Object.assign(new Error("stream_read_error"), { code: "stream_read_error", error: providerError.error })
        })
        const setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
            queueMicrotask(callback)
            return {} as NodeJS.Timeout
        }) as typeof setTimeout)
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(false)).run("Reproduce stream_read_error", () => {})

        assert.equal(result.status, "failed")
        assert.equal(result.retryable, true)
        assert.equal(createMessage.mock.calls.length, 6)
        assert.deepEqual(
            setTimeoutSpy.mock.calls.map(([, timeout]) => timeout),
            [5_000, 8_000, 11_000, 14_000, 17_000],
        )
    })

    // The `response.failed` follow-up event carries only `upstream_error` plus a 502.
    it("retries an upstream_error reported through response.failed with HTTP 502", async () => {
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield* []
            throw Object.assign(new Error("Upstream request failed"), { code: "upstream_error", status: 502 })
        })
        vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
            queueMicrotask(callback)
            return {} as NodeJS.Timeout
        }) as typeof setTimeout)
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(false)).run("Reproduce upstream_error", () => {})

        assert.equal(result.status, "failed")
        assert.equal(result.retryable, true)
        assert.equal(createMessage.mock.calls.length, 6)
    })

    // A bare Error with no code and no status must still reach the backoff sequence.
    it("retries an unclassified provider error that carries neither code nor status", async () => {
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield* []
            throw new Error("Upstream request failed")
        })
        vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
            queueMicrotask(callback)
            return {} as NodeJS.Timeout
        }) as typeof setTimeout)
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(false)).run("Reproduce bare provider error", () => {})

        assert.equal(result.status, "failed")
        assert.equal(result.retryable, true)
        assert.equal(createMessage.mock.calls.length, 6)
    })

    it.each([
        ["insufficient credits", { code: "insufficient_credits", details: { current_balance: 0 } }],
        ["spend limit", { code: "SPEND_LIMIT_EXCEEDED" }],
        ["inference cap", { code: "INFERENCE_CAP_ERROR" }],
        ["auth", { status: 401 }],
    ])("does not retry a non-recoverable %s failure", async (_label, errorShape) => {
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield* []
            throw Object.assign(new Error("Account level failure"), errorShape)
        })
        const setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
            queueMicrotask(callback)
            return {} as NodeJS.Timeout
        }) as typeof setTimeout)
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(false)).run("Account failure", () => {})

        assert.equal(result.status, "failed")
        assert.equal(result.retryable, false)
        assert.equal(createMessage.mock.calls.length, 1)
        assert.equal(setTimeoutSpy.mock.calls.length, 0)
    })

    it("retries a retryable failure after a usage-only prefix", async () => {
        const createMessage = vi.fn()
        createMessage.mockImplementationOnce(async function* () {
            yield { type: "usage", inputTokens: 10, outputTokens: 0 }
            throw Object.assign(new Error("408 Temporary provider failure"), { status: 408 })
        })
        createMessage.mockImplementationOnce(async function* () {
            yield {
                type: "tool_calls",
                function_id: "usage-prefix-complete",
                tool_call: { function: { name: DlineDefaultTool.ATTEMPT, arguments: JSON.stringify({ result: "done" }) } },
            }
        })
        vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
            queueMicrotask(callback)
            return {} as NodeJS.Timeout
        }) as typeof setTimeout)
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(false)).run("Retry after usage", () => {})

        assert.equal(result.status, "completed", result.error)
        assert.equal(createMessage.mock.calls.length, 2)
    })

    it("retries an Anthropic nested service_unavailable error after a usage-only prefix", async () => {
        const createMessage = vi.fn()
        const providerError = {
            type: "error",
            error: { type: "service_unavailable", message: "Temporary Anthropic stream failure" },
            request_id: "req_usage_first",
        }
        createMessage.mockImplementationOnce(async function* () {
            yield { type: "usage", inputTokens: 442_700, outputTokens: 0 }
            throw Object.assign(new Error(JSON.stringify(providerError)), {
                error: providerError,
                type: "service_unavailable",
            })
        })
        createMessage.mockImplementationOnce(async function* () {
            yield {
                type: "tool_calls",
                function_id: "anthropic-usage-prefix-complete",
                tool_call: { function: { name: DlineDefaultTool.ATTEMPT, arguments: JSON.stringify({ result: "done" }) } },
            }
        })
        vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
            queueMicrotask(callback)
            return {} as NodeJS.Timeout
        }) as typeof setTimeout)
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(false)).run("Retry Anthropic usage prefix", () => {})

        assert.equal(result.status, "completed", result.error)
        assert.equal(createMessage.mock.calls.length, 2)
    })

    // BUGFIX-028: Anthropic adaptive thinking emits a thinking block before any answer.
    // `signature_delta` maps to a reasoning chunk whose text is empty, so the prefix carries
    // no observable output and the whole backoff sequence must still run.
    it("retries an upstream stream_read_error after an empty-content reasoning prefix", async () => {
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield { type: "usage", inputTokens: 1_200, outputTokens: 0 }
            yield { type: "reasoning", reasoning: "Considering the request" }
            yield { type: "reasoning", reasoning: "", signature: "sig_adaptive" }
            throw Object.assign(new Error("stream_read_error"), {
                code: "stream_read_error",
                error: { code: "stream_read_error", message: "stream_read_error", type: "upstream_error" },
            })
        })
        const setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
            queueMicrotask(callback)
            return {} as NodeJS.Timeout
        }) as typeof setTimeout)
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(false)).run("Retry after reasoning prefix", () => {})

        assert.equal(result.status, "failed")
        assert.equal(result.retryable, true)
        assert.equal(createMessage.mock.calls.length, 6)
        assert.deepEqual(
            setTimeoutSpy.mock.calls.map(([, timeout]) => timeout),
            [5_000, 8_000, 11_000, 14_000, 17_000],
        )
    })

    // BUGFIX-028: Anthropic emits a standalone "\n" separator for text blocks at index > 0,
    // and Codex emits equivalent whitespace-only prefixes. Whitespace is not observable
    // output, so replaying it cannot duplicate anything the user has seen.
    it("retries an upstream stream_read_error after a whitespace-only text prefix", async () => {
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield { type: "usage", inputTokens: 800, outputTokens: 0 }
            yield { type: "text", text: "\n" }
            throw Object.assign(new Error("stream_read_error"), { code: "stream_read_error" })
        })
        const setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
            queueMicrotask(callback)
            return {} as NodeJS.Timeout
        }) as typeof setTimeout)
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(false)).run("Retry after whitespace prefix", () => {})

        assert.equal(result.status, "failed")
        assert.equal(result.retryable, true)
        assert.equal(createMessage.mock.calls.length, 6)
        assert.deepEqual(
            setTimeoutSpy.mock.calls.map(([, timeout]) => timeout),
            [5_000, 8_000, 11_000, 14_000, 17_000],
        )
    })

    // BUGFIX-028 guard: once real assistant text is observable, replaying the attempt would
    // duplicate content. The retry sequence must stay disabled for that case.
    it("does not retry after observable assistant text has been produced", async () => {
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield { type: "usage", inputTokens: 900, outputTokens: 0 }
            yield { type: "text", text: "Partial answer already streamed" }
            throw Object.assign(new Error("stream_read_error"), { code: "stream_read_error" })
        })
        const setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
            queueMicrotask(callback)
            return {} as NodeJS.Timeout
        }) as typeof setTimeout)
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(false)).run("Do not replay observable text", () => {})

        assert.equal(result.status, "failed")
        assert.equal(createMessage.mock.calls.length, 1)
        assert.deepEqual(
            setTimeoutSpy.mock.calls.map(([, timeout]) => timeout),
            [],
        )
    })

    it("retries structured Responses server errors before the first chunk", async () => {
        const createMessage = vi.fn()
        createMessage.mockImplementationOnce(async function* () {
            yield* []
            throw Object.assign(new Error("Responses API request failed: server_error: upstream exploded"), {
                name: "ResponsesApiError",
                code: "server_error",
                request_id: "req_failed_1",
                details: { code: "server_error", message: "upstream exploded" },
            })
        })
        createMessage.mockImplementationOnce(async function* () {
            yield {
                type: "tool_calls",
                function_id: "responses-server-error-complete",
                tool_call: { function: { name: DlineDefaultTool.ATTEMPT, arguments: JSON.stringify({ result: "done" }) } },
            }
        })
        vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
            queueMicrotask(callback)
            return {} as NodeJS.Timeout
        }) as typeof setTimeout)
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(false)).run("Retry Responses server error", () => {})

        assert.equal(result.status, "completed", result.error)
        assert.equal(createMessage.mock.calls.length, 2)
    })

    it.each([
        "ECONNRESET",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_HEADERS_TIMEOUT",
        "UND_ERR_BODY_TIMEOUT",
        "UND_ERR_SOCKET",
    ])("retries nested network cause code %s before the first chunk", async (causeCode) => {
        const createMessage = vi.fn()
        createMessage.mockImplementationOnce(async function* () {
            yield* []
            throw Object.assign(new TypeError("fetch failed"), { cause: { code: causeCode } })
        })
        createMessage.mockImplementationOnce(async function* () {
            yield {
                type: "tool_calls",
                function_id: "network-cause-complete",
                tool_call: { function: { name: DlineDefaultTool.ATTEMPT, arguments: JSON.stringify({ result: "done" }) } },
            }
        })
        vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
            queueMicrotask(callback)
            return {} as NodeJS.Timeout
        }) as typeof setTimeout)
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(false)).run("Retry nested network error", () => {})

        assert.equal(result.status, "completed", result.error)
        assert.equal(createMessage.mock.calls.length, 2)
    })

    it("keeps initial stream retries under one semantic telemetry request", async () => {
        const createMessage = vi.fn()
        createMessage.mockImplementationOnce(async function* () {
            yield* []
            throw Object.assign(new Error("408 Temporary provider failure"), { status: 408 })
        })
        const completeRound = async function* () {
            yield { type: "usage", inputTokens: 100, outputTokens: 20, cacheReadTokens: 0 }
            yield {
                type: "tool_calls",
                function_id: "toolu_round_complete",
                tool_index: 0,
                tool_call: {
                    function: {
                        name: DlineDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "done" }),
                    },
                },
            }
        }
        createMessage.mockImplementationOnce(completeRound)
        createMessage.mockImplementationOnce(completeRound)
        const setTimeoutSpy = vi.spyOn(global, "setTimeout").mockImplementation(((callback: (...args: unknown[]) => void) => {
            queueMicrotask(callback)
            return {} as NodeJS.Timeout
        }) as typeof setTimeout)
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage, 200_000, false, vi.fn(), "CNY")
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(false)).run("Retry the provider request", () => {})

        assert.equal(result.status, "completed")
        assert.equal(createMessage.mock.calls.length, 2)
        // A retry continues the semantic request it retries.
        assert.equal(createMessage.mock.calls[1]?.[3]?.telemetryRequestId, createMessage.mock.calls[0]?.[3]?.telemetryRequestId)
        expect(createMessage.mock.calls.map((call) => call[3])).toEqual([
            expect.objectContaining({
                telemetryRole: "subagent",
                telemetryRequestId: expect.stringMatching(SUBAGENT_REQUEST_ID),
                telemetryAttempt: 0,
            }),
            expect.objectContaining({
                telemetryRole: "subagent",
                telemetryRequestId: expect.stringMatching(SUBAGENT_REQUEST_ID),
                telemetryAttempt: 1,
            }),
        ])
        assert.deepEqual(
            setTimeoutSpy.mock.calls.map(([, timeout]) => timeout),
            [5_000],
        )

        // Another runner of the same Task counts its requests from 1 too; it must not reuse the label.
        const second = await new SubagentRunner(createTaskConfig(false)).run("Run in parallel", () => {})
        assert.equal(second.status, "completed")
        assert.notEqual(
            createMessage.mock.calls[2]?.[3]?.telemetryRequestId,
            createMessage.mock.calls[0]?.[3]?.telemetryRequestId,
        )
    })

    // BUGFIX-022: retry classification is a deny-list. Only account-level failures
    // that cannot recover by waiting short-circuit the backoff sequence.
    it.each([
        ["authentication error", Object.assign(new Error("Unauthorized"), { status: 401 })],
    ])("does not retry %s", async (_label, error) => {
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield* []
            throw error
        })
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(false)).run("Do not retry this", () => {})

        assert.equal(result.status, "failed")
        assert.equal(result.retryable, false)
        assert.equal(createMessage.mock.calls.length, 1)
    })

    it("finishes a pending retry wait through a reminder on the unchanged prompt and tools", async () => {
        const createMessage = vi.fn()
        createMessage.mockImplementationOnce(async function* () {
            yield* []
            throw new Error('{"code":"stream_initialization_failed","message":"Temporary provider failure"}')
        })
        createMessage.mockImplementationOnce(async function* (_systemPrompt: string, conversation: unknown[]) {
            const reminder = conversation.at(-1) as { role: string; content: Array<{ type: string; text?: string }> }
            assert.equal(reminder.role, "user")
            assert.match(reminder.content[0]?.text || "", /user requested/i)
            yield {
                type: "tool_calls",
                function_id: "toolu_retry_finish_complete",
                tool_index: 0,
                tool_call: {
                    function: {
                        name: DlineDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: "finished after retry interruption" }),
                    },
                },
            }
        })
        vi.spyOn(systemPromptFacade, "getSystemPrompt").mockResolvedValue({
            systemPrompt: "system prompt",
            tools: [
                { type: "function", function: { name: DlineDefaultTool.LIST_FILES, description: "List files" } },
                { type: "function", function: { name: DlineDefaultTool.ATTEMPT, description: "Complete" } },
            ] as never,
            profile: PromptProfile.Standard,
            warnings: [],
        })
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const runner = new SubagentRunner(createTaskConfig(true))
        const runPromise = runner.run("Finish the provider retry", () => {})
        await vi.waitFor(() => assert.equal(createMessage.mock.calls.length, 1))
        assert.equal(await runner.requestFinish("user"), true)
        const result = await runPromise

        assert.equal(result.status, "completed", result.error)
        assert.equal(result.result, "finished after retry interruption")
        assert.equal(createMessage.mock.calls.length, 2)
        assertFinishTurnReusesRequestShape(createMessage, [DlineDefaultTool.LIST_FILES, DlineDefaultTool.ATTEMPT])
    })

    it("fails context window errors", async () => {
        const createMessage = vi.fn()
        createMessage.mockImplementationOnce(async function* () {
            yield* []
            const e = new Error("context length exceeded") as Error & { status: number }
            e.status = 400
            throw e
        })
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()
        const runner = new SubagentRunner(createTaskConfig(false))
        const result = await runner.run("Huge prompt", () => {})
        assert.equal(result.status, "failed")
        assert.equal(createMessage.mock.calls.length, 1)
        assert.match(result.error || "", /context length exceeded/i)
    })
})
