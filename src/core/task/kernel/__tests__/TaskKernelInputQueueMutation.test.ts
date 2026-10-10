import { describe, expect, it } from "vitest"
import { pendingIntakeEntryIds } from "../machines/intake"
import { transition } from "../transition"
import { createInitialTaskState, type TaskState, type TransitionResult } from "../types"

function accepted(result: TransitionResult): Extract<TransitionResult, { kind: "accepted" }> {
    if (result.kind !== "accepted") throw new Error(result.diagnostic.message)
    return result
}

function running(): TaskState {
    return { ...createInitialTaskState("task-1"), flow: { phase: "running" } }
}

function enqueue(state: TaskState, entryId: string, payloadRef = `payload:${entryId}`): TaskState {
    return accepted(transition(state, { type: "input_queue.enqueued", generation: state.generation, entryId, payloadRef })).state
}

function awaitingCompletion(state: TaskState): TaskState {
    return {
        ...state,
        dialog: {
            ...state.dialog,
            primary: {
                interactionId: "interaction-1",
                turnId: "turn-1",
                kind: "completion",
                status: "awaiting",
                createdRevision: state.revision,
                presentationRef: "presentation:1",
                actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
                receiverGeneration: state.generation,
            },
        },
    }
}

describe("canonical input queue mutations", () => {
    it("retains enqueue without opening a provider round", () => {
        const result = accepted(
            transition(running(), {
                type: "input_queue.enqueued",
                generation: 0,
                entryId: "queue-1",
                payloadRef: "payload:1",
            }),
        )

        expect(result.commands).toEqual([])
        expect(result.state.intake.queued).toEqual([
            expect.objectContaining({
                entryId: "queue-1",
                payloadRef: "payload:1",
                mode: "queued",
                queue: { editing: false },
                state: "accepted",
            }),
        ])
        expect(pendingIntakeEntryIds(result.state.intake)).toEqual([])
    })

    it.each(["scheduled", "running"] as const)("durably retains input while a compaction is %s", (status) => {
        const state: TaskState = {
            ...running(),
            flow: {
                phase: "running",
                compaction: { compactionId: "compaction-1", attempt: "attempt-1", contextRef: "context:1", status },
            },
        }

        const result = accepted(
            transition(state, {
                type: "input_queue.enqueued",
                generation: 0,
                entryId: "queue-1",
                payloadRef: "payload:1",
            }),
        )

        expect(result.commands).toEqual([])
        expect(result.state.intake.queued).toEqual([
            expect.objectContaining({ entryId: "queue-1", state: "accepted", mode: "queued", queue: { editing: false } }),
        ])
    })

    it("retains input again once the compaction has landed", () => {
        const state: TaskState = {
            ...running(),
            flow: {
                phase: "running",
                compaction: { compactionId: "compaction-1", attempt: "attempt-1", contextRef: "context:1", status: "completed" },
            },
        }

        expect(enqueue(state, "queue-1").intake.queued.map((entry) => entry.entryId)).toEqual(["queue-1"])
    })

    it("applies toggle, reorder, edit, cancel and remove without changing authority", () => {
        let state = enqueue(enqueue(enqueue(running(), "a"), "b"), "c")
        state = accepted(transition(state, { type: "input_queue.mode_toggled", generation: 0, entryId: "b" })).state
        expect(state.intake.queued.find((entry) => entry.entryId === "b")?.mode).toBe("steering")

        state = accepted(transition(state, { type: "input_queue.reordered", generation: 0, entryId: "c", targetIndex: 0 })).state
        expect(
            state.intake.queued
                .filter((entry) => entry.queue)
                .sort((left, right) => left.sequence - right.sequence)
                .map((entry) => entry.entryId),
        ).toEqual(["c", "a", "b"])

        state = accepted(transition(state, { type: "input_queue.edit_started", generation: 0, entryId: "a" })).state
        expect(state.intake.queued.find((entry) => entry.entryId === "a")?.queue).toEqual({ editing: true })

        state = accepted(
            transition(state, {
                type: "input_queue.edit_committed",
                generation: 0,
                entryId: "a",
                payloadRef: "payload:a:edited",
            }),
        ).state
        expect(state.intake.queued.find((entry) => entry.entryId === "a")).toMatchObject({
            payloadRef: "payload:a:edited",
            queue: { editing: false },
        })

        state = accepted(transition(state, { type: "input_queue.edit_started", generation: 0, entryId: "a" })).state
        state = accepted(transition(state, { type: "input_queue.edit_cancelled", generation: 0, entryId: "a" })).state
        expect(state.intake.queued.find((entry) => entry.entryId === "a")?.queue).toEqual({ editing: false })

        state = accepted(transition(state, { type: "input_queue.removed", generation: 0, entryId: "b" })).state
        expect(state.intake.queued.map((entry) => entry.entryId)).toEqual(["a", "c"])
    })

    it("rejects missing entries and capacity overflow without mutation", () => {
        const initial = running()
        const missing = transition(initial, { type: "input_queue.mode_toggled", generation: 0, entryId: "missing" })
        expect(missing).toMatchObject({ kind: "rejected", reason: "identity_mismatch", state: initial })

        let full = initial
        for (let index = 0; index < 32; index++) full = enqueue(full, `entry-${index}`)
        const overflow = transition(full, {
            type: "input_queue.enqueued",
            generation: 0,
            entryId: "overflow",
            payloadRef: "payload:overflow",
        })
        expect(overflow).toMatchObject({ kind: "rejected", reason: "capacity_exceeded", state: full })
    })

    it("reserves every non-editing steering entry before queued input and consumes it with the dialog response", () => {
        let state = enqueue(enqueue(enqueue(running(), "queued"), "steering"), "editing")
        state = accepted(transition(state, { type: "input_queue.mode_toggled", generation: 0, entryId: "steering" })).state
        state = accepted(transition(state, { type: "input_queue.mode_toggled", generation: 0, entryId: "editing" })).state
        state = accepted(transition(state, { type: "input_queue.edit_started", generation: 0, entryId: "editing" })).state
        state = awaitingCompletion(state)

        const reserved = accepted(
            transition(state, {
                type: "input_queue.delivery_reserved",
                generation: 0,
                deliveryId: "delivery-1",
                point: "turn_end",
                ownerId: "interaction-1",
            }),
        )
        expect(reserved.state.intake.queued.find((entry) => entry.entryId === "steering")).toMatchObject({
            state: "reserved",
            queue: { editing: false, delivery: { deliveryId: "delivery-1", point: "turn_end", ownerId: "interaction-1" } },
        })
        expect(reserved.state.intake.queued.find((entry) => entry.entryId === "queued")?.state).toBe("accepted")
        expect(reserved.state.intake.queued.find((entry) => entry.entryId === "editing")?.state).toBe("accepted")

        const responded = accepted(
            transition(reserved.state, {
                type: "dialog.responded",
                generation: 0,
                taskId: "task-1",
                turnId: "turn-1",
                interactionId: "interaction-1",
                stateRevision: reserved.state.revision,
                receiverGeneration: 0,
                actionId: "reply",
                draftRef: "draft:1",
                queueDeliveryId: "delivery-1",
                queueDeliveryEntries: [{ entryId: "steering", payloadRef: "payload:steering" }],
                queueDeliveryMode: "steering",
            }),
        )
        expect(responded.state.intake.queued.find((entry) => entry.entryId === "steering")).toMatchObject({
            state: "consumed",
            queue: { editing: false },
        })
    })

    it("takes one queued entry at turn end and rejects the response when removal wins the race", () => {
        let state = awaitingCompletion(enqueue(enqueue(running(), "first"), "second"))
        const reserved = accepted(
            transition(state, {
                type: "input_queue.delivery_reserved",
                generation: 0,
                deliveryId: "delivery-1",
                point: "turn_end",
                ownerId: "interaction-1",
            }),
        )
        expect(reserved.state.intake.queued.find((entry) => entry.entryId === "first")?.state).toBe("reserved")
        expect(reserved.state.intake.queued.find((entry) => entry.entryId === "second")?.state).toBe("accepted")

        state = accepted(transition(reserved.state, { type: "input_queue.removed", generation: 0, entryId: "first" })).state
        const response = transition(state, {
            type: "dialog.responded",
            generation: 0,
            taskId: "task-1",
            turnId: "turn-1",
            interactionId: "interaction-1",
            stateRevision: state.revision,
            receiverGeneration: 0,
            actionId: "reply",
            draftRef: "draft:1",
            queueDeliveryId: "delivery-1",
        })
        expect(response).toMatchObject({ kind: "rejected", reason: "identity_mismatch" })
    })
})
