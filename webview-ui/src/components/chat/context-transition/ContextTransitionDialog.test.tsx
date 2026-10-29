import { fireEvent, render, screen } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { ContextTransitionDialog, type ContextTransitionDialogState } from "./ContextTransitionDialog"

function awaitingState(): ContextTransitionDialogState {
    return {
        kind: "profile",
        phase: "awaiting_confirmation",
        operationId: "operation-1",
        sourceLabel: "large-profile",
        targetLabel: "small-profile",
        currentTokens: 92_000,
        targetContextWindow: 100_000,
        fittingExitTarget: 80_000,
    }
}

describe("ContextTransitionDialog", () => {
    it("presents the Profile window notice as advice that never promises compaction", () => {
        render(<ContextTransitionDialog onCancel={vi.fn()} onConfirm={vi.fn()} onRetry={vi.fn()} state={awaitingState()} />)

        expect(screen.getByText(/nothing is compacted now/i)).toBeInTheDocument()
        expect(screen.getByText("Context in use")).toBeInTheDocument()
        expect(screen.getByText("Switch")).toBeInTheDocument()
        expect(screen.queryByText("Compact & Switch")).not.toBeInTheDocument()
    })

    it("keeps a Mode transition describing the compaction it still performs", () => {
        render(
            <ContextTransitionDialog
                onCancel={vi.fn()}
                onConfirm={vi.fn()}
                onRetry={vi.fn()}
                state={{ ...awaitingState(), kind: "mode" }}
            />,
        )

        expect(screen.getByText(/Compaction will run with/i)).toBeInTheDocument()
        expect(screen.getByText("Compact & Switch")).toBeInTheDocument()
    })

    it("reports a failed Profile switch while keeping the adopted target active", () => {
        const onRetry = vi.fn()
        render(
            <ContextTransitionDialog
                onCancel={vi.fn()}
                onConfirm={vi.fn()}
                onRetry={onRetry}
                state={{
                    ...awaitingState(),
                    phase: "failed",
                    targetAdopted: true,
                    error: "Profile switch state changed before commit.",
                }}
            />,
        )

        expect(screen.getByText("Switch not completed")).toBeInTheDocument()
        expect(screen.getByText(/small-profile remains active/i)).toBeInTheDocument()
        expect(screen.getByText("Profile switch state changed before commit.")).toBeInTheDocument()
        fireEvent.click(screen.getByText("Retry"))
        expect(onRetry).toHaveBeenCalledWith("operation-1")
        fireEvent.click(screen.getByText("Dismiss"))
        expect(screen.queryByRole("dialog")).not.toBeInTheDocument()
    })

    it("reports a failed Profile adoption without claiming that the target remains active", () => {
        render(
            <ContextTransitionDialog
                onCancel={vi.fn()}
                onConfirm={vi.fn()}
                onRetry={vi.fn()}
                state={{ ...awaitingState(), phase: "failed", targetAdopted: false, error: "Profile adoption failed." }}
            />,
        )

        expect(screen.getByText("Switch not completed")).toBeInTheDocument()
        expect(screen.getByText(/large-profile remains active/i)).toBeInTheDocument()
        expect(screen.getByText("Profile adoption failed.")).toBeInTheDocument()
    })
})
