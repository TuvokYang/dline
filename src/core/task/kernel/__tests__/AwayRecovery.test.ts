import { describe, expect, it } from "vitest"
import { hydrate, requiredPayloadRefs } from "../hydrate"
import { transition } from "../transition"
import { createInitialTaskState, type TaskEvent, type TaskState } from "../types"

const configuration = { enabled: true, automatic: true, modeRevocation: 0, automaticRevocation: 0 }
function acceptedTimeout(): TaskState {
    const base = createInitialTaskState("away-recovery")
    const result = transition(
        {
            ...base,
            flow: { phase: "running" },
            away: { configuration },
            dialog: {
                approvalsByBlock: {},
                primary: {
                    interactionId: "ask",
                    turnId: "turn",
                    kind: "followup",
                    status: "awaiting",
                    createdRevision: 0,
                    presentationRef: "question",
                    receiverGeneration: 0,
                    actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
                    deadline: { kind: "ask", deadlineAt: 1000, modeRevocation: 0, automaticRevocation: 0 },
                },
            },
        },
        {
            type: "away.deadline_due",
            generation: 0,
            interactionId: "ask",
            turnId: "turn",
            receiverGeneration: 0,
            deadlineAt: 1000,
            now: 1000,
        },
    )
    if (result.kind !== "accepted") throw new Error(result.diagnostic.message)
    return result.state
}

function step(state: TaskState, event: TaskEvent) {
    const result = transition(state, event)
    if (result.kind !== "accepted") throw new Error(result.diagnostic.message)
    return result
}

describe("accepted Away response recovery", () => {
    it("offers Resume without delivering while paused, then restores exactly the already accepted answer", () => {
        const restored = hydrate({
            taskId: "away-recovery",
            snapshot: acceptedTimeout(),
            journalTail: { seq: 0 },
            openReason: "crash_recovery",
        })
        expect(restored.rebuilt).toBe(false)
        expect(restored.state.flow.phase).toBe("paused")
        expect(restored.state.dialog.primary?.kind).toBe("resume")
        expect(restored.state.dialog.interrupted).toMatchObject({
            interactionId: "ask",
            status: "resolving",
            acceptedResponse: { origin: "timeout" },
        })
        expect(restored.initialCommands.map((command) => command.type)).toEqual(["dialog.prepare"])
        const prepare = restored.initialCommands[0]
        let result = step(restored.state, {
            type: "dialog.prepared",
            generation: 1,
            interactionId: restored.state.dialog.primary!.interactionId,
            commandId: prepare.commandId,
            originRevision: prepare.originRevision,
            journalRef: "journal:0",
            receiverGeneration: 1,
        })
        const reveal = result.commands[0]
        result = step(result.state, {
            type: "dialog.presented",
            generation: 1,
            interactionId: result.state.dialog.primary!.interactionId,
            commandId: reveal.commandId,
            originRevision: reveal.originRevision,
        })
        const resume = result.state.dialog.primary!
        result = step(result.state, {
            type: "dialog.responded",
            generation: 1,
            taskId: "away-recovery",
            turnId: resume.turnId,
            interactionId: resume.interactionId,
            stateRevision: result.state.revision,
            receiverGeneration: 1,
            actionId: "resume",
            draftRef: "resume-note",
        })
        expect(result.commands).toEqual([])
        result = step(result.state, { type: "dialog.resolved", generation: 1, interactionId: resume.interactionId })
        expect(result.state.flow.phase).toBe("waiting")
        expect(result.state.dialog.primary?.interactionId).toBe("ask")
        expect(result.state.dialog.primary?.acceptedResponse?.origin).toBe("timeout")
        expect(result.commands).toEqual([
            expect.objectContaining({
                type: "dialog.deliver_automatic",
                interactionId: "ask",
                deadlineKind: "ask",
                generation: 1,
            }),
        ])
        expect(result.state.roundMaterial?.feedback).toEqual([
            {
                id: `reply:${resume.interactionId}:${result.state.revision - 1}`,
                source: "dialog",
                payloadRef: "resume-note",
                revision: result.state.revision - 1,
            },
        ])
    })

    it("lets a live cancelled task offer Resume over its accepted timeout without answering it twice", () => {
        const state = { ...acceptedTimeout(), flow: { phase: "paused" as const } }
        const result = transition(state, {
            type: "dialog.interrupt_requested",
            generation: 0,
            interactionId: "cancelled-resume",
            turnId: "turn",
            kind: "cancelled_resume",
            presentationRef: "resume",
            actionRules: [{ actionId: "resume", payloadPolicy: "draft" }],
        })
        expect(result.kind).toBe("accepted")
        expect(result.state.dialog.interrupted?.acceptedResponse?.origin).toBe("timeout")
        expect(result.state.dialog.primary?.kind).toBe("cancelled_resume")
    })

    it.each([
        { configuration: null },
        { configuration: { ...configuration, modeRevocation: -1 } },
        { configuration, mode: { source: "unknown", modeRevocation: 0, enteredRevision: 1 } },
    ])("rebuilds a malformed Away slice instead of granting permission or throwing: %j", (away) => {
        const snapshot = { ...acceptedTimeout(), away } as unknown as TaskState
        const restored = hydrate({ taskId: snapshot.taskId, snapshot, journalTail: { seq: 0 }, openReason: "crash_recovery" })
        expect(restored.rebuilt).toBe(true)
        expect(restored.state.away?.mode).toBeUndefined()
        expect(restored.state.flow.phase).toBe("paused")
    })

    it.each([
        { roundMaterial: { notices: [], feedback: {} } },
        { flow: { phase: "running", compose: { materialPlan: { id: "round", inputs: null, notices: [] } } } },
        { dialog: { approvalsByBlock: {}, primary: { deadline: { kind: "ask", deadlineAt: "later" } } } },
    ])("handles malformed material or deadline only at snapshot ingress: %j", (broken) => {
        const snapshot = { ...acceptedTimeout(), ...broken } as unknown as TaskState
        expect(() => requiredPayloadRefs(snapshot)).not.toThrow()
        const restored = hydrate({ taskId: snapshot.taskId, snapshot, journalTail: { seq: 0 }, openReason: "crash_recovery" })
        expect(restored.rebuilt).toBe(true)
        expect(restored.state.away?.mode).toBeUndefined()
    })

    it("clears external command deadlines when real user content ends Away", () => {
        const snapshot = acceptedTimeout()
        const state: TaskState = {
            ...snapshot,
            dialog: {
                approvalsByBlock: {
                    command: {
                        interactionId: "command",
                        turnId: "turn",
                        blockId: "command",
                        kind: "tool_approval",
                        status: "awaiting",
                        createdRevision: 0,
                        presentationRef: "approval",
                        receiverGeneration: 0,
                        actionRules: [{ actionId: "approve", payloadPolicy: "draft" }],
                        deadline: { kind: "external_command", deadlineAt: 60000, modeRevocation: 0, automaticRevocation: 0 },
                    },
                },
            },
        }
        const returned = step(state, {
            type: "user.submit",
            generation: 0,
            entryId: "back",
            payloadRef: "back",
            userControl: { kind: "user_returned" },
        })
        expect(returned.state.away?.mode).toBeUndefined()
        expect(returned.state.dialog.approvalsByBlock.command.deadline).toBeUndefined()
    })
})
