import { MAX_TOOL_RESULT_TEXT_BYTES } from "@shared/content-limits"
import { describe, expect, it } from "vitest"
import { replayDurableToolResult } from "../../../../DurableToolResult"
import type { ToolInvocationEnvelope } from "../../../../stores/payload/TaskPayloadEnvelopes"
import type { TaskConfig } from "../../../../tools/types/TaskConfig"
import { createDeniedSurface } from "../../ToolDomainSurface"
import { applyRepeatedCallGuard, DefaultProductionToolExecutionService } from "../DefaultProductionToolExecutionService"
import type { ProductionToolHandlerRuntime } from "../ProductionToolHandlerRuntime"

const REFUSAL = "Explicit-only tool 'summarize_task' was rejected: explicit_instruction_missing."

const INVOCATION: ToolInvocationEnvelope = {
    kind: "tool_invocation",
    toolName: "summarize_task",
    input: { context: "SECRET_SUMMARY" },
    functionId: "dline_function_01",
    dlineTid: "dline_tid_01",
    presentationId: 1,
    isNativeToolCall: false,
}

/** The task facts the handler service reads around every call. */
function toolConfig(extra: Partial<TaskConfig> = {}): TaskConfig {
    return {
        taskState: { consecutiveMistakeCount: 0, consecutiveIdenticalToolCount: 0, lastToolName: "", lastToolParams: "" },
        services: { stateManager: { getGlobalSettingsKey: () => 4 } },
        ...extra,
    } as unknown as TaskConfig
}

/** A handler runtime whose gate refuses every call, as the central explicit-only gate does. */
function refusingRuntime(): ProductionToolHandlerRuntime {
    return {
        coordinator: { getHandler: () => undefined },
        execute: async () => REFUSAL,
        restoreSubagentRetry: async () => false,
    } as unknown as ProductionToolHandlerRuntime
}

async function execute(invocation: ToolInvocationEnvelope): Promise<string> {
    const service = new DefaultProductionToolExecutionService({
        taskId: "task-1",
        config: { create: () => toolConfig() },
        runtime: refusingRuntime(),
    })
    const result = await service.execute({
        command: { commandId: "command-1", turnId: "turn-1", dlineTid: invocation.dlineTid, invocationRef: "ref-1" },
        invocation,
        surface: createDeniedSurface("detached_domain"),
    })
    return result.content
}

describe("DefaultProductionToolExecutionService", () => {
    // The provider boundary kept this call in history as the markup the model
    // wrote, so the refusal must reach the model as prose rather than as a result
    // paired with a call id the provider never issued.
    it("persists the result of a call that was never recorded so it replays as prose", async () => {
        const content = await execute({ ...INVOCATION, resultReplay: "text" })

        expect(replayDurableToolResult(content)).toEqual([{ type: "text", text: `[summarize_task] Result:\n${REFUSAL}` }])
    })

    it("persists the result of a recorded call as a result paired with that call", async () => {
        const content = await execute(INVOCATION)

        // A string result opens with the call it answers, as main sends it.
        expect(replayDurableToolResult(content)).toEqual([
            {
                type: "tool_result",
                function_id: "dline_function_01",
                dline_tid: "dline_tid_01",
                content: `[summarize_task] Result:\n${REFUSAL}`,
            },
        ])
    })

    // A conversational reply is the user's text returned as the tool's result,
    // so nothing upstream bounds it; an unbounded reply rides along in every
    // later request and alone can push the conversation past its window.
    it("bounds an oversized handler result to the canonical tool result limit", async () => {
        const reply = `<feedback>\n${"x".repeat(MAX_TOOL_RESULT_TEXT_BYTES * 2)}\n</feedback>`
        const service = new DefaultProductionToolExecutionService({
            taskId: "task-1",
            config: { create: () => toolConfig() },
            runtime: {
                coordinator: { getHandler: () => undefined },
                execute: async () => reply,
                restoreSubagentRetry: async () => false,
            } as unknown as ProductionToolHandlerRuntime,
        })

        const { content } = await service.execute({
            command: { commandId: "command-1", turnId: "turn-1", dlineTid: INVOCATION.dlineTid, invocationRef: "ref-1" },
            invocation: { ...INVOCATION, toolName: "qna_respond" },
            surface: createDeniedSurface("detached_domain"),
        })

        const [result] = replayDurableToolResult(content) ?? []
        const text = result?.type === "tool_result" && typeof result.content === "string" ? result.content : ""
        expect(text.startsWith("[qna_respond] Result:\n<feedback>\n")).toBe(true)
        expect(text).toContain("[FILE TRUNCATED:")
        expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(MAX_TOOL_RESULT_TEXT_BYTES)
    })

    it("reuses the manual approval anchor timestamp for the handler lifecycle row", async () => {
        let receivedPresentationTs: number | undefined
        const runtime = {
            coordinator: { getHandler: () => undefined },
            execute: async (_config: TaskConfig, block: { ts?: number }) => {
                receivedPresentationTs = block.ts
                return REFUSAL
            },
            restoreSubagentRetry: async () => false,
        } as unknown as ProductionToolHandlerRuntime
        const service = new DefaultProductionToolExecutionService({
            taskId: "task-1",
            config: {
                create: () =>
                    toolConfig({
                        messageState: {
                            clineMessages: [
                                {
                                    ts: 99,
                                    type: "ask",
                                    ask: "tool",
                                    interactionId: "approval:dline_tid_01",
                                },
                            ],
                        },
                    } as unknown as Partial<TaskConfig>),
            },
            runtime,
        })

        await service.execute({
            command: { commandId: "command-1", turnId: "turn-1", dlineTid: INVOCATION.dlineTid, invocationRef: "ref-1" },
            invocation: INVOCATION,
            surface: createDeniedSurface("detached_domain"),
        })

        expect(receivedPresentationTs).toBe(99)
    })
})

describe("applyRepeatedCallGuard", () => {
    const read = { name: "read_file", params: { path: "README.md" } } as Parameters<typeof applyRepeatedCallGuard>[1]

    it("latches the mistake limit on the fifth identical call after the handler reset it", () => {
        const config = toolConfig()
        const results: unknown[] = []
        for (let call = 1; call <= 5; call++) {
            config.taskState.consecutiveMistakeCount = 0
            results.push(applyRepeatedCallGuard(config, read, "contents"))
            expect(config.taskState.consecutiveMistakeCount).toBe(call === 5 ? 4 : 0)
        }

        expect(results[2]).toContain("3 times consecutively with identical arguments")
        expect(results[3]).toBe("contents")
    })

    it("restarts the run when the arguments change", () => {
        const config = toolConfig()
        for (let call = 1; call <= 4; call++) applyRepeatedCallGuard(config, read, "contents")
        applyRepeatedCallGuard(config, { ...read, params: { path: "other.md" } }, "contents")

        expect(config.taskState.consecutiveMistakeCount).toBe(0)
        expect(config.taskState.consecutiveIdenticalToolCount).toBe(1)
    })

    it("appends the soft warning as a text block to structured results", () => {
        const config = toolConfig()
        let response: unknown
        for (let call = 1; call <= 3; call++) {
            response = applyRepeatedCallGuard(config, read, [{ type: "text", text: "contents" }])
        }

        expect(response).toEqual([
            { type: "text", text: "contents" },
            { type: "text", text: expect.stringContaining("identical arguments") },
        ])
    })
})
