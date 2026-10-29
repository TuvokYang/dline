import { CheckIcon } from "lucide-react"
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip"

interface TaskCompletionBadgeProps {
    /** Side the tooltip opens on; matches the surrounding list layout. */
    side?: "top" | "right" | "bottom" | "left"
    className?: string
}

/**
 * Completion checkmark shared by every task-history list.
 *
 * Both the Recent preview and the History view render this component so the
 * indicator cannot drift between panels.
 */
export function TaskCompletionBadge({ side = "left", className }: TaskCompletionBadgeProps) {
    return (
        <Tooltip>
            <TooltipTrigger asChild>
                <span aria-label="Completed" className={className ?? "history-completion-status"} role="img">
                    <CheckIcon aria-hidden="true" size={14} strokeWidth={2.4} />
                </span>
            </TooltipTrigger>
            <TooltipContent side={side}>Completed</TooltipContent>
        </Tooltip>
    )
}
