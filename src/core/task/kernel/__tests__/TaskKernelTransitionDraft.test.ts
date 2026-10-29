import { describe, expect, it } from "vitest"
import { hydrate, requiredPayloadRefs } from "../hydrate"
import { openTransitionDraft, replyableDialog } from "../machines/transition-draft"
import { transition } from "../transition"
import type { TaskEvent, TaskState, TransitionResult } from "../types"
import { createInitialTaskState } from "../types"

function accepted(result: TransitionResult): Extract<TransitionResult, { kind: "accepted" }> {
    expect(result.kind).toBe("accepted")
    if (result.kind !== "accepted") throw new Error(result.diagnostic.message)
    return result
}

function runningState(): TaskState {
    return {
        ...createInitialTaskState("task-1"),
        flow: { phase: "running" },
        turn: {
            turnId: "turn-1",
            mode: "serial",
            blocks: [],
            manualApprovalBlockIds: [],
            automaticApprovalBlockIds: [],
            executingBlockIds: [],
        },
    }
}

/** A question awaiting the user's reply, prepared and shown. */
function awaitingQuestion(actionId = "reply"): TaskState {
    const requested = accepted(
        transition(runningState(), {
            type: "dialog.requested",
            generation: 0,
            interactionId: "i-1",
            turnId: "turn-1",
            kind: "followup",
            presentationRef: "question:i-1",
            actionRules: [{ actionId, payloadPolicy: "draft" }],
        }),
    )
    const prepare = requested.state.dialog.primary?.prepare
    if (!prepare) throw new Error("Missing prepare owner")
    const prepared = accepted(
        transition(requested.state, {
            type: "dialog.prepared",
            generation: 0,
            commandId: prepare.commandId,
            originRevision: prepare.originRevision,
            interactionId: "i-1",
            journalRef: "journal:1",
            receiverGeneration: 7,
        }),
    )
    const reveal = prepared.commands[0]
    if (reveal?.type !== "dialog.reveal") throw new Error("Missing reveal command")
    return accepted(
        transition(prepared.state, {
            type: "dialog.presented",
            generation: 0,
            commandId: reveal.commandId,
            originRevision: reveal.originRevision,
            interactionId: "i-1",
        }),
    ).state
}

function recorded(state: TaskState, interactionId = "i-1", draftId = "draft-1"): TaskEvent {
    return {
        type: "transition_draft.recorded",
        generation: state.generation,
        draftId,
        payloadRef: `payload:${draftId}`,
        interactionId,
    }
}

describe("task kernel transition draft", () => {
    it("keeps the draft recorded for the awaiting reply dialog", () => {
        const state = accepted(transition(awaitingQuestion(), recorded(awaitingQuestion()))).state

        expect(openTransitionDraft(state)).toEqual({ draftId: "draft-1", payloadRef: "payload:draft-1", interactionId: "i-1" })
    })

    it("replaces an earlier draft with the one recorded last", () => {
        const first = accepted(transition(awaitingQuestion(), recorded(awaitingQuestion()))).state
        const second = accepted(transition(first, recorded(first, "i-1", "draft-2"))).state

        expect(openTransitionDraft(second)?.draftId).toBe("draft-2")
    })

    it("refuses a draft for a dialog that is not the primary one", () => {
        const state = awaitingQuestion()
        const result = transition(state, recorded(state, "other"))

        expect(result).toMatchObject({ kind: "rejected", reason: "identity_mismatch" })
    })

    it("refuses a draft for a dialog that takes no reply", () => {
        const state = awaitingQuestion("approve")
        const result = transition(state, recorded(state))

        expect(result).toMatchObject({ kind: "rejected", reason: "phase_invalid" })
    })

    it("refuses a draft when no dialog awaits the user", () => {
        const state = runningState()

        expect(transition(state, recorded(state))).toMatchObject({ kind: "rejected", reason: "identity_mismatch" })
    })

    it("drops the draft once the dialog it answers took a reply", () => {
        const kept = accepted(transition(awaitingQuestion(), recorded(awaitingQuestion()))).state
        const replied = accepted(
            transition(kept, {
                type: "dialog.responded",
                generation: 0,
                taskId: "task-1",
                turnId: "turn-1",
                interactionId: "i-1",
                stateRevision: kept.dialog.primary?.createdRevision ?? 0,
                receiverGeneration: 7,
                actionId: "reply",
                draftRef: "draft:1",
            }),
        ).state

        expect(replied.transitionDraft).toBeUndefined()
        expect(openTransitionDraft(replied)).toBeUndefined()
    })

    it("survives a restart without making its payload required", () => {
        const kept = accepted(transition(awaitingQuestion(), recorded(awaitingQuestion()))).state
        const restored = hydrate({ taskId: "task-1", snapshot: kept, journalTail: { seq: 10 }, openReason: "crash_recovery" })

        expect(restored.kind).toBe("ready")
        if (restored.kind !== "ready") return
        expect(openTransitionDraft(restored.state)).toMatchObject({ draftId: "draft-1", interactionId: "i-1" })
        expect(requiredPayloadRefs(kept)).not.toContain("payload:draft-1")
    })

    it("keeps the draft while an interrupting dialog sets its dialog aside", () => {
        const kept = accepted(transition(awaitingQuestion(), recorded(awaitingQuestion()))).state
        const interrupted = accepted(
            transition(kept, {
                type: "dialog.interrupt_requested",
                generation: 0,
                interactionId: "i-2",
                turnId: "turn-1",
                kind: "followup",
                presentationRef: "question:i-2",
                actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
            }),
        ).state

        expect(interrupted.dialog.interrupted?.interactionId).toBe("i-1")
        expect(openTransitionDraft(interrupted)).toMatchObject({ draftId: "draft-1", interactionId: "i-1" })
        // The interrupting dialog is not revealed yet, so nothing can take a new draft meanwhile.
        expect(replyableDialog(interrupted)).toBeUndefined()
    })

    it("drops on restore a draft whose dialog did not survive", () => {
        const kept = accepted(transition(awaitingQuestion(), recorded(awaitingQuestion()))).state
        const orphaned: TaskState = {
            ...kept,
            transitionDraft: { draftId: "draft-1", payloadRef: "payload:draft-1", interactionId: "gone" },
        }

        const restored = hydrate({ taskId: "task-1", snapshot: orphaned, journalTail: { seq: 10 }, openReason: "crash_recovery" })

        expect(restored.kind).toBe("ready")
        if (restored.kind !== "ready") return
        expect(restored.state.transitionDraft).toBeUndefined()
    })

    it("offers only a revealed dialog with a live receiver as the one a draft answers", () => {
        const state = awaitingQuestion()
        const primary = state.dialog.primary
        if (!primary) throw new Error("Missing primary")

        expect(replyableDialog(state)?.interactionId).toBe("i-1")
        expect(replyableDialog(awaitingQuestion("approve"))).toBeUndefined()
        const { receiverGeneration: _receiver, ...withoutReceiver } = primary
        expect(replyableDialog({ ...state, dialog: { ...state.dialog, primary: withoutReceiver } })).toBeUndefined()
        expect(transition({ ...state, dialog: { ...state.dialog, primary: withoutReceiver } }, recorded(state))).toMatchObject({
            kind: "rejected",
            reason: "phase_invalid",
        })
    })
})
