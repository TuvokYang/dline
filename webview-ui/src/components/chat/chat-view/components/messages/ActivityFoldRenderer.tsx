import { ChevronRightIcon } from "lucide-react"
import type React from "react"
import { useMemo } from "react"
import { cn } from "@/lib/utils"
import { describeActivityFold, describeToolCalls, summarizeActivityFold } from "../../utils/activityFoldSummary"
import type { ActivityFold } from "../../utils/chatRowKinds"
import { rowIdentity } from "../../utils/rowCoordinate"
import { RowContent, type RowRenderContext } from "./RowContent"

interface ActivityFoldRendererProps extends RowRenderContext {
    fold: ActivityFold
    isExpanded: boolean
    onToggleFold: (foldId: string) => void
}

/**
 * A collapsible block of finished rows.
 *
 * Collapsed, it draws a one-line summary. Expanded, it draws each member row
 * exactly as the standard level does, so nested groups keep their own
 * expansion. A fold only ever holds finished work, so no member is drawn as
 * the list's last row or as the newest tool activity.
 */
export const ActivityFoldRenderer: React.FC<ActivityFoldRendererProps> = ({ fold, isExpanded, onToggleFold, ...context }) => {
    const summary = useMemo(
        () => summarizeActivityFold(fold, context.checkpointAttachments),
        [fold, context.checkpointAttachments],
    )
    const foldId = fold._activityFoldId

    return (
        <div data-fold-id={foldId} data-testid="activity-fold">
            <div className="px-4 py-1">
                <button
                    aria-expanded={isExpanded}
                    className="flex w-full items-center gap-1.5 rounded-xs border-0 bg-transparent p-0 text-left text-xs text-description hover:text-foreground cursor-pointer"
                    data-testid="activity-fold-header"
                    onClick={() => onToggleFold(foldId)}
                    title={describeToolCalls(summary) || undefined}
                    type="button">
                    <ChevronRightIcon className={cn("size-3 shrink-0 transition-transform", isExpanded && "rotate-90")} />
                    <span className="truncate">{describeActivityFold(summary)}</span>
                </button>
            </div>
            {isExpanded && (
                <div data-testid="activity-fold-children">
                    {fold._children.map((child) => (
                        <RowContent
                            {...context}
                            isLastRow={false}
                            isLastToolActivity={false}
                            key={rowIdentity(child)}
                            row={child}
                        />
                    ))}
                </div>
            )}
        </div>
    )
}
