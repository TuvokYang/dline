import { describe, expect, it } from "vitest"
import { hydrate } from "../hydrate"
import { transition } from "../transition"
import { createInitialTaskState, type TaskEvent, type TaskState } from "../types"

function apply(state: TaskState, event: TaskEvent): TaskState {
    const result = transition(state, event)
    if (result.kind !== "accepted") throw new Error(result.diagnostic.message)
    return result.state
}

function reserved(): TaskState {
    const base = createInitialTaskState("task-1")
    let state: TaskState = {
        ...base,
        flow: {
            phase: "running",
            compose: { commandId: "old-compose", originRevision: 0, status: "completed", admittedEntryIds: [] },
        },
        dialog: {
            approvalsByBlock: {},
            primary: {
                interactionId: "dialog-1",
                turnId: "turn-1",
                kind: "completion",
                status: "awaiting",
                createdRevision: 0,
                presentationRef: "presentation:1",
                actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
                receiverGeneration: 0,
            },
        },
    }
    for (const entryId of ["a", "b"]) {
        state = apply(state, { type: "input_queue.enqueued", generation: 0, entryId, payloadRef: `payload:${entryId}` })
        state = apply(state, { type: "input_queue.mode_toggled", generation: 0, entryId })
    }
    return apply(state, {
        type: "input_queue.delivery_reserved",
        generation: 0,
        deliveryId: "delivery-1",
        point: "turn_end",
        ownerId: "dialog-1",
    })
}

function response(state: TaskState): Extract<TaskEvent, { type: "dialog.responded" }> {
    return {
        type: "dialog.responded",
        generation: 0,
        taskId: "task-1",
        turnId: "turn-1",
        interactionId: "dialog-1",
        stateRevision: state.revision,
        receiverGeneration: 0,
        actionId: "reply",
        draftRef: "draft:ab",
        queueDeliveryId: "delivery-1",
        queueDeliveryMode: "steering",
        queueDeliveryEntries: [
            { entryId: "a", payloadRef: "payload:a" },
            { entryId: "b", payloadRef: "payload:b" },
        ],
    }
}

function pendingToolRound(): TaskState {
    const base = createInitialTaskState("task-1")
    const entries = [
        { entryId: "a", payloadRef: "payload:a" },
        { entryId: "b", payloadRef: "payload:b" },
    ]
    const delivery = {
        deliveryId: "delivery-tool-1",
        point: "tool_round" as const,
        ownerId: "compose:tool-1",
        generation: 0,
    }
    return {
        ...base,
        flow: {
            phase: "running",
            compose: {
                commandId: delivery.ownerId,
                originRevision: 3,
                status: "completed",
                admittedEntryIds: entries.map((entry) => entry.entryId),
                queueJournalReceipt: {
                    deliveryId: delivery.deliveryId,
                    entries,
                    journalWatermark: { seq: 4 },
                },
            },
            provider: { commandId: "provider:tool-1", originRevision: 4, status: "running" },
        },
        intake: {
            ...base.intake,
            queued: entries.map((entry, sequence) => ({
                ...entry,
                source: "user" as const,
                mode: "steering" as const,
                sequence,
                state: "included" as const,
                queue: { editing: false, delivery },
            })),
        },
    }
}

