import { MegaphoneIcon } from "lucide-react"
import { memo } from "react"
import { CopyButton } from "@/components/common/CopyButton"
import MarkdownBlock from "@/components/common/MarkdownBlock"
import { cn } from "@/lib/utils"

interface WorkingRespondProps {
    text: string
    headClassNames?: string
}

/** A working_respond message: the model's reply while it keeps working. */
const WorkingRespondRow = memo(({ text, headClassNames }: WorkingRespondProps) => {
    return (
        <div className="rounded-sm border border-sky-300/30 overflow-visible bg-sky-100/20 dark:bg-sky-900/10 p-2 pt-3 relative">
            <div className="absolute top-2 right-2 z-10">
                <CopyButton textToCopy={text || ""} />
            </div>
            <div className={cn(headClassNames, "justify-between px-1")}>
                <div className="flex gap-2 items-center">
                    <MegaphoneIcon className="size-2 text-sky-500" />
                    <span className="text-sky-600 dark:text-sky-400 font-semibold">Progress Update</span>
                </div>
            </div>
            <div className="w-full relative border-t-1 border-sky-300/20 dark:border-sky-700/20 rounded-b-sm">
                <div className="plan-completion-content p-2 pt-3 w-full [&_hr]:opacity-20 [&_p:last-child]:mb-0 max-h-[80vh] overflow-y-auto">
                    <div className="wrap-anywhere [&_hr]:opacity-20">
                        <MarkdownBlock markdown={text} />
                    </div>
                </div>
            </div>
        </div>
    )
})

WorkingRespondRow.displayName = "WorkingRespondRow"

export default WorkingRespondRow
