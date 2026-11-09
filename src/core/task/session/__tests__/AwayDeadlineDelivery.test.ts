import { afterEach, describe, expect, it, vi } from "vitest"
import { createInitialTaskState, hydrate, type TaskState } from "../../kernel"
import type { MessageStateHandler } from "../../message-state"
import { TaskRuntime } from "../../runtime/TaskRuntime"
import { InMemoryConversationJournal, InMemoryTaskPayloadStore } from "../../stores"
import { encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { ToolInvocationEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"
import type { ActiveTaskSession } from "../ActiveTaskSession"
import { RestoredToolDialogContinuation } from "../RestoredToolDialogContinuation"
import { TaskInteractionOwner } from "../TaskInteractionOwner"

const configuration = { enabled: true, automatic: true, modeRevocation: 0, automaticRevocation: 0 }
const runtimes: TaskRuntime[] = []
afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.disposeDeadlines()))
    vi.useRealTimers()
})

function messages(): MessageStateHandler {
    return {
        clineMessages: [],
        addToClineMessages: vi.fn(async () => {}),
        flushUiMessages: vi.fn(async () => {}),
    } as unknown as MessageStateHandler
}

function harness(state: TaskState, payloads = new InMemoryTaskPayloadStore(), journal = new InMemoryConversationJournal()) {
    const rows = messages()
    let runtime: TaskRuntime
    const resumption = {
        materialize: vi.fn(async () => ({
            entryId: "continued",
            payloadRef: await payloads.put(encodeTaskPayload({ kind: "user_input", text: "" })),
        })),
        materializeAnswer: vi.fn(),
        submit: vi.fn(async (input: { entryId: string; payloadRef: string }) =>
            runtime.submit({ type: "user.submit", generation: runtime.getState().generation, ...input }),
        ),
    }
    const continuation = new RestoredToolDialogContinuation(
        {
            state: () => runtime.getState(),
            payloads,
            journal,
            messages: rows,
            nextPresentationId: () => 10,
            admitReply: vi.fn(async () => undefined),
        },
        resumption,
        { accepts: () => false, continue: async () => "declined" },
    )
    const owner = new TaskInteractionOwner(rows, payloads, continuation)
    runtime = new TaskRuntime({
        initialState: state,
        vault: { load: async () => undefined, save: async () => {} },
        taskView: { notifyCommitted: async () => {}, notifyTransient: () => {} },
        publications: { has: async () => false, mark: async () => {} },
        executors: [
            { domain: "dialog", execute: async () => {} },
            { domain: "compose", execute: async () => {} },
        ],
        automaticResponses: { deliver: (command) => owner.deliverAutomatic(command) },
    })
    runtimes.push(runtime)
    owner.bind({ writable: true, state: () => runtime.getState(), assembly: { runtime } } as unknown as ActiveTaskSession)
    return { runtime, owner, rows, resumption, payloads, journal }
}

async function reveal(h: ReturnType<typeof harness>, interactionId: string) {
    await vi.waitFor(() => expect(h.runtime.getState().dialog.primary?.prepare).toBeDefined())
    const prepare = h.runtime.getState().dialog.primary!.prepare!
    await h.runtime.submit({
        type: "dialog.prepared",
        generation: 0,
        interactionId,
        commandId: prepare.commandId,
        originRevision: prepare.originRevision,
        receiverGeneration: 0,
        journalRef: "journal:0",
    })
    const command = h.runtime.getState().dialog.primary!.reveal!
    await h.runtime.submit({
        type: "dialog.presented",
        generation: 0,
        interactionId,
        commandId: command.commandId,
        originRevision: command.originRevision,
    })
}

