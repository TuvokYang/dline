import { NotepadTextIcon } from "lucide-react"
import { memo } from "react"
import { CopyButton } from "@/components/common/CopyButton"
import MarkdownBlock from "@/components/common/MarkdownBlock"
import { cn } from "@/lib/utils"

interface PlanCompletionOutputProps {
	text: string
	onCopy?: () => void
	headClassNames?: string
}

/**
 * Styled completion output for Plan Mode responses
 * Uses grayscale colors to distinguish from Act Mode's green success theme
 */
const PlanCompletionOutputRow = memo(({ text, headClassNames }: PlanCompletionOutputProps) => {
	return (
		<div
			className="relative flex max-h-[80vh] flex-col overflow-hidden rounded-sm border border-teal-300/30 bg-teal-100/20 p-2 pt-3 dark:border-teal-700/30 dark:bg-teal-900/10"
			data-testid="plan-completion-card">
			{/* Header */}
			<div className={cn(headClassNames, "shrink-0 justify-between px-1")}>
				<div className="flex gap-2 items-center">
					<NotepadTextIcon className="size-2 text-teal-500 dark:text-teal-400" />
					<span className="text-teal-600 dark:text-teal-400 font-semibold">Plan Created</span>
				</div>
				<CopyButton textToCopy={text || ""} />
			</div>

			{/* Content */}
			<div
				className="relative min-h-0 w-full flex-auto overflow-y-auto overscroll-x-contain rounded-b-sm border-t-1 border-teal-300/20 dark:border-teal-700/20"
				data-testid="plan-completion-scroll">
				<div className="plan-completion-content p-2 pt-3 w-full [&_hr]:opacity-20 [&_p:last-child]:mb-0">
					<div className="wrap-anywhere [&_hr]:opacity-20">
						<MarkdownBlock markdown={text} />
					</div>
				</div>
			</div>
		</div>
	)
})

PlanCompletionOutputRow.displayName = "PlanCompletionOutputRow"

export default PlanCompletionOutputRow
