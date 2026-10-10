import { createInitialTaskState, transition } from "@core/task/kernel"
import { projectCanonicalTaskView } from "@core/task/view/canonical/projectCanonicalTaskView"
import { describe, expect, it } from "vitest"
import { adaptCanonicalTaskView } from "../TaskViewMessageAdapter"

/** An active task whose running work already projects a task-level Cancel. */
function runningCommandProjection() {
    return projectCanonicalTaskView({ ...createInitialTaskState("task-1"), flow: { phase: "running" } })
}

describe("adaptCanonicalTaskView", () => {
    it("decorates an awaiting canonical dialog with its exact message anchor", () => {
        const initial = createInitialTaskState("task-1")
        const projection = projectCanonicalTaskView({
            ...initial,
            revision: 4,
            flow: { phase: "paused" },
            dialog: {
                approvalsByBlock: {},
                primary: {
                    interactionId: "interaction-1",
                    turnId: "turn-1",
                    kind: "followup",
                    status: "awaiting",
                    createdRevision: 3,
                    presentationRef: "presentation-1",
                    receiverGeneration: 0,
                    actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
                },
            },
        })
        const view = adaptCanonicalTaskView(projection, [
            { type: "ask", ask: "followup", ts: 100, text: "question", interactionId: "interaction-1" },
        ])

        expect(view.activeInteraction).toMatchObject({
            interactionId: "interaction-1",
            taskAsk: "followup",
            askMessageTs: 100,
            anchorVerified: true,
        })
        expect(view.input).toMatchObject({ enabled: true, enterAction: "reply" })
    })

    it("renders a legacy running completion as completed instead of streaming", () => {
        const initial = createInitialTaskState("task-1")
        const projection = projectCanonicalTaskView({
            ...initial,
            flow: { phase: "running" },
            dialog: {
                approvalsByBlock: {},
                primary: {
                    interactionId: "completion-1",
                    turnId: "turn-1",
                    kind: "completion",
                    status: "awaiting",
                    createdRevision: 3,
                    presentationRef: "completion:done",
                    receiverGeneration: 0,
                    actionRules: [
                        { actionId: "reply", payloadPolicy: "draft" },
                        { actionId: "start_new_task", payloadPolicy: "draft" },
                    ],
                },
            },
        })
        const view = adaptCanonicalTaskView(projection, [
            { type: "ask", ask: "completion_result", ts: 101, text: "done", interactionId: "completion-1" },
        ])

        expect(view.phase).toBe("completed")
        expect(view.input).toMatchObject({ enabled: true, enterAction: "reply" })
        expect(view.footer.actions.map((action) => action.type)).toEqual(["start_new_task"])
    })

    it("opens the composer for one reply after a dismissed provider failure, as dev's profile recovery", () => {
        const initial = createInitialTaskState("task-1")
        const failed = {
            ...initial,
            flow: { phase: "error" as const, error: "Profile not valid" },
            dialog: {
                approvalsByBlock: {},
                primary: {
                    interactionId: "error:provider.failed:1",
                    turnId: "turn-1",
                    kind: "error_retry",
                    status: "awaiting" as const,
                    createdRevision: 1,
                    presentationRef: "Profile not valid",
                    receiverGeneration: 0,
                    actionRules: [{ actionId: "retry", payloadPolicy: "draft" as const }],
                },
            },
        }
        const dismissed = transition(failed, {
            type: "dialog.dismissed",
            generation: 0,
            interactionId: "error:provider.failed:1",
        })
        if (dismissed.kind !== "accepted") throw new Error(`dismissal rejected: ${dismissed.kind}`)

        const view = adaptCanonicalTaskView(projectCanonicalTaskView(dismissed.state))

        expect(view.phase).toBe("between_turns")
        expect(view.activeInteraction).toBeUndefined()
        expect(view.input).toEqual({
            enabled: true,
            acceptsText: true,
            acceptsImages: true,
            acceptsFiles: true,
            enterAction: "reply",
        })
        expect(view.footer.actions).toEqual([])

        // A plain waiting task without the admission keeps the composer closed.
        const plain = adaptCanonicalTaskView(projectCanonicalTaskView({ ...initial, flow: { phase: "waiting" } }))
        expect(plain.input.enabled).toBe(false)
    })

    it("projects canonical halt and compaction without legacy runtime options", () => {
        const initial = createInitialTaskState("task-1")
        const projection = projectCanonicalTaskView({
            ...initial,
            flow: {
                phase: "running",
                compaction: { compactionId: "compact-1", attempt: "attempt-1", contextRef: "context-1", status: "running" },
            },
            halt: {
                status: "stopping",
                generation: 1,
                haltId: "halt-1",
                target: "paused",
                pending: ["provider"],
                halted: [],
                failed: [],
                timedOut: [],
            },
        })
        const view = adaptCanonicalTaskView(projection)

        expect(view.phase).toBe("cancelling")
        expect(view.contextCompaction).toEqual({ active: true, operationId: "compact-1" })
        expect(view.footer.actions).toEqual([
            {
                type: "cancel",
                label: "Cancel",
                appearance: "danger",
                enabled: false,
                payloadPolicy: "none",
                dispatchTarget: "task",
            },
        ])
    })

    it("offers the background handoff before Cancel while a foreground command owns it", () => {
        const view = adaptCanonicalTaskView(runningCommandProjection(), [], {
            readyActivityId: () => "command-1",
            isRequested: () => false,
        })

        expect(view.footer.actions).toEqual([
            {
                type: "continue_in_background",
                label: "Continue in Background",
                appearance: "secondary",
                enabled: true,
                payloadPolicy: "none",
                dispatchTarget: "task",
                activityId: "command-1",
            },
            {
                type: "cancel",
                label: "Cancel",
                appearance: "danger",
                enabled: true,
                payloadPolicy: "none",
                dispatchTarget: "task",
            },
        ])
    })

    it("disables the handoff once the move is already settling", () => {
        const view = adaptCanonicalTaskView(runningCommandProjection(), [], {
            readyActivityId: () => "command-1",
            isRequested: (activityId) => activityId === "command-1",
        })

        expect(view.footer.actions[0]).toMatchObject({ type: "continue_in_background", enabled: false })
    })

    it("omits the handoff when no executor owns an eligible command", () => {
        const view = adaptCanonicalTaskView(runningCommandProjection(), [], {
            readyActivityId: () => undefined,
            isRequested: () => false,
        })

        expect(view.footer.actions.map((action) => action.type)).toEqual(["cancel"])
    })
})
