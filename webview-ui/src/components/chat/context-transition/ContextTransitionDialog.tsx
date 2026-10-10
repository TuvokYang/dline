import { AlertTriangle } from "lucide-react"
import { useEffect, useState } from "react"
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "../../common/AlertDialog"

export type ContextTransitionDialogPhase = "awaiting_confirmation" | "failed"

export interface ContextTransitionDialogState {
    kind: "mode" | "profile"
    phase: ContextTransitionDialogPhase
    operationId: string
    sourceLabel?: string
    targetLabel?: string
    targetAdopted?: boolean
    compactionModel?: string
    sourceContextWindow?: number
    targetContextWindow?: number
    currentTokens?: number
    fittingExitTarget?: number
    error?: string
}

interface ContextTransitionDialogProps {
    state?: ContextTransitionDialogState
    onCancel: (operationId: string) => void
    onConfirm: (operationId: string) => void
    onRetry: (operationId: string) => void
}

/** Format a context-window or token count for readable transaction details. */
function formatCount(value?: number): string {
    return typeof value === "number" && Number.isFinite(value) ? Math.max(0, value).toLocaleString("en-US") : "Unavailable"
}

/** Render one consistent confirmation or terminal failure for Profile and Mode transitions. */
export function ContextTransitionDialog({ state, onCancel, onConfirm, onRetry }: ContextTransitionDialogProps) {
    const [dismissedFailureId, setDismissedFailureId] = useState<string>()

    useEffect(() => {
        if (state?.phase !== "failed" || state.operationId !== dismissedFailureId) {
            setDismissedFailureId(undefined)
        }
    }, [dismissedFailureId, state?.operationId, state?.phase])

    if (!state || (state.phase === "failed" && state.operationId === dismissedFailureId)) return null

    const isFailure = state.phase === "failed"
    const isProfile = state.kind === "profile"
    const operationId = state.operationId
    const sourceLabel = state.sourceLabel ?? "source settings"
    const targetLabel = state.targetLabel ?? "target settings"

    const handleOpenChange = (open: boolean): void => {
        if (open) return
        if (isFailure) setDismissedFailureId(operationId)
        else onCancel(operationId)
    }

    return (
        <AlertDialog onOpenChange={handleOpenChange} open={true}>
            <AlertDialogContent>
                <AlertDialogHeader>
                    <AlertDialogTitle>
                        <AlertTriangle className="h-5 w-5 text-(--vscode-errorForeground)" />
                        {isFailure
                            ? "Switch not completed"
                            : isProfile
                              ? "Switch to a smaller context window?"
                              : "Compact context before switching?"}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                        {isFailure ? (
                            isProfile && state.targetAdopted ? (
                                <>{targetLabel} remains active.</>
                            ) : (
                                <>{sourceLabel} remains active. The target settings were not adopted.</>
                            )
                        ) : isProfile ? (
                            <>
                                The context already in use does not fit inside the {targetLabel} context window. Switching only
                                rebinds the handler; nothing is compacted now, and ordinary compaction still runs later while the
                                task continues.
                            </>
                        ) : (
                            <>
                                The target context window cannot safely hold the complete candidate. Compaction will run with{" "}
                                {targetLabel}, the target Profile, before the switch is committed.
                            </>
                        )}
                    </AlertDialogDescription>
                </AlertDialogHeader>

                <div className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-xs border border-[rgba(255,255,255,0.12)] bg-[rgba(0,0,0,0.18)] p-3 text-sm">
                    <span className="text-[#a1a1aa]">Source</span>
                    <span>
                        {sourceLabel}
                        {state.sourceContextWindow !== undefined ? ` · ${formatCount(state.sourceContextWindow)} tokens` : ""}
                    </span>
                    <span className="text-[#a1a1aa]">Target</span>
                    <span>
                        {targetLabel}
                        {state.targetContextWindow !== undefined ? ` · ${formatCount(state.targetContextWindow)} tokens` : ""}
                    </span>
                    {state.currentTokens !== undefined && (
                        <>
                            <span className="text-[#a1a1aa]">{isProfile ? "Context in use" : "Complete candidate"}</span>
                            <span>{formatCount(state.currentTokens)} tokens</span>
                        </>
                    )}
                    {state.fittingExitTarget !== undefined && (
                        <>
                            <span className="text-[#a1a1aa]">Must fit below</span>
                            <span>{formatCount(state.fittingExitTarget)} tokens</span>
                        </>
                    )}
                    {state.compactionModel && (
                        <>
                            <span className="text-[#a1a1aa]">Compaction model</span>
                            <span className="break-all">{state.compactionModel}</span>
                        </>
                    )}
                </div>

                {isFailure && state.error && (
                    <p className="mt-3 rounded-xs border border-(--vscode-inputValidation-errorBorder) bg-(--vscode-inputValidation-errorBackground) p-2 text-sm">
                        {state.error}
                    </p>
                )}

                <AlertDialogFooter>
                    {isFailure ? (
                        <>
                            <AlertDialogCancel onClick={() => setDismissedFailureId(operationId)}>Dismiss</AlertDialogCancel>
                            <AlertDialogAction onClick={() => onRetry(operationId)}>Retry</AlertDialogAction>
                        </>
                    ) : (
                        <>
                            <AlertDialogCancel onClick={() => onCancel(operationId)}>Cancel</AlertDialogCancel>
                            <AlertDialogAction onClick={() => onConfirm(operationId)}>
                                {isProfile ? "Switch" : "Compact & Switch"}
                            </AlertDialogAction>
                        </>
                    )}
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    )
}
