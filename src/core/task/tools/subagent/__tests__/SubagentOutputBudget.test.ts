import { strict as assert } from "node:assert"
import { describe, it } from "vitest"
import { DefaultToolHandlerState } from "../../state/ToolHandlerState"
import type { TaskConfig } from "../../types/TaskConfig"
import {
    buildSubagentOutputBudgetPrompt,
    estimateSubagentOutputTokens,
    MIN_SUBAGENT_OUTPUT_TOKENS,
    resolveSubagentOutputBudget,
    truncateTextToSubagentOutputBudget,
} from "../SubagentOutputBudget"

function createConfig(contextWindow: number, contextTokens: number): Pick<TaskConfig, "api" | "messageState" | "taskState"> {
    return {
        api: {
            getModel: () => ({
                id: "main-model",
                info: { capabilities: { contextWindow } },
            }),
        } as TaskConfig["api"],
        messageState: {
            clineMessages:
                contextTokens > 0
                    ? [
                          {
                              type: "say",
                              say: "api_req_started",
                              text: JSON.stringify({ contextTokens }),
                              ts: 1,
                          },
                      ]
                    : [],
        } as TaskConfig["messageState"],
        taskState: new DefaultToolHandlerState(),
    }
}

describe("SubagentOutputBudget", () => {
    it("uses five percent of the main task remaining context by default", () => {
        const budget = resolveSubagentOutputBudget(createConfig(200_000, 100_000))

        assert.equal(budget.mainTaskRemainingTokens, 100_000)
        assert.equal(budget.outputTokens, 5_000)
        assert.equal(budget.source, "default_ratio")
    })

    it("supports an explicit ratio and caps it at the main task remaining context", () => {
        const budget = resolveSubagentOutputBudget(createConfig(100_000, 90_000), 0.5)

        assert.equal(budget.requestedOutputTokens, 5_000)
        assert.equal(budget.outputTokens, 5_000)
        assert.equal(budget.source, "configured_ratio")
    })

    // A nearly full main task used to drive the budget to zero, which silently
    // erased the subagent result instead of shortening it.
    it("never drops the budget below the floor when the remaining window is tiny", () => {
        const budget = resolveSubagentOutputBudget(createConfig(10_000, 9_990))

        assert.equal(budget.mainTaskRemainingTokens, 10)
        assert.equal(budget.requestedOutputTokens, 1)
        assert.equal(budget.outputTokens, MIN_SUBAGENT_OUTPUT_TOKENS)
    })

    it("never drops the budget to zero when the main task window is exhausted", () => {
        const budget = resolveSubagentOutputBudget(createConfig(10_000, 10_000))

        assert.equal(budget.mainTaskRemainingTokens, 0)
        assert.equal(budget.requestedOutputTokens, 0)
        assert.equal(budget.outputTokens, MIN_SUBAGENT_OUTPUT_TOKENS)
    })

    it("supports an explicit absolute token count and caps it at remaining context", () => {
        const budget = resolveSubagentOutputBudget(createConfig(100_000, 90_000), 10_240)

        assert.equal(budget.requestedOutputTokens, 10_240)
        assert.equal(budget.outputTokens, 10_000)
        assert.equal(budget.source, "configured_absolute")
    })

    it("falls back to the default ratio for an invalid runtime configuration", () => {
        const budget = resolveSubagentOutputBudget(createConfig(1_000_000, 800_000), 1.5)

        assert.equal(budget.outputTokens, 10_000)
        assert.equal(budget.source, "default_ratio")
    })

    it("states the budget rule in the task prompt but leaves the figure to the per-request section", () => {
        const prompt = buildSubagentOutputBudgetPrompt("<task>inspect</task>")

        assert.match(prompt, /attempt_completion result is returned to the main task/)
        assert.match(prompt, /Context Budget section at the end of the latest message/)
        assert.doesNotMatch(prompt, /\d[\d,]* tokens/)
    })

    it("truncates final output without exceeding the estimated token budget", () => {
        const source = "abcdefghij".repeat(100)
        const result = truncateTextToSubagentOutputBudget(source, 20)

        assert.ok(result.length < source.length)
        assert.ok(estimateSubagentOutputTokens(result) <= 20)
    })

    it("marks truncated output so the main task can tell it is incomplete", () => {
        const source = "abcdefghij".repeat(500)
        const result = truncateTextToSubagentOutputBudget(source, 200)

        assert.match(result, /truncated to 200 tokens/)
        assert.ok(estimateSubagentOutputTokens(result) <= 200)
    })
})
