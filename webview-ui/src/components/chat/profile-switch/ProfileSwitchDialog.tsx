import type { ProfileSwitchSnapshot } from "@shared/profile-switch"
import { ContextTransitionDialog, type ContextTransitionDialogState } from "../context-transition/ContextTransitionDialog"

interface ProfileSwitchDialogProps {
    state: ProfileSwitchSnapshot
    onCancel: (operationId: string) => void
    onConfirm: (operationId: string) => void
    onRetry: (operationId: string) => void
}

/** Map Profile transaction state into the shared transition presentation. */
export function ProfileSwitchDialog({ state, onCancel, onConfirm, onRetry }: ProfileSwitchDialogProps) {
    if ((state.phase !== "awaiting_confirmation" && state.phase !== "failed") || !state.operationId) return null
    const dialogState: ContextTransitionDialogState = {
        kind: "profile",
        phase: state.phase,
        operationId: state.operationId,
        sourceLabel: state.sourceProfile,
        targetLabel: state.targetProfile,
        targetAdopted: state.targetAdopted,
        compactionModel: state.compactionModel,
        targetContextWindow: state.targetContextWindow,
        currentTokens: state.currentTokens,
        fittingExitTarget: state.fittingExitTarget,
        error: state.error,
    }
    return <ContextTransitionDialog onCancel={onCancel} onConfirm={onConfirm} onRetry={onRetry} state={dialogState} />
}
