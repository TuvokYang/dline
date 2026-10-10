import type { ModeSwitchSnapshot } from "@shared/mode-switch"
import { ContextTransitionDialog, type ContextTransitionDialogState } from "../context-transition/ContextTransitionDialog"

interface ModeSwitchDialogProps {
    state: ModeSwitchSnapshot
    onCancel: (operationId: string) => void
    onConfirm: (operationId: string) => void
    onRetry?: (operationId: string) => void
}

/** Map Mode transaction state into the shared transition presentation. */
export function ModeSwitchDialog({ state, onCancel, onConfirm, onRetry }: ModeSwitchDialogProps) {
    if ((state.phase !== "awaiting_confirmation" && state.phase !== "failed") || !state.operationId) return null
    const dialogState: ContextTransitionDialogState = {
        kind: "mode",
        phase: state.phase,
        operationId: state.operationId,
        sourceLabel: state.sourceProfile ?? state.sourceMode,
        targetLabel: state.targetProfile ?? state.targetMode,
        compactionModel: state.compactionModel,
        sourceContextWindow: state.sourceContextWindow,
        targetContextWindow: state.targetContextWindow,
        currentTokens: state.currentTokens,
        fittingExitTarget: state.fittingExitTarget,
        error: state.error,
    }
    return (
        <ContextTransitionDialog
            onCancel={onCancel}
            onConfirm={onConfirm}
            onRetry={onRetry ?? (() => undefined)}
            state={dialogState}
        />
    )
}
