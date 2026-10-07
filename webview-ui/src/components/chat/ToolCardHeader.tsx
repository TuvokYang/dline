import { ChevronDownIcon, ChevronRightIcon } from "lucide-react"
import type { ReactNode } from "react"

export interface ToolCardExpansion {
	expanded: boolean
	onToggle: () => void
}

interface ToolCardHeaderProps {
	icon: ReactNode
	title: string
	/** Present only while the card has collapsible details; the whole title row then toggles them. */
	expansion?: ToolCardExpansion
	testId?: string
}

/**
 * Title row shared by the provider tool cards (Web Fetch, Web Search, Code Execution).
 *
 * When the card has collapsible details, the title itself is the toggle, so the details can be opened
 * or closed from the top of the card instead of a control that may sit below a long expanded body.
 */
const ToolCardHeader = ({ icon, title, expansion, testId }: ToolCardHeaderProps) => {
	if (!expansion) {
		return (
			<div className="mb-3 flex shrink-0 items-center gap-2.5" data-testid={testId}>
				{icon}
				<span className="font-bold">{title}</span>
			</div>
		)
	}

	const Chevron = expansion.expanded ? ChevronDownIcon : ChevronRightIcon
	return (
		<button
			aria-expanded={expansion.expanded}
			className="mb-3 flex w-full shrink-0 cursor-pointer items-center gap-2.5 border-0 bg-transparent p-0 text-left hover:text-foreground"
			data-testid={testId}
			onClick={expansion.onToggle}
			type="button">
			{icon}
			<span className="font-bold">{title}</span>
			<Chevron aria-hidden="true" className="size-3 shrink-0 text-description" />
		</button>
	)
}

export default ToolCardHeader
