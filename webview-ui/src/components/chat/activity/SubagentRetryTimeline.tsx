import type { TaskActivityEvent } from "@shared/proto/dline/task"
import { useMemo } from "react"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { buildSubagentRetryAttempts, type SubagentRetryAttempt } from "./subagent-activity-model"

function formatRetryDuration(milliseconds: number): string {
    const seconds = Math.max(0, Math.round(milliseconds / 1000))
    if (seconds < 60) return `${seconds}s`
    const minutes = Math.floor(seconds / 60)
    const remainingSeconds = seconds % 60
    return remainingSeconds > 0 ? `${minutes}m ${remainingSeconds}s` : `${minutes}m`
}

export function SubagentRetryTimeline({
    events,
    attempts,
    currentAttempt,
}: {
    events?: TaskActivityEvent[]
    attempts?: readonly SubagentRetryAttempt[]
    currentAttempt?: number
}) {
    const { t } = useUiTranslation()
    const projectedAttempts = useMemo(
        () => attempts ?? buildSubagentRetryAttempts(events, currentAttempt),
        [attempts, events, currentAttempt],
    )
    if (projectedAttempts.length === 0) return null

    return (
        <div className="min-w-0 text-[11px] text-description" data-testid="subagent-retry-timeline">
            <div className="mb-1 font-semibold uppercase tracking-wide">
                {t("chatRows.subagent.retries", { count: projectedAttempts.length })}
            </div>
            <ol className="m-0 space-y-0.5 p-0 list-none">
                {projectedAttempts.map((attempt) => (
                    <li
                        className="flex min-w-0 flex-wrap items-center gap-x-1.5 font-mono"
                        data-testid="subagent-retry-attempt"
                        key={attempt.sequence}>
                        <span>
                            {t("chatRows.subagent.retry", {
                                attempt: attempt.retryAttempt,
                                maxRetries: attempt.maxRetries,
                            })}
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>{t("chatRows.subagent.retryWait", { duration: formatRetryDuration(attempt.delayMs) })}</span>
                        <span aria-hidden="true">·</span>
                        <span>
                            {t("chatRows.subagent.retryTotal", {
                                duration: formatRetryDuration(attempt.cumulativeDelayMs),
                            })}
                        </span>
                    </li>
                ))}
            </ol>
        </div>
    )
}
