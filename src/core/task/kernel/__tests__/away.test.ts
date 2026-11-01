import { describe, expect, it } from "vitest"
import { transition } from "../transition"
import { createInitialTaskState, type TaskEvent, type TaskState } from "../types"

const configuration = { enabled: true, automatic: true, modeRevocation: 0, automaticRevocation: 0 }
type EventInput<T = TaskEvent> = T extends TaskEvent ? Omit<T, "generation"> : never
function accept(state: TaskState, event: EventInput): TaskState {
    const result = transition(state, { ...event, generation: state.generation } as TaskEvent)
    if (result.kind !== "accepted") throw new Error(result.diagnostic.message)
    return result.state
}
function configured(): TaskState {
    return accept(createInitialTaskState("away"), { type: "away.configured", configuration })
}
function input(state: TaskState, id: string, kind: "enter_away" | "user_returned"): TaskState {
    return accept(state, { type: "user.submit", entryId: id, payloadRef: `payload:${id}`, userControl: { kind } })
}

describe("Away state ownership", () => {
    it("enters once, remains task-local, and exits without changing tool/flow ownership", () => {
        const entered = input(configured(), "first", "enter_away")
        expect(entered.away?.mode).toMatchObject({ source: "command", modeRevocation: 0 })
        const repeated = input(entered, "second", "enter_away")
        expect(repeated.away?.mode).toEqual(entered.away?.mode)
        expect(repeated.roundMaterial?.notices ?? []).toEqual([])
        expect(createInitialTaskState("other").away).toBeUndefined()
        const result = transition(repeated, { type: "away.stopped", generation: repeated.generation })
        expect(result.kind).toBe("accepted")
        if (result.kind !== "accepted") return
        expect(result.state.away?.mode).toBeUndefined()
        expect(result.state.flow).toEqual(repeated.flow)
        expect(result.state.turn).toEqual(repeated.turn)
        expect(result.state.dialog).toEqual(repeated.dialog)
        expect(result.commands).toEqual([])
        expect(result.state.roundMaterial?.notices).toMatchObject([{ kind: "away_exited", reason: "stopped" }])
    })

    it("does not exit on configuration refresh and does exit on ordinary content", () => {
        const state = input(configured(), "first", "enter_away")
        const unchanged = accept(state, { type: "away.configured", configuration } as never)
        expect(unchanged.away?.mode).toEqual(state.away?.mode)
        const returned = input(unchanged, "normal", "user_returned")
        expect(returned.away?.mode).toBeUndefined()
        expect(returned.roundMaterial?.notices).toMatchObject([{ reason: "user_returned" }])
    })

    it("does not enter without the effective gate and preference", () => {
        const disabled = accept(configured(), {
            type: "away.configured",
            configuration: { ...configuration, enabled: false },
        } as never)
        expect(input(disabled, "disabled", "enter_away").away?.mode).toBeUndefined()
    })

    it("revokes old modes even after preferences have been reopened", () => {
        const entered = input(configured(), "first", "enter_away")
        const revoked = accept(entered, {
            type: "away.configured",
            configuration: { ...configuration, modeRevocation: 1, automaticRevocation: 1 },
        } as never)
        expect(revoked.away?.mode).toBeUndefined()
        expect(revoked.roundMaterial?.notices).toMatchObject([{ reason: "configuration_revoked" }])
        const reopened = input(revoked, "new", "enter_away")
        expect(reopened.away?.mode?.modeRevocation).toBe(1)
        expect(reopened.roundMaterial?.notices).toHaveLength(1)
    })

    it("keeps queue edits inert and accepts tool-round control before composing, only once", () => {
        let state = accept(configured(), {
            type: "input_queue.enqueued",
            entryId: "queued",
            payloadRef: "old",
            mode: "steering",
            userControl: { kind: "enter_away" },
        })
        expect(state.away?.mode).toBeUndefined()
        state = accept(state, {
            type: "input_queue.edit_committed",
            entryId: "queued",
            payloadRef: "new",
            userControl: { kind: "user_returned" },
        })
        expect(state.intake.queued[0].userControl).toEqual({ kind: "user_returned" })
        state = accept(state, {
            type: "input_queue.edit_committed",
            entryId: "queued",
            payloadRef: "away",
            userControl: { kind: "enter_away" },
        })
        state = accept(state, {
            type: "input_queue.delivery_reserved",
            deliveryId: "delivery",
            point: "tool_round",
            ownerId: "compose",
        })
        expect(state.away?.mode).toBeUndefined()
        state = {
            ...state,
            flow: {
                phase: "running",
                compose: {
                    commandId: "compose",
                    originRevision: state.revision,
                    status: "running",
                    admittedEntryIds: ["queued"],
                },
            },
        }
        const delivery = {
            type: "input_queue.delivery_accepted" as const,
            commandId: "compose",
            originRevision: state.revision,
            deliveryId: "delivery",
        }
        state = accept(state, delivery)
        expect(state.away?.mode?.source).toBe("command")
        expect(state.intake.queued[0].acceptedRevision).toBe(state.revision)
        state = accept(state, { type: "away.stopped" })
        state = accept(state, delivery)
        expect(state.away?.mode).toBeUndefined()
        expect(state.roundMaterial?.notices).toHaveLength(1)
    })

    it("refuses a tool-round acceptance from another compose owner", () => {
        const state = configured()
        const result = transition(state, {
            type: "input_queue.delivery_accepted",
            generation: 0,
            commandId: "old",
            originRevision: 1,
            deliveryId: "missing",
        })
        expect(result.kind).toBe("rejected")
        expect(result.state).toBe(state)
    })

    it("closing automatic eligibility does not stop an existing Away run", () => {
        const entered = input(configured(), "first", "enter_away")
        const changed = accept(entered, {
            type: "away.configured",
            configuration: { ...configuration, automatic: false, automaticRevocation: 1 },
        } as never)
        expect(changed.away?.mode).toEqual(entered.away?.mode)
    })
})
