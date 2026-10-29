import { MoreHorizontalIcon } from "lucide-react"
import { useState } from "react"
import { Button } from "../../../ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "../../../ui/popover"

interface ForceTruncateTaskButtonProps {
    disabled?: boolean
    onSelect: () => void
}

/** Render the guarded context actions entry point and its destructive action. */
const ForceTruncateTaskButton: React.FC<ForceTruncateTaskButtonProps> = ({ disabled, onSelect }) => {
    const [open, setOpen] = useState(false)

    return (
        <Popover onOpenChange={setOpen} open={open}>
            <PopoverTrigger asChild>
                <Button
                    aria-label="More context actions"
                    disabled={disabled}
                    size="icon"
                    title="More context actions"
                    variant="icon">
                    <MoreHorizontalIcon />
                </Button>
            </PopoverTrigger>
            <PopoverContent align="end" className="w-[min(18rem,calc(100vw-2rem))] p-1" side="bottom">
                <button
                    aria-label="Force truncate conversation history"
                    className="flex w-full items-start rounded-xs px-3 py-2 text-left text-sm text-(--vscode-errorForeground) hover:bg-(--vscode-toolbar-hoverBackground) focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
                    onClick={(event) => {
                        event.preventDefault()
                        event.stopPropagation()
                        setOpen(false)
                        onSelect()
                    }}
                    type="button">
                    Force truncate conversation history
                </button>
            </PopoverContent>
        </Popover>
    )
}

export default ForceTruncateTaskButton
