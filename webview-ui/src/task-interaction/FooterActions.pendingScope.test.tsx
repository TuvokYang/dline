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
function cancelIsPending(): boolean {
    return screen.getByRole("button", { name: "Cancel" }).getAttribute("aria-disabled") === "true"
}

/** Build a working task view whose only footer action is task Cancel. */
function cancellableView(stateRevision: number): TaskViewState {
    return {
        taskId: "task-1",
        phase: "streaming",
        stateRevision,
        input: { enabled: false, acceptsText: false, acceptsImages: false, acceptsFiles: false },
        footer: {
            actions: [
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

describe("FooterActions cancel pending scope", () => {
    // Cancelling a task makes the backend emit new projections while the cancel
    // RPC is still in flight. Scoping the pending latch to `stateRevision` made
    // every one of those projections clear it, so Cancel flipped back to enabled
    // mid-cancellation and the user could fire duplicate cancels.
    it("keeps Cancel pending across backend revision advances during the in-flight call", async () => {
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

        fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
        expect(dispatchTaskAction).toHaveBeenCalledTimes(1)
        expect(cancelIsPending()).toBe(true)

        // The backend keeps publishing progress for the same task while it winds down.
        rerender(
            <FooterActions
                dispatch={vi.fn()}
                dispatchTaskAction={dispatchTaskAction}
                draft={EMPTY_DRAFT}
                view={cancellableView(9)}
            />,
        )

        expect(cancelIsPending()).toBe(true)
        fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
        expect(dispatchTaskAction).toHaveBeenCalledTimes(1)

        settleCancel()
    })

    it("releases the pending latch once the cancel call settles", async () => {
        const dispatchTaskAction = vi.fn(async () => undefined)
        render(
            <FooterActions
                dispatch={vi.fn()}
                dispatchTaskAction={dispatchTaskAction}
                draft={EMPTY_DRAFT}
                view={cancellableView(8)}
            />,
        )

        fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
        await vi.waitFor(() => expect(cancelIsPending()).toBe(false))
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

        fireEvent.click(screen.getByRole("button", { name: "Cancel" }))
        expect(cancelIsPending()).toBe(true)

        rerender(
            <FooterActions
                dispatch={vi.fn()}
                dispatchTaskAction={dispatchTaskAction}
                draft={EMPTY_DRAFT}
                view={{ ...cancellableView(1), taskId: "task-2" }}
            />,
        )

        expect(cancelIsPending()).toBe(false)

        settleCancel()
    })
})
