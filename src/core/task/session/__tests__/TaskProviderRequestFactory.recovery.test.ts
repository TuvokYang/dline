import { DlineDefaultTool } from "@shared/tools"
import { describe, expect, it, vi } from "vitest"
import { serializeDurableToolResult } from "../../DurableToolResult"
import { JournalConversationView } from "../../executors/provider/service/JournalConversationView"
import { ProviderJournalMessageMaterializer } from "../../executors/provider/service/ProviderJournalMessageMaterializer"
import { TaskTurnAuthority } from "../../explicit-instructions/TurnAuthority"
import type { ExplicitInstructionDeclaration } from "../../explicit-instructions/types"
import type { TaskState } from "../../kernel"
import { NEW_TASK_FEEDBACK_CONTINUATION_MARKER } from "../../new-task/new-task-continuation"
import type { JournalCausation, JournalSource } from "../../stores"
import { InMemoryConversationJournal, InMemoryTaskPayloadStore } from "../../stores/InMemoryRuntimeStores"
import { encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import { TaskProviderRequestFactory, type TaskProviderRequestFactoryOptions } from "../TaskProviderRequestFactory"

const NEW_TASK_COMMAND: ExplicitInstructionDeclaration = {
    type: "new_task",
    source: "slash_command",
    targetTool: DlineDefaultTool.NEW_TASK,
}
const REPORT_BUG_COMMAND: ExplicitInstructionDeclaration = {
    type: "report_bug",
    source: "slash_command",
    targetTool: DlineDefaultTool.REPORT_BUG,
}

/** A task store and the factory a restarted session composes over it. */
function harness() {
    const journal = new InMemoryConversationJournal()
    const payloads = new InMemoryTaskPayloadStore()
    const materializer = new ProviderJournalMessageMaterializer(payloads)
    const authority = new TaskTurnAuthority()
    const rebuild = vi.fn(async () => undefined)
    const factory = new TaskProviderRequestFactory({
        taskId: "task-1",
        conversation: new JournalConversationView(journal, materializer),
        messages: materializer,
        authority,
        api: { rebuild, current: vi.fn() },
    } as unknown as TaskProviderRequestFactoryOptions)
    const put = (payload: object) => payloads.put(encodeTaskPayload(payload))
    let operation = 0
    const append = async (payload: object, source: JournalSource, causation: JournalCausation, operationId?: string) =>
        journal.append({
            operationId: operationId ?? `op-${++operation}`,
            payloadRef: await put(payload),
            source,
            causation,
        })
    return { payloads, authority, rebuild, factory, put, append }
}

type Harness = ReturnType<typeof harness>

function toolCall(tid: string, toolName: string = DlineDefaultTool.NEW_TASK) {
    return {
        kind: "tool_invocation",
        toolName,
        input: { context: "handoff" },
        functionId: `call-${tid}`,
        dlineTid: tid,
        presentationId: 1,
        isNativeToolCall: true,
    }
}

/** Journal the reply of `turnId` that planned one call, as the provider executor writes it. */
async function planCall(
    h: Harness,
    input: { turnId: string; tid: string; commandId: string; toolName?: string; invocationRef?: string },
): Promise<string> {
    const toolName = input.toolName ?? DlineDefaultTool.NEW_TASK
    const invocationRef = input.invocationRef ?? (await h.put(toolCall(input.tid, toolName)))
    await h.append(
        {
            kind: "provider_final",
            content: [
                {
                    type: "tool_use",
                    function_id: `call-${input.tid}`,
                    dline_tid: input.tid,
                    name: toolName,
                    input: { context: "handoff" },
                },
            ],
            turnPlan: {
                mode: "serial",
                blocks: [
                    {
                        blockId: input.tid,
                        attempt: "attempt-1",
                        index: 0,
                        lanes: [],
                        turnEnding: true,
                        invocationRef,
                        approval: {
                            kind: "manual",
                            interactionId: `approval:${input.tid}`,
                            presentationRef: "presentation",
                            actionRules: [],
                        },
                    },
                ],
            },
        },
        "provider",
        { turnId: input.turnId },
        `provider.final:${input.commandId}`,
    )
    return invocationRef
}

function toolResult(tid: string, text: string): string {
    return serializeDurableToolResult({
        type: "tool_result",
        function_id: `call-${tid}`,
        dline_tid: tid,
        content: [{ type: "text", text }],
    })
}

/** The hydrated kernel state of a task restarted while `tid` waited for approval. */
function awaitingState(
    turnId: string,
    tid: string,
    invocationRef: string,
    approval: Record<string, unknown> = {},
    phase = "awaiting_approval",
): TaskState {
    return {
        turn: {
            turnId,
            mode: "serial",
            blocks: [{ blockId: tid, index: 0, phase, attempt: "attempt-1", lanes: [], turnEnding: true, invocationRef }],
            manualApprovalBlockIds: [tid],
            automaticApprovalBlockIds: [],
            executingBlockIds: [],
        },
        dialog: {
            approvalsByBlock: {
                [tid]: {
                    interactionId: `approval:${tid}`,
                    turnId,
                    kind: "tool_approval",
                    status: "awaiting",
                    createdRevision: 1,
                    presentationRef: "presentation",
                    actionRules: [],
                    blockId: tid,
                    ...approval,
                },
            },
        },
    } as unknown as TaskState
}

/** A first `/newtask` round whose call waits for approval when the window restarts. */
async function firstApprovalRestart(h: Harness, declarations: readonly ExplicitInstructionDeclaration[] = [NEW_TASK_COMMAND]) {
    await h.append(
        { kind: "user_input", text: "/newtask", admittedText: "Hand this off", explicitInstructions: declarations },
        "intake",
        { turnId: "turn-1" },
    )
    return planCall(h, { turnId: "turn-1", tid: "tid-1", commandId: "provider:1" })
}

describe("TaskProviderRequestFactory restored New Task approval", () => {
    it("re-grants the restored turn's /newtask once, limited to new_task, without rebuilding the handler", async () => {
        const h = harness()
        const invocationRef = await firstApprovalRestart(h, [NEW_TASK_COMMAND, REPORT_BUG_COMMAND])

        await h.factory.restoreNewTaskApproval(awaitingState("turn-1", "tid-1", invocationRef), h.payloads)

        const port = h.authority.read("turn-1")
        expect(port?.getPendingToolAuthorization(DlineDefaultTool.REPORT_BUG)).toBeUndefined()
        expect(port?.consumeTool(DlineDefaultTool.NEW_TASK).ok).toBe(true)
        expect(port?.consumeTool(DlineDefaultTool.NEW_TASK).ok).toBe(false)
        expect(h.rebuild).not.toHaveBeenCalled()
    })

    it("re-grants the feedback continuation of a second New Task call and never the earlier turn", async () => {
        const h = harness()
        await firstApprovalRestart(h)
        await h.append(
            {
                kind: "tool_terminal_manifest",
                turnId: "turn-1",
                results: [
                    {
                        blockId: "tid-1",
                        phase: "completed",
                        content: toolResult("tid-1", `${NEW_TASK_FEEDBACK_CONTINUATION_MARKER}\nKeep the tests.`),
                    },
                ],
                supersededPayloadRefs: [],
            },
            "tool",
            { turnId: "turn-1" },
        )
        const invocationRef = await planCall(h, { turnId: "turn-2", tid: "tid-2", commandId: "provider:2" })

        await h.factory.restoreNewTaskApproval(awaitingState("turn-2", "tid-2", invocationRef), h.payloads)

        expect(h.authority.read("turn-1")).toBeUndefined()
        const port = h.authority.read("turn-2")
        expect(port?.consumeTool(DlineDefaultTool.NEW_TASK).ok).toBe(true)
        expect(port?.consumeTool(DlineDefaultTool.NEW_TASK).ok).toBe(false)
    })

    it("re-grants a /newtask typed as the answer to a tool through the manifest's feedback inputs", async () => {
        const h = harness()
        await h.append({ kind: "user_input", text: "Read the file", admittedText: "Read the file" }, "intake", {
            turnId: "turn-1",
        })
        await planCall(h, { turnId: "turn-1", tid: "tid-read", commandId: "provider:1", toolName: DlineDefaultTool.FILE_READ })
        const feedbackRef = await h.put({ kind: "user_input", text: "/newtask", explicitInstructions: [NEW_TASK_COMMAND] })
        await h.append(
            {
                kind: "tool_terminal_manifest",
                turnId: "turn-1",
                results: [{ blockId: "tid-read", phase: "completed", content: toolResult("tid-read", "file contents") }],
                supersededPayloadRefs: [],
                feedbackInputRefs: [feedbackRef],
            },
            "tool",
            { turnId: "turn-1" },
        )
        const invocationRef = await planCall(h, { turnId: "turn-2", tid: "tid-2", commandId: "provider:2" })

        await h.factory.restoreNewTaskApproval(awaitingState("turn-2", "tid-2", invocationRef), h.payloads)

        expect(h.authority.read("turn-2")?.consumeTool(DlineDefaultTool.NEW_TASK).ok).toBe(true)
    })

    it("does not mint a second grant over authority the live turn already holds", async () => {
        const h = harness()
        const invocationRef = await firstApprovalRestart(h)
        const live = h.authority.grant("turn-1", [NEW_TASK_COMMAND])
        expect(live?.port.consumeTool(DlineDefaultTool.NEW_TASK).ok).toBe(true)

        await h.factory.restoreNewTaskApproval(awaitingState("turn-1", "tid-1", invocationRef), h.payloads)

        expect(h.authority.read("turn-1")?.consumeTool(DlineDefaultTool.NEW_TASK).ok).toBe(false)
    })

    it("stays closed when more than one new_task call awaits approval", async () => {
        const h = harness()
        const invocationRef = await firstApprovalRestart(h)
        const state = awaitingState("turn-1", "tid-1", invocationRef)
        const second = { ...state.turn.blocks[0], blockId: "tid-2", index: 1, invocationRef: await h.put(toolCall("tid-2")) }
        const twoAwaiting = { ...state, turn: { ...state.turn, blocks: [...state.turn.blocks, second] } } as TaskState

        await h.factory.restoreNewTaskApproval(twoAwaiting, h.payloads)

        expect(h.authority.read("turn-1")).toBeUndefined()
    })

    it.each([
        {
            name: "the turn carried no /newtask",
            build: async (h: Harness) => ({
                invocationRef: await firstApprovalRestart(h, []),
            }),
        },
        {
            name: "the approval is not the kernel approval of the call",
            build: async (h: Harness) => ({
                invocationRef: await firstApprovalRestart(h),
                approval: { interactionId: "tid-1" },
            }),
        },
        {
            name: "the approval belongs to another turn",
            build: async (h: Harness) => ({ invocationRef: await firstApprovalRestart(h), approval: { turnId: "turn-0" } }),
        },
        {
            name: "the dialog is not a tool approval",
            build: async (h: Harness) => ({ invocationRef: await firstApprovalRestart(h), approval: { kind: "followup" } }),
        },
        {
            name: "the call no longer awaits approval",
            build: async (h: Harness) => ({ invocationRef: await firstApprovalRestart(h), phase: "ready" }),
        },
        {
            name: "the awaiting call is not new_task",
            build: async (h: Harness) => {
                await h.append({ kind: "user_input", text: "/newtask", explicitInstructions: [NEW_TASK_COMMAND] }, "intake", {
                    turnId: "turn-1",
                })
                return {
                    invocationRef: await planCall(h, {
                        turnId: "turn-1",
                        tid: "tid-1",
                        commandId: "provider:1",
                        toolName: DlineDefaultTool.FILE_READ,
                    }),
                }
            },
        },
        {
            name: "the invocation names another call",
            build: async (h: Harness) => {
                await h.append({ kind: "user_input", text: "/newtask", explicitInstructions: [NEW_TASK_COMMAND] }, "intake", {
                    turnId: "turn-1",
                })
                const invocationRef = await h.put(toolCall("tid-other"))
                return {
                    invocationRef: await planCall(h, { turnId: "turn-1", tid: "tid-1", commandId: "provider:1", invocationRef }),
                }
            },
        },
        {
            name: "no reply of the turn planned the call",
            build: async (h: Harness) => {
                await h.append({ kind: "user_input", text: "/newtask", explicitInstructions: [NEW_TASK_COMMAND] }, "intake", {
                    turnId: "turn-1",
                })
                return { invocationRef: await planCall(h, { turnId: "turn-0", tid: "tid-1", commandId: "provider:1" }) }
            },
        },
        {
            name: "the turn has more than one reply",
            build: async (h: Harness) => {
                const invocationRef = await firstApprovalRestart(h)
                await planCall(h, { turnId: "turn-1", tid: "tid-1", commandId: "provider:2", invocationRef })
                return { invocationRef }
            },
        },
        {
            name: "the reply planned a different invocation",
            build: async (h: Harness) => {
                await firstApprovalRestart(h)
                // Same call identity, different durable invocation than the reply planned.
                return { invocationRef: await h.put({ ...toolCall("tid-1"), input: { context: "rewritten" } }) }
            },
        },
    ])("stays closed when $name", async ({ build }) => {
        const h = harness()
        const { invocationRef, approval, phase } = (await build(h)) as {
            invocationRef: string
            approval?: Record<string, unknown>
            phase?: string
        }

        await h.factory.restoreNewTaskApproval(awaitingState("turn-1", "tid-1", invocationRef, approval, phase), h.payloads)

        expect(h.authority.read("turn-1")).toBeUndefined()
    })
})
