import { ActivityIcon, MessagesSquareIcon } from "lucide-react"
import { cn } from "@/lib/utils"

export type TaskContentTab = "chat" | "activity"

export function TaskActivityTabs({
    value,
    onChange,
    activeCount,
}: {
    value: TaskContentTab
    onChange: (value: TaskContentTab) => void
    activeCount: number
}) {
    return (
        <div className="flex items-center gap-1 border-b border-editor-group-border px-4" role="tablist">
            {(
                [
                    ["chat", "Work", MessagesSquareIcon],
                    ["activity", "Activities", ActivityIcon],
                ] as const
            ).map(([id, label, Icon]) => (
                <button
                    aria-selected={value === id}
                    className={cn(
                        "flex items-center gap-1.5 border-0 border-b-2 bg-transparent px-3 py-2 text-xs cursor-pointer",
                        value === id
                            ? "border-link text-foreground"
                            : "border-transparent text-description hover:text-foreground",
                    )}
                    key={id}
                    onClick={() => onChange(id)}
                    role="tab"
                    type="button">
                    <Icon className="size-3.5" />
                    {label}
                    {id === "activity" && activeCount > 0 && (
                        <span className="min-w-4 rounded-full bg-badge-background px-1 text-[10px] text-badge-foreground">
                            {activeCount}
                        </span>
                    )}
                </button>
            ))}
        </div>
    )
}
