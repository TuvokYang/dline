import { TrajectoryRequest } from "@shared/proto/dline/task"
import { useEffect, useMemo, useState } from "react"
import { TaskServiceClient } from "@/services/grpc-client"
import { getTaskViewKey } from "@/services/task-messages"
import {
    applyTrajectoryUpdate,
    isTrajectoryShown,
    TRAJECTORY_GAP,
    type TrajectoryLog,
    toTrajectoryAttempts,
} from "./trajectory-from-proto"
import type { TrajectoryAttempt } from "./trajectory-model"

/** First wait before reopening a stream that ended; doubles per consecutive failure up to the cap. */
export const TRAJECTORY_RESUBSCRIBE_MIN_MS = 500
export const TRAJECTORY_RESUBSCRIBE_MAX_MS = 8_000

type Opening = { taskId: string; taskInstanceId: string }

const NO_ATTEMPTS: readonly TrajectoryAttempt[] = []

/**
 * Follow one opening's trajectory stream until disposed.
 *
 * Availability changes arrive inside the stream as reset responses, so the
 * stream is reopened only when it ends, fails, or a delta does not follow the
 * held revision; each reopen starts again from the reset the extension always
 * sends first.
 */
function followTrajectory(opening: Opening, publish: (log: TrajectoryLog) => void): () => void {
    const viewKey = getTaskViewKey(opening)
    let disposed = false
    let log: TrajectoryLog | undefined
    let stream = 0
    let cancelStream: (() => void) | undefined
    let retryTimer: ReturnType<typeof setTimeout> | undefined
    let retryDelay = TRAJECTORY_RESUBSCRIBE_MIN_MS

    const reopenLater = () => {
        stream += 1
        const cancel = cancelStream
        cancelStream = undefined
        cancel?.()
        const delay = retryDelay
        retryDelay = Math.min(retryDelay * 2, TRAJECTORY_RESUBSCRIBE_MAX_MS)
        retryTimer = setTimeout(() => {
            retryTimer = undefined
            if (!disposed) open()
        }, delay)
    }

    const open = () => {
        const current = ++stream
        const isCurrent = () => !disposed && current === stream
        const unsubscribe = TaskServiceClient.subscribeToTrajectory(TrajectoryRequest.create(opening), {
            onResponse: (update) => {
                if (!isCurrent() || getTaskViewKey(update) !== viewKey) return
                const next = applyTrajectoryUpdate(log, update)
                if (next === TRAJECTORY_GAP) {
                    reopenLater()
                    return
                }
                // Only a shown trajectory proves the source healthy: a failing stream also
                // ends with an unavailable reset, and resetting on that would retry it at the minimum forever.
                if (update.reset && isTrajectoryShown(next)) retryDelay = TRAJECTORY_RESUBSCRIBE_MIN_MS
                log = next
                publish(next)
            },
            onError: (error) => {
                if (!isCurrent()) return
                console.error("Trajectory subscription failed", error)
                reopenLater()
            },
            onComplete: () => {
                if (isCurrent()) reopenLater()
            },
        })
        if (isCurrent()) cancelStream = unsubscribe
        else unsubscribe()
    }

    open()
    return () => {
        disposed = true
        stream += 1
        if (retryTimer) clearTimeout(retryTimer)
        cancelStream?.()
        cancelStream = undefined
    }
}

/**
 * The trajectory attempts of the shown opening, empty while the extension
 * reports the trajectory unavailable or broken.
 */
export function useTrajectory(taskId: string | undefined, taskInstanceId: string | undefined): readonly TrajectoryAttempt[] {
    const key = getTaskViewKey({ taskId, taskInstanceId })
    const [view, setView] = useState<{ key?: string; log?: TrajectoryLog }>({})
    useEffect(() => {
        if (!taskId || !taskInstanceId) return
        return followTrajectory({ taskId, taskInstanceId }, (log) => setView({ key, log }))
    }, [taskId, taskInstanceId, key])
    const log = view.key === key ? view.log : undefined
    return useMemo(() => (isTrajectoryShown(log) ? toTrajectoryAttempts(log.turns) : NO_ATTEMPTS), [log])
}
