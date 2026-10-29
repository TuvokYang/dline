import { HistoryItem } from "@shared/HistoryItem"
import { StringRequest } from "@shared/proto/dline/common"
import { ExternalLinkIcon } from "lucide-react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { TaskServiceClient } from "@/services/grpc-client"

/**
 * SpawnedTasksBar — renders a horizontal bar of buttons below the TaskHeader
 * showing all tasks that were spawned from the current (parent) task.
 *
 * Each button opens the corresponding task in a new Editor Tab window.
 */
const SpawnedTasksBar = () => {
    const { currentTaskItem, taskHistory } = useExtensionState()

    const spawnedTaskIds = currentTaskItem?.spawnedTaskIds
    if (!spawnedTaskIds || spawnedTaskIds.length === 0) {
        return null
    }

    // Resolve task names from history for display
    const getTaskDisplayName = (taskId: string): string => {
        const historyItem: HistoryItem | undefined = taskHistory?.find((item) => item.id === taskId)
        if (!historyItem?.task) {
            return taskId.substring(0, 8)
        }
        // Truncate to 20 chars for button display
        return historyItem.task.length > 20 ? historyItem.task.substring(0, 20) : historyItem.task
    }

    const handleOpenTask = async (taskId: string) => {
        try {
            await TaskServiceClient.openTaskInNewWindow(StringRequest.create({ value: taskId }))
        } catch (error) {
            console.error(`Failed to open spawned task ${taskId}:`, error)
        }
    }

    return (
        <div className="px-4 flex items-center gap-1.5 py-1">
            <span className="text-xs font-medium text-description shrink-0">Spawned:</span>
            <div className="flex items-center gap-1 flex-wrap">
                {spawnedTaskIds.map((taskId) => (
                    <button
                        className="inline-flex items-center gap-1 px-2 py-0.5 rounded-xs text-xs
							bg-(--vscode-badge-background) text-(--vscode-badge-foreground)
							hover:brightness-110 cursor-pointer border-0"
                        key={taskId}
                        onClick={() => handleOpenTask(taskId)}
                        title={`Open task: ${taskId}`}
                        type="button">
                        <ExternalLinkIcon className="size-2.5 shrink-0" />
                        <span className="truncate max-w-32">{getTaskDisplayName(taskId)}</span>
                    </button>
                ))}
            </div>
        </div>
    )
}

export default SpawnedTasksBar
