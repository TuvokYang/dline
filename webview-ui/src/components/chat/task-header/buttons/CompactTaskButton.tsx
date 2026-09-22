import { FoldVerticalIcon } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

const CompactTaskButton: React.FC<{
	className?: string
	disabled?: boolean
	onClick: (e: React.MouseEvent<HTMLButtonElement>) => void
}> = ({ onClick, disabled, className }) => {
	return (
		<Tooltip>
			<TooltipContent side="left">Compact Task</TooltipContent>
			<TooltipTrigger
				aria-disabled={disabled}
				aria-label="Compact task"
				className={cn(
					buttonVariants({ variant: "icon", size: "icon" }),
					"!overflow-visible !min-h-6",
					"[&_svg]:size-3",
					disabled && "opacity-50 cursor-not-allowed pointer-events-none",
					className,
				)}
				disabled={disabled}
				onClick={(e) => {
					e.preventDefault()
					e.stopPropagation()
					if (disabled) return
					onClick(e)
				}}>
				<FoldVerticalIcon />
			</TooltipTrigger>
		</Tooltip>
	)
}

export default CompactTaskButton
