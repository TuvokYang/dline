import { createInitialTaskState, type DialogInteraction, type TaskState } from "@core/task/kernel"
import { projectCanonicalTaskView } from "@core/task/view/canonical/projectCanonicalTaskView"
import type { UiAsk } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { readOnlyTaskView } from "../readOnlyTaskView"
import { adaptCanonicalTaskView } from "../TaskViewMessageAdapter"

function awayState(source: "command" | "ask_timeout" = "command"): TaskState {
    return {
        ...createInitialTaskState("away-task"),
        revision: 12,
        flow: { phase: "running" },
        away: {
            configuration: { enabled: true, automatic: true, modeRevocation: 2, automaticRevocation: 3 },
            mode: { source, modeRevocation: 2, enteredRevision: 6 },
        },
    }
}

function waiting(state: TaskState, kind: string): TaskState {
    const primary: DialogInteraction = {
        interactionId: "dialog-1",
        turnId: "turn-1",
        kind,
        status: "awaiting",
        createdRevision: 9,
        presentationRef: "presentation-1",
        receiverGeneration: state.generation,
        actionRules:
            kind === "resume"
                ? [{ actionId: "resume", payloadPolicy: "draft" }]
                : [
                      { actionId: "approve", payloadPolicy: "draft" },
                      { actionId: "reject", payloadPolicy: "draft" },
                  ],
    }
    return { ...state, flow: { phase: "paused" }, dialog: { primary, approvalsByBlock: {} } }
}

// Catches dropping task-level Stop behind interaction actions, remapping it to
// Cancel, or projecting a second UI-owned mode instead of the committed state.
describe("Away task view", () => {
    it.each(["command", "ask_timeout"] as const)("projects %s mode and Stop while no dialog exists", (source) => {
        const view = adaptCanonicalTaskView(projectCanonicalTaskView(awayState(source)))
        expect(view.away).toEqual({ source })
        expect(view.activeInteraction).toBeUndefined()
        expect(view.footer.actions.map(({ type }) => type)).toEqual(["cancel", "stop_away"])
        expect(view.footer.actions[1]).toMatchObject({
            enabled: true,
            appearance: "secondary",
            payloadPolicy: "none",
            dispatchTarget: "task",
        })
    })

    it.each([
        ["resume", "resume_task"],
        ["tool_approval", "tool"],
    ] as const)("keeps Stop beside %s", (kind, ask) => {
        const view = adaptCanonicalTaskView(projectCanonicalTaskView(waiting(awayState(), kind)), [
            { type: "ask", ask: ask as UiAsk, ts: 41, interactionId: "dialog-1", text: "{}" },
        ])
        expect(view.footer.actions.map(({ type }) => type)).toEqual(
            kind === "resume" ? ["resume", "stop_away"] : ["approve", "reject", "stop_away"],
        )
        const readonly = readOnlyTaskView(view)
        expect(readonly.away).toEqual(view.away)
        expect(readonly.footer.actions.every(({ enabled }) => !enabled)).toBe(true)
    })

    it("removes Stop when normal or completed and never leaks private revocation metadata", () => {
        const state = awayState()
        const normal = adaptCanonicalTaskView(projectCanonicalTaskView({ ...state, away: { ...state.away!, mode: undefined } }))
        const completed = adaptCanonicalTaskView(projectCanonicalTaskView({ ...state, flow: { phase: "completed" } }))
        for (const view of [normal, completed]) expect(view.footer.actions.some(({ type }) => type === "stop_away")).toBe(false)
        expect(normal.away).toBeUndefined()
    })

    it("projects only the current awaiting dialog's absolute deadline and removes it on settlement", () => {
        const base = waiting(awayState(), "followup")
        const primary = {
            ...base.dialog.primary!,
            deadline: { kind: "ask" as const, deadlineAt: 600123, modeRevocation: 2, automaticRevocation: 3 },
        }
        const view = (interaction: DialogInteraction) =>
            adaptCanonicalTaskView(
                projectCanonicalTaskView({ ...base, dialog: { primary: interaction, approvalsByBlock: {} } }),
                [{ type: "ask", ask: "followup", ts: 42, interactionId: "dialog-1" }],
            )
        expect(view(primary).activeInteraction?.deadline).toEqual({ kind: "ask", deadlineAt: 600123 })
        expect(view({ ...primary, status: "resolving" }).activeInteraction?.deadline).toBeUndefined()
    })
})
