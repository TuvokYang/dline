import { type FoldRoundUsage } from "@shared/chat/foldUsage"
import { GetTaskRateMetricsRequest, TaskRateMetricsResolution as ProtoResolution } from "@shared/proto/dline/task"
import { useEffect, useRef, useState } from "react"
import { TaskServiceClient } from "@/services/grpc-client"
import { projectRoundUsage } from "../utils/roundUsageProjection"

/** One day of Provider rounds; a longer task keeps its newest rounds only. */
const ROUND_WINDOW_MS = 24 * 60 * 60 * 1_000
/** Matches the backend's recent-round page so the window and the page agree. */
const MAX_ROUNDS = 60

interface FoldRoundUsageState {
    readonly requestKey: string
    readonly rounds: readonly FoldRoundUsage[]
}

/**
 * The figures a folded block states, read from the Task's Provider rounds.
 *
 * The chat asks for rounds rather than a time bucket: a block's header costs the
 * rounds it holds, so a minute bucket would attribute one send's duration to a
 * block that never made it. Nothing is returned until the Task reports a
 * canonical opening, because the RPC refuses a request that does not belong to
 * the opening it answers.
 */
export function useFoldRoundUsage(taskId: string | undefined, taskInstanceId: string | undefined): readonly FoldRoundUsage[] {
    const requestKey = JSON.stringify([taskId, taskInstanceId])
    const latestRequestKey = useRef(requestKey)
    latestRequestKey.current = requestKey
    const [state, setState] = useState<FoldRoundUsageState>({ requestKey, rounds: [] })

    useEffect(() => {
        let active = true
        const isCurrent = () => active && latestRequestKey.current === requestKey
        if (!taskId || !taskInstanceId) return noRounds(active)

        const endMs = Date.now() + ROUND_WINDOW_MS
        void TaskServiceClient.getTaskRateMetrics(
            GetTaskRateMetricsRequest.create({
                taskId,
                taskInstanceId,
                resolution: ProtoResolution.TASK_RATE_METRICS_RESOLUTION_ROUND,
                startMs: endMs - ROUND_WINDOW_MS,
                endMs,
                maxPoints: MAX_ROUNDS,
            }),
        )
            .then((data) => {
                if (!isCurrent()) return
                // Another opening's rounds must never be attributed to this transcript.
                if (data.taskId !== taskId || data.taskInstanceId !== taskInstanceId) return
                setState({ requestKey, rounds: projectRoundUsage(data.points) })
            })
            .catch(() => {
                // A block without figures states none; a missing header figure is
                // not a reason to disturb the transcript.
                if (isCurrent()) setState({ requestKey, rounds: [] })
            })
        return () => {
            active = false
        }
    }, [requestKey, taskId, taskInstanceId])

    // A new opening must not state the previous Task's figures even for one frame.
    return state.requestKey === requestKey ? state.rounds : []
}

/** Nothing to clean up: the request was never issued. */
function noRounds(_active: boolean): () => void {
    return () => undefined
}
