import { cn } from "@heroui/react"
import { CheckIcon, CopyIcon } from "lucide-react"
import { useCallback, useState } from "react"
import { buttonVariants } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

const CopyTaskButton: React.FC<{
    taskText?: string
    className?: string
}> = ({ taskText, className }) => {
    const [copied, setCopied] = useState(false)

    const handleCopy = useCallback(() => {
        if (!taskText) {
            return
        }

        navigator.clipboard.writeText(taskText).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1500)
        })
    }, [taskText])

    return (
        <Tooltip>
            <TooltipContent side="bottom">Copy Text</TooltipContent>
            <TooltipTrigger
                className={cn(buttonVariants({ variant: "icon", size: "icon" }), "!overflow-visible !min-h-6", className)}
                onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    handleCopy()
                }}>
                {copied ? <CheckIcon /> : <CopyIcon />}
            </TooltipTrigger>
        </Tooltip>
    )
}

export default CopyTaskButton
