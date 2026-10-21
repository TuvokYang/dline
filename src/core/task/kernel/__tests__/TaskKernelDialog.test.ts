import { describe, expect, it } from "vitest"
import { transition } from "../transition"
import type { ProviderTurnBlockPlan, TaskEvent, TaskState, TransitionResult } from "../types"
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

function findInteraction(state: TaskState, interactionId: string) {
    if (state.dialog.primary?.interactionId === interactionId) return state.dialog.primary
    return Object.values(state.dialog.approvalsByBlock).find((interaction) => interaction.interactionId === interactionId)
}

function prepareAndPresent(state: TaskState, interactionId: string, journalRef: string): TaskState {
    const prepare = findInteraction(state, interactionId)?.prepare
    if (!prepare) throw new Error(`Missing prepare owner for ${interactionId}`)
    const prepared = accepted(
        transition(state, {
            type: "dialog.prepared",
            generation: 0,
            commandId: prepare.commandId,
            originRevision: prepare.originRevision,
            interactionId,
            journalRef,
            receiverGeneration: 7,
        }),
    )
    const reveal = prepared.commands[0]
    if (reveal?.type !== "dialog.reveal") throw new Error(`Missing reveal command for ${interactionId}`)
    return accepted(
        transition(prepared.state, {
            type: "dialog.presented",
            generation: 0,
            commandId: reveal.commandId,
            originRevision: reveal.originRevision,
            interactionId,
        }),
    ).state
}

function openQuestion(state: TaskState, interactionId = "i-1"): TaskState {
    const requested = accepted(
        transition(state, {
            type: "dialog.requested",
            generation: 0,
            interactionId,
            turnId: "turn-1",
            kind: "followup",
            presentationRef: `question:${interactionId}`,
            actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
        }),
    )
    return prepareAndPresent(requested.state, interactionId, "journal:1")
}

function response(stateRevision: number, interactionId = "i-1"): Extract<TaskEvent, { type: "dialog.responded" }> {
    return {
        type: "dialog.responded",
        generation: 0,
        taskId: "task-1",
        turnId: "turn-1",
        interactionId,
        stateRevision,
        receiverGeneration: 7,
        actionId: "reply",
        draftRef: "draft:1",
    }
}

