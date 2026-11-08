import { StringArrayRequest } from "@shared/proto/dline/common"
import { AlertTriangle, TrashIcon } from "lucide-react"
import { useState } from "react"
import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle,
} from "@/components/common/AlertDialog"
import { buttonVariants } from "@/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { cn } from "@/lib/utils"
import { TaskServiceClient } from "@/services/grpc-client"
import { formatSize } from "@/utils/format"

interface DeleteTaskButtonProps {
    taskId?: string
    taskSize?: number
    className?: string
    onDeleteConfirmed?: () => void
}

/**
 * Button that opens a themed confirmation dialog before deleting a task.
 * @param props Task deletion button properties.
 * @returns Task delete button and optional confirmation dialog.
 */
const DeleteTaskButton: React.FC<DeleteTaskButtonProps> = ({ taskId, className, taskSize, onDeleteConfirmed }) => {
    const { t } = useUiTranslation()
    const [confirmOpen, setConfirmOpen] = useState(false)
    const [deleting, setDeleting] = useState(false)

    /**
     * Open the delete confirmation dialog without deleting immediately.
     * @param e Mouse click event from the icon button.
     */
    const handleOpen = (e: React.MouseEvent) => {
        e.preventDefault()
        e.stopPropagation()
        if (!taskId || deleting) return
        setConfirmOpen(true)
    }

    /**
     * Close the confirmation dialog.
     */
    const handleCancel = () => {
        setConfirmOpen(false)
    }

    /**
     * Confirm deletion and send the delete request.
     */
    const handleConfirm = async () => {
        if (!taskId || deleting) return
        setDeleting(true)
        setConfirmOpen(false)
        // Confirmation closes the current presentation immediately. The canonical
        // deletion RPC continues to own lock release, task detachment and storage cleanup.
        onDeleteConfirmed?.()
        try {
            await TaskServiceClient.deleteTasksWithIds(StringArrayRequest.create({ value: [taskId] }))
        } finally {
            setDeleting(false)
        }
    }

    return (
        <>
            <Tooltip>
                <TooltipContent>
                    {t("chatInput.button.deleteTooltip", { size: taskSize ? formatSize(taskSize) : "--" })}
                </TooltipContent>
                <TooltipTrigger
                    aria-label={t("chatInput.button.deleteTitle")}
                    className={cn(buttonVariants({ variant: "icon", size: "xs" }), "!overflow-visible !min-h-6", className)}
                    disabled={!taskId || deleting}
                    onClick={handleOpen}>
                    <TrashIcon />
                </TooltipTrigger>
            </Tooltip>
            <AlertDialog onOpenChange={setConfirmOpen} open={confirmOpen}>
                <AlertDialogContent>
                    <AlertDialogHeader>
                        <AlertDialogTitle>
                            <AlertTriangle className="h-4 w-4 text-(--vscode-errorForeground)" />
                            {t("chatInput.button.deleteTitle")}
                        </AlertDialogTitle>
                        <AlertDialogDescription>
                            {t("chatInput.button.deleteWarning", { size: taskSize ? formatSize(taskSize) : undefined })}
                        </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                        <AlertDialogCancel disabled={deleting} onClick={handleCancel}>
                            {t("chatInput.common.cancel")}
                        </AlertDialogCancel>
                        <AlertDialogAction appearance="primary" disabled={deleting} onClick={handleConfirm}>
                            {t(deleting ? "chatInput.button.deleting" : "chatInput.button.delete")}
                        </AlertDialogAction>
                    </AlertDialogFooter>
                </AlertDialogContent>
            </AlertDialog>
        </>
    )
}
DeleteTaskButton.displayName = "DeleteTaskButton"

export default DeleteTaskButton
