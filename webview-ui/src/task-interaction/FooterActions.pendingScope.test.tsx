import type { TaskViewState } from "@shared/ExtensionMessage"
import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { FooterActions } from "./FooterActions"
import type { InteractionDraft } from "./types"

const EMPTY_DRAFT: InteractionDraft = { text: "", images: [], files: [] }

/**
 * Read the pending state from the rendered action.
 *
 * `vscode-button` is a custom element, so `toBeDisabled` does not apply: the
 * component mirrors its disabled state onto `aria-disabled`.
 */
function handoffIsPending(): boolean {
    return handoffButton().getAttribute("aria-disabled") === "true"
}

function handoffButton(): HTMLElement {
    return screen.getByRole("button", { name: "Continue in Background" })
}

/**
 * Build a working task view whose footer offers a task action. Cancel rides
 * along as the backend projects it, but the composer's action button owns it.
 */
function cancellableView(stateRevision: number): TaskViewState {
    return {
        taskId: "task-1",
        phase: "executing",
        stateRevision,
        input: { enabled: false, acceptsText: false, acceptsImages: false, acceptsFiles: false },
        footer: {
            actions: [
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
            ],
        },
    } as TaskViewState
}

describe("FooterActions task action pending scope", () => {
    // A task action makes the backend emit new projections while its RPC is
    // still in flight. Scoping the pending latch to `stateRevision` made every
    // one of those projections clear it, so the action flipped back to enabled
    // mid-flight and the user could fire it twice.
    it("keeps a task action pending across backend revision advances during the in-flight call", async () => {
        let settleCancel: () => void = () => undefined
        const dispatchTaskAction = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    settleCancel = resolve
                }),
        )
        const { rerender } = render(
            <FooterActions
                dispatch={vi.fn()}
                dispatchTaskAction={dispatchTaskAction}
                draft={EMPTY_DRAFT}
                view={cancellableView(8)}
            />,
        )

        fireEvent.click(handoffButton())
        expect(dispatchTaskAction).toHaveBeenCalledTimes(1)
        expect(handoffIsPending()).toBe(true)

        // The backend keeps publishing progress for the same task meanwhile.
        rerender(
            <FooterActions
                dispatch={vi.fn()}
                dispatchTaskAction={dispatchTaskAction}
                draft={EMPTY_DRAFT}
                view={cancellableView(9)}
            />,
        )

        expect(handoffIsPending()).toBe(true)
        fireEvent.click(handoffButton())
        expect(dispatchTaskAction).toHaveBeenCalledTimes(1)

        settleCancel()
    })

    it("releases the pending latch once the task action settles", async () => {
        const dispatchTaskAction = vi.fn(async () => undefined)
        render(
            <FooterActions
                dispatch={vi.fn()}
                dispatchTaskAction={dispatchTaskAction}
                draft={EMPTY_DRAFT}
                view={cancellableView(8)}
            />,
        )

        fireEvent.click(handoffButton())
        await vi.waitFor(() => expect(handoffIsPending()).toBe(false))
        expect(dispatchTaskAction).toHaveBeenCalledTimes(1)
    })

    // Switching to a different task must not inherit the previous task's latch.
    it("does not carry the pending latch across a task switch", async () => {
        let settleCancel: () => void = () => undefined
        const dispatchTaskAction = vi.fn(
            () =>
                new Promise<void>((resolve) => {
                    settleCancel = resolve
                }),
        )
        const { rerender } = render(
            <FooterActions
                dispatch={vi.fn()}
                dispatchTaskAction={dispatchTaskAction}
                draft={EMPTY_DRAFT}
                view={cancellableView(8)}
            />,
        )

        fireEvent.click(handoffButton())
        expect(handoffIsPending()).toBe(true)

        rerender(
            <FooterActions
                dispatch={vi.fn()}
                dispatchTaskAction={dispatchTaskAction}
                draft={EMPTY_DRAFT}
                view={{ ...cancellableView(1), taskId: "task-2" }}
            />,
        )

        expect(handoffIsPending()).toBe(false)

        settleCancel()
    })
})
