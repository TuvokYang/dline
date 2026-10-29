import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ContextBudgetLedger } from "@core/context/context-management/context-budget-ledger"
import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { MAX_TOOL_RESULT_TEXT_BYTES } from "@shared/content-limits"
import { WebToolsMode } from "@shared/proto/dline/provider/common"
import { DlineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import { replayDurableToolResult } from "../../../../DurableToolResult"
import type { ToolInvocationEnvelope } from "../../../../stores/payload/TaskPayloadEnvelopes"
import type { TaskConfig } from "../../../../tools/types/TaskConfig"
import { createDeniedSurface } from "../../ToolDomainSurface"
import {
    applyRepeatedCallGuard,
    DefaultProductionToolExecutionService,
    type ProductionToolConfigFactory,
} from "../DefaultProductionToolExecutionService"
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

function configFactory(extra: Partial<TaskConfig> = {}, cwd = process.cwd()): ProductionToolConfigFactory {
    return {
        create: () => toolConfig(extra),
        readAdmissionSnapshot: () => ({
            taskId: "task-1",
            cwd,
            workspaceRoots: [cwd],
            settings: DEFAULT_AUTO_APPROVAL_SETTINGS,
            blanket: {},
        }),
    }
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
        config: configFactory(),
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
            config: configFactory(),
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
                ...configFactory(),
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

    /** The row a manual approval drew for INVOCATION, which every terminal write of the call must reuse. */
    const approvalRow = { ts: 99, type: "ask", ask: "tool", interactionId: "approval:dline_tid_01" }

    it("fails closed before the handler when a workspace junction widens to an external target", async () => {
        const temporaryRoot = await fs.mkdtemp(path.join(os.tmpdir(), "dline-tool-boundary-"))
        try {
            const workspace = path.join(temporaryRoot, "workspace")
            const external = path.join(temporaryRoot, "external")
            const linked = path.join(workspace, "linked-outside")
            await fs.mkdir(workspace)
            await fs.mkdir(external)
            await fs.symlink(external, linked, process.platform === "win32" ? "junction" : "dir")
            const executeHandler = vi.fn(async () => "must not execute")
            const say = vi.fn(async () => 99)
            const service = new DefaultProductionToolExecutionService({
                taskId: "task-1",
                config: configFactory(
                    { callbacks: { say }, messageState: { clineMessages: [approvalRow] } } as unknown as Partial<TaskConfig>,
                    workspace,
                ),
                runtime: {
                    coordinator: { getHandler: () => undefined },
                    execute: executeHandler,
                    restoreSubagentRetry: async () => false,
                } as unknown as ProductionToolHandlerRuntime,
            })
            const invocation: ToolInvocationEnvelope = {
                ...INVOCATION,
                toolName: DlineDefaultTool.FILE_NEW,
                input: { path: path.relative(workspace, path.join(linked, "proof.txt")), content: "proof" },
            }

            const result = await service.execute({
                command: { commandId: "command-1", turnId: "turn-1", dlineTid: invocation.dlineTid, invocationRef: "ref-1" },
                invocation,
                surface: createDeniedSurface("detached_domain"),
            })

            expect(executeHandler).not.toHaveBeenCalled()
            expect(result).toMatchObject({ failed: true, failure: { stage: "authorization", code: "scope_widened" } })
            expect(JSON.stringify(replayDurableToolResult(result.content))).toContain("[scope_widened]")
            await expect(fs.stat(path.join(external, "proof.txt"))).rejects.toMatchObject({ code: "ENOENT" })
            // The approved row shows the refusal itself instead of staying an answered approval.
            expect(say).toHaveBeenCalledOnce()
            expect(say).toHaveBeenCalledWith(
                "error",
                expect.stringContaining("[scope_widened]"),
                undefined,
                undefined,
                false,
                approvalRow.ts,
            )
        } finally {
            await fs.rm(temporaryRoot, { recursive: true, force: true })
        }
    })

    it("ends a hosted Web Search call it cannot route on the call's own approval row", async () => {
        const say = vi.fn(async () => 99)
        const executeHandler = vi.fn(async () => "must not execute")
        const service = new DefaultProductionToolExecutionService({
            taskId: "task-1",
            config: configFactory({
                api: { getProviderId: () => "openai" },
                callbacks: { say },
                messageState: { clineMessages: [approvalRow] },
                webSearchRoutingPlan: { route: "hosted", mode: WebToolsMode.WEB_TOOLS_MODE_FORCE_REMOTE },
            } as unknown as Partial<TaskConfig>),
            runtime: {
                coordinator: { getHandler: () => undefined },
                execute: executeHandler,
                restoreSubagentRetry: async () => false,
            } as unknown as ProductionToolHandlerRuntime,
        })

        const result = await service.execute({
            command: { commandId: "command-1", turnId: "turn-1", dlineTid: INVOCATION.dlineTid, invocationRef: "ref-1" },
            invocation: {
                ...INVOCATION,
                toolName: DlineDefaultTool.WEB_SEARCH,
                input: { query: "dline" },
                isNativeToolCall: true,
            },
            surface: createDeniedSurface("detached_domain"),
        })

        expect(executeHandler).not.toHaveBeenCalled()
        expect(result).toMatchObject({ failed: true, failure: { stage: "routing", code: "hosted_fallback_unavailable" } })
        expect(say).toHaveBeenCalledOnce()
        expect(say).toHaveBeenCalledWith("tool", expect.stringContaining('"status":"failed"'), undefined, undefined, false, 99)
    })

    it("lets the local search that takes over a hosted call explain the fallback on the call's row", async () => {
        const say = vi.fn(async () => 99)
        let handedOver: TaskConfig | undefined
        const service = new DefaultProductionToolExecutionService({
            taskId: "task-1",
            config: configFactory({
                api: { getProviderId: () => "openai" },
                callbacks: { say },
                coordinator: { has: () => true },
                messageState: { clineMessages: [approvalRow] },
                webToolsEnabled: true,
                webSearchRoutingPlan: { route: "hosted", mode: WebToolsMode.WEB_TOOLS_MODE_AUTO, localFallbackAvailable: true },
            } as unknown as Partial<TaskConfig>),
            runtime: {
                coordinator: { getHandler: () => undefined },
                execute: async (config: TaskConfig) => {
                    handedOver = config
                    return "local results"
                },
                restoreSubagentRetry: async () => false,
            } as unknown as ProductionToolHandlerRuntime,
        })

        await service.execute({
            command: { commandId: "command-1", turnId: "turn-1", dlineTid: INVOCATION.dlineTid, invocationRef: "ref-1" },
            invocation: {
                ...INVOCATION,
                toolName: DlineDefaultTool.WEB_SEARCH,
                input: { query: "dline" },
                isNativeToolCall: true,
            },
            surface: createDeniedSurface("detached_domain"),
        })

        // No card of its own: the local search writes the call's row and carries the notice.
        expect(say).not.toHaveBeenCalled()
        expect(handedOver?.webSearchRoutingPlan?.route).toBe("local")
        expect(handedOver?.webSearchFallbackNotice).toContain("falling back to Dline local Web Search")
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
            config: configFactory(options.config),
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

    it("keeps the user's reply to a conversational call whole after the round's budget is spent", async () => {
        // 100K window, 125K occupied: the round has nothing left to share out.
        const reply = "<feedback>\nWORK_CONTEXT_AUTO_COMPACT_CONTINUE\n</feedback>"
        const { ledger, run } = budgetedService(125_000, 100_000, [Promise.resolve(reply)], { toolName: "qna_respond" })

        const text = replayedText((await run("tid-reply")).content)

        expect(text).toContain(reply)
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
