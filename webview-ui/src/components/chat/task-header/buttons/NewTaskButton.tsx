import { XIcon } from "lucide-react"
import { useRef, useState } from "react"
import { buttonVariants } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

const NewTaskButton: React.FC<{
	onClick: () => Promise<void>
	className?: string
}> = ({ className, onClick }) => {
	const closingRef = useRef(false)
	const [closing, setClosing] = useState(false)
	const [error, setError] = useState(false)

	const close = () => {
		if (closingRef.current) return
		closingRef.current = true
		setClosing(true)
		setError(false)
		void onClick()
			.catch(() => setError(true))
			.finally(() => {
				closingRef.current = false
				setClosing(false)
			})
	}

	return (
		<>
			<Tooltip>
				<TooltipContent side="left">{closing ? "Closing Task..." : "Close Task"}</TooltipContent>
				<TooltipTrigger
					aria-busy={closing}
					aria-label="Close Task"
					className={cn(buttonVariants({ variant: "icon", size: "icon" }), "!overflow-visible !min-h-6", className)}
					disabled={closing}
					onClick={(event) => {
						event.preventDefault()
						event.stopPropagation()
						close()
					}}>
					<XIcon />
				</TooltipTrigger>
			</Tooltip>
			{error && (
				<span className="text-(--vscode-errorForeground) text-xs" role="alert">
					Could not close this task. Try again.
				</span>
			)}
		</>
	)
}

export default NewTaskButton
