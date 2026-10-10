import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it, vi } from "vitest"
import { isInteractionCancellationError } from "../../interaction/InteractionCancellationError"
import { createInitialTaskState, type DialogInteraction, type TaskState } from "../../kernel"
import type { MessageStateHandler } from "../../message-state"
import type { RuntimeDiagnostic } from "../../runtime"
import type { TaskPayloadStore } from "../../stores"
import type { ActiveTaskSession } from "../ActiveTaskSession"
import { TaskInteractionOwner } from "../TaskInteractionOwner"
import type { UnownedDialogContinuationPort, UnownedDialogOutcome } from "../UnownedDialogContinuation"

function createMessages(rows: UiMessage[] = []): MessageStateHandler {
    return {
        clineMessages: rows,
        addToClineMessages: vi.fn(async () => undefined),
        finalizeClineMessage: vi.fn(async () => undefined),
        flushUiMessages: vi.fn(async () => undefined),
        removeMessagesByTs: vi.fn(async (timestamps: number[]) => {
            for (const timestamp of timestamps) {
                const index = rows.findIndex((row) => row.ts === timestamp)
                if (index >= 0) rows.splice(index, 1)
            }
        }),
    } as unknown as MessageStateHandler
}

/** A dialog the kernel restored, which no receiver in this process awaits. */
function restoredPrimary(interactionId: string, kind: DialogInteraction["kind"]): TaskState {
    const state = createInitialTaskState("task-1")
    return {
        ...state,
        dialog: {
            ...state.dialog,
            primary: {
                interactionId,
                turnId: "turn-restored",
                kind,
                status: "awaiting",
                createdRevision: state.revision,
                presentationRef: "sha256:presentation",
                actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
                receiverGeneration: state.generation,
            },
        },
    }
}

function createOwner(options?: {
    readonly continuation?: UnownedDialogContinuationPort
    readonly state?: () => TaskState
    readonly messages?: MessageStateHandler
    readonly nextPresentationId?: () => number
    readonly publishRow?: (row: UiMessage) => unknown
    readonly submit?: (event: { type: string }) => Promise<{
        readonly kind: "accepted"
        readonly receipt?: { readonly durable: Promise<void> }
    }>
}): {
    owner: TaskInteractionOwner
    messages: MessageStateHandler
    submitted: string[]
    recorded: RuntimeDiagnostic[]
    /** Resolves on the next event the owner submits; arm it before causing one. */
    whenSubmitted: () => Promise<void>
} {
    const submitted: string[] = []
    const recorded: RuntimeDiagnostic[] = []
    let announce: (() => void) | undefined
    const payloads = { put: vi.fn(async () => "sha256:payload"), read: vi.fn() } as unknown as TaskPayloadStore
    const messages = options?.messages ?? createMessages()
    const owner = new TaskInteractionOwner(
        messages,
        payloads,
        options?.continuation,
        { record: (diagnostic) => recorded.push(diagnostic) },
        options?.publishRow,
    )
    const session = {
        ...(options?.nextPresentationId ? { owners: { nextPresentationId: options.nextPresentationId } } : {}),
        state: options?.state ?? (() => createInitialTaskState("task-1")),
        assembly: {
            runtime: {
                submit: async (event: { type: string }) => {
                    submitted.push(event.type)
                    announce?.()
                    return options?.submit?.(event) ?? { kind: "accepted" as const }
                },
            },
        },
    } as unknown as ActiveTaskSession
    owner.bind(session)
    // A request registers its receiver immediately before submitting the event,
    // so the submission is when a stop would first find something to release.
    return { owner, messages, submitted, recorded, whenSubmitted: () => new Promise<void>((resolve) => (announce = resolve)) }
}

function continuationPort(outcome: UnownedDialogOutcome): UnownedDialogContinuationPort & {
    readonly continue: ReturnType<typeof vi.fn>
} {
    return { accepts: () => outcome !== "declined", continue: vi.fn(async () => outcome) }
}

