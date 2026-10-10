import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import type { ReactNode } from "react"
import { cn } from "../../../lib/utils"

interface SubagentWorkSectionProps {
    title: string
    ariaLabel: string
    expanded: boolean
    onToggle: () => void
    scrollTestId: string
    children: ReactNode
    contentClassName?: string
    scrollable?: boolean
}

export function SubagentWorkSection({
    title,
    ariaLabel,
    expanded,
    onToggle,
    scrollTestId,
    children,
    contentClassName,
    scrollable = true,
}: SubagentWorkSectionProps) {
    return (
        <section
            className={cn(
                "min-w-0 border-t border-editor-group-border/50",
                expanded && "flex min-h-[24px] flex-col overflow-hidden",
                expanded && !scrollable && "shrink-0",
                expanded && scrollable && "flex-[0_1_auto]",
                !expanded && "shrink-0",
            )}>
            <button
                aria-expanded={expanded}
                aria-label={ariaLabel}
                className="flex w-full shrink-0 items-center gap-1 border-0 bg-transparent px-1 py-1 text-left text-[10px] font-semibold uppercase tracking-wide text-description cursor-pointer"
                onClick={onToggle}
                type="button">
                {expanded ? (
                    <ChevronDownIcon className="size-2.5 shrink-0" />
                ) : (
                    <ChevronRightIcon className="size-2.5 shrink-0" />
                )}
                <span className="min-w-0 truncate">{title}</span>
            </button>
            {expanded && (
                <div
                    className={cn(
                        "overflow-x-hidden px-1 pb-1",
                        scrollable && "min-h-0 flex-1 overflow-y-auto",
                        contentClassName,
                    )}
                    data-testid={scrollTestId}>
                    {children}
                </div>
            )}
        </section>
    )
}
