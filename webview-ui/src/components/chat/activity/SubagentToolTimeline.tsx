import type { TaskActivityEvent } from "@shared/proto/dline/task"
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, CircleXIcon, LoaderCircleIcon } from "lucide-react"
import { useMemo, useState } from "react"
import { cn } from "@/lib/utils"
import { buildSubagentToolSteps, type SubagentToolStep } from "./subagent-activity-model"

function ToolStatusIcon({ status }: { status: SubagentToolStep["status"] }) {
    if (status === "started") return <LoaderCircleIcon className="size-3 shrink-0 animate-spin text-link" />
    if (status === "failed") return <CircleXIcon className="size-3 shrink-0 text-error" />
    return <CheckIcon className="size-3 shrink-0 text-success" />
}

function statusLabel(status: SubagentToolStep["status"]): string {
    if (status === "started") return "Running"
    if (status === "failed") return "Failed"
    return "Done"
}

type SubagentToolDetailsMode = "none" | "inline"

function ToolStep({
    step,
    index,
    compact,
    detailsMode,
}: {
    step: SubagentToolStep
    index: number
    compact: boolean
    detailsMode: SubagentToolDetailsMode
}) {
    const [expanded, setExpanded] = useState(false)
    const canExpandDetails = detailsMode === "inline" && Boolean(step.resultText || step.error)
    const summary = step.summary || ""

    return (
        <li className="min-w-0" data-testid="subagent-tool-step">
            <button
                aria-expanded={canExpandDetails ? expanded : undefined}
                className={cn(
                    "flex w-full min-w-0 items-center gap-1.5 border-0 bg-transparent text-left text-foreground",
                    compact ? "py-0.5 text-[10px]" : "rounded-xs px-1.5 py-1 text-[11px] hover:bg-toolbar-hover/40",
                    !canExpandDetails && "cursor-default",
                )}
                disabled={!canExpandDetails}
                onClick={() => canExpandDetails && setExpanded((value) => !value)}
                type="button">
                <span className="w-4 shrink-0 text-right font-mono text-[10px] text-description tabular-nums">{index + 1}</span>
                <ToolStatusIcon status={step.status} />
                <span className="min-w-0 shrink-0 font-mono font-medium" data-testid="subagent-tool-step-name">
                    {step.toolName}
                </span>
                {summary && (
                    <span
                        className="min-w-0 flex-1 truncate font-mono text-description"
                        data-testid="subagent-tool-step-summary"
                        title={summary}>
                        {summary}
                    </span>
                )}
                <span
                    className="ml-auto flex shrink-0 items-center gap-1 text-[10px] text-description"
                    data-testid="subagent-tool-step-status">
                    {step.durationMs !== undefined && <span>{step.durationMs}ms</span>}
                    <span>{statusLabel(step.status)}</span>
                    {canExpandDetails &&
                        (expanded ? <ChevronDownIcon className="size-3" /> : <ChevronRightIcon className="size-3" />)}
                </span>
            </button>
            {expanded && canExpandDetails && (
                <div
                    className="ml-7 min-w-0 border-l border-editor-group-border pl-2 pb-1 text-[11px]"
                    data-testid="subagent-tool-step-details">
                    {step.resultText && (
                        <pre className="m-0 max-h-[160px] overflow-auto whitespace-pre-wrap break-words font-mono text-foreground/80">
                            {step.resultText}
                        </pre>
                    )}
                    {step.error && <div className="whitespace-pre-wrap break-words text-error">{step.error}</div>}
                </div>
            )}
        </li>
    )
}

export function SubagentToolTimeline({
    events,
    steps,
    currentAttempt,
    compact = false,
    className,
    detailsMode = "inline",
    showHeader = true,
}: {
    events?: TaskActivityEvent[]
    steps?: readonly SubagentToolStep[]
    currentAttempt?: number
    compact?: boolean
    className?: string
    detailsMode?: SubagentToolDetailsMode
    showHeader?: boolean
}) {
    const projectedSteps = useMemo(() => steps ?? buildSubagentToolSteps(events, currentAttempt), [steps, events, currentAttempt])
    if (projectedSteps.length === 0) return null

    return (
        <div className={cn("min-w-0", className)} data-testid="subagent-tool-timeline">
            {showHeader && (
                <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wide text-description">
                    <span>Tools</span>
                    <span className="font-normal normal-case">({projectedSteps.length})</span>
                </div>
            )}
            <ol className={cn("m-0 list-none p-0", !compact && "space-y-0.5")}>
                {projectedSteps.map((step, index) => (
                    <ToolStep compact={compact} detailsMode={detailsMode} index={index} key={step.toolCallId} step={step} />
                ))}
            </ol>
        </div>
    )
}