describe("retained queue delivery safety", () => {
    it("refuses stale materialized content when one member of a steering batch was removed", () => {
        const state = apply(reserved(), { type: "input_queue.removed", generation: 0, entryId: "a" })
        const rejected = transition(state, response(state))
        expect(rejected).toMatchObject({ kind: "rejected", reason: "identity_mismatch" })
        expect(state.intake.queued).toHaveLength(1)
        expect(state.intake.queued[0]).toMatchObject({ entryId: "b", state: "reserved" })
    })

    it("releases all retained reservations on cancel even when an older compose owned an empty batch", () => {
        const cancelled = apply(reserved(), { type: "user.cancel", generation: 0, haltId: "halt-1" })
        expect(cancelled.intake.queued.map((entry) => entry.state)).toEqual(["released", "released"])
        expect(cancelled.intake.queued.map((entry) => entry.queue?.delivery)).toEqual([undefined, undefined])
        expect(transition(cancelled, response(cancelled))).toMatchObject({ kind: "rejected", reason: "generation_mismatch" })
        expect(transition(cancelled, { ...response(cancelled), generation: cancelled.generation })).toMatchObject({
            kind: "rejected",
        })
    })

    it("retires the queued response only with matching terminal tool feedback", () => {
        const accepted = apply(reserved(), response(reserved()))
        const state: TaskState = {
            ...accepted,
            turn: {
                ...accepted.turn,
                turnId: "turn-1",
                executingBlockIds: ["dialog-1"],
                blocks: [
                    {
                        blockId: "dialog-1",
                        attempt: "attempt-1",
                        index: 0,
                        phase: "executing",
                        lanes: [],
                        turnEnding: true,
                        invocationRef: "invocation:1",
                    },
                ],
            },
        }
        const settled = apply(state, {
            type: "tool.completed",
            generation: 0,
            turnId: "turn-1",
            blockId: "dialog-1",
            attempt: "attempt-1",
        })
        expect(settled.dialog.primary).toBeUndefined()
        expect(settled.flow.pendingQueueResponse?.deliveryId).toBe("delivery-1")
        expect(settled.intake.queued.map((entry) => entry.state)).toEqual(["consumed", "consumed"])
    })

    it("reveals the durable response's owner after restart without allowing another response", () => {
        const before = reserved()
        const state = apply(before, response(before))
        const primary = state.dialog.primary!
        const restored = hydrate({
            taskId: "task-1",
            journalTail: { seq: 0 },
            openReason: "crash_recovery",
            snapshot: { ...state, dialog: { ...state.dialog, primary: { ...primary, journalRef: "journal:0" } } },
        })
        expect(restored.state.dialog.primary).toMatchObject({
            status: "prepared",
            acceptedResponse: { queuedInput: { deliveryId: "delivery-1" } },
        })
        expect(restored.initialCommands).toHaveLength(1)
        const command = restored.initialCommands[0]
        if (command.type !== "dialog.reveal") throw new Error("Expected reveal command")
        const shown = apply(restored.state, {
            type: "dialog.presented",
            generation: command.generation,
            commandId: command.commandId,
            originRevision: command.originRevision,
            interactionId: command.interactionId,
        })
        expect(
            transition(shown, {
                ...response(shown),
                generation: shown.generation,
                receiverGeneration: shown.generation,
                stateRevision: shown.revision,
            }),
        ).toMatchObject({ kind: "rejected", reason: "duplicate" })
    })

    it("restores a reserved but unanswered turn-end batch, and never restores a durably accepted response", () => {
        const before = reserved()
        const restored = hydrate({ taskId: "task-1", snapshot: before, journalTail: { seq: 0 }, openReason: "crash_recovery" })
        expect(restored.state.intake.queued.map((entry) => entry.state)).toEqual(["released", "released"])
        expect(restored.state.intake.queued.map((entry) => entry.queue?.editing)).toEqual([false, false])
        const consumed = apply(before, response(before))
        const reopened = hydrate({ taskId: "task-1", snapshot: consumed, journalTail: { seq: 0 }, openReason: "crash_recovery" })
        expect(reopened.state.intake.queued.map((entry) => entry.state)).toEqual(["consumed", "consumed"])
        expect(reopened.state.flow.pendingQueueResponse?.entries).toEqual(response(before).queueDeliveryEntries)
    })

    it("accepts a retained compose receipt in admitted order after queue reordering changed physical array order", () => {
        const pending = pendingToolRound()
        const owner = pending.flow.compose!
        const receipt = owner.queueJournalReceipt!
        const { queueJournalReceipt: _receipt, ...runningOwner } = owner
        const state: TaskState = {
            ...pending,
            flow: { ...pending.flow, compose: { ...runningOwner, status: "running" } },
            intake: {
                ...pending.intake,
                queued: [...pending.intake.queued].reverse().map((entry) => ({ ...entry, state: "reserved" as const })),
            },
        }

        const result = transition(state, {
            type: "compose.completed",
            generation: 0,
            commandId: runningOwner.commandId,
            originRevision: runningOwner.originRevision,
            draftRef: "draft:reordered",
            queueJournalReceipt: receipt,
        })

        expect(result).toMatchObject({
            kind: "accepted",
            commands: [expect.objectContaining({ type: "provider.start", draftRef: "draft:reordered" })],
        })
    })

    it("advances the canonical journal watermark when a tool-round delivery is reconciled as consumed", () => {
        const state = pendingToolRound()
        const reconciled = apply(state, {
            type: "input_queue.delivery_reconciled",
            generation: 0,
            deliveryId: "delivery-tool-1",
            outcome: "consumed",
            journalWatermark: { seq: 9 },
        })

        expect(reconciled.journalWatermark).toEqual({ seq: 9 })
        expect(
            reconciled.intake.queued.map((entry) => ({
                state: entry.state,
                delivery: entry.queue?.delivery,
                journalWatermark: entry.journalWatermark,
            })),
        ).toEqual([
            { state: "consumed", delivery: undefined, journalWatermark: { seq: 9 } },
            { state: "consumed", delivery: undefined, journalWatermark: { seq: 9 } },
        ])
    })

    it("keeps an unresolved tool-round delivery fenced and applies shell-proven settlements", () => {
        const snapshot = pendingToolRound()
        const unresolved = hydrate({
            taskId: "task-1",
            snapshot,
            journalTail: { seq: 8 },
            openReason: "crash_recovery",
        })
        expect(unresolved.state.intake.queued).toEqual([
            expect.objectContaining({
                state: "uncertain",
                queue: expect.objectContaining({ delivery: expect.objectContaining({ deliveryId: "delivery-tool-1" }) }),
            }),
            expect.objectContaining({
                state: "uncertain",
                queue: expect.objectContaining({ delivery: expect.objectContaining({ deliveryId: "delivery-tool-1" }) }),
            }),
        ])

        const released = hydrate({
            taskId: "task-1",
            snapshot,
            journalTail: { seq: 8 },
            openReason: "crash_recovery",
            queueSettlements: [{ deliveryId: "delivery-tool-1", outcome: "released" }],
        })
        expect(released.state.intake.queued.map((entry) => ({ state: entry.state, delivery: entry.queue?.delivery }))).toEqual([
            { state: "released", delivery: undefined },
            { state: "released", delivery: undefined },
        ])

        const consumed = hydrate({
            taskId: "task-1",
            snapshot,
            journalTail: { seq: 9 },
            openReason: "crash_recovery",
            queueSettlements: [{ deliveryId: "delivery-tool-1", outcome: "consumed", journalWatermark: { seq: 9 } }],
        })
        expect(
            consumed.state.intake.queued.map((entry) => ({
                state: entry.state,
                delivery: entry.queue?.delivery,
                journalWatermark: entry.journalWatermark,
            })),
        ).toEqual([
            { state: "consumed", delivery: undefined, journalWatermark: { seq: 9 } },
            { state: "consumed", delivery: undefined, journalWatermark: { seq: 9 } },
        ])
    })
})
