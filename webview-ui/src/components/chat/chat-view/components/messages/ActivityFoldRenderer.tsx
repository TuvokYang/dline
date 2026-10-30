import { ChevronRightIcon } from "lucide-react"
import type React from "react"
import { useMemo } from "react"
import { describeActivityFold, describeToolCalls, summarizeActivityFold } from "../../utils/activityFoldSummary"
import type { ActivityFold } from "../../utils/chatRowKinds"
import type { RowRenderContext } from "./RowContent"

interface ActivityFoldRendererProps extends RowRenderContext {
    fold: ActivityFold
    onToggleFold: (foldId: string) => void
}

/** Closed summary only. Open blocks are projected into the ordinary top-level renderer. */
export const ActivityFoldRenderer: React.FC<ActivityFoldRendererProps> = ({ fold, onToggleFold, ...context }) => {
    const summary = useMemo(
        () => summarizeActivityFold(fold, context.checkpointAttachments),
        [fold, context.checkpointAttachments],
    )
    const foldId = fold._activityFoldId

    return (
        <div data-fold-id={foldId} data-testid="activity-fold">
            <div className="px-4 py-1">
                <button
                    aria-expanded={false}
                    className="flex w-full items-center gap-1.5 rounded-xs border-0 bg-transparent p-0 text-left text-xs text-description hover:text-foreground cursor-pointer"
                    data-testid="activity-fold-header"
                    onClick={() => onToggleFold(foldId)}
                    title={describeToolCalls(summary) || undefined}
                    type="button">
                    <ChevronRightIcon className="size-3 shrink-0" />
                    <span className="truncate">{describeActivityFold(summary)}</span>
                </button>
            </div>
        </div>
    )
}
