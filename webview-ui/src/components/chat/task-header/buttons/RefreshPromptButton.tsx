import type { PromptFreshnessSnapshot } from "@shared/PromptFreshness"
import { AlertTriangle, RefreshCw } from "lucide-react"
import { useMemo, useState } from "react"
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/common/AlertDialog"
import { buttonVariants } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { cn } from "@/lib/utils"
import { TaskServiceClient } from "@/services/grpc-client"
import { buildRefreshPromptBudget } from "./refreshPromptBudget"

interface RefreshPromptButtonProps {
    taskId?: string
    className?: string
    estimatedInputTokens?: number
    inputPrice?: number
    currency?: string
    promptFreshness?: PromptFreshnessSnapshot
}

/**
 * Button to manually refresh the frozen system prompt cache.
 * Sends a gRPC RefreshPrompt request with confirmation dialog.
 */
const RefreshPromptButton: React.FC<RefreshPromptButtonProps> = ({
    taskId,
    className,
    estimatedInputTokens = 0,
    inputPrice,
    currency,
    promptFreshness,
}) => {
    const { t } = useUiTranslation()
    const [loading, setLoading] = useState(false)
    const [confirmOpen, setConfirmOpen] = useState(false)
    const budget = useMemo(
        () => buildRefreshPromptBudget({ estimatedInputTokens, inputPrice, currency }, t),
        [estimatedInputTokens, inputPrice, currency, t],
    )
    const isStale = promptFreshness?.status === "stale"
    const visibleChanges = promptFreshness?.changes.slice(0, 4) ?? []
    const remainingChangeCount = Math.max(0, (promptFreshness?.changes.length ?? 0) - visibleChanges.length)

    const handleRefresh = (e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        if (!taskId || loading) return
        setConfirmOpen(true)
    }

    const handleCancel = () => {
        setConfirmOpen(false)
    }

    const handleConfirm = async () => {
        if (!taskId || loading) return
        setLoading(true)
        try {
            await TaskServiceClient.refreshPrompt({ taskId })
            setConfirmOpen(false)
        } finally {
            setLoading(false)
        }
    }

    return (
        <>
            <Tooltip>
                <TooltipContent>
                    {isStale ? (
                        <span className="flex max-w-xs flex-col gap-1.5">
                            <span className="font-semibold">{t("chatInput.prompt.available")}</span>
                            <span>{t("chatInput.prompt.oldSnapshot")}</span>
                            {visibleChanges.length > 0 && (
                                <span className="flex flex-col">
                                    {visibleChanges.map((change) => (
                                        <span key={change.kind}>• {t(`chatInput.prompt.change.${change.kind}`)}</span>
                                    ))}
                                    {remainingChangeCount > 0 && (
                                        <span>{t("chatInput.prompt.moreChanges", { count: remainingChangeCount })}</span>
                                    )}
                                </span>
                            )}
                            <span>{t("chatInput.prompt.review")}</span>
                        </span>
                    ) : (
                        t("chatInput.prompt.refresh")
                    )}
                </TooltipContent>
                <TooltipTrigger
                    aria-label={t("chatInput.prompt.refresh")}
                    className={cn(
                        buttonVariants({ variant: "icon", size: "xs" }),
                        "relative !overflow-visible !min-h-6",
                        className,
                    )}
                    disabled={!taskId || loading}
                    onClick={handleRefresh}>
                    <RefreshCw className={loading ? "animate-spin" : ""} />
                    {isStale && (
                        <AlertTriangle
                            aria-label={t("chatInput.prompt.available")}
                            className="absolute -right-1 -top-1 !h-3 !w-3 fill-(--vscode-warningForeground) text-(--vscode-warningForeground)"
                            data-testid="prompt-freshness-warning"
                            role="img"
                        />
                    )}
                </TooltipTrigger>
            </Tooltip>
            <AlertDialog onOpenChange={setConfirmOpen} open={confirmOpen}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            <AlertTriangle className="w-5 h-5 text-(--vscode-warningForeground)" />
                            {t("chatInput.prompt.refresh")}
                        </AlertDialogTitle>
                        <AlertDialogDescription>{t("chatInput.prompt.refreshDescription")}</AlertDialogDescription>
                    </AlertDialogHeader>
                    <div
                        className="mt-4 rounded-xs border border-(--vscode-panel-border) p-3 text-left shadow-[inset_0_0_0_1px_var(--vscode-editorWidget-border)]"
                        style={{ backgroundColor: "var(--vscode-editor-background)" }}>
                        <div className="text-xs font-semibold uppercase tracking-wide text-(--vscode-editor-foreground)">
                            {t("chatInput.prompt.estimatedMiss")}
                        </div>
                        <div className="mt-2 text-lg font-bold text-(--vscode-editor-foreground)">{budget.tokenLine}</div>
                        {budget.priceLine && (
                            <div className="mt-1 text-lg font-bold text-(--vscode-editor-foreground)">{budget.priceLine}</div>
                        )}
                        {budget.inputPriceLine && (
                            <div className="mt-3 text-xs font-medium text-(--vscode-editor-foreground)">
                                {budget.inputPriceLine}
                            </div>
                        )}
                    </div>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={loading} onClick={handleCancel}>
                            {t("chatInput.common.cancel")}
                        </AlertDialogCancel>
                        <AlertDialogAction disabled={loading} onClick={handleConfirm}>
                            {t(loading ? "chatInput.prompt.refreshing" : "chatInput.common.confirm")}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    )
}
RefreshPromptButton.displayName = "RefreshPromptButton"

export default RefreshPromptButton
