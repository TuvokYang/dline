import { MegaphoneIcon } from "lucide-react"
import { memo } from "react"
import { CopyButton } from "@/components/common/CopyButton"
import MarkdownBlock from "@/components/common/MarkdownBlock"
import { cn } from "@/lib/utils"

interface StatusUpdateProps {
    text: string
    headClassNames?: string
    title?: string
}

const StatusUpdateRow = memo(({ text, headClassNames, title = "Status Update" }: StatusUpdateProps) => {
    return (
        <div className="rounded-sm border border-blue-300/30 dark:border-blue-700/30 overflow-visible bg-blue-100/20 dark:bg-blue-900/10 p-2 pt-3 relative">
            <div className="absolute top-2 right-2 z-10">
                <CopyButton textToCopy={text || ""} />
            </div>
            <div className={cn(headClassNames, "justify-between px-1")}>
                <div className="flex gap-2 items-center">
                    <MegaphoneIcon className="size-2 text-blue-500 dark:text-blue-400" />
                    <span className="text-blue-600 dark:text-blue-400 font-semibold">{title || "Status Update"}</span>
                </div>
            </div>
            <div className="w-full relative border-t-1 border-blue-300/20 dark:border-blue-700/20 rounded-b-sm">
                <div className="plan-completion-content p-2 pt-3 w-full [&_hr]:opacity-20 [&_p:last-child]:mb-0 max-h-[80vh] overflow-y-auto">
                    <div className="wrap-anywhere [&_hr]:opacity-20">
                        <MarkdownBlock markdown={text} />
                    </div>
                </div>
            </div>
        </div>
    )
})

StatusUpdateRow.displayName = "StatusUpdateRow"

export default StatusUpdateRow
