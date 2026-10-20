import { ActivityIcon, CircleStopIcon, LoaderCircleIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { useTaskActivityNavigation } from "./activity/TaskActivityNavigationContext"
import { useTaskActivities } from "./activity/useTaskActivities"
import { TOOL_RESPONSE_SCROLL_CLASS } from "./constants"
import { projectKillCommandOutcome } from "./killCommandOutcome"

interface KillCommandRowProps {
    command: string
    result: string
    activityId?: string
}

/** A kill_command row that follows the targeted command activity to its terminal state. */
export function KillCommandRow(props: KillCommandRowProps) {
    const { taskViewState } = useExtensionState()
    const { getById } = useTaskActivities(taskViewState?.taskId, taskViewState?.taskInstanceId ?? "")
    const status = props.activityId ? getById(props.activityId)?.status : undefined
    return <KillCommandRowView {...props} status={status} />
}

export function KillCommandRowView({ command, result, activityId, status }: KillCommandRowProps & { status?: string }) {
    const navigateToActivity = useTaskActivityNavigation()
    const outcome = projectKillCommandOutcome(activityId, status)
    return (
        <div data-phase={outcome.phase} data-testid="kill-command-result">
            <div className="flex items-center gap-2.5 mb-3">
                {outcome.pending ? <LoaderCircleIcon className="size-3 animate-spin" /> : <CircleStopIcon className="size-2" />}
                <span className="font-bold">{outcome.label}</span>
            </div>
            <div
                className={`bg-code border border-editor-group-border rounded-[3px] py-2 px-2.5 ${TOOL_RESPONSE_SCROLL_CLASS}`}
                data-testid="kill-command-scroll">
                <code className="ph-no-capture break-all">{command}</code>
                {/* Until the activity status arrives, the tool's own result is the only outcome known. */}
                {outcome.phase === "requested" && result ? (
                    <div className="mt-1 text-description break-words">{result}</div>
                ) : null}
                {activityId ? (
                    <Button className="mt-2" onClick={() => navigateToActivity(activityId)} size="sm" variant="secondary">
                        <ActivityIcon className="size-3.5" />
                        View command activity
                    </Button>
                ) : null}
            </div>
        </div>
    )
}