// These use the actual timer, outbox, owner and restored-result writer: an accepted
// timeout that never reaches its parked receiver or loses its paired result fails here.
describe("Away deadline delivery", () => {
    it("delivers the ten-minute answer to the live receiver after committing full Away", async () => {
        vi.useFakeTimers()
        vi.setSystemTime(1000)
        const h = harness({ ...createInitialTaskState("deadline"), flow: { phase: "running" }, away: { configuration } })
        const waiting = h.owner.open({ kind: "followup", interactionId: "question", turnId: "turn", presentation: "Choose" })
        await reveal(h, "question")
        h.runtime.allowRestoredCommands()
        await vi.advanceTimersByTimeAsync(600000)
        const answer = await waiting
        expect(answer).toMatchObject({ actionId: "reply", origin: "timeout" })
        expect(h.runtime.getState().away?.mode?.source).toBe("ask_timeout")
        expect(h.runtime.getState().dialog.primary).toBeUndefined()
        expect(h.rows.addToClineMessages).toHaveBeenCalledTimes(1)
    })

    it("retains a live accepted timeout across the result-write crash window until terminal feedback", async () => {
        vi.useFakeTimers()
        vi.setSystemTime(1000)
        const payloads = new InMemoryTaskPayloadStore()
        const invocationRef = await payloads.put(
            encodeTaskPayload<ToolInvocationEnvelope>({
                kind: "tool_invocation",
                toolName: "ask_followup_question",
                input: { question: "Choose" },
                functionId: "call",
                dlineTid: "question",
                presentationId: 1,
                isNativeToolCall: true,
            }),
        )
        const base = createInitialTaskState("deadline")
        const h = harness(
            {
                ...base,
                flow: { phase: "running" },
                away: { configuration },
                turn: {
                    ...base.turn,
                    turnId: "turn",
                    executingBlockIds: ["question"],
                    blocks: [
                        {
                            blockId: "question",
                            index: 0,
                            phase: "executing",
                            attempt: "attempt",
                            lanes: [],
                            turnEnding: true,
                            invocationRef,
                        },
                    ],
                },
            },
            payloads,
        )
        const waiting = h.owner.open({ kind: "followup", interactionId: "question", turnId: "turn", presentation: "Choose" })
        await reveal(h, "question")
        h.runtime.allowRestoredCommands()
        await vi.advanceTimersByTimeAsync(600000)
        expect(await waiting).toMatchObject({ origin: "timeout" })
        const accepted = h.runtime.getState()
        expect(accepted.dialog.primary?.acceptedResponse).toMatchObject({ origin: "timeout" })
        const restored = hydrate({
            taskId: "deadline",
            snapshot: accepted,
            journalTail: h.journal.watermark(),
            openReason: "crash_recovery",
        })
        expect(restored.state.dialog.interrupted?.acceptedResponse).toMatchObject({ origin: "timeout" })
        await h.journal.append({
            operationId: "tool.result:turn:question",
            source: "tool",
            payloadRef: await payloads.put(
                encodeTaskPayload({ kind: "tool_result", blockId: "question", content: "automatic answer" }),
            ),
        })
        await h.runtime.submit({ type: "tool.completed", generation: 0, turnId: "turn", blockId: "question", attempt: "attempt" })
        expect(h.runtime.getState().dialog.primary).toBeUndefined()
    })

    it.each([
        "command",
        "ask_timeout",
        undefined,
    ] as const)("delivers the late approval rejection with Away source %s", async (source) => {
        vi.useFakeTimers()
        vi.setSystemTime(1000)
        const h = harness({
            ...createInitialTaskState("deadline"),
            flow: { phase: "running" },
            away: {
                configuration: { ...configuration, automatic: source === undefined },
                ...(source ? { mode: { source, enteredRevision: 0, modeRevocation: 0 } } : {}),
            },
        })
        let requestedAt = 0
        const submit = h.runtime.submit.bind(h.runtime)
        vi.spyOn(h.runtime, "submit").mockImplementation((event) => {
            if (event.type === "dialog.requested") requestedAt = Date.now()
            return submit(event)
        })
        const waiting = h.owner.open({
            kind: "command_approval",
            interactionId: "command",
            turnId: "turn",
            presentation: "echo done",
            externalCommand: true,
        })
        await reveal(h, "command")
        const timeoutMs = source ? 60000 : 600000
        expect(h.runtime.getState().dialog.primary?.deadline?.deadlineAt).toBe(requestedAt + timeoutMs)
        h.runtime.allowRestoredCommands()
        await vi.advanceTimersByTimeAsync(timeoutMs)
        expect(await waiting).toMatchObject({ actionId: "reject", origin: "timeout" })
        expect(h.runtime.getState().away?.mode?.source).toBe(source ?? "ask_timeout")
        expect(h.runtime.getState().dialog.primary).toBeUndefined()
    })

    it.each([
        { kind: "followup" as const, deadlineKind: "ask" as const },
        { kind: "command_approval" as const, deadlineKind: "external_command" as const },
        { kind: "command_approval" as const, deadlineKind: "command_approval" as const },
    ])("journals one paired automatic result for an unowned $kind / $deadlineKind", async ({ kind, deadlineKind }) => {
        vi.useFakeTimers()
        vi.setSystemTime(1000)
        const payloads = new InMemoryTaskPayloadStore()
        const journal = new InMemoryConversationJournal()
        const invocation: ToolInvocationEnvelope = {
            kind: "tool_invocation",
            toolName: kind === "followup" ? "ask_followup_question" : "execute_command",
            input: {},
            functionId: "call",
            dlineTid: "block",
            presentationId: 1,
            isNativeToolCall: true,
        }
        const invocationRef = await payloads.put(encodeTaskPayload(invocation))
        const base = createInitialTaskState("unowned")
        const state: TaskState = {
            ...base,
            flow: { phase: "waiting" },
            away: { configuration, mode: { source: "command", enteredRevision: 0, modeRevocation: 0 } },
            turn: {
                ...base.turn,
                turnId: "turn",
                blocks: [
                    {
                        blockId: "block",
                        index: 0,
                        phase: "cancelled",
                        attempt: "attempt",
                        lanes: [],
                        turnEnding: kind === "followup",
                        invocationRef,
                    },
                ],
            },
            dialog: {
                approvalsByBlock: {},
                primary: {
                    interactionId: "block",
                    turnId: "turn",
                    kind,
                    status: "awaiting",
                    createdRevision: 0,
                    receiverGeneration: 0,
                    presentationRef: "question",
                    actionRules: [{ actionId: kind === "followup" ? "reply" : "reject", payloadPolicy: "draft" }],
                    deadline: {
                        kind: deadlineKind,
                        deadlineAt: 2000,
                        modeRevocation: 0,
                        automaticRevocation: 0,
                    },
                },
            },
        }
        const h = harness(state, payloads, journal)
        h.runtime.allowRestoredCommands()
        await vi.advanceTimersByTimeAsync(1000)
        await h.runtime.waitForQuiescence()
        expect((await journal.read()).filter((entry) => entry.operationId === "tool.restored_result:turn:block")).toHaveLength(1)
        expect(h.resumption.submit).toHaveBeenCalledTimes(1)
        expect(h.runtime.getState().dialog.primary).toBeUndefined()
        expect(h.rows.addToClineMessages).not.toHaveBeenCalled()
        await vi.advanceTimersByTimeAsync(600000)
        expect(h.resumption.submit).toHaveBeenCalledTimes(1)
    })
})
