import { strict as assert } from "node:assert"
import type { ToolUse } from "@core/assistant-message"
import { describe, expect, it, vi } from "vitest"
import { DefaultToolHandlerState } from "../../state/ToolHandlerState"
import type { TaskConfig } from "../../types/TaskConfig"
import { QnaRespondHandler } from "../QnaRespondHandler"

/**
 * Create a minimal TaskConfig for QnaRespondHandler tests.
 * @param overrides Optional config overrides for each scenario.
 * @returns TaskConfig with mocked callbacks and task state.
 */
function createConfig(overrides: Partial<TaskConfig> = {}): TaskConfig {
    const taskState = new DefaultToolHandlerState()

    return {
        taskId: "task-qna",
        ulid: "ulid-qna",
        cwd: "/workspace",
        mode: "act",
        taskState,
        interactions: {
            open: vi.fn(async () => ({
                actionId: "reply",
                draft: { text: "你可以干什么", images: [], files: [] },
            })),
        },
        callbacks: {
            say: vi.fn(async () => Date.now()),
            saveCheckpoint: vi.fn(async () => {}),
            sayAndCreateMissingParamError: vi.fn(async () => "missing response"),
        } as unknown as TaskConfig["callbacks"],
        ...overrides,
    } as unknown as TaskConfig
}

/**
 * Create a qna_respond tool block.
 * @returns ToolUse block with a response payload.
 */
function createBlock(): ToolUse {
    return {
        type: "tool_use",
        name: "qna_respond",
        dline_tid: "tid-qna",
        ts: 100,
        params: { response: "我是 Dline" },
        partial: false,
    } as unknown as ToolUse
}

describe("QnaRespondHandler", () => {
    it("clears the awaiting response flag when opening the interaction fails", async () => {
        const config = createConfig({
            interactions: {
                open: vi.fn(async () => {
                    throw new Error("interaction transport failed")
                }),
            } as unknown as TaskConfig["interactions"],
        })

        await expect(new QnaRespondHandler().execute(config, createBlock())).rejects.toThrow("interaction transport failed")
        expect(config.taskState.isAwaitingPlanResponse).toBe(false)
    })

    it("does not render duplicate user_feedback when response was already acked", async () => {
        const config = createConfig()
        config.taskState.ackedFeedback = {
            response: "messageResponse",
            text: "你可以干什么",
            images: [],
            files: [],
        }
        const handler = new QnaRespondHandler()

        const result = await handler.execute(config, createBlock())

        expect(config.callbacks.say).not.toHaveBeenCalledWith("user_feedback", "你可以干什么", [], [])
        assert.equal(config.taskState.ackedFeedback, undefined)
        assert.ok(typeof result === "string")
        assert.match(result, /<feedback>\n你可以干什么\n<\/feedback>/)
        assert.doesNotMatch(result, /<user_message>/)
    })

    it("keeps acked text feedback in the qna tool result", async () => {
        const config = createConfig()
        config.taskState.ackedFeedback = {
            response: "messageResponse",
            text: "你可以干什么",
            images: [],
            files: [],
        }
        const handler = new QnaRespondHandler()

        const result = await handler.execute(config, createBlock())

        assert.ok(typeof result === "string")
        assert.match(result, /<feedback>\n你可以干什么\n<\/feedback>/)
        assert.doesNotMatch(result, /<user_message>/)
    })

    it("consumes the one-shot Plan to Act switch state", async () => {
        const config = createConfig({
            mode: "plan",
            interactions: {
                open: vi.fn(async () => ({ actionId: "reply", draft: { text: "", images: [], files: [] } })),
            } as unknown as TaskConfig["interactions"],
        })
        config.taskState.didRespondToPlanAskBySwitchingMode = true

        const result = await new QnaRespondHandler().execute(config, createBlock())

        expect(config.taskState.didRespondToPlanAskBySwitchingMode).toBe(false)
        assert.ok(typeof result === "string")
        assert.match(result, /switched to ACT MODE/)
    })
})
