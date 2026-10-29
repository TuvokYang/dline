import { FileTextIcon } from "lucide-react"
import { memo } from "react"
import { CopyButton } from "@/components/common/CopyButton"
import MarkdownBlock from "@/components/common/MarkdownBlock"
import { cn } from "@/lib/utils"

interface GenerateReportProps {
    title?: string
    content: string
    headClassNames?: string
}

const GenerateReportRow = memo(({ title, content, headClassNames }: GenerateReportProps) => {
    return (
        <div className="rounded-sm border border-slate-300/30 dark:border-slate-700/30 overflow-visible bg-slate-100/20 dark:bg-slate-900/10 p-2 pt-3 relative">
            <div className="absolute top-2 right-2 z-10">
                <CopyButton textToCopy={content || ""} />
            </div>
            <div className={cn(headClassNames, "justify-between px-1")}>
                <div className="flex gap-2 items-center">
                    <FileTextIcon className="size-2 text-slate-500 dark:text-slate-400" />
                    <span className="text-slate-700 dark:text-slate-200 font-semibold">{title || "Report"}</span>
                </div>
            </div>
            <div className="w-full relative border-t-1 border-slate-300/20 dark:border-slate-700/20 rounded-b-sm">
                <div className="plan-completion-content p-2 pt-3 w-full [&_hr]:opacity-20 [&_p:last-child]:mb-0 max-h-[50vh] overflow-y-auto overscroll-contain">
                    <div className="wrap-anywhere [&_hr]:opacity-20">
                        <MarkdownBlock markdown={content} />
                    </div>
                </div>
            </div>
        </div>
    )
})

GenerateReportRow.displayName = "GenerateReportRow"

export default GenerateReportRow
