import type { IgnoreController } from "@core/ignore/IgnoreController"
import { DEFAULT_AUTO_APPROVAL_SETTINGS } from "@shared/AutoApprovalSettings"
import { DlineDefaultTool } from "@shared/tools"
import { afterEach, describe, expect, it, vi } from "vitest"
import { ComposeCommandExecutor } from "../../executors/compose/ComposeCommandExecutor"
import { ProductionComposeAdapter } from "../../executors/compose/ProductionComposeAdapter"
import type { TaskEventSink } from "../../executors/contracts"
import { DialogCommandExecutor } from "../../executors/dialog/DialogCommandExecutor"
import { JournalConversationView } from "../../executors/provider/service/JournalConversationView"
import { ProviderJournalMessageMaterializer } from "../../executors/provider/service/ProviderJournalMessageMaterializer"
import { ProductionToolHandlerRuntime } from "../../executors/tool/production/ProductionToolHandlerRuntime"
import { planProductionTool } from "../../executors/tool/production/ProductionToolPlanner"
import { ToolCommandExecutor } from "../../executors/tool/ToolCommandExecutor"
import { createDeniedSurface } from "../../executors/tool/ToolDomainSurface"
import { TurnToolScheduler } from "../../executors/tool/TurnToolScheduler"
import { createInitialTaskState } from "../../kernel"
import type { MessageStateHandler } from "../../message-state"
import { TaskRuntime } from "../../runtime/TaskRuntime"
import {
    InMemoryCommandPublicationStore,
    InMemoryConversationJournal,
    InMemoryStateVault,
    InMemoryTaskPayloadStore,
    InMemoryTaskViewPort,
} from "../../stores"
import { decodeTaskPayload, encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type {
    ProviderDraftEnvelope,
    ToolInvocationEnvelope,
    ToolTerminalManifestEnvelope,
} from "../../stores/payload/TaskPayloadEnvelopes"
import { ToolValidator } from "../../tools/ToolValidator"
import type { ActiveTaskSession } from "../ActiveTaskSession"
import { TaskInteractionOwner } from "../TaskInteractionOwner"

const runtimes: TaskRuntime[] = []
afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.disposeDeadlines()))
    vi.useRealTimers()
})

