import { strict as assert } from "node:assert"
import { describe, expect, it, vi } from "vitest"

vi.mock("@/config", () => import("./SubagentRunner.config.fixture"))

import * as coreApi from "@core/api"
import * as skills from "@core/context/instructions/user-instructions/skills"
import type { TaskConfig } from "@core/task/tools/types/TaskConfig"
import { DlineDefaultTool } from "@/shared/tools"
import { renderContextBudgetSection } from "../SubagentContextBudget"
import { SubagentRunner } from "../SubagentRunner"
import {
    createTaskConfig,
    initializeHostProvider,
    stubApiHandler,
    stubSystemPrompt,
    type TestConversationMessage,
    useSubagentRunnerTestLifecycle,
} from "./SubagentRunner.fixtures"

type SubagentRunnerTestAccess = { shouldCompactBeforeNextRequest: (...args: unknown[]) => boolean }

function createContextApi(contextWindow: number): ReturnType<typeof coreApi.buildApiHandler> {
    return {
        getModel: () => ({
            id: "gpt-5.4-mini",
            info: {
                capabilities: {
                    contextWindow,
                    supportsImages: false,
                    supportsPromptCache: true,
                },
            },
        }),
    } as unknown as ReturnType<typeof coreApi.buildApiHandler>
}

describe("SubagentRunner context and usage", () => {
    useSubagentRunnerTestLifecycle()

    it("passes prior request token totals into the next-turn compaction check", async () => {
        const createMessage = vi.fn()
        createMessage.mockImplementationOnce(async function* () {
            yield {
                type: "usage",
                inputTokens: 11,
                outputTokens: 7,
                cacheWriteTokens: 3,
                cacheReadTokens: 2,
            }
            yield {
                type: "tool_calls",
                function_id: "toolu_subagent_previous_tokens_1",
                tool_call: {
                    function: {
                        name: DlineDefaultTool.LIST_FILES,
                        arguments: JSON.stringify({ path: ".", recursive: false }),
                    },
                },
            }
        })
        createMessage.mockImplementationOnce(async function* () {
            yield {
                type: "tool_calls",
                function_id: "toolu_subagent_previous_tokens_complete_1",
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
        const scs = vi
            .spyOn(runner as unknown as SubagentRunnerTestAccess, "shouldCompactBeforeNextRequest")
            .mockImplementation((...args: unknown[]) => {
                assert.equal(args[0], 23)
                return false
            })
        const result = await runner.run("List files", () => {})
        assert.equal(result.status, "completed")
        assert.equal(result.result, "done")
        assert.equal(createMessage.mock.calls.length, 2)
        assert.equal(scs.mock.calls.length, 1)
    })

    it("measures the trigger against the absolute cap with the shared 2K trigger tolerance", () => {
        stubApiHandler(vi.fn(), 1_000_000)
        const runner = new SubagentRunner(
            createTaskConfig(true, {
                useAutoCondense: true,
                autoCondenseTriggerPercent: 60,
                autoCondenseMinReserveTokens: 5_000,
                autoCondenseMaxReserveTokens: 30_000,
                autoCondenseMaxContextTokens: 500_000,
            }),
        )
        const probe = runner as unknown as {
            shouldCompactBeforeNextRequest: (
                requestTotalTokens: number,
                api: ReturnType<typeof coreApi.buildApiHandler>,
                modelId: string,
            ) => boolean
        }
        const api = createContextApi(1_000_000)

        // W = 500K, reserve = 40% clamped to 30K: T = 500K - 30K - 5.5K = 464.5K.
        assert.equal(probe.shouldCompactBeforeNextRequest(464_499, api, "gpt-5.4-mini"), false)
        assert.equal(probe.shouldCompactBeforeNextRequest(464_500, api, "gpt-5.4-mini"), true)
    })

    it("uses the reserve pair when the context window equals the absolute cap", () => {
        stubApiHandler(vi.fn(), 272_000)
        const runner = new SubagentRunner(
            createTaskConfig(true, {
                useAutoCondense: true,
                autoCondenseTriggerPercent: 97,
                autoCondenseMinReserveTokens: 20_000,
                autoCondenseMaxReserveTokens: 30_000,
                autoCondenseMaxContextTokens: 272_000,
            }),
        )
        const probe = runner as unknown as {
            shouldCompactBeforeNextRequest: (
                requestTotalTokens: number,
                api: ReturnType<typeof coreApi.buildApiHandler>,
                modelId: string,
            ) => boolean
        }
        const api = createContextApi(272_000)

        assert.equal(probe.shouldCompactBeforeNextRequest(246_499, api, "gpt-5.4-mini"), false)
        assert.equal(probe.shouldCompactBeforeNextRequest(246_500, api, "gpt-5.4-mini"), true)
    })

    it("retains standard truncation pressure when auto-compaction is disabled", () => {
        stubApiHandler(vi.fn(), 1_000_000)
        const runner = new SubagentRunner(createTaskConfig(true, { useAutoCondense: false }))
        const probe = runner as unknown as {
            shouldCompactBeforeNextRequest: (
                requestTotalTokens: number,
                api: ReturnType<typeof coreApi.buildApiHandler>,
                modelId: string,
            ) => boolean
        }
        const api = createContextApi(1_000_000)

        assert.equal(probe.shouldCompactBeforeNextRequest(959_999, api, "gpt-5.4-mini"), false)
        assert.equal(probe.shouldCompactBeforeNextRequest(960_000, api, "gpt-5.4-mini"), true)
    })

    // BUGFIX-112: the Anthropic endpoint re-emits cumulative snapshots, so summing raw
    // chunks doubled subagent input tokens. Running totals must follow the resolved delta.
    it.each([
        [
            "cumulative snapshots",
            [
                { type: "usage", usageMode: "snapshot", inputTokens: 10, outputTokens: 0 },
                { type: "usage", usageMode: "snapshot", inputTokens: 10, outputTokens: 2 },
            ],
        ],
        [
            "explicit deltas",
            [
                { type: "usage", usageMode: "delta", inputTokens: 10, outputTokens: 1 },
                { type: "usage", usageMode: "delta", inputTokens: 0, outputTokens: 1 },
            ],
        ],
    ])("counts each provider token once when usage arrives as %s", async (_label, usageChunks) => {
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield* usageChunks
            yield {
                type: "tool_calls",
                function_id: "usage-once-complete",
                tool_call: { function: { name: DlineDefaultTool.ATTEMPT, arguments: JSON.stringify({ result: "done" }) } },
            }
        })
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(false)).run("Count usage once", () => {})

        assert.equal(result.status, "completed", result.error)
        assert.equal(result.stats.inputTokens, 10)
        assert.equal(result.stats.outputTokens, 2)
    })

    // BUGFIX-257 D6: the runner must not keep its own delta arithmetic. A Provider may
    // report an estimate and then replace it with the send's final total; summing the
    // deltas keeps the estimate while the send really consumed the replacement.
    it("reports the send's final usage total instead of accumulating an earlier estimate", async () => {
        const createMessage = vi.fn().mockImplementation(async function* () {
            yield { type: "usage", usageMode: "snapshot", inputTokens: 1_100, outputTokens: 0 }
            yield { type: "usage", usageMode: "delta", inputTokens: 0, outputTokens: 40 }
            yield { type: "usage", usageMode: "delta", inputTokens: 0, outputTokens: 60 }
            // The send's authoritative total: an estimate that came before the deltas is replaced.
            yield { type: "usage", usageMode: "snapshot", inputTokens: 900, outputTokens: 100 }
            yield {
                type: "tool_calls",
                function_id: "usage-final-total",
                tool_call: { function: { name: DlineDefaultTool.ATTEMPT, arguments: JSON.stringify({ result: "done" }) } },
            }
        })
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(false)).run("Count the final total", () => {})

        assert.equal(result.status, "completed", result.error)
        // ApiUsageAccumulator.getUsage() resolves this stream to 900/100. Accumulating the
        // non-negative deltas instead keeps the first estimate and reports 1100/100.
        assert.equal(result.stats.inputTokens, 900)
        assert.equal(result.stats.outputTokens, 100)
    })

    it("keeps provider context append-only across rounds and preserves thinking", async () => {
        const requests: TestConversationMessage[][] = []
        const createMessage = vi.fn()
        createMessage.mockImplementationOnce(async function* (_systemPrompt: string, messages: TestConversationMessage[]) {
            requests.push(structuredClone(messages))
            yield { type: "usage", inputTokens: 100, outputTokens: 10, cacheReadTokens: 0 }
            yield { type: "reasoning", reasoning: "Inspecting the first round" }
            yield { type: "reasoning", reasoning: "", signature: "thinking-signature" }
            yield {
                type: "tool_calls",
                function_id: "append-only-read-1",
                tool_call: {
                    function: { name: DlineDefaultTool.LIST_FILES, arguments: JSON.stringify({ path: ".", recursive: false }) },
                },
            }
        })
        createMessage.mockImplementationOnce(async function* (_systemPrompt: string, messages: TestConversationMessage[]) {
            requests.push(structuredClone(messages))
            expect(requests[1][0]).toEqual(requests[0][0])
            expect(JSON.stringify(requests[1][1])).toContain("Inspecting the first round")
            expect(JSON.stringify(requests[1][2])).toContain("# Context Window Usage")
            yield { type: "usage", inputTokens: 200, outputTokens: 20, cacheReadTokens: 0 }
            yield {
                type: "reasoning",
                reasoning: "[Redacted thinking block]",
                redacted_data: "opaque-round-two-thinking",
                redacted_phase: "final",
            }
            yield {
                type: "tool_calls",
                function_id: "append-only-read-2",
                tool_call: {
                    function: { name: DlineDefaultTool.LIST_FILES, arguments: JSON.stringify({ path: ".", recursive: false }) },
                },
            }
        })
        createMessage.mockImplementationOnce(async function* (_systemPrompt: string, messages: TestConversationMessage[]) {
            requests.push(structuredClone(messages))
            expect(requests[2].slice(0, requests[1].length)).toEqual(requests[1])
            expect(JSON.stringify(requests[2][1])).toContain("thinking-signature")
            expect(JSON.stringify(requests[2][3])).toContain("opaque-round-two-thinking")
            yield {
                type: "tool_calls",
                function_id: "append-only-complete",
                tool_call: { function: { name: DlineDefaultTool.ATTEMPT, arguments: JSON.stringify({ result: "done" }) } },
            }
        })
        stubSystemPrompt(true)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(true)).run("Inspect append-only context", () => {})

        assert.equal(result.status, "completed", result.error)
        assert.equal(result.result, "done")
        assert.equal(requests.length, 3)
    })

    it("freezes one provider-visible context across transport retries", async () => {
        let shareTokens = 8_000
        let budget: NonNullable<TaskConfig["contextBudget"]>
        budget = {
            snapshot: () => ({
                contextWindowTokens: 200_000,
                occupiedTokens: 10_000,
                stagedTokens: 0,
                remainingTokens: 190_000,
                roundBudgetTokens: shareTokens,
                roundStagedTokens: 0,
                activeConsumers: 1,
                shareTokens,
                mustYield: false,
            }),
            shareBytes: (capBytes) => Math.min(capBytes, shareTokens * 4),
            child: () => budget,
            end: vi.fn(),
        }
        let frozenRequest: TestConversationMessage[] | undefined
        const createMessage = vi.fn()
        createMessage.mockImplementationOnce(async function* (_systemPrompt: string, messages: TestConversationMessage[]) {
            frozenRequest = structuredClone(messages)
            shareTokens = 1_000
            yield* []
            throw Object.assign(new Error("temporary failure"), { status: 408 })
        })
        createMessage.mockImplementationOnce(async function* (_systemPrompt: string, messages: TestConversationMessage[]) {
            expect(messages).toEqual(frozenRequest)
            yield {
                type: "tool_calls",
                function_id: "frozen-context-complete",
                tool_call: { function: { name: DlineDefaultTool.ATTEMPT, arguments: JSON.stringify({ result: "done" }) } },
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
        const config = createTaskConfig(true)
        config.contextBudget = budget

        const result = await new SubagentRunner(config).run("Retry one frozen context", () => {})

        assert.equal(result.status, "completed", result.error)
        assert.equal(createMessage.mock.calls.length, 2)
    })

    it("injects and enforces the configured final output token budget", async () => {
        const longResult = "abcdefghij".repeat(100)
        const createMessage = vi.fn().mockImplementation(async function* (_systemPrompt: string, messages: unknown[]) {
            const initialUserMessage = messages[0] as { content: Array<{ type: string; text?: string }> }
            const initialText = initialUserMessage.content
                .filter((block) => block.type === "text")
                .map((block) => block.text ?? "")
                .join("\n")
            // Above MIN_SUBAGENT_OUTPUT_TOKENS so the configured value, not the
            // floor, is the effective budget under test. The figure appears once,
            // in the per-request Context Budget tail, never as a second static limit.
            assert.ok(initialText.includes(renderContextBudgetSection({ finalResultTokens: 1_024, delivery: "inline" })))
            assert.equal(initialText.match(/1,024 tokens/g)?.length, 1)
            yield {
                type: "tool_calls",
                function_id: "budget-complete",
                tool_call: {
                    function: {
                        name: DlineDefaultTool.ATTEMPT,
                        arguments: JSON.stringify({ result: longResult }),
                    },
                },
            }
        })
        stubSystemPrompt(false)
        vi.spyOn(skills, "discoverSkills").mockResolvedValue([])
        vi.spyOn(skills, "getAvailableSkills").mockReturnValue([])
        stubApiHandler(createMessage)
        initializeHostProvider()

        const result = await new SubagentRunner(createTaskConfig(false), "budget-agent", {
            name: "budget-agent",
            description: "Budget test agent",
            tools: [DlineDefaultTool.ATTEMPT],
            maxOutputTokens: 1_024,
            systemPrompt: "",
        }).run("Return a detailed report", () => {})

        assert.equal(result.status, "completed", result.error)
        assert.ok(result.result)
        assert.ok(Buffer.byteLength(result.result ?? "", "utf8") <= 1_024 * 4)
    })

    it("includes workspace metadata only in the initial user message", async () => {
        const createMessage = vi.fn()
        createMessage.mockImplementationOnce(async function* (_s: string, c: unknown[]) {
            const iu = c[0] as { role: string; content: Array<{ type: string; text?: string }> }
            assert.equal(iu.role, "user")
            assert.match(
                iu.content
                    .filter((block) => block.type === "text")
                    .map((block) => block.text || "")
                    .join("\n"),
                /# Workspace Configuration/,
            )
            yield {
                type: "tool_calls",
                function_id: "tww1",
                tool_call: {
                    function: {
                        name: DlineDefaultTool.LIST_FILES,
                        arguments: JSON.stringify({ path: ".", recursive: false }),
                    },
                },
            }
        })
        createMessage.mockImplementationOnce(async function* (_s: string, c: unknown[]) {
            const fu = c[2] as TestConversationMessage
            assert.equal(fu.role, "user")
            assert.equal(
                fu.content
                    .filter((block) => block.type === "text")
                    .map((block) => block.text || "")
                    .join("\n")
                    .includes("# Workspace Configuration"),
                false,
            )
            yield {
                type: "tool_calls",
                function_id: "twwc1",
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
        const result = await runner.run("List files", () => {})
        assert.equal(result.status, "completed")
        assert.equal(result.result, "done")
        assert.equal(createMessage.mock.calls.length, 2)
    })
})
