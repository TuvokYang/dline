import type { ToolUse } from "@core/assistant-message"
import { ControllerTaskCallbacksOwner } from "@core/controller/task/host/ControllerTaskCallbacksOwner"
import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import type { UiMessage } from "@shared/ExtensionMessage"
import { DlineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import { readDurableToolResult, replayDurableToolResult } from "../../../../DurableToolResult"
import { MessageStateHandler } from "../../../../message-state"
import { InMemoryConversationJournal, InMemoryTaskPayloadStore } from "../../../../stores/InMemoryRuntimeStores"
import { decodeTaskPayload, encodeTaskPayload } from "../../../../stores/payload/TaskPayloadCodec"
import type { ToolInvocationEnvelope, ToolResultEnvelope } from "../../../../stores/payload/TaskPayloadEnvelopes"
import { ToolExecutorCoordinator } from "../../../../tools/ToolExecutorCoordinator"
import type { TaskConfig } from "../../../../tools/types/TaskConfig"
import { ProviderJournalMessageMaterializer } from "../../../provider/service/ProviderJournalMessageMaterializer"
import { createProductionToolAdapter } from "../../ProductionToolAdapter"
import type { ToolAdmissionSnapshot } from "../../ToolAdmissionRegistry"
import { createDeniedSurface } from "../../ToolDomainSurface"
import { TurnToolScheduler } from "../../TurnToolScheduler"
import { DefaultProductionToolExecutionService, materializeToolInvocation } from "../DefaultProductionToolExecutionService"
import type { ProductionToolHandlerRuntime } from "../ProductionToolHandlerRuntime"

const INVOCATION: ToolInvocationEnvelope = {
    kind: "tool_invocation",
    toolName: DlineDefaultTool.BASH,
    input: { command: "echo admission-probe", requires_approval: "not-a-boolean" },
    functionId: "function-admission",
    dlineTid: "tid-admission",
    presentationId: 1,
    isNativeToolCall: true,
}

/** The admission and service are real; the final effect never starts a process or network request. */
function subject(overrides: Partial<TaskConfig> = {}) {
    const effect = vi.fn(async (_config: TaskConfig, block: ToolUse) => `handled:${block.params.command ?? block.params.url}`)
    const coordinator = new ToolExecutorCoordinator()
    for (const name of [DlineDefaultTool.BASH, DlineDefaultTool.WEB_FETCH]) {
        coordinator.register({ name, getDescription: (block) => `[${block.name}]`, execute: effect })
    }
    const snapshot: ToolAdmissionSnapshot = {
        taskId: "task-admission",
        cwd: process.cwd(),
        workspaceRoots: [process.cwd()],
        settings: {
            ...DEFAULT_AUTO_APPROVAL_SETTINGS,
            actions: { ...DEFAULT_AUTO_APPROVAL_SETTINGS.actions, useWeb: false, executeSafeCommands: false },
        },
        blanket: {},
    }
    const say = vi.fn(async () => 99)
    const open = vi.fn()
    const settleAwayFeedback = vi.fn(async () => undefined)
    const config = {
        taskState: { consecutiveMistakeCount: 0 },
        services: { stateManager: { getGlobalSettingsKey: () => 4 } },
        callbacks: { say },
        interactions: { open },
        messageState: { clineMessages: [{ ts: 99, interactionId: "approval:tid-admission" }] },
        ...overrides,
    } as unknown as TaskConfig
    const service = new DefaultProductionToolExecutionService({
        taskId: snapshot.taskId,
        config: {
            readAdmissionSnapshot: () => snapshot,
            settleAwayFeedback,
            create: () => config,
        },
        runtime: {
            coordinator,
            execute: effect,
            restoreSubagentRetry: async () => false,
        } as unknown as ProductionToolHandlerRuntime,
    })
    const execute = (invocation: ToolInvocationEnvelope) =>
        service.execute({
            command: {
                commandId: "command-admission",
                turnId: "turn-admission",
                dlineTid: invocation.dlineTid,
                invocationRef: "ref",
            },
            invocation,
            surface: createDeniedSurface("detached_domain"),
        })
    return { coordinator, snapshot, effect, say, open, settleAwayFeedback, config, service, execute }
}

const REJECTIONS = [
    {
        label: "invalid command approval flag",
        toolName: DlineDefaultTool.BASH,
        input: INVOCATION.input,
        reason: "invalid_parameters",
        message: "Invalid parameter 'requires_approval' for tool 'execute_command': expected true or false.",
    },
    {
        label: "missing Web Fetch URL",
        toolName: DlineDefaultTool.WEB_FETCH,
        input: { prompt: "Historical optional input" },
        reason: "invalid_parameters",
        message: "Missing required parameter 'url' for tool 'web_fetch'.",
    },
    {
        label: "unregistered tool",
        toolName: DlineDefaultTool.GENERATE_IMAGE,
        input: { prompt: "An owl" },
        reason: "unsupported_tool",
        message: "No handler registered for tool: generate_image",
    },
] as const

describe("production admission rejection", () => {
    for (const resultReplay of [undefined, "text"] as const) {
        it.each(REJECTIONS)(`does not execute $label with replay=${resultReplay ?? "paired"}`, async (testCase) => {
            const harness = subject()
            const invocation: ToolInvocationEnvelope = {
                ...INVOCATION,
                toolName: testCase.toolName,
                input: testCase.input,
                resultReplay,
            }
            const admission = harness.coordinator.prepareAdmission(
                materializeToolInvocation(invocation),
                harness.snapshot,
                async () => undefined,
            )
            expect(admission).toEqual({
                outcome: "rejected",
                rejection: { reason: testCase.reason, message: testCase.message },
            })

            const result = await harness.execute(invocation)

            expect(harness.effect).not.toHaveBeenCalled()
            expect(harness.open).not.toHaveBeenCalled()
            expect(result).toMatchObject({ failed: true, failure: { stage: "validation", code: testCase.reason } })
            expect(readDurableToolResult(result.content)?.block).toMatchObject({
                function_id: "function-admission",
                dline_tid: "tid-admission",
                is_error: true,
                content: expect.stringContaining(testCase.message),
            })
            expect(replayDurableToolResult(result.content)).toEqual([
                resultReplay === "text"
                    ? { type: "text", text: expect.stringContaining(testCase.message) }
                    : expect.objectContaining({ type: "tool_result", function_id: "function-admission", is_error: true }),
            ])
            expect(harness.say).toHaveBeenCalledExactlyOnceWith("error", testCase.message, undefined, undefined, false, 99)
            expect(harness.config.taskState.consecutiveMistakeCount).toBe(testCase.reason === "invalid_parameters" ? 1 : 0)
        })
    }

    it("counts varying malformed calls once each without running a handler", async () => {
        const harness = subject()
        const inputs = [{ command: "echo missing-flag" }, { command: "echo malformed-flag", requires_approval: "invalid" }]

        for (const [index, input] of inputs.entries()) {
            const result = await harness.execute({ ...INVOCATION, input })
            expect(result).toMatchObject({ failed: true, failure: { stage: "validation", code: "invalid_parameters" } })
            expect(harness.config.taskState.consecutiveMistakeCount).toBe(index + 1)
        }

        expect(harness.effect).not.toHaveBeenCalled()
        expect(harness.open).not.toHaveBeenCalled()
    })

    it("rejects malformed Away commands before command approval or feedback settlement", async () => {
        const harness = subject()
        harness.snapshot.awayActive = true

        const result = await harness.execute(INVOCATION)

        expect(result).toMatchObject({ failed: true, failure: { stage: "validation", code: "invalid_parameters" } })
        expect(harness.effect).not.toHaveBeenCalled()
        expect(harness.open).not.toHaveBeenCalled()
        expect(harness.settleAwayFeedback).not.toHaveBeenCalled()
    })

    it.each([
        false,
        true,
    ])("settles a streamed partial through the real host say adapter with approval anchor=%s", async (anchored) => {
        const messages = new MessageStateHandler({
            taskId: "task-admission",
            ulid: "task-admission",
            updateTaskHistory: async () => [],
        })
        const ts = anchored ? 99 : INVOCATION.presentationId
        messages.upsertTransientClineMessage({
            ts,
            type: "say",
            say: "command",
            text: "echo admission-probe",
            partial: true,
            ...(anchored ? { interactionId: "approval:tid-admission" } : {}),
        })
        const finalized: UiMessage[] = []
        messages.on("clineMessagesChanged", (change) => {
            if (change.message) finalized.push(change.message)
        })
        const callbacks = new ControllerTaskCallbacksOwner({
            controller: { currentOpening: () => undefined } as never,
            taskId: "task-admission",
            taskInstanceId: "opening-admission",
            stateManager: { getGlobalSettingsKey: () => ({ enabled: false, remindClineInterval: 6 }) } as never,
            messages,
            interactions: { open: vi.fn() } as never,
            nextPresentationId: () => 100,
            api: {} as never,
            toolState: {} as never,
            createBrowser: () => ({}) as never,
        }).callbacks
        const harness = subject({ messageState: messages, callbacks })

        const result = await harness.execute(INVOCATION)

        expect(result.failed).toBe(true)
        expect(finalized).toEqual([
            expect.objectContaining({ ts, type: "say", say: "error", partial: false, text: REJECTIONS[0].message }),
        ])
        expect(messages.clineMessages.filter((row) => row.partial)).toEqual([])
        expect(harness.effect).not.toHaveBeenCalled()
    })

    it.each([
        undefined,
        "text",
    ] as const)("persists a rejection and rehydrates its provider replay=%s without effects", async (resultReplay) => {
        const harness = subject()
        const payloads = new InMemoryTaskPayloadStore()
        const journal = new InMemoryConversationJournal()
        const invocationRef = await payloads.put(encodeTaskPayload({ ...INVOCATION, resultReplay }))
        const adapter = createProductionToolAdapter({
            payloads,
            journal,
            resources: { revertDiff: async () => undefined, cancelCommand: async () => undefined },
            surface: createDeniedSurface("detached_domain"),
            service: harness.service,
            scheduler: new TurnToolScheduler({ readConfiguredLimit: () => undefined }),
        })

        await expect(
            adapter.runner.runBlock({
                commandId: "command-admission",
                turnId: "turn-admission",
                dlineTid: "tid-admission",
                invocationRef,
            }),
        ).resolves.toEqual({ failed: true })

        const entries = await journal.read()
        expect(entries).toHaveLength(1)
        expect(entries[0]).toMatchObject({ operationId: "tool.result:command-admission", source: "tool" })
        const resultRef = entries[0].payloadRef
        if (!resultRef) throw new Error("Missing durable admission rejection")
        const envelope = decodeTaskPayload<ToolResultEnvelope>(await payloads.read(resultRef))
        expect(envelope).toMatchObject({ kind: "tool_result", blockId: "tid-admission", failed: true })
        const messages = await new ProviderJournalMessageMaterializer(payloads).materialize([resultRef])
        expect(messages).toHaveLength(1)
        expect(messages[0]).toMatchObject({ role: "user" })
        expect(messages[0].content).toEqual([
            resultReplay === "text"
                ? { type: "text", text: expect.stringContaining("Invalid parameter 'requires_approval'") }
                : expect.objectContaining({
                      type: "tool_result",
                      function_id: "function-admission",
                      dline_tid: "tid-admission",
                      is_error: true,
                  }),
        ])
        // A fresh reader uses the durable result, not a live handler or admission cache.
        expect(await new ProviderJournalMessageMaterializer(payloads).materialize([resultRef])).toEqual(messages)
        expect(await journal.read()).toHaveLength(1)
        expect(harness.effect).not.toHaveBeenCalled()
        expect(harness.open).not.toHaveBeenCalled()
        expect(harness.say).toHaveBeenCalledOnce()
    })

    it.each(["true", "false"])("still executes an admitted command with requires_approval=%s once", async (requiresApproval) => {
        const harness = subject()
        const invocation: ToolInvocationEnvelope = {
            ...INVOCATION,
            input: { command: "echo admitted-probe", requires_approval: requiresApproval },
        }

        const result = await harness.execute(invocation)

        expect(harness.effect).toHaveBeenCalledOnce()
        expect(harness.open).not.toHaveBeenCalled()
        expect(harness.say).not.toHaveBeenCalled()
        expect(result.failed).not.toBe(true)
        expect(replayDurableToolResult(result.content)).toEqual([
            expect.objectContaining({
                type: "tool_result",
                function_id: "function-admission",
                dline_tid: "tid-admission",
                content: "[execute_command] Result:\nhandled:echo admitted-probe",
            }),
        ])
    })
})
