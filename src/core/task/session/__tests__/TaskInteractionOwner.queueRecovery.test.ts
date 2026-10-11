import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it, vi } from "vitest"
import type { DraftAttachmentPort } from "../../interaction/DraftAttachments"
import { createInitialTaskState, hydrate, type TaskEvent, type TaskState, transition } from "../../kernel"
import type { MessageStateHandler } from "../../message-state"
import type { EventSubmissionResult } from "../../runtime"
import { InMemoryConversationJournal, InMemoryTaskPayloadStore } from "../../stores/InMemoryRuntimeStores"
import { decodeTaskPayload, encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type { DialogDraftEnvelope, ToolInvocationEnvelope, ToolResultEnvelope } from "../../stores/payload/TaskPayloadEnvelopes"
import type { ActiveTaskSession } from "../ActiveTaskSession"
import { RestoredToolDialogContinuation } from "../RestoredToolDialogContinuation"
import { TaskInteractionOwner } from "../TaskInteractionOwner"

const cases = [
    ["followup", "ask_followup_question", "reply"],
    ["make_plan", "make_plan", "reply"],
    ["qna_response", "qna_respond", "reply"],
    ["generate_report", "generate_report", "reply"],
    ["status_acknowledgment", "status_update", "acknowledge"],
    ["completion", "attempt_completion", "reply"],
] as const

interface HarnessOptions {
    readonly draft?: DialogDraftEnvelope
    readonly draftAttachments?: DraftAttachmentPort
}

async function harness(kind: string, toolName: string, actionId: string, options: HarnessOptions = {}) {
    const payloads = new InMemoryTaskPayloadStore()
    const journal = new InMemoryConversationJournal()
    const rawRef = await payloads.put(
        encodeTaskPayload({ kind: "user_input", text: "RAW_QUEUE_INPUT", admittedText: "ADMITTED_INPUT" }),
    )
    const draft: DialogDraftEnvelope = options.draft ?? {
        kind: "dialog_draft",
        text: "MODEL_GUIDANCE\nADMITTED_INPUT",
        images: [],
        files: [],
    }
    const draftRef = await payloads.put(encodeTaskPayload(draft))
    const invocation: ToolInvocationEnvelope = {
        kind: "tool_invocation",
        toolName,
        input: {},
        functionId: "call_original",
        dlineTid: "block-1",
        presentationId: 1,
        isNativeToolCall: true,
    }
    const invocationRef = await payloads.put(encodeTaskPayload(invocation))
    const base = createInitialTaskState("task-1")
    const queuedInput = {
        deliveryId: "delivery-1",
        mode: "steering" as const,
        entries: [{ entryId: "entry-1", payloadRef: rawRef }],
    }
    const snapshot: TaskState = {
        ...base,
        journalWatermark: { seq: 0 },
        flow: { phase: "running", pendingQueueResponse: queuedInput },
        turn: {
            ...base.turn,
            turnId: "turn-1",
            executingBlockIds: ["block-1"],
            blocks: [
                {
                    blockId: "block-1",
                    phase: "executing",
                    attempt: "attempt-1",
                    index: 0,
                    lanes: [],
                    turnEnding: true,
                    invocationRef,
                },
            ],
        },
        intake: {
            ...base.intake,
            queued: [
                {
                    entryId: "entry-1",
                    payloadRef: rawRef,
                    source: "user",
                    mode: "steering",
                    sequence: 0,
                    queue: { editing: false },
                    state: "consumed",
                },
            ],
        },
        dialog: {
            approvalsByBlock: {},
            primary: {
                interactionId: "block-1",
                turnId: "turn-1",
                kind,
                status: "resolving",
                createdRevision: 0,
                presentationRef: "presentation:1",
                journalRef: "journal:0",
                journalWatermark: { seq: 0 },
                receiverGeneration: 0,
                actionRules: [{ actionId, payloadPolicy: "draft" }],
                acceptedResponse: { actionId, stateRevision: 0, receiverGeneration: 0, draftRef, queuedInput },
            },
        },
    }
    const restored = hydrate({ taskId: "task-1", openReason: "crash_recovery", snapshot, journalTail: { seq: 0 } })
    let state = restored.state
    const submitted: TaskEvent[] = []
    const runtime = {
        submit: vi.fn(async (event: TaskEvent) => {
            const result = transition(state, event)
            if (result.kind === "rejected") return result
            state = result.state
            submitted.push(event)
            return { kind: "accepted", receipt: { durable: Promise.resolve() } }
        }),
    }
    const reveal = restored.initialCommands.find((command) => command.type === "dialog.reveal")
    if (reveal?.type !== "dialog.reveal") throw new Error("Missing restored reveal")
    await runtime.submit({
        type: "dialog.presented",
        generation: state.generation,
        commandId: reveal.commandId,
        originRevision: reveal.originRevision,
        interactionId: reveal.interactionId,
    })
    const rows: UiMessage[] = []
    const messages = {
        clineMessages: rows,
        addToClineMessages: vi.fn(async (row: UiMessage) => {
            rows.push(row)
        }),
        flushUiMessages: vi.fn(async () => undefined),
        updateClineMessage: vi.fn(),
        flushMessageUpdate: vi.fn(),
    } as unknown as MessageStateHandler
    let ts = 1
    const resumption = {
        materialize: vi.fn(async () => ({ entryId: "resume-empty", payloadRef: rawRef })),
        submit: vi.fn(async () => ({ kind: "accepted" }) as unknown as EventSubmissionResult),
    }
    const fallback = { accepts: vi.fn(() => false), continue: vi.fn(async () => "declined" as const) }
    const continuation = new RestoredToolDialogContinuation(
        {
            state: () => state,
            payloads,
            journal,
            messages,
            nextPresentationId: () => ts++,
        },
        resumption,
        fallback,
    )
    const owner = new TaskInteractionOwner(messages, payloads, continuation)
    const onTurnEndAwaiting = vi.fn()
    owner.bind({
        state: () => state,
        assembly: { runtime },
        owners: { nextPresentationId: () => ts++ },
        inputQueue: { onTurnEndAwaiting },
        draftAttachments: options.draftAttachments,
    } as unknown as ActiveTaskSession)
    const boundary = { turnId: "turn-1", interactionId: "block-1", kind }
    return {
        owner,
        journal,
        payloads,
        rows,
        messages,
        resumption,
        fallback,
        onTurnEndAwaiting,
        submitted,
        state: () => state,
        runtime,
        boundary,
    }
}

describe("queued response restart continuation", () => {
    it.each(
        cases,
    )("continues %s with its original paired result and raw row, not a new queue claim", async (kind, toolName, actionId) => {
        const h = await harness(kind, toolName, actionId)
        await h.owner.awaiting(h.boundary)
        expect(h.resumption.submit).toHaveBeenCalledOnce()
        expect(h.resumption.materialize).toHaveBeenCalledWith({})
        expect(h.onTurnEndAwaiting).not.toHaveBeenCalled()
        expect(h.fallback.continue).not.toHaveBeenCalled()
        expect(h.state().intake.queued[0]?.state).toBe("consumed")
        expect(h.state().flow.pendingQueueResponse?.entries).toHaveLength(1)
        expect(h.rows).toHaveLength(1)
        expect(h.rows[0]).toMatchObject({ say: "user_feedback", text: "RAW_QUEUE_INPUT", interactionId: "delivery-1" })
        expect(JSON.stringify(h.rows)).not.toContain("MODEL_GUIDANCE")
        const entries = await h.journal.read()
        expect(entries).toHaveLength(1)
        const result = decodeTaskPayload<ToolResultEnvelope>(await h.payloads.read(entries[0].payloadRef!))
        expect(result).toMatchObject({ kind: "tool_result", blockId: "block-1" })
        expect(result.content).toContain("call_original")
        expect(result.content).toContain("MODEL_GUIDANCE")
        expect(result.content).toContain("ADMITTED_INPUT")
        expect(h.submitted.map((event) => event.type)).toEqual(["dialog.presented", "dialog.resolved"])
    })

    it("keeps the accepted owner until its result append is durable", async () => {
        const h = await harness(...cases[0])
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const append = h.journal.append.bind(h.journal)
        const guarded = vi.spyOn(h.journal, "append").mockImplementation(async (input) => {
            await gate
            return append(input)
        })
        const pending = h.owner.awaiting(h.boundary)
        await vi.waitFor(() => expect(guarded).toHaveBeenCalledOnce())
        expect(h.state().dialog.primary?.acceptedResponse?.queuedInput).toBeDefined()
        expect(h.submitted.map((event) => event.type)).not.toContain("dialog.resolved")
        expect(h.resumption.submit).not.toHaveBeenCalled()
        release()
        await pending
        expect(h.resumption.submit).toHaveBeenCalledOnce()
    })

    it("does not resume after cancel advances the generation during restored append", async () => {
        const h = await harness(...cases[0])
        let release!: () => void
        const gate = new Promise<void>((resolve) => {
            release = resolve
        })
        const append = h.journal.append.bind(h.journal)
        const guarded = vi.spyOn(h.journal, "append").mockImplementation(async (input) => {
            await gate
            return append(input)
        })
        const pending = h.owner.awaiting(h.boundary)
        await vi.waitFor(() => expect(guarded).toHaveBeenCalledOnce())
        await h.runtime.submit({ type: "user.cancel", generation: h.state().generation, haltId: "cancel-1" })
        h.owner.suspend("dialog_cancel")
        release()
        await pending
        expect(h.resumption.submit).not.toHaveBeenCalled()
        expect(h.submitted.map((event) => event.type)).not.toContain("dialog.resolved")
        expect(h.state().intake.queued[0]?.state).toBe("consumed")
    })

    it("does not duplicate a tool result journaled before the crash", async () => {
        const h = await harness(...cases[0])
        const payloadRef = await h.payloads.put(
            encodeTaskPayload<ToolResultEnvelope>({
                kind: "tool_result",
                blockId: "block-1",
                content: "ORIGINAL_DURABLE_RESULT",
            }),
        )
        await h.journal.append({
            operationId: "tool.result:original-command",
            source: "tool",
            payloadRef,
            causation: { turnId: "turn-1", commandId: "original-command" },
        })
        await h.owner.awaiting(h.boundary)
        const entries = await h.journal.read()
        expect(entries).toHaveLength(1)
        expect(decodeTaskPayload<ToolResultEnvelope>(await h.payloads.read(entries[0].payloadRef!)).content).toBe(
            "ORIGINAL_DURABLE_RESULT",
        )
        expect(h.resumption.submit).toHaveBeenCalledOnce()
    })

    // The durable draft keeps a resource by reference only; the restored receiver
    // must still be handed it, resolved the same way a live receiver is.
    it("hands the restored receiver the draft's resources resolved from their parts", async () => {
        const image = {
            kind: "resource" as const,
            entityId: "img-1",
            nodeKind: "image" as const,
            displayName: "shot.png",
            ref: {
                resourceId: "00000000-0000-4000-8000-000000000009",
                expectedContentHash: "d".repeat(64),
                mediaType: "image/png",
                byteLength: 4,
                owner: { kind: "task" as const, taskId: "task-1" },
                generation: 1,
            },
        }
        const resolved: unknown[] = []
        const h = await harness(...cases[0], {
            draft: {
                kind: "dialog_draft",
                text: "MODEL_GUIDANCE\nADMITTED_INPUT",
                images: [],
                files: [],
                admittedParts: [{ kind: "text", text: "ADMITTED_INPUT " }, image],
            },
            draftAttachments: {
                resolve: async (parts) => {
                    resolved.push(parts)
                    return { images: [], files: [], notices: ["RESOLVED_FROM_PARTS"] }
                },
            },
        })

        await h.owner.awaiting(h.boundary)

        expect(resolved).toEqual([[{ kind: "text", text: "ADMITTED_INPUT " }, image]])
        const [entry] = await h.journal.read()
        if (!entry?.payloadRef) throw new Error("expected the restored tool result to be journaled")
        const result = decodeTaskPayload<ToolResultEnvelope>(await h.payloads.read(entry.payloadRef))
        expect(result.content).toContain("RESOLVED_FROM_PARTS")
    })

    it("leaves a failed result append recoverable and does not dispatch a fresh response", async () => {
        const h = await harness(...cases[0])
        const append = vi.spyOn(h.journal, "append").mockRejectedValueOnce(new Error("disk unavailable"))
        await h.owner.awaiting(h.boundary)
        expect(append).toHaveBeenCalledOnce()
        expect(h.state().dialog.primary?.acceptedResponse?.queuedInput).toBeDefined()
        expect(h.submitted.map((event) => event.type)).not.toContain("dialog.resolved")
        expect(h.resumption.submit).not.toHaveBeenCalled()
        expect(h.onTurnEndAwaiting).not.toHaveBeenCalled()
    })
})