// Removing the block-approval receiver, losing timeout origin, or treating the
// timeout as a user denial would lose the neutral paired result or run the command.
describe("Away planned external command deadline", () => {
    it.each([
        { source: "command" as const, failFirstDelivery: false },
        { source: "ask_timeout" as const, failFirstDelivery: false },
        { source: "command" as const, failFirstDelivery: true },
    ])("keeps the planned approval manual and journals one timed-out result: $source / transient failure $failFirstDelivery", async ({
        source,
        failFirstDelivery,
    }) => {
        vi.useFakeTimers()
        vi.setSystemTime(1000)
        const payloads = new InMemoryTaskPayloadStore()
        const journal = new InMemoryConversationJournal()
        const vault = new InMemoryStateVault()
        const rows = {
            clineMessages: [],
            addToClineMessages: vi.fn(async () => {}),
            flushUiMessages: vi.fn(async () => {}),
        } as unknown as MessageStateHandler
        const owner = new TaskInteractionOwner(rows, payloads, { accepts: () => false, continue: async () => "declined" })
        const tools = new ProductionToolHandlerRuntime(
            new ToolValidator({ validateAccess: () => true } as unknown as IgnoreController),
        )
        const call = {
            type: "tool_use" as const,
            name: DlineDefaultTool.BASH,
            params: { command: "echo not-executed", requires_approval: "true" },
            partial: false,
            ts: 1,
            function_id: "call",
            dline_tid: "command",
        }
        const plan = planProductionTool(tools.coordinator, call, {
            taskId: "deadline",
            cwd: process.cwd(),
            workspaceRoots: [process.cwd()],
            settings: DEFAULT_AUTO_APPROVAL_SETTINGS,
            blanket: { yoloMode: true, approveAll: true },
            inheritsApproval: true,
            awayActive: true,
            awayCommandScope: "external",
        })
        expect(plan.approval).toMatchObject({ kind: "manual", externalCommand: true })
        const invocationRef = await payloads.put(
            encodeTaskPayload<ToolInvocationEnvelope>({
                kind: "tool_invocation",
                toolName: call.name,
                input: call.params,
                functionId: "call",
                dlineTid: "command",
                presentationId: 1,
                isNativeToolCall: true,
            }),
        )
        const finalPayloadRef = await payloads.put(
            encodeTaskPayload({
                kind: "provider_final",
                content: [{ type: "tool_use", function_id: "call", dline_tid: "command", name: call.name, input: call.params }],
            }),
        )
        await journal.append({
            operationId: "provider.final:provider",
            source: "provider",
            payloadRef: finalPayloadRef,
            causation: { turnId: "turn" },
        })
        let runtime!: TaskRuntime
        const events: TaskEventSink = {
            submit: async (event) => {
                const result = await runtime.submit(event)
                if (result.kind === "rejected") throw new Error(`${event.type}:${result.diagnostic.message}`)
                return {
                    kind: "accepted",
                    durable: result.receipt.durable,
                    ...(event.type === "compose.freeze_requested"
                        ? { materialPlan: result.state.flow.compose!.materialPlan! }
                        : {}),
                }
            },
        }
        const adapter = new ProductionComposeAdapter({ payloads, journal, readState: () => runtime.getState() })
        const executed = vi.fn(async () => {})
        const sent: ProviderDraftEnvelope[] = []
        runtime = new TaskRuntime({
            initialState: {
                ...createInitialTaskState("deadline"),
                away: {
                    configuration: { enabled: true, automatic: false, modeRevocation: 0, automaticRevocation: 0 },
                    mode: { source, enteredRevision: 0, modeRevocation: 0 },
                },
                flow: { phase: "running", provider: { commandId: "provider", originRevision: 0, status: "running" } },
            },
            vault,
            taskView: new InMemoryTaskViewPort(),
            publications: new InMemoryCommandPublicationStore(),
            automaticResponses: { deliver: (command) => owner.deliverAutomatic(command) },
            executors: [
                new ComposeCommandExecutor(adapter, events),
                new DialogCommandExecutor(
                    {
                        prepare: async () => ({
                            journalRef: "approval",
                            journalWatermark: journal.watermark(),
                            receiverGeneration: 0,
                            disposition: "created",
                        }),
                        reveal: async () => ({ disposition: "revealed" }),
                    },
                    events,
                ),
                new ToolCommandExecutor(
                    {
                        runner: { runBlock: executed, release: async () => {} },
                        surface: createDeniedSurface("detached_domain"),
                        scheduler: new TurnToolScheduler({ readConfiguredLimit: () => undefined }),
                    },
                    events,
                ),
                {
                    domain: "provider",
                    execute: async (command) => {
                        if (command.type === "provider.start")
                            sent.push(decodeTaskPayload<ProviderDraftEnvelope>(await payloads.read(command.draftRef)))
                    },
                },
            ],
        })
        runtimes.push(runtime)
        owner.bind({
            taskId: "deadline",
            writable: true,
            state: () => runtime.getState(),
            assembly: { runtime },
        } as unknown as ActiveTaskSession)
        const ready = await runtime.submit({
            type: "provider.turn_ready",
            generation: 0,
            commandId: "provider",
            originRevision: 0,
            turnId: "turn",
            finalPayloadRef,
            journalWatermark: journal.watermark(),
            turnPlan: { mode: "serial", blocks: [{ ...plan, blockId: "command", index: 0, invocationRef }] },
        })
        expect(ready.kind).toBe("accepted")
        await runtime.waitForQuiescence()
        expect(runtime.getState().dialog.approvalsByBlock.command).toMatchObject({
            status: "awaiting",
            deadline: { kind: "external_command", deadlineAt: 61000 },
        })
        const put = payloads.put.bind(payloads)
        let deliveryWrites = 0
        vi.spyOn(payloads, "put").mockImplementation(async (bytes) => {
            if (decodeTaskPayload<{ kind: string }>(bytes).kind === "dialog_draft") {
                deliveryWrites++
                if (failFirstDelivery && deliveryWrites === 1) throw new Error("Transient delivery write failure")
            }
            return put(bytes)
        })
        await vi.advanceTimersByTimeAsync(59999)
        expect(sent).toEqual([])
        await vi.advanceTimersByTimeAsync(1)
        await runtime.waitForQuiescence()
        expect(executed).not.toHaveBeenCalled()
        expect(sent).toHaveLength(1)
        expect(deliveryWrites).toBe(failFirstDelivery ? 2 : 1)
        expect(runtime.getState().turn.blocks[0]).toMatchObject({ phase: "rejected", approvalTimedOut: true })
        expect(runtime.getState().turn.blocks[0].deniedByUser).toBeUndefined()
        expect(runtime.getState().dialog.approvalsByBlock).toEqual({})
        const terminal = (await journal.read()).find((entry) => entry.operationId === "tool.terminal_manifest:turn")!
        const manifest = decodeTaskPayload<ToolTerminalManifestEnvelope>(await payloads.read(terminal.payloadRef!))
        expect(manifest.results).toMatchObject([{ blockId: "command", phase: "rejected", failed: false }])
        const view = new JournalConversationView(journal, new ProviderJournalMessageMaterializer(payloads))
        const entries = await view.entries()
        const results = entries
            .filter((entry) => entry.kind === "tool_terminal_manifest")
            .flatMap((entry) => entry.messages)
            .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
        expect(results).toHaveLength(1)
        expect(results[0]).toMatchObject({ type: "tool_result", function_id: "call", dline_tid: "command" })
        expect(results[0]).not.toHaveProperty("is_error")
        expect(rows.addToClineMessages).not.toHaveBeenCalled()
        expect((await vault.load("deadline"))!.state.turn.blocks[0].approvalTimedOut).toBe(true)
    })
})
