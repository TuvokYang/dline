import { describe, expect, it, vi } from "vitest"
import type { DialogCommand, TaskEvent } from "../../kernel"
import { DialogCommandExecutor } from "./DialogCommandExecutor"

const input = {
    commandId: "dialog-1",
    originRevision: 1,
    generation: 0,
    interactionId: "i-1",
    turnId: "turn-1",
    kind: "followup",
    presentationRef: "question:1",
    actionRules: [{ actionId: "reply", payloadPolicy: "draft" as const }],
    prepareKey: "dialog.prepare:i-1",
}

function prepare(): Extract<DialogCommand, { type: "dialog.prepare" }> {
    return { ...input, type: "dialog.prepare" }
}

function reveal(): Extract<DialogCommand, { type: "dialog.reveal" }> {
    return {
        ...input,
        commandId: "dialog-2",
        originRevision: 2,
        type: "dialog.reveal",
        journalRef: "journal:1",
        receiverGeneration: 4,
        revealKey: "dialog.reveal:i-1:4",
    }
}

describe("DialogCommandExecutor", () => {
    it("registers preparation before feedback and reveals only after the durable command arrives", async () => {
        const events: TaskEvent[] = []
        const port = {
            prepare: vi.fn(async () => ({
                journalRef: "journal:1",
                journalWatermark: { seq: 1 },
                receiverGeneration: 4,
                disposition: "created" as const,
            })),
            reveal: vi.fn(async () => ({ disposition: "revealed" as const })),
        }
        const executor = new DialogCommandExecutor(port, {
            submit: async (event) => (events.push(event), { kind: "accepted" as const }),
        })

        await executor.execute(prepare())
        await executor.execute(reveal())

        expect(port.prepare).toHaveBeenCalledWith(expect.objectContaining({ presentationRef: "question:1" }))
        expect(events).toEqual([
            expect.objectContaining({ type: "dialog.prepared", commandId: "dialog-1", journalRef: "journal:1" }),
            expect.objectContaining({ type: "dialog.presented", commandId: "dialog-2", interactionId: "i-1" }),
        ])
    })

    it("notifies awaiting observers only after the presented state is durable", async () => {
        let makeDurable!: () => void
        const durable = new Promise<void>((resolve) => {
            makeDurable = resolve
        })
        const awaiting = { awaiting: vi.fn(async () => undefined) }
        const executor = new DialogCommandExecutor(
            {
                prepare: async () => ({
                    journalRef: "journal:1",
                    journalWatermark: { seq: 1 },
                    receiverGeneration: 4,
                    disposition: "created" as const,
                }),
                reveal: async () => ({ disposition: "revealed" as const }),
            },
            { submit: async () => ({ kind: "accepted" as const, durable }) },
            undefined,
            awaiting,
        )

        const running = executor.execute(reveal())
        await Promise.resolve()
        expect(awaiting.awaiting).not.toHaveBeenCalled()

        makeDurable()
        await running
        expect(awaiting.awaiting).toHaveBeenCalledExactlyOnceWith({
            turnId: "turn-1",
            interactionId: "i-1",
            kind: "followup",
        })
    })

    it("dismisses a reveal whose presented feedback loses the causal race", async () => {
        const dismiss = vi.fn(async () => undefined)
        const executor = new DialogCommandExecutor(
            {
                prepare: async () => ({
                    journalRef: "journal:1",
                    journalWatermark: { seq: 1 },
                    receiverGeneration: 4,
                    disposition: "existing" as const,
                }),
                reveal: async () => ({ disposition: "already_revealed" as const }),
                dismiss,
            },
            { submit: async () => ({ kind: "rejected" as const }) },
        )
        await executor.execute(reveal())
        expect(dismiss).toHaveBeenCalledWith(
            expect.objectContaining({ interactionId: "i-1", reason: "presentation_feedback_rejected" }),
        )
    })

    it("suspends receivers for the whole halt and admits them again on rearm", async () => {
        const waiters = { suspend: vi.fn(), resume: vi.fn() }
        const executor = new DialogCommandExecutor(
            {
                prepare: async () => ({
                    journalRef: "journal:1",
                    journalWatermark: { seq: 1 },
                    receiverGeneration: 4,
                    disposition: "created" as const,
                }),
                reveal: async () => ({ disposition: "revealed" as const }),
            },
            { submit: async () => ({ kind: "accepted" as const }) },
            waiters,
        )
        const order = { haltId: "halt-1", generation: 0, reason: "terminate" as const }
        executor.fence(order)
        executor.stop(order)
        await executor.drain(order)

        // Without this the tool domain drains by waiting for a turn-ending block
        // that is itself waiting for this domain, and the stop never completes.
        expect(waiters.suspend).toHaveBeenCalledExactlyOnceWith("dialog_terminate")
        // Refusal has to outlast the stop itself: a tool still finishing other
        // work asks for its dialog afterwards and would wait just as forever.
        expect(waiters.resume).not.toHaveBeenCalled()

        executor.rearm("halt-1")

        expect(waiters.resume).toHaveBeenCalledOnce()
    })

    it("keeps receivers refused when an unrelated halt rearms", async () => {
        const waiters = { suspend: vi.fn(), resume: vi.fn() }
        const executor = new DialogCommandExecutor(
            {
                prepare: async () => ({
                    journalRef: "journal:1",
                    journalWatermark: { seq: 1 },
                    receiverGeneration: 4,
                    disposition: "created" as const,
                }),
                reveal: async () => ({ disposition: "revealed" as const }),
            },
            { submit: async () => ({ kind: "accepted" as const }) },
            waiters,
        )
        const order = { haltId: "halt-1", generation: 0, reason: "cancel" as const }
        executor.fence(order)
        executor.stop(order)

        executor.rearm("halt-0")

        expect(waiters.resume).not.toHaveBeenCalled()
    })

    it("sanitizes port failures and does not present after cancellation", async () => {
        const events: TaskEvent[] = []
        const executor = new DialogCommandExecutor(
            {
                prepare: async () => {
                    const error = new Error("secret payload")
                    error.name = "DialogBackendError"
                    throw error
                },
                reveal: async ({ signal }) =>
                    new Promise<{ disposition: "revealed" }>((_, reject) =>
                        signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
                    ),
            },
            { submit: async (event) => (events.push(event), { kind: "accepted" as const }) },
        )
        await executor.execute(prepare())
        expect(events[0]).toMatchObject({ type: "dialog.failed", message: "dialog execution failed (DialogBackendError)" })

        const revealing = executor.execute(reveal())
        const order = { haltId: "halt-1", generation: 0, reason: "cancel" as const }
        executor.fence(order)
        executor.stop(order)
        await executor.drain(order)
        await revealing
        expect(events.some((event) => event.type === "dialog.presented")).toBe(false)
    })
})