describe("TaskInteractionOwner", () => {
    it("fails a receiver whose answer a stop has made impossible", async () => {
        const { owner, whenSubmitted } = createOwner()
        const waiting = owner.open({
            turnId: "turn-1",
            interactionId: "i-1",
            kind: "completion",
            presentation: "done",
        })
        await whenSubmitted()

        owner.suspend("dialog_terminate")

        // A turn-ending tool parked here is in-flight work of the tool domain, so
        // the stop that fenced this dialog drains by waiting for it. It has to
        // fail rather than keep waiting for an answer that can no longer arrive.
        await expect(waiting).rejects.toSatisfy(isInteractionCancellationError)
    })

    it("refuses a receiver that arrives after the stop, not just the ones already waiting", async () => {
        const { owner, submitted } = createOwner()
        owner.suspend("dialog_terminate")

        // The tool was busy elsewhere when the stop ran — writing a checkpoint,
        // for instance — and asks only now. Admitting it would park it on an
        // answer the stopped domain can no longer deliver, which is exactly the
        // wait that kept the task from ever finishing its teardown.
        const late = owner.complete({
            turnId: "turn-1",
            interactionId: "i-late",
            completionId: "c-late",
            presentation: "done",
        })

        await expect(late).rejects.toSatisfy(isInteractionCancellationError)
        expect(submitted).toEqual([])
    })

    it.each([
        ["partial", [{ ts: 10, partial: true }]],
        [
            "duplicated",
            [
                { ts: 10, partial: false },
                { ts: 11, partial: false },
            ],
        ],
    ] as const)("replaces a %s anchor row with exactly one complete row", async (_shape, torn) => {
        const rows: UiMessage[] = [
            { ts: 1, type: "say", say: "text", text: "kept" },
            ...torn.map((row) => ({
                ...row,
                type: "ask" as const,
                ask: "tool" as const,
                text: "{}",
                interactionId: "approval-1",
            })),
        ]
        const messages = createMessages(rows)
        vi.mocked(messages.addToClineMessages).mockImplementation(async (row) => {
            rows.push(row as UiMessage)
        })
        const { owner } = createOwner({ messages, nextPresentationId: () => 50 })

        await owner.anchor({ interactionId: "approval-1", kind: "tool_approval", body: '{"tool":"readFile","path":"a.txt"}' })

        const anchors = rows.filter((row) => row.type === "ask" && row.interactionId === "approval-1")
        expect(anchors).toHaveLength(1)
        expect(anchors[0]).toMatchObject({ ask: "tool", text: '{"tool":"readFile","path":"a.txt"}' })
        expect(anchors[0].partial).not.toBe(true)
        expect(rows[0]).toMatchObject({ ts: 1, text: "kept" })
    })

    it("promotes a streamed command row into its approval anchor without appending a duplicate", async () => {
        const rows: UiMessage[] = [{ ts: 10, type: "say", say: "command", text: "npm test", partial: true }]
        const messages = createMessages(rows)
        const { owner } = createOwner({ messages, nextPresentationId: () => 50 })

        await owner.anchor({
            interactionId: "approval:tid-command",
            kind: "tool_approval",
            ask: "command",
            body: "npm test",
        })

        expect(messages.finalizeClineMessage).toHaveBeenCalledWith(
            expect.objectContaining({
                ts: 10,
                type: "ask",
                ask: "command",
                interactionId: "approval:tid-command",
                commandStatus: "pending",
                partial: false,
            }),
        )
        expect(messages.addToClineMessages).not.toHaveBeenCalled()
    })

    it("keeps a single complete anchor row as it is", async () => {
        const anchor: UiMessage = { ts: 10, type: "ask", ask: "tool", text: "{}", partial: false, interactionId: "approval-1" }
        const messages = createMessages([anchor])
        const { owner } = createOwner({ messages })

        await owner.anchor({ interactionId: "approval-1", kind: "tool_approval", body: "{}" })

        expect(messages.removeMessagesByTs).not.toHaveBeenCalled()
        expect(messages.addToClineMessages).not.toHaveBeenCalled()
    })

    it("dismisses an invalid-Profile failure and removes its obsolete rows", async () => {
        const failure = 'Profile not valid: "azure-profile" requires an Azure endpoint for Azure Identity authentication.'
        const messages = createMessages([
            { ts: 1, type: "say", say: "error_retry", text: JSON.stringify({ errorMessage: failure }) },
            {
                ts: 2,
                type: "ask",
                ask: "api_req_failed",
                text: failure,
                interactionId: "i-error",
            },
        ])
        const restored = restoredPrimary("i-error", "error_retry")
        const state = () => ({ ...restored, flow: { phase: "error" as const, error: failure } })
        const { owner, submitted } = createOwner({ messages, state })

        await owner.dismissProviderFailure()

        expect(submitted).toEqual(["dialog.dismissed"])
        expect(messages.removeMessagesByTs).toHaveBeenCalledWith([1, 2])
        expect(messages.clineMessages).toEqual([])
    })

    it("keeps a rate-limit failure retryable across a Profile switch", async () => {
        const failure = "429 E2E_PROFILE_SWITCH_429_RATE_LIMIT"
        const rows = [
            { ts: 1, type: "say" as const, say: "error_retry" as const, text: JSON.stringify({ errorMessage: failure }) },
            { ts: 2, type: "ask" as const, ask: "api_req_failed" as const, text: failure, interactionId: "i-error" },
        ]
        const messages = createMessages(rows)
        const restored = restoredPrimary("i-error", "error_retry")
        const state = () => ({ ...restored, flow: { phase: "error" as const, error: failure } })
        const { owner, submitted } = createOwner({ messages, state })

        await owner.dismissProviderFailure()

        expect(submitted).toEqual([])
        expect(messages.removeMessagesByTs).not.toHaveBeenCalled()
        expect(messages.clineMessages).toEqual(rows)
    })

    // The anchor replaces the completion row in place. A reply arriving before
    // the store commits that rewrite on its own would find the buffer unclean,
    // and the dialog would be open over an anchor that exists only in memory.
    it("commits and pushes a completion anchor before the dialog is requested", async () => {
        const order: string[] = []
        const messages = createMessages([{ ts: 7, type: "say", say: "completion_result", text: "done" }])
        vi.mocked(messages.finalizeClineMessage).mockImplementation(async () => {
            order.push("anchor")
            return undefined as never
        })
        vi.mocked(messages.flushUiMessages).mockImplementation(async () => {
            order.push("flush")
        })
        const pushed: UiMessage[] = []
        const { owner, submitted, whenSubmitted } = createOwner({
            messages,
            publishRow: (row) => {
                order.push("push")
                pushed.push(row)
            },
        })
        const submittedNext = whenSubmitted()

        void owner.complete({
            turnId: "turn-1",
            interactionId: "i-completion",
            completionId: "c-1",
            presentation: "done",
            existingTs: 7,
        })
        await submittedNext
        order.push(...submitted)

        // The webview must get the reply surface even if no later state reaches it.
        expect(order).toEqual(["anchor", "flush", "push", "dialog.requested"])
        expect(pushed).toEqual([expect.objectContaining({ ts: 7 })])
    })

    // Another producer may hold the current millisecond. Reusing it would turn
    // the anchor into an in-place replacement of that producer's row.
    it("draws a new anchor's id from the session sequence, not the wall clock", async () => {
        vi.spyOn(Date, "now").mockReturnValue(1000)
        try {
            const messages = createMessages([{ ts: 1000, type: "say", say: "user_feedback", text: "/compact" }])
            const { owner, whenSubmitted } = createOwner({ messages, nextPresentationId: () => 1001 })
            const submittedNext = whenSubmitted()

            void owner.open({ turnId: "turn-1", interactionId: "i-followup", kind: "followup", presentation: "ask" })
            await submittedNext

            expect(messages.finalizeClineMessage).not.toHaveBeenCalled()
            expect(messages.addToClineMessages).toHaveBeenCalledWith(
                expect.objectContaining({ ts: 1001, interactionId: "i-followup" }),
            )
        } finally {
            vi.restoreAllMocks()
        }
    })

    it("stays usable after a stop, because a cancelled task may resume", async () => {
        const { owner, submitted, whenSubmitted } = createOwner()
        const abandoned = owner.open({ turnId: "turn-1", interactionId: "i-1", kind: "followup", presentation: "ask" })
        await whenSubmitted()
        owner.suspend("dialog_cancel")
        await expect(abandoned).rejects.toSatisfy(isInteractionCancellationError)
        owner.resume()

        const reopened = owner.open({ turnId: "turn-2", interactionId: "i-2", kind: "followup", presentation: "ask again" })
        await whenSubmitted()
        const retired = whenSubmitted()
        owner.resolve("i-2", { actionId: "reply" })
        await retired

        await expect(reopened).resolves.toMatchObject({ actionId: "reply" })
        expect(submitted).toEqual(["dialog.requested", "dialog.requested", "dialog.resolved"])
    })

    it("keeps a delivered queued response owned until terminal tool feedback", async () => {
        const state = restoredPrimary("i-queued", "followup")
        const primary = state.dialog.primary!
        const { owner, submitted, whenSubmitted } = createOwner({
            state: () => ({
                ...state,
                dialog: {
                    ...state.dialog,
                    primary: {
                        ...primary,
                        status: "resolving",
                        acceptedResponse: {
                            actionId: "reply",
                            stateRevision: 0,
                            receiverGeneration: 0,
                            draftRef: "sha256:draft",
                            queuedInput: {
                                deliveryId: "delivery-1",
                                mode: "queued",
                                entries: [{ entryId: "entry-1", payloadRef: "sha256:raw" }],
                            },
                        },
                    },
                },
            }),
        })
        const waiting = owner.open({
            turnId: "turn-restored",
            interactionId: "i-queued",
            kind: "followup",
            presentation: "question",
        })
        await whenSubmitted()
        owner.resolve("i-queued", { actionId: "reply", feedbackPresented: true })
        await expect(waiting).resolves.toMatchObject({ actionId: "reply", feedbackPresented: true })
        expect(submitted).toEqual(["dialog.requested"])
    })

    // Retiring says the answer reached whoever had to act on it. When the
    // continuation carries the task on, that is true and the dialog must be
    // released so the next one can open.
    it("retires a restored dialog once the continuation carries the task on", async () => {
        const continuation = continuationPort("continued")
        const { owner, submitted } = createOwner({
            continuation,
            state: () => restoredPrimary("i-restored", "completion"),
        })

        owner.resolve("i-restored", { actionId: "reply" })
        await vi.waitFor(() =>
            expect(continuation.continue).toHaveBeenCalledWith(
                expect.objectContaining({ interactionId: "i-restored", kind: "completion" }),
            ),
        )

        // Retired before the continuation ran, because the round it opens needs
        // the dialog slot the retire releases.
        expect(submitted).toEqual(["dialog.resolved"])
    })

    // Retiring a dialog nothing acted on told the kernel the answer was
    // consumed while the task stayed paused with no dialog at all, which is
    // what left the composer permanently disabled after reopening a task.
    it("keeps a restored dialog answerable when nothing carried the task on", async () => {
        const continuation = continuationPort("declined")
        const { owner, submitted, recorded } = createOwner({
            continuation,
            state: () => restoredPrimary("i-restored", "completion"),
        })

        owner.resolve("i-restored", { actionId: "start_new_task" })
        await vi.waitFor(() =>
            expect(recorded).toContainEqual(
                expect.objectContaining({ source: "dialog", code: "unowned_dialog_settled", severity: "observation" }),
            ),
        )

        expect(submitted).toEqual([])
    })

    // Every unowned answer is reported, because "the task resumed" and "the
    // answer went nowhere" are otherwise indistinguishable in the log.
    it("reports how a restored dialog was settled even when the task carried on", async () => {
        const { owner, recorded } = createOwner({
            continuation: continuationPort("continued"),
            state: () => restoredPrimary("i-restored", "completion"),
        })

        owner.resolve("i-restored", { actionId: "reply" })
        await vi.waitFor(() =>
            expect(recorded).toContainEqual(
                expect.objectContaining({ code: "unowned_dialog_settled", message: expect.stringContaining("continued") }),
            ),
        )
    })

    // A continuation that accepted the answer but then failed to act on it must
    // leave the question answerable, or the task is stuck with no dialog.
    it("reopens a restored dialog when the continuation accepted but failed", async () => {
        const { owner, submitted } = createOwner({
            continuation: continuationPort("failed"),
            state: () => restoredPrimary("i-restored", "completion"),
        })

        owner.resolve("i-restored", { actionId: "reply" })
        await vi.waitFor(() => expect(submitted).toEqual(["dialog.resolved", "dialog.reopened"]))
    })

    // A receiver is the one that acts on the answer, so its dialog retires on
    // delivery and never consults the continuation.
    it("retires an awaited dialog without asking the continuation", async () => {
        const continuation = continuationPort("declined")
        const { owner, submitted, whenSubmitted } = createOwner({ continuation })
        const waiting = owner.open({ turnId: "turn-1", interactionId: "i-1", kind: "followup", presentation: "ask" })
        await whenSubmitted()

        const retired = whenSubmitted()
        owner.resolve("i-1", { actionId: "reply" })
        await retired

        await expect(waiting).resolves.toMatchObject({ actionId: "reply" })
        expect(continuation.continue).not.toHaveBeenCalled()
        expect(submitted).toEqual(["dialog.requested", "dialog.resolved"])
    })

    it("does not release an awaited handler until dialog retirement is durable", async () => {
        let releaseRetirement!: () => void
        const retirementDurable = new Promise<void>((resolve) => {
            releaseRetirement = resolve
        })
        const { owner, whenSubmitted } = createOwner({
            submit: async (event) =>
                event.type === "dialog.resolved"
                    ? { kind: "accepted", receipt: { durable: retirementDurable } }
                    : { kind: "accepted" },
        })
        const waiting = owner.open({ turnId: "turn-1", interactionId: "i-1", kind: "followup", presentation: "ask" })
        await whenSubmitted()
        let released = false
        void waiting.then(() => {
            released = true
        })

        const retired = whenSubmitted()
        owner.resolve("i-1", { actionId: "reply" })
        await retired
        await Promise.resolve()
        expect(released).toBe(false)

        releaseRetirement()
        await expect(waiting).resolves.toMatchObject({ actionId: "reply" })
        expect(released).toBe(true)
    })
})
