import { AlertTriangle } from "lucide-react"
import { useEffect, useState } from "react"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
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

/** Render one consistent confirmation or terminal failure for Profile and Mode transitions. */
export function ContextTransitionDialog({ state, onCancel, onConfirm, onRetry }: ContextTransitionDialogProps) {
    const { t } = useUiTranslation()
    const [dismissedFailureId, setDismissedFailureId] = useState<string>()

    /** Format a context-window or token count for readable transaction details. */
    const formatCount = (value?: number): string =>
        typeof value === "number" && Number.isFinite(value)
            ? Math.max(0, value).toLocaleString("en-US")
            : t("chatRows.transition.available")

    useEffect(() => {
        if (state?.phase !== "failed" || state.operationId !== dismissedFailureId) {
            setDismissedFailureId(undefined)
        }
    }, [dismissedFailureId, state?.operationId, state?.phase])

    if (!state || (state.phase === "failed" && state.operationId === dismissedFailureId)) return null

    const isFailure = state.phase === "failed"
    const isProfile = state.kind === "profile"
    const operationId = state.operationId
    const sourceLabel = state.sourceLabel ?? t("chatRows.transition.sourceDefault")
    const targetLabel = state.targetLabel ?? t("chatRows.transition.targetDefault")

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
                            ? t("chatRows.transition.switchNotCompleted")
                            : isProfile
                              ? t("chatRows.transition.smallerWindowTitle")
                              : t("chatRows.transition.compactTitle")}
                    </AlertDialogTitle>
                    <AlertDialogDescription>
                        {isFailure ? (
                            isProfile && state.targetAdopted ? (
                                <>{t("chatRows.transition.targetAdopted", { target: targetLabel })}</>
                            ) : (
                                <>{t("chatRows.transition.sourceRetained", { source: sourceLabel })}</>
                            )
                        ) : isProfile ? (
                            <>{t("chatRows.transition.profileBody", { target: targetLabel })}</>
                        ) : (
                            <>{t("chatRows.transition.compactBody", { target: targetLabel })}</>
                        )}
                    </AlertDialogDescription>
                </AlertDialogHeader>

                <div className="mt-4 grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 rounded-xs border border-[rgba(255,255,255,0.12)] bg-[rgba(0,0,0,0.18)] p-3 text-sm">
                    <span className="text-[#a1a1aa]">{t("chatRows.common.source")}</span>
                    <span>
                        {sourceLabel}
                        {state.sourceContextWindow !== undefined
                            ? ` · ${t("chatRows.common.tokens", { count: formatCount(state.sourceContextWindow) })}`
                            : ""}
                    </span>
                    <span className="text-[#a1a1aa]">{t("chatRows.common.target")}</span>
                    <span>
                        {targetLabel}
                        {state.targetContextWindow !== undefined
                            ? ` · ${t("chatRows.common.tokens", { count: formatCount(state.targetContextWindow) })}`
                            : ""}
                    </span>
                    {state.currentTokens !== undefined && (
                        <>
                            <span className="text-[#a1a1aa]">
                                {isProfile ? t("chatRows.transition.contextInUse") : t("chatRows.transition.completeCandidate")}
                            </span>
                            <span>{t("chatRows.common.tokens", { count: formatCount(state.currentTokens) })}</span>
                        </>
                    )}
                    {state.fittingExitTarget !== undefined && (
                        <>
                            <span className="text-[#a1a1aa]">{t("chatRows.transition.mustFitBelow")}</span>
                            <span>{t("chatRows.common.tokens", { count: formatCount(state.fittingExitTarget) })}</span>
                        </>
                    )}
                    {state.compactionModel && (
                        <>
                            <span className="text-[#a1a1aa]">{t("chatRows.transition.compactionModel")}</span>
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
                            <AlertDialogCancel onClick={() => setDismissedFailureId(operationId)}>
                                {t("chatRows.common.dismiss")}
                            </AlertDialogCancel>
                            <AlertDialogAction onClick={() => onRetry(operationId)}>
                                {t("chatRows.common.retry")}
                            </AlertDialogAction>
                        </>
                    ) : (
                        <>
                            <AlertDialogCancel onClick={() => onCancel(operationId)}>
                                {t("chatRows.common.cancel")}
                            </AlertDialogCancel>
                            <AlertDialogAction onClick={() => onConfirm(operationId)}>
                                {isProfile ? t("chatRows.transition.switch") : t("chatRows.transition.compactAndSwitch")}
                            </AlertDialogAction>
                        </>
                    )}
                </AlertDialogFooter>
            </AlertDialogContent>
        </AlertDialog>
    )
}
