import { StringRequest } from "@shared/proto/dline/common"
import { ArrowDownToLineIcon } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"
import { FileServiceClient } from "@/services/grpc-client"

const OpenDiskConversationHistoryButton: React.FC<{
    taskId?: string
    className?: string
}> = ({ taskId, className }) => {
    const handleOpenDiskConversationHistory = () => {
        if (!taskId) {
            return
        }

        FileServiceClient.openDiskConversationHistory(StringRequest.create({ value: taskId })).catch((err) => {
            console.error(err)
        })
    }

    return (
        <Tooltip>
            <TooltipContent>Open Conversation History File</TooltipContent>
            <TooltipTrigger
                className={cn(buttonVariants({ variant: "icon", size: "icon" }), "!overflow-visible !min-h-6", className)}
                onClick={(e) => {
                    e.preventDefault()
                    e.stopPropagation()
                    handleOpenDiskConversationHistory()
                }}>
                <ArrowDownToLineIcon />
            </TooltipTrigger>
        </Tooltip>
    )
}

OpenDiskConversationHistoryButton.displayName = "OpenDiskConversationHistoryButton"
export default OpenDiskConversationHistoryButton
