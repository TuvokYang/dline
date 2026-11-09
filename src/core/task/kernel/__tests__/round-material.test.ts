import { describe, expect, it } from "vitest"
import { createInitialTaskState, type TaskState, transition } from "../index"
import { roundMaterialReceipt } from "../round-material"

function composeState(): TaskState {
    return {
        ...createInitialTaskState("materials"),
        flow: {
            phase: "running",
            compose: {
                commandId: "compose",
                originRevision: 0,
                status: "running",
                admittedEntryIds: ["input"],
            },
        },
        intake: {
            queued: [
                {
                    entryId: "input",
                    payloadRef: "body",
                    source: "user",
                    mode: "queued",
                    sequence: 1,
                    state: "reserved",
                    acceptedRevision: 3,
                },
            ],
            background: [],
            coTask: [],
        },
        away: {
            configuration: { enabled: true, automatic: true, modeRevocation: 0, automaticRevocation: 0 },
            mode: { source: "command", enteredRevision: 3, modeRevocation: 0 },
        },
        roundMaterial: {
            notices: [{ id: "exit", kind: "away_exited", revision: 2, reason: "stopped" }],
            feedback: [{ id: "first", payloadRef: "same-body", revision: 1, source: "approval" }],
        },
    }
}

function freeze(state: TaskState) {
    const result = transition(state, { type: "compose.freeze_requested", generation: 0, commandId: "compose", originRevision: 0 })
    if (result.kind !== "accepted") throw new Error(result.diagnostic.message)
    return result.state
}

describe("Runtime-owned round material plans", () => {
    it("freezes accepted feedback, input and Away without consuming pending notices", () => {
        const original = composeState()
        const frozen = freeze(original)
        expect(frozen.flow.compose!.materialPlan).toMatchObject({
            id: "round-material:compose",
            frozenRevision: 1,
            notices: original.roundMaterial!.notices,
            inputs: [
                { id: "first", revision: 1 },
                { id: "intake:input", revision: 3 },
            ],
            activeAway: original.away!.mode,
        })
        expect(frozen.roundMaterial).toEqual(original.roundMaterial)
        expect(freeze(frozen).flow.compose!.materialPlan).toEqual(frozen.flow.compose!.materialPlan)
    })

    it("settles exactly the frozen identities, keeping later feedback with identical bytes and later exits", () => {
        let state = freeze(composeState())
        const plan = state.flow.compose!.materialPlan!
        state = {
            ...state,
            roundMaterial: {
                notices: [
                    ...state.roundMaterial!.notices,
                    { id: "later-exit", kind: "away_exited", revision: 5, reason: "user_returned" },
                ],
                feedback: [
                    ...state.roundMaterial!.feedback,
                    { id: "second", payloadRef: "same-body", revision: 4, source: "approval" },
                ],
            },
        }
        const result = transition(state, {
            type: "compose.completed",
            generation: 0,
            commandId: "compose",
            originRevision: 0,
            draftRef: "draft",
            materialReceipt: roundMaterialReceipt(plan),
        })
        if (result.kind !== "accepted") throw new Error(result.diagnostic.message)
        expect(result.state.roundMaterial).toEqual({
            notices: [{ id: "later-exit", kind: "away_exited", revision: 5, reason: "user_returned" }],
            feedback: [{ id: "second", payloadRef: "same-body", revision: 4, source: "approval" }],
        })
        expect(result.state.flow.compose!.draftRef).toBe("draft")
    })

    it("does not consume a plan on failure, withdrawal, or a mismatched receipt", () => {
        const state = freeze(composeState())
        for (const event of [
            { type: "compose.failed" as const, message: "failed" },
            { type: "compose.withdrawn" as const, reason: "withdrawn" },
            {
                type: "compose.completed" as const,
                draftRef: "draft",
                materialReceipt: { planId: "other", noticeIds: [], feedbackIds: [] },
            },
        ]) {
            const result = transition(state, { ...event, generation: 0, commandId: "compose", originRevision: 0 })
            expect(result.state.roundMaterial).toEqual(state.roundMaterial)
            if (event.type === "compose.completed") expect(result.kind).toBe("rejected")
        }
    })

    it("refuses a stale owner or stopped generation before freezing", () => {
        const state = composeState()
        expect(
            transition(state, { type: "compose.freeze_requested", generation: 0, commandId: "other", originRevision: 0 }).kind,
        ).toBe("rejected")
        expect(
            transition(
                { ...state, flow: { ...state.flow, phase: "paused" } },
                { type: "compose.freeze_requested", generation: 0, commandId: "compose", originRevision: 0 },
            ).kind,
        ).toBe("rejected")
    })
})