describe("task kernel causal dialog", () => {
    it("accepts the opening revision after unrelated revisions and rejects duplicate responses", () => {
        let state = openQuestion(runningState())
        state = accepted(
            transition(state, { type: "user.submit", generation: 0, entryId: "entry-1", payloadRef: "payload:1" }),
        ).state
        const first = accepted(transition(state, response(1)))
        expect(first.state.dialog.primary).toMatchObject({ status: "resolving", acceptedResponse: { actionId: "reply" } })
        const reopened = accepted(
            transition(first.state, {
                type: "dialog.reopened",
                generation: first.state.generation,
                interactionId: "i-1",
            }),
        )
        expect(reopened.state.dialog.primary).toMatchObject({ interactionId: "i-1", status: "awaiting" })
        expect(reopened.state.dialog.primary?.acceptedResponse).toBeUndefined()
        const duplicate = transition(first.state, response(first.state.revision))
        expect(duplicate).toMatchObject({ kind: "rejected", reason: "duplicate" })
        expect(duplicate.state).toBe(first.state)
    })

    it("keeps approvals per block and folds human/AI races by causal ownership", () => {
        const block = (blockId: string, index: number) => ({
            blockId,
            index,
            phase: "pending" as const,
            attempt: `attempt:${blockId}`,
            invocationRef: `invocation:${blockId}`,
            lanes: [],
            turnEnding: false,
        })
        const initial: TaskState = {
            ...runningState(),
            turn: {
                turnId: "turn-1",
                mode: "parallel",
                blocks: [block("b1", 0), block("b2", 1)],
                manualApprovalBlockIds: [],
                automaticApprovalBlockIds: [],
                executingBlockIds: [],
            },
        }
        const approval = (blockId: string) => ({
            type: "approval.requested" as const,
            generation: 0,
            turnId: "turn-1",
            blockId,
            interactionId: `approval:${blockId}`,
            kind: "tool_approval",
            presentationRef: `approval:${blockId}`,
            actionRules: [
                { actionId: "approve", payloadPolicy: "none" as const },
                { actionId: "reject", payloadPolicy: "none" as const },
            ],
        })
        let concurrent = accepted(transition(initial, approval("b1"))).state
        concurrent = accepted(transition(concurrent, approval("b2"))).state
        expect(concurrent.turn.manualApprovalBlockIds).toEqual(["b1", "b2"])
        expect(Object.keys(concurrent.dialog.approvalsByBlock)).toEqual(["b1", "b2"])
        let rejected = prepareAndPresent(concurrent, "approval:b1", "journal:5")
        rejected = prepareAndPresent(rejected, "approval:b2", "journal:6")
        rejected = accepted(
            transition(rejected, {
                type: "dialog.responded",
                generation: 0,
                taskId: "task-1",
                turnId: "turn-1",
                interactionId: "approval:b1",
                stateRevision: rejected.revision,
                receiverGeneration: 7,
                actionId: "reject",
            }),
        ).state
        const mismatchedDecision = transition(rejected, {
            type: "approval.responded",
            generation: 0,
            turnId: "turn-1",
            blockId: "b1",
            interactionId: "approval:b1",
            approved: true,
        })
        expect(mismatchedDecision).toMatchObject({ kind: "rejected", reason: "identity_mismatch" })
        const cascade = accepted(
            transition(rejected, {
                type: "approval.responded",
                generation: 0,
                turnId: "turn-1",
                blockId: "b1",
                interactionId: "approval:b1",
                approved: false,
            }),
        )
        expect(cascade.state.turn.blocks.map((candidate) => candidate.phase)).toEqual(["rejected", "skipped"])
        expect(cascade.state.turn.manualApprovalBlockIds).toEqual([])
        expect(cascade.state.dialog.approvalsByBlock).toEqual({})

        const policyRequest = {
            type: "approval.evaluation_requested" as const,
            generation: 0,
            turnId: "turn-1",
            blockId: "b1",
            interactionId: "policy:b1",
            policyRevision: 1,
            riskFacts: {},
            attempt: "attempt:b1",
        }
        let humanFirst = accepted(transition(initial, policyRequest)).state
        const humanPolicy = humanFirst.turn.blocks[0].policy
        if (!humanPolicy) throw new Error("Expected human-first policy evaluation")
        humanFirst = accepted(transition(humanFirst, approval("b1"))).state
        humanFirst = prepareAndPresent(humanFirst, "approval:b1", "journal:3")
        humanFirst = accepted(
            transition(humanFirst, {
                type: "dialog.responded",
                generation: 0,
                taskId: "task-1",
                turnId: "turn-1",
                interactionId: "approval:b1",
                stateRevision: humanFirst.revision,
                receiverGeneration: 7,
                actionId: "approve",
            }),
        ).state
        humanFirst = accepted(
            transition(humanFirst, {
                type: "approval.responded",
                generation: 0,
                turnId: "turn-1",
                blockId: "b1",
                interactionId: "approval:b1",
                approved: true,
            }),
        ).state
        expect(humanFirst.turn.blocks[0].policy?.status).toBe("cancelled")
        const latePolicy = transition(humanFirst, {
            type: "approval.evaluated",
            generation: 0,
            commandId: humanPolicy.commandId,
            originRevision: humanPolicy.originRevision,
            interactionId: humanPolicy.interactionId,
            policyRevision: humanPolicy.policyRevision,
            blockId: "b1",
            attempt: "attempt:b1",
            approved: true,
        })
        expect(latePolicy).toMatchObject({ kind: "rejected", reason: "duplicate" })

        let aiFirst = accepted(transition(initial, policyRequest)).state
        const aiPolicy = aiFirst.turn.blocks[0].policy
        if (!aiPolicy) throw new Error("Expected AI-first policy evaluation")
        aiFirst = accepted(transition(aiFirst, approval("b1"))).state
        aiFirst = prepareAndPresent(aiFirst, "approval:b1", "journal:4")
        const aiWon = accepted(
            transition(aiFirst, {
                type: "approval.evaluated",
                generation: 0,
                commandId: aiPolicy.commandId,
                originRevision: aiPolicy.originRevision,
                interactionId: aiPolicy.interactionId,
                policyRevision: aiPolicy.policyRevision,
                blockId: "b1",
                attempt: "attempt:b1",
                approved: true,
            }),
        )
        expect(aiWon.state.turn.manualApprovalBlockIds).toEqual([])
        expect(aiWon.state.dialog.approvalsByBlock.b1).toBeUndefined()
        const lateHuman = transition(aiWon.state, {
            type: "dialog.responded",
            generation: 0,
            taskId: "task-1",
            turnId: "turn-1",
            interactionId: "approval:b1",
            stateRevision: aiWon.state.revision,
            receiverGeneration: 7,
            actionId: "approve",
        })
        expect(lateHuman).toMatchObject({ kind: "rejected", reason: "identity_mismatch" })
    })

    it("dismisses an obsolete provider failure and releases the task to the user", () => {
        const initial = createInitialTaskState("task-1")
        const state: TaskState = {
            ...initial,
            flow: { phase: "error", error: "Profile not valid" },
            dialog: {
                ...initial.dialog,
                primary: {
                    interactionId: "error:provider.failed:1",
                    turnId: "turn-1",
                    kind: "error_retry",
                    status: "awaiting",
                    createdRevision: 1,
                    presentationRef: "Profile not valid",
                    actionRules: [{ actionId: "retry", payloadPolicy: "draft" }],
                    receiverGeneration: 0,
                },
            },
        }

        const result = accepted(
            transition(state, { type: "dialog.dismissed", generation: 0, interactionId: "error:provider.failed:1" }),
        )

        expect(result.state.flow).toEqual({ phase: "waiting", error: undefined, replyAdmission: "profile_recovery" })
        expect(result.state.dialog.primary).toBeUndefined()
        expect(result.commands).toEqual([])

        // The user's next submission spends the one reply the dismissal admitted.
        const replied = accepted(
            transition(result.state, { type: "user.submit", generation: 0, entryId: "entry-1", payloadRef: "payload:1" }),
        )
        expect(replied.state.flow.replyAdmission).toBeUndefined()
    })

    it("admits no recovery reply when the dismissed dialog did not stop the round", () => {
        const initial = createInitialTaskState("task-1")
        const state: TaskState = {
            ...initial,
            flow: { phase: "waiting" },
            dialog: {
                ...initial.dialog,
                primary: {
                    interactionId: "error:provider.failed:1",
                    turnId: "turn-1",
                    kind: "error_retry",
                    status: "awaiting",
                    createdRevision: 1,
                    presentationRef: "Profile not valid",
                    actionRules: [{ actionId: "retry", payloadPolicy: "draft" }],
                    receiverGeneration: 0,
                },
            },
        }

        const result = accepted(
            transition(state, { type: "dialog.dismissed", generation: 0, interactionId: "error:provider.failed:1" }),
        )

        expect(result.state.flow.replyAdmission).toBeUndefined()
    })

    it("restores the interrupted interaction atomically when the interrupt resolves", () => {
        let state = openQuestion(runningState(), "primary")
        state = accepted(
            transition(state, {
                type: "dialog.interrupt_requested",
                generation: 0,
                interactionId: "interrupt",
                turnId: "turn-1",
                kind: "condense",
                presentationRef: "condense:1",
                actionRules: [{ actionId: "confirm_utility", payloadPolicy: "none" }],
            }),
        ).state
        expect(state.dialog.interrupted?.interactionId).toBe("primary")
        const interruptedResponse = transition(state, response(state.revision, "primary"))
        expect(interruptedResponse).toMatchObject({ kind: "rejected", reason: "phase_invalid" })
        expect(interruptedResponse.state).toBe(state)
        state = prepareAndPresent(state, "interrupt", "journal:2")
        state = accepted(
            transition(state, {
                ...response(state.revision, "interrupt"),
                actionId: "confirm_utility",
                draftRef: undefined,
            }),
        ).state
        state = accepted(transition(state, { type: "dialog.resolved", generation: 0, interactionId: "interrupt" })).state
        expect(state.dialog.primary).toMatchObject({ interactionId: "primary", status: "awaiting" })
        expect(state.dialog.interrupted).toBeUndefined()
    })

    it("records on the waiting dialog the compaction that completed beside it, never on that compaction's own review", () => {
        let state = openQuestion(runningState(), "primary")
        state = accepted(
            transition(state, {
                type: "compaction.requested",
                generation: 0,
                compactionId: "compact-1",
                attempt: "attempt-1",
                contextRef: "manual:ctx",
            }),
        ).state
        state = accepted(
            transition(state, { type: "compaction.started", generation: 0, compactionId: "compact-1", attempt: "attempt-1" }),
        ).state
        state = accepted(
            transition(state, {
                type: "dialog.interrupt_requested",
                generation: 0,
                interactionId: "review",
                turnId: "compact-1",
                kind: "condense",
                presentationRef: "condense:1",
                actionRules: [{ actionId: "confirm_utility", payloadPolicy: "none" }],
            }),
        ).state
        const completed = (current: TaskState): TaskState =>
            accepted(
                transition(current, {
                    type: "compaction.completed",
                    generation: 0,
                    compactionId: "compact-1",
                    attempt: "attempt-1",
                    resultRef: "summary:1",
                }),
            ).state

        // Landing while the review is still open marks only the dialog it interrupted.
        const whileReviewing = completed(state)
        expect(whileReviewing.dialog.primary).toMatchObject({ interactionId: "review" })
        expect(whileReviewing.dialog.primary).not.toHaveProperty("outlivedCompactionId")
        expect(whileReviewing.dialog.interrupted).toMatchObject({ interactionId: "primary", outlivedCompactionId: "compact-1" })

        // Landing after the review was answered marks the dialog the answer restored.
        state = prepareAndPresent(state, "review", "journal:2")
        state = accepted(
            transition(state, {
                ...response(state.revision, "review"),
                turnId: "compact-1",
                actionId: "confirm_utility",
                draftRef: undefined,
            }),
        ).state
        state = accepted(transition(state, { type: "dialog.resolved", generation: 0, interactionId: "review" })).state
        expect(completed(state).dialog.primary).toMatchObject({ interactionId: "primary", outlivedCompactionId: "compact-1" })
    })

    it("carries a planned approval's surface ask and row unchanged to prepare and reveal", () => {
        // The kernel never interprets the ask; it only has to deliver it, because
        // the anchor row is unreadable when written with another ask than the body.
        const block: ProviderTurnBlockPlan = {
            blockId: "b1",
            attempt: "attempt-b1",
            index: 0,
            lanes: [],
            turnEnding: false,
            invocationRef: "invocation:b1",
            approval: {
                kind: "manual",
                interactionId: "approval:b1",
                presentationRef: "npm test",
                presentationAsk: "command",
                // The row the call drew while it streamed; the anchor takes it over.
                presentationRow: 42,
                actionRules: [{ actionId: "approve", payloadPolicy: "draft" }],
            },
        }
        const awaitingProvider: TaskState = {
            ...createInitialTaskState("task-1"),
            revision: 4,
            flow: {
                phase: "running",
                provider: { commandId: "provider:1", originRevision: 4, status: "running", turnId: "turn-1" },
            },
        }
        const ready = accepted(
            transition(awaitingProvider, {
                type: "provider.turn_ready",
                generation: 0,
                commandId: "provider:1",
                originRevision: 4,
                turnId: "turn-1",
                finalPayloadRef: "final:1",
                journalWatermark: { seq: 3 },
                turnPlan: { mode: "serial", blocks: [block] },
            }),
        )
        expect(ready.commands).toContainEqual(
            expect.objectContaining({
                type: "dialog.prepare",
                interactionId: "approval:b1",
                presentationAsk: "command",
                presentationRow: 42,
            }),
        )
        const prepare = findInteraction(ready.state, "approval:b1")?.prepare
        if (!prepare) throw new Error("Missing prepare owner for approval:b1")
        const prepared = accepted(
            transition(ready.state, {
                type: "dialog.prepared",
                generation: 0,
                commandId: prepare.commandId,
                originRevision: prepare.originRevision,
                interactionId: "approval:b1",
                journalRef: "journal:1",
                receiverGeneration: 0,
            }),
        )
        expect(prepared.commands[0]).toMatchObject({ type: "dialog.reveal", presentationAsk: "command", presentationRow: 42 })
    })
})
