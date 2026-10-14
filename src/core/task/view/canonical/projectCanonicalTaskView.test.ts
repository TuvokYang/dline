import { describe, expect, it } from "vitest"
import { createInitialTaskState, type DialogInteraction, type TaskState } from "../../kernel"
import { projectCanonicalTaskView } from "./projectCanonicalTaskView"

function state(overrides: Partial<TaskState> = {}): TaskState {
    const initial = createInitialTaskState("task-1")
    return { ...initial, revision: 8, generation: 2, ...overrides }
}

function dialog(overrides: Partial<DialogInteraction> = {}): DialogInteraction {
    return {
        interactionId: "interaction-1",
        turnId: "turn-1",
        kind: "followup",
        status: "awaiting",
        createdRevision: 7,
        presentationRef: "presentation-1",
        actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
        receiverGeneration: 2,
        ...overrides,
    }
}

describe("projectCanonicalTaskView", () => {
    it("projects identity and keeps an unopened task inert", () => {
        const view = projectCanonicalTaskView(state())

        expect(view).toMatchObject({
            taskId: "task-1",
            revision: 8,
            generation: 2,
            flowPhase: "idle",
            terminal: "active",
            activity: "idle",
            input: { mode: "disabled" },
            taskActions: [],
        })
    })

    // The completion is staged before its checkpoint, hooks and reply dialog run.
    // Input sent in that window is queued and delivered as the reply (BUGFIX-179).
    describe("completion still being presented", () => {
        const presenting = (overrides: Partial<TaskState> = {}): TaskState => {
            const base = state()
            return state({
                flow: { ...base.flow, phase: "completed", completionId: "block-done" },
                turn: { ...base.turn, executingBlockIds: ["block-done"] },
                ...overrides,
            })
        }

        it("queues input before the reply dialog exists", () => {
            expect(projectCanonicalTaskView(presenting()).input).toEqual({ mode: "queued" })
        })

        it("queues input while the completion dialog is still opening", () => {
            const base = presenting()
            const view = projectCanonicalTaskView(
                presenting({ dialog: { ...base.dialog, primary: dialog({ kind: "completion", status: "planned" }) } }),
            )
            expect(view.input).toEqual({ mode: "queued" })
        })

        it("keeps input closed once the completion block has finished", () => {
            const base = presenting()
            const view = projectCanonicalTaskView(presenting({ turn: { ...base.turn, executingBlockIds: [] } }))
            expect(view.input).toEqual({ mode: "disabled" })
        })
    })

    it("projects running command ownership as queued input with Cancel", () => {
        const base = state()
        const view = projectCanonicalTaskView(
            state({
                flow: {
                    ...base.flow,
                    phase: "running",
                    provider: { commandId: "provider-1", originRevision: 7, status: "running", turnId: "turn-1" },
                },
            }),
        )

        expect(view.activity).toBe("working")
        expect(view.input).toEqual({ mode: "queued" })
        expect(view.taskActions).toEqual([{ actionId: "cancel", enabled: true }])
    })

    it("admits one ordinary reply only while a dismissed failure left the task waiting", () => {
        const base = state()

        expect(projectCanonicalTaskView(state({ flow: { ...base.flow, phase: "waiting" } })).input).toEqual({
            mode: "queued",
        })
        expect(
            projectCanonicalTaskView(state({ flow: { ...base.flow, phase: "waiting", replyAdmission: "profile_recovery" } }))
                .input,
        ).toEqual({ mode: "reply" })
        // A dialog that owns the input still takes precedence over the admission.
        expect(
            projectCanonicalTaskView(
                state({
                    flow: { ...base.flow, phase: "waiting", replyAdmission: "profile_recovery" },
                    dialog: { ...base.dialog, primary: dialog() },
                }),
            ).input,
        ).toEqual({ mode: "dialog", ownerInteractionId: "interaction-1" })
    })

    it("projects a stopping halt before other activity and disables Cancel", () => {
        const base = state()
        const view = projectCanonicalTaskView(
            state({
                flow: { ...base.flow, phase: "running" },
                halt: {
                    status: "stopping",
                    generation: 2,
                    haltId: "halt-1",
                    target: "paused",
                    pending: ["provider"],
                    halted: [],
                    failed: [],
                    timedOut: [],
                },
            }),
        )

        expect(view.activity).toBe("halting")
        expect(view.input).toEqual({ mode: "disabled" })
        expect(view.taskActions).toEqual([{ actionId: "cancel", enabled: false }])
        expect(view.halt).toMatchObject({ haltId: "halt-1", pending: ["provider"] })
    })

    it.each([
        ["planned", false],
        ["prepared", false],
        ["awaiting", true],
        ["resolving", false],
        ["failed", false],
    ] as const)("projects %s dialog actions directly from canonical action rules", (status, enabled) => {
        const primary = dialog({ status, actionRules: [{ actionId: "reply", payloadPolicy: "draft_and_selection" }] })
        const view = projectCanonicalTaskView(state({ dialog: { primary, approvalsByBlock: {} } }))

        expect(view.primary).toMatchObject({
            interactionId: "interaction-1",
            status,
            stateRevision: 8,
            receiverGeneration: 2,
            presentationRef: "presentation-1",
        })
        expect(view.primary?.actions).toEqual([{ actionId: "reply", payloadPolicy: "draft_and_selection", enabled }])
        expect(view.input.mode).toBe(status === "awaiting" ? "dialog" : "disabled")
    })

    it("keeps an awaiting completion dialog responsive on a terminal flow", () => {
        const primary = dialog({ kind: "completion" })
        const view = projectCanonicalTaskView(
            state({
                flow: { phase: "completed", completionId: "completion-1" },
                dialog: { primary, approvalsByBlock: {} },
            }),
        )

        expect(view.terminal).toBe("completed")
        expect(view.activity).toBe("waiting_for_dialog")
        expect(view.input).toEqual({ mode: "dialog", ownerInteractionId: "interaction-1" })
        expect(view.taskActions).toEqual([])
    })

    it("projects a legacy running completion snapshot as completed", () => {
        const base = state()
        const view = projectCanonicalTaskView(
            state({
                flow: {
                    ...base.flow,
                    phase: "running",
                    provider: { commandId: "provider-1", originRevision: 7, status: "completed", turnId: "turn-1" },
                },
                dialog: { primary: dialog({ kind: "completion" }), approvalsByBlock: {} },
            }),
        )

        expect(view.terminal).toBe("completed")
        expect(view.activity).toBe("waiting_for_dialog")
        expect(view.taskActions).toEqual([])
    })

    it("projects every parallel approval in stable block order", () => {
        const approvalA = dialog({ interactionId: "approval-a", kind: "tool_approval", blockId: "block-a" })
        const approvalB = dialog({ interactionId: "approval-b", kind: "tool_approval", blockId: "block-b" })
        const base = state()
        const view = projectCanonicalTaskView(
            state({
                turn: {
                    ...base.turn,
                    turnId: "turn-1",
                    mode: "parallel",
                    blocks: [
                        {
                            blockId: "block-b",
                            index: 0,
                            phase: "awaiting_approval",
                            attempt: "attempt-b",
                            lanes: [],
                            turnEnding: false,
                            invocationRef: "invocation-b",
                        },
                        {
                            blockId: "block-a",
                            index: 1,
                            phase: "awaiting_approval",
                            attempt: "attempt-a",
                            lanes: [],
                            turnEnding: false,
                            invocationRef: "invocation-a",
                        },
                    ],
                },
                dialog: { approvalsByBlock: { "block-a": approvalA, "block-b": approvalB } },
            }),
        )

        expect(view.approvals.map((approval) => [approval.blockId, approval.interactionId])).toEqual([
            ["block-b", "approval-b"],
            ["block-a", "approval-a"],
        ])
        expect(view.input).toEqual({ mode: "dialog", ownerInteractionId: "approval-b", ownerBlockId: "block-b" })
    })

    it("projects compaction state from the canonical flow slice", () => {
        const base = state()
        const view = projectCanonicalTaskView(
            state({
                flow: {
                    ...base.flow,
                    phase: "running",
                    compaction: {
                        compactionId: "compact-1",
                        attempt: "attempt-1",
                        contextRef: "context-1",
                        status: "running",
                    },
                },
            }),
        )

        expect(view.compaction).toEqual({
            compactionId: "compact-1",
            attempt: "attempt-1",
            status: "running",
            resultRef: undefined,
            message: undefined,
        })
    })

    it("fails closed when an awaiting dialog lacks its receiver generation", () => {
        const primary = dialog({ receiverGeneration: undefined })
        const view = projectCanonicalTaskView(state({ dialog: { primary, approvalsByBlock: {} } }))

        expect(view.diagnostics).toContainEqual({
            code: "dialog_receiver_generation_missing",
            message: "Awaiting dialog interaction-1 has no receiver generation",
            interactionId: "interaction-1",
            blockId: undefined,
        })
    })

    it("projects a durable diagnostic when termination force-closes a halt participant", () => {
        const view = projectCanonicalTaskView(
            state({ flow: { phase: "terminated", forcedClosedParticipants: ["provider", "tool"] } }),
        )

        expect(view.diagnostics).toContainEqual({
            code: "forced_closed",
            message: "Task termination abandoned unresponsive halt participants: provider, tool",
        })
    })

    it("keeps consumed tasks fully inert", () => {
        const view = projectCanonicalTaskView(
            state({ flow: { phase: "completed", terminalReason: "consumed", consumedRef: "child-1" } }),
        )

        expect(view.terminal).toBe("consumed")
        expect(view.activity).toBe("terminal")
        expect(view.input).toEqual({ mode: "disabled" })
        expect(view.taskActions).toEqual([])
    })
})
