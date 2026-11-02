import { describeFoldUsage } from "@shared/chat/foldUsage"
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import type React from "react"
import { useMemo } from "react"
import { describeActivityFoldParts, describeFoldDetail, summarizeActivityFold } from "../../utils/activityFoldSummary"
import type { ActivityFold } from "../../utils/chatRowKinds"
import { rowIdentity } from "../../utils/rowCoordinate"
import { RowContent, type RowRenderContext } from "./RowContent"

interface ActivityFoldRendererProps extends RowRenderContext {
    fold: ActivityFold
    expanded: boolean
    onToggleFold: (foldId: string) => void
}

/**
 * One collapsible block of finished activity.
 *
 * The header is drawn whether the block is open or closed, so the same control
 * opens it and closes it again. The cost line — generation time, tokens and the
 * average token rate — stays with the header in both states: it answers "what
 * did this block cost me" before the reader opens it, and keeps answering while
 * they read the work underneath.
 */
export const ActivityFoldRenderer: React.FC<ActivityFoldRendererProps> = ({ fold, expanded, onToggleFold, ...context }) => {
    const summary = useMemo(
        () => summarizeActivityFold(fold, context.checkpointAttachments),
        [fold, context.checkpointAttachments],
    )
    const parts = useMemo(() => describeActivityFoldParts(summary), [summary])
    const detail = useMemo(() => describeFoldDetail(summary), [summary])
    const usage = useMemo(() => (fold._usage ? describeFoldUsage(fold._usage) : ""), [fold._usage])
    const foldId = fold._activityFoldId

    return (
        <div data-fold-id={foldId} data-testid="activity-fold">
            <div className="px-4 py-1">
                <button
                    aria-expanded={expanded}
                    className="flex w-full items-start gap-1.5 rounded-xs border-0 bg-transparent p-0 text-left text-xs text-description hover:text-foreground cursor-pointer"
                    data-testid="activity-fold-header"
                    onClick={() => onToggleFold(foldId)}
                    title={detail}
                    type="button">
                    {expanded ? (
                        <ChevronDownIcon className="mt-0.5 size-3 shrink-0" />
                    ) : (
                        <ChevronRightIcon className="mt-0.5 size-3 shrink-0" />
                    )}
                    {/* One wrapping line: the figures ride beside the summary when they fit and
                        fall onto a second line aligned with it when the summary is too wide.
                        Each part wraps on its own, so a long summary cannot truncate the
                        counts that follow it. */}
                    <span className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-0.5">
                        <span className="min-w-0 break-words">
                            {parts.map((part, index) => (
                                <span key={part.text}>
                                    {index === 0 ? "" : " · "}
                                    {/* A lost edit, command or subagent is the first thing a
                                        reader looks for, so error counts carry the error tone
                                        while the rest of the line stays muted. */}
                                    <span className={part.isFailure ? "text-error" : undefined}>{part.text}</span>
                                </span>
                            ))}
                        </span>
                        {/* The cost capsule is one unbroken unit: it states what the block
                            spent, and a header too narrow for it wraps the capsule to its own
                            line instead of truncating the figures. */}
                        {usage !== "" && (
                            <span
                                className="shrink-0 whitespace-nowrap rounded-xs bg-toolbar-hover/40 px-1.5 py-0.5 text-[11px] leading-none tabular-nums text-description"
                                data-testid="activity-fold-usage">
                                {usage}
                            </span>
                        )}
                    </span>
                </button>
            </div>
            {expanded && (
                <div data-testid="activity-fold-children">
                    {fold._children.map((child) => (
                        <div key={rowIdentity(child)}>
                            <RowContent {...context} isLastRow={false} isLastToolActivity={false} row={child} />
                        </div>
                    ))}
                </div>
            )}
        </div>
    )
}
