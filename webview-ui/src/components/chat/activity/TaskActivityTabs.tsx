import { ActivityIcon, MessagesSquareIcon } from "lucide-react"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
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
    const { t } = useUiTranslation()
    return (
        <div className="flex items-center gap-1 border-b border-editor-group-border px-4" role="tablist">
            {(
                [
                    ["chat", "chatRows.activity.tabs.work", MessagesSquareIcon],
                    ["activity", "chatRows.activity.tabs.activities", ActivityIcon],
                ] as const
            ).map(([id, labelKey, Icon]) => (
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
                    {t(labelKey)}
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
