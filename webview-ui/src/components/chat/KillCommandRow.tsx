import { ActivityIcon, CircleStopIcon } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useTaskActivityNavigation } from "./activity/TaskActivityNavigationContext"
import { TOOL_RESPONSE_SCROLL_CLASS } from "./constants"

interface KillCommandRowProps {
    command: string
    result: string
    activityId?: string
}

export function KillCommandRow({ command, result, activityId }: KillCommandRowProps) {
    const navigateToActivity = useTaskActivityNavigation()
    return (
        <div data-testid="kill-command-result">
            <div className="flex items-center gap-2.5 mb-3">
                <CircleStopIcon className="size-2" />
                <span className="font-bold">Dline requested command termination:</span>
            </div>
            <div
                className={`bg-code border border-editor-group-border rounded-[3px] py-2 px-2.5 ${TOOL_RESPONSE_SCROLL_CLASS}`}
                data-testid="kill-command-scroll">
                <code className="ph-no-capture break-all">{command}</code>
                {result ? <div className="mt-1 text-description break-words">{result}</div> : null}
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
