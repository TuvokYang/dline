import type { Mode } from "@shared/storage/types"
import { InfoIcon } from "lucide-react"
import React from "react"
import MarkdownBlock from "../common/MarkdownBlock"
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover"

interface NewTaskPreviewProps {
    task: string
    context?: string[]
    mode?: Mode
}

/**
 * NewTaskPreview — renders a task description with optional startup mode and context blocks.
 *
 * The task is displayed inline as Markdown. When context entries exist,
 * a compact bottom bar shows a truncated preview with an info icon;
 * hovering or clicking the icon opens a Popover with full context rendered as Markdown.
 *
 * Each context entry is rendered in its own MarkdownBlock for independent readability.
 */
const NewTaskPreview: React.FC<NewTaskPreviewProps> = ({ task, context, mode }) => {
    const hasContext = context && context.length > 0
    // Build a single-line preview from the first context entry
    const preview = hasContext ? context[0].replace(/\n/g, " ").substring(0, 80) + (context[0].length > 80 ? "…" : "") : ""

    return (
        <div className="bg-(--vscode-badge-background) text-(--vscode-badge-foreground) rounded-[3px] p-[14px] pb-[6px]">
            {mode && (
                <div className="mb-2 flex items-center gap-1.5 text-xs" data-testid="new-task-mode">
                    <span className="font-bold">Mode</span>
                    <span>{mode.toUpperCase()}</span>
                </div>
            )}
            <span style={{ fontWeight: "bold" }}>Task</span>
            <MarkdownBlock markdown={task} />
            {hasContext && (
                <Popover>
                    <PopoverTrigger asChild>
                        <button
                            className="mt-2 flex w-full items-center gap-1.5 rounded-[2px] bg-(--vscode-badge-background) px-2 py-1 text-xs text-(--vscode-descriptionForeground) hover:bg-(--vscode-list-hoverBackground) transition-colors cursor-pointer border-none"
                            style={{ fontFamily: "inherit" }}
                            type="button">
                            <InfoIcon className="size-3 shrink-0" />
                            <span className="truncate">
                                {context.length > 1 ? `${context.length} contexts` : preview || "context"}
                            </span>
                        </button>
                    </PopoverTrigger>
                    <PopoverContent align="start" className="max-h-[60vh] w-[min(80vw,500px)] overflow-y-auto p-3" sideOffset={6}>
                        <div className="space-y-3">
                            {context.map((ctx, idx) => (
                                <div key={`ctx-${idx}`}>
                                    {context.length > 1 && (
                                        <div className="mb-1 text-xs font-semibold text-(--vscode-descriptionForeground)">
                                            Context {idx + 1}
                                        </div>
                                    )}
                                    <MarkdownBlock markdown={ctx} />
                                </div>
                            ))}
                        </div>
                    </PopoverContent>
                </Popover>
            )}
        </div>
    )
}

export default NewTaskPreview
