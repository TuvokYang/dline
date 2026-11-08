import { useState } from "react"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { MetricIcon } from "../../../common/metrics/MetricIcon"
import { Button } from "../../../ui/button"
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from "../../../ui/dialog"
import { TaskMetricsChart } from "./TaskMetricsChart"
import type { TaskMetricsChartType, TaskMetricsView } from "./TaskMetricsChartModel"
import { type TaskRateMetricsResolution, useTaskRateMetrics } from "./useTaskRateMetrics"

interface TaskRateMetricsDialogProps {
    taskId?: string
    taskInstanceId?: string
    open: boolean
    onOpenChange: (open: boolean) => void
}

const RESOLUTION_OPTIONS: Array<{ value: TaskRateMetricsResolution; label: string }> = [
    { value: "minute", label: "Minute" },
    { value: "hour", label: "Hour" },
    { value: "day", label: "Day" },
]

const VIEW_OPTIONS: Array<{ value: TaskMetricsView; label: string }> = [
    { value: "tokenCache", label: "Token/Cache" },
    { value: "rates", label: "TPM/RPM" },
]

const CHART_TYPE_OPTIONS: Array<{ value: TaskMetricsChartType; icon: "bar" | "line"; label: string }> = [
    { value: "bar", icon: "bar", label: "Bar" },
    { value: "line", icon: "line", label: "Line" },
]

/** Show Task-local API rate history on demand. */
export function TaskRateMetricsDialog({ taskId, taskInstanceId, open, onOpenChange }: TaskRateMetricsDialogProps) {
    const { t } = useUiTranslation()
    const [resolution, setResolution] = useState<TaskRateMetricsResolution>("hour")
    const [view, setView] = useState<TaskMetricsView>("tokenCache")
    const [chartType, setChartType] = useState<TaskMetricsChartType>("line")
    const { data, loading, error, refresh } = useTaskRateMetrics({ taskId, taskInstanceId, resolution, enabled: open })

    return (
        <Dialog onOpenChange={onOpenChange} open={open}>
            <DialogContent className="max-w-3xl gap-2 p-2">
                <DialogHeader>
                    <DialogTitle>{t("chatInput.metrics.title")}</DialogTitle>
                    <DialogDescription>{t("chatInput.metrics.description")}</DialogDescription>
                </DialogHeader>

                <div
                    aria-label={t("chatInput.metrics.controls")}
                    className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 overflow-visible whitespace-nowrap"
                    data-testid="task-metrics-toolbar"
                    role="toolbar">
                    <select
                        aria-label={t("chatInput.metrics.resolution")}
                        className="h-5 w-[58px] shrink-0 rounded-sm border border-input-placeholder/30 bg-background px-1 text-center text-[11px] leading-normal text-foreground [text-align-last:center]"
                        onChange={(event) => setResolution(event.currentTarget.value as TaskRateMetricsResolution)}
                        value={resolution}>
                        {RESOLUTION_OPTIONS.map((option) => (
                            <option key={option.value} value={option.value}>
                                {t(`chatInput.metrics.${option.value}`)}
                            </option>
                        ))}
                    </select>

                    <div aria-label={t("chatInput.metrics.view")} className="flex shrink-0 items-center gap-1" role="radiogroup">
                        {VIEW_OPTIONS.map((option) => {
                            const selected = view === option.value
                            return (
                                <button
                                    aria-checked={selected}
                                    className={`inline-flex h-5 items-center rounded-sm px-1 text-[11px] leading-normal ${
                                        selected
                                            ? "bg-button-background text-button-foreground"
                                            : "bg-transparent text-description hover:bg-toolbar-hover"
                                    }`}
                                    key={option.value}
                                    onClick={() => setView(option.value)}
                                    role="radio"
                                    type="button">
                                    {t(`chatInput.metrics.${option.value}`)}
                                </button>
                            )
                        })}
                    </div>

                    <div
                        aria-label={t("chatInput.metrics.chartType")}
                        className="flex shrink-0 items-center gap-1"
                        role="radiogroup">
                        {CHART_TYPE_OPTIONS.map((option) => {
                            const selected = chartType === option.value
                            return (
                                <button
                                    aria-checked={selected}
                                    aria-label={t(`chatInput.metrics.${option.value}`)}
                                    className={`inline-flex size-4 items-center justify-center rounded-sm ${
                                        selected
                                            ? "bg-button-background text-button-foreground"
                                            : "bg-transparent text-description hover:bg-toolbar-hover"
                                    }`}
                                    key={option.value}
                                    onClick={() => setChartType(option.value)}
                                    role="radio"
                                    title={t(`chatInput.metrics.${option.value}`)}
                                    type="button">
                                    <MetricIcon kind={option.icon} />
                                </button>
                            )
                        })}
                    </div>

                    <button
                        aria-label={t("chatInput.metrics.refresh")}
                        className="ml-auto inline-flex size-4 shrink-0 items-center justify-center rounded-sm border border-input-placeholder/30 text-[10px] text-description hover:bg-toolbar-hover hover:text-foreground"
                        onClick={refresh}
                        title={t("chatInput.metrics.refresh")}
                        type="button">
                        ↻
                    </button>
                </div>

                {loading && (
                    <div className="py-12 text-center text-description" role="status">
                        {t("chatInput.metrics.loading")}
                    </div>
                )}
                {!loading && error && (
                    <div className="rounded-sm border border-error/40 bg-error/10 p-3" role="alert">
                        <p>{error}</p>
                        <Button className="mt-2" onClick={refresh} size="xs" variant="outline">
                            {t("chatInput.common.retry")}
                        </Button>
                    </div>
                )}
                {!loading && !error && data && data.points.length === 0 && (
                    <div className="py-12 text-center text-description">{t("chatInput.metrics.empty")}</div>
                )}
                {!loading && !error && data && data.points.length > 0 && (
                    <>
                        {(data.degraded || data.truncated) && (
                            <div className="flex flex-wrap gap-x-3 gap-y-1 text-[10px] text-description">
                                {data.degraded && <span>{t("chatInput.metrics.degraded")}</span>}
                                {data.truncated && <span>{t("chatInput.metrics.truncated")}</span>}
                            </div>
                        )}
                        <TaskMetricsChart chartType={chartType} degraded={data.degraded} points={data.points} view={view} />
                    </>
                )}
            </DialogContent>
        </Dialog>
    )
}
