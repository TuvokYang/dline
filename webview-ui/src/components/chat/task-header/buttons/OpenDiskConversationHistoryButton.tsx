import { StringRequest } from "@shared/proto/dline/common"
import { ArrowDownToLineIcon } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { cn } from "@/lib/utils"
import { FileServiceClient } from "@/services/grpc-client"

const OpenDiskConversationHistoryButton: React.FC<{
    taskId?: string
    className?: string
}> = ({ taskId, className }) => {
    const { t } = useUiTranslation()
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
            <TooltipContent>{t("chatInput.button.openHistory")}</TooltipContent>
            <TooltipTrigger
                aria-label={t("chatInput.button.openHistory")}
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
