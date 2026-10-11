import { ContextBudgetLedger } from "@core/context/context-management/context-budget-ledger"
import { MAX_TOOL_RESULT_TEXT_BYTES } from "@shared/content-limits"
import { describe, expect, it, vi } from "vitest"
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
        expect(text.includes("[OUTPUT TRUNCATED:")).toBe(true)
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

describe("DefaultProductionToolExecutionService context budget", () => {
    function replayedText(content: string): string {
        const [block] = replayDurableToolResult(content) ?? []
        return String((block as { content?: unknown } | undefined)?.content ?? "")
    }

    function budgetedService(
        occupied: number,
        contextWindow: number,
        results: Promise<string>[],
        options: { readonly toolName?: string; readonly config?: Partial<TaskConfig> } = {},
    ) {
        const ledger = new ContextBudgetLedger({
            contextWindow: () => contextWindow,
            occupiedTokens: () => occupied,
            tokenPerByte: () => 0.25,
        })
        const leases: unknown[] = []
        let call = 0
        const service = new DefaultProductionToolExecutionService({
            taskId: "task-1",
            config: { create: () => toolConfig(options.config) },
            runtime: {
                coordinator: { getHandler: () => undefined },
                execute: async (config: TaskConfig) => {
                    leases.push(config.contextBudget)
                    return results[call++]
                },
                restoreSubagentRetry: async () => false,
            } as unknown as ProductionToolHandlerRuntime,
            contextBudget: ledger,
        })
        const run = (dlineTid: string) =>
            service.execute({
                command: { commandId: dlineTid, turnId: "turn-1", dlineTid, invocationRef: dlineTid },
                invocation: {
                    ...INVOCATION,
                    toolName: options.toolName ?? INVOCATION.toolName,
                    dlineTid,
                    functionId: `function-${dlineTid}`,
                },
                surface: createDeniedSurface("detached_domain"),
            })
        return { ledger, leases, run }
    }

    function deferred() {
        let resolve!: (value: string) => void
        const promise = new Promise<string>((done) => {
            resolve = done
        })
        return { promise, resolve }
    }

    it("gives parallel calls only the round's budget and counts each result as it is produced", async () => {
        // 100K window, 87.5K occupied: the round may take 80% of the 12.5K left, 10K tokens (40 KB).
        const first = deferred()
        const second = deferred()
        const { ledger, leases, run } = budgetedService(87_500, 100_000, [first.promise, second.promise])

        const firstRun = run("tid-a")
        const secondRun = run("tid-b")
        await vi.waitFor(() => expect(leases).toHaveLength(2))
        expect(leases.every(Boolean)).toBe(true)
        expect(ledger.snapshot().activeConsumers).toBe(2)

        first.resolve("a".repeat(100_000))
        const firstText = replayedText((await firstRun).content)
        const stagedAfterFirst = ledger.snapshot().stagedTokens
        second.resolve("b".repeat(100_000))
        const secondText = replayedText((await secondRun).content)

        expect(Buffer.byteLength(firstText) <= 20 * 1024).toBe(true)
        expect(stagedAfterFirst).toBe(Math.ceil(Buffer.byteLength(firstText) * 0.25))
        expect(firstText.includes("near its budget")).toBe(true)
        expect(secondText.includes("[OUTPUT TRUNCATED:")).toBe(true)
        expect(ledger.snapshot().stagedTokens <= 10_000).toBe(true)
        expect(ledger.snapshot().activeConsumers).toBe(0)
    })

    it("leaves a result whole while the window has room", async () => {
        const { ledger, run } = budgetedService(0, 1_000_000, [Promise.resolve("c".repeat(10_000))])

        const text = replayedText((await run("tid-c")).content)

        expect(text).toBe(`[summarize_task] Result:\n${"c".repeat(10_000)}`)
        expect(ledger.snapshot().stagedTokens).toBe(Math.ceil(Buffer.byteLength(text) * 0.25))
    })

    it("holds a subagent result for after compaction once less than the yield margin is left", async () => {
        const publish = vi.fn(async () => undefined)
        // 100K window, 98K occupied: 2K left, below the 3K yield margin.
        const { ledger, run } = budgetedService(98_000, 100_000, [Promise.resolve("subagent final result")], {
            toolName: "use_subagents",
            config: { backgroundResults: { publish } } as unknown as Partial<TaskConfig>,
        })

        const text = replayedText((await run("tid-d")).content)

        expect(text.includes("[DEFERRED]")).toBe(true)
        expect(text.includes("subagent final result")).toBe(false)
        expect(publish).toHaveBeenCalledOnce()
        const [delivery] = publish.mock.calls[0] as unknown as [{ entryId: string; producerKind: string; text: string }]
        expect(delivery.entryId).toBe("background:subagent-deferred:tid-d:attempt:1")
        expect(delivery.producerKind).toBe("subagent_batch")
        expect(delivery.text.startsWith("# Background Results\n## Deferred Subagent Results\n")).toBe(true)
        expect(delivery.text.includes("(function_id function-tid-d) Result:")).toBe(true)
        expect(delivery.text.endsWith("subagent final result")).toBe(true)
        // Only the notice entered the conversation, so only the notice is staged.
        expect(ledger.snapshot().stagedTokens).toBe(Math.ceil(Buffer.byteLength(text) * 0.25))
    })

    it("returns a subagent result directly while the conversation has room", async () => {
        const publish = vi.fn(async () => undefined)
        const { run } = budgetedService(0, 1_000_000, [Promise.resolve("subagent final result")], {
            toolName: "use_subagent",
            config: { backgroundResults: { publish } } as unknown as Partial<TaskConfig>,
        })

        const text = replayedText((await run("tid-e")).content)

        expect(text.endsWith("subagent final result")).toBe(true)
        expect(publish).not.toHaveBeenCalled()
    })

    it("never holds the result of a tool other than a subagent", async () => {
        const publish = vi.fn(async () => undefined)
        const { run } = budgetedService(98_000, 100_000, [Promise.resolve("short")], {
            config: { backgroundResults: { publish } } as unknown as Partial<TaskConfig>,
        })

        const text = replayedText((await run("tid-f")).content)

        expect(text.includes("[DEFERRED]")).toBe(false)
        expect(publish).not.toHaveBeenCalled()
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
