import { describe, expect, it } from "vitest"
import { hydrate, transition } from ".."
import type { ProviderTurnBlockPlan, TaskEvent, TaskState } from "../types"
import { createInitialTaskState } from "../types"

const configuration = { enabled: true, automatic: true, modeRevocation: 0, automaticRevocation: 0 }

function accept(state: TaskState, event: TaskEvent) {
    const result = transition(state, event)
    if (result.kind !== "accepted") throw new Error(result.diagnostic.message)
    return result
}

function planned(options: { automatic?: boolean; enabled?: boolean; now?: number } = {}) {
    const blocks: ProviderTurnBlockPlan[] = ["command", "command", "tool"].map((ask, index) => ({
        blockId: `block-${index}`,
        index,
        attempt: `attempt-${index}`,
        invocationRef: `invocation-${index}`,
        lanes: [],
        turnEnding: false,
        approval: {
            kind: "manual",
            interactionId: `approval-${index}`,
            presentationRef: `body-${index}`,
            presentationAsk: ask,
            actionRules: [
                { actionId: "approve", payloadPolicy: "draft" },
                { actionId: "reject", payloadPolicy: "draft" },
            ],
        },
    }))
    return accept(
        {
            ...createInitialTaskState("command-deadlines"),
            away: { configuration: { ...configuration, enabled: options.enabled ?? true, automatic: options.automatic ?? true } },
            flow: { phase: "running", provider: { commandId: "provider", originRevision: 0, status: "running" } },
        },
        {
            type: "provider.turn_ready",
            generation: 0,
            now: options.now ?? 1000,
            commandId: "provider",
            originRevision: 0,
            turnId: "turn",
            finalPayloadRef: "final",
            journalWatermark: { seq: 0 },
            turnPlan: { mode: "parallel", blocks },
        },
    )
}

function awaiting(): TaskState {
    let result = planned()
    for (const prepare of result.commands.filter((command) => command.type === "dialog.prepare")) {
        result = accept(result.state, {
            type: "dialog.prepared",
            generation: 0,
            interactionId: prepare.interactionId,
            commandId: prepare.commandId,
            originRevision: prepare.originRevision,
            journalRef: `journal:${prepare.interactionId}`,
            receiverGeneration: 0,
        })
        const reveal = result.commands.find((command) => command.type === "dialog.reveal")!
        result = accept(result.state, {
            type: "dialog.presented",
            generation: 0,
            interactionId: prepare.interactionId,
            commandId: reveal.commandId,
            originRevision: reveal.originRevision,
        })
    }
    return result.state
}

function due(interactionId: string): TaskEvent {
    return {
        type: "away.deadline_due",
        generation: 0,
        interactionId,
        turnId: "turn",
        receiverGeneration: 0,
        deadlineAt: 601000,
        now: 601000,
    }
}

describe("automatic command approval ownership", () => {
    it("arms only command approvals without changing other tool decisions", () => {
        const { state } = planned()
        expect(state.dialog.approvalsByBlock["block-0"].deadline).toMatchObject({ kind: "command_approval", deadlineAt: 601000 })
        expect(state.dialog.approvalsByBlock["block-1"].deadline).toMatchObject({ kind: "command_approval", deadlineAt: 601000 })
        expect(state.dialog.approvalsByBlock["block-2"].deadline).toBeUndefined()
        expect(state.turn.blocks.map((block) => block.phase)).toEqual([
            "awaiting_approval",
            "awaiting_approval",
            "awaiting_approval",
        ])
    })

    it.each([
        { automatic: false },
        { enabled: false },
        { now: Number.NaN },
    ])("does not arm an ineligible approval: %j", (options) => {
        const { state } = planned(options)
        expect(Object.values(state.dialog.approvalsByBlock).every((interaction) => interaction.deadline === undefined)).toBe(true)
    })

    it("accepts each parallel deadline once without answering its peers or unrelated tools", () => {
        const state = awaiting()
        const first = accept(state, due("approval-0"))
        expect(first.state.away?.mode?.source).toBe("ask_timeout")
        expect(first.state.dialog.approvalsByBlock["block-0"].acceptedResponse).toMatchObject({
            actionId: "reject",
            origin: "timeout",
        })
        expect(first.state.dialog.approvalsByBlock["block-1"]).toEqual(state.dialog.approvalsByBlock["block-1"])
        expect(first.state.dialog.approvalsByBlock["block-2"]).toEqual(state.dialog.approvalsByBlock["block-2"])
        expect(transition(first.state, due("approval-0")).kind).toBe("rejected")
        const second = accept(first.state, due("approval-1"))
        expect(second.commands.filter((command) => command.type === "dialog.deliver_automatic")).toMatchObject([
            { interactionId: "approval-1", deadlineKind: "command_approval" },
        ])
        expect(second.state.turn).toEqual(state.turn)
        const delivered = accept(second.state, {
            type: "approval.responded",
            generation: 0,
            turnId: "turn",
            blockId: "block-0",
            interactionId: "approval-0",
            approved: false,
            origin: "timeout",
        })
        expect(delivered.state.turn.blocks.map((block) => block.phase)).toEqual([
            "rejected",
            "awaiting_approval",
            "awaiting_approval",
        ])
        expect(delivered.state.dialog.approvalsByBlock["block-1"]).toEqual(second.state.dialog.approvalsByBlock["block-1"])
        expect(delivered.state.dialog.approvalsByBlock["block-2"]).toEqual(second.state.dialog.approvalsByBlock["block-2"])
    })

    it("keeps the existing human refusal cascade distinct from timeout", () => {
        const state = awaiting()
        const answered = accept(state, {
            type: "dialog.responded",
            generation: 0,
            taskId: state.taskId,
            turnId: "turn",
            interactionId: "approval-0",
            stateRevision: state.revision,
            receiverGeneration: 0,
            actionId: "reject",
            draftRef: "user-feedback",
        })
        const rejected = accept(answered.state, {
            type: "approval.responded",
            generation: 0,
            turnId: "turn",
            blockId: "block-0",
            interactionId: "approval-0",
            approved: false,
        })
        expect(rejected.state.turn.blocks.map((block) => block.phase)).toEqual(["rejected", "skipped", "skipped"])
        expect(rejected.state.turn.blocks[0].deniedByUser).toBe(true)
        expect(rejected.state.turn.blocks[0].approvalTimedOut).toBeUndefined()
    })

    it("preserves an absolute pending command deadline through hydrate without granting approval", () => {
        const state = awaiting()
        const restored = hydrate({ taskId: state.taskId, snapshot: state, journalTail: { seq: 0 }, openReason: "crash_recovery" })
        expect(restored.rebuilt).toBe(false)
        expect(restored.state.dialog.approvalsByBlock["block-0"].deadline).toEqual(
            state.dialog.approvalsByBlock["block-0"].deadline,
        )
        expect(restored.state.away?.mode).toBeUndefined()
        expect(
            restored.initialCommands.every(
                (command) => command.type !== "tool.run" && command.type !== "dialog.deliver_automatic",
            ),
        ).toBe(true)
    })
})
