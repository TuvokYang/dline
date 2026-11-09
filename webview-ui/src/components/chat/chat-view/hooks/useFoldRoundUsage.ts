import type { UiMessage } from "@shared/ExtensionMessage"
import {
    GetTaskRateMetricsRequest,
    TaskRateMetricsResolution as ProtoResolution,
    TaskRateUsageQuality,
} from "@shared/proto/dline/task"
import { useEffect, useRef, useState } from "react"
import { TaskServiceClient } from "@/services/grpc-client"
import {
    bindFoldUsage,
    captureFoldUsageRequests,
    EMPTY_FOLD_USAGE,
    type FoldUsageBinding,
    type FoldUsageByRequest,
    type FoldUsageRequest,
} from "../utils/foldUsageBinding"

/** Match the backend's recent-round cap without requesting full history. */
const MAX_ROUNDS = 60
const ROUND_WINDOW_MS = 24 * 60 * 60 * 1_000
/** Readiness and late usage get a finite recovery window, never continuous polling. */
const RETRY_DELAYS_MS = [250, 1_000, 3_000] as const

interface FoldRoundUsageState {
    readonly openingKey: string
    readonly binding: FoldUsageBinding
}

/** Read Provider figures on send completion/usage revision, scoped to one opening. */
export function useFoldRoundUsage(
    taskId: string | undefined,
    taskInstanceId: string | undefined,
    messages: readonly UiMessage[],
    enabled: boolean,
): FoldUsageByRequest {
    const openingKey = JSON.stringify([taskId, taskInstanceId])
    const snapshotKey = JSON.stringify(captureFoldUsageRequests(messages))
    const queryKey = JSON.stringify([openingKey, snapshotKey, enabled])
    const latestQueryKey = useRef(queryKey)
    latestQueryKey.current = queryKey
    const [state, setState] = useState<FoldRoundUsageState>({ openingKey, binding: EMPTY_FOLD_USAGE })
    const retained = useRef(state)

    useEffect(() => {
        let active = true
        let timer: ReturnType<typeof setTimeout> | undefined
        let warned = false
        const isCurrent = () => active && latestQueryKey.current === queryKey
        if (!taskId || !taskInstanceId || !enabled) return
        const requests = JSON.parse(snapshotKey) as FoldUsageRequest[]
        const expected = Math.min(MAX_ROUNDS, requests.filter((request) => request.finished).length)
        const warn = (reason: string) => {
            if (warned) return
            warned = true
            // Never log RPC errors: they can carry request or account payloads.
            console.warn(`[fold-usage] ${reason}`)
        }
        const retry = (attempt: number) => {
            const delay = RETRY_DELAYS_MS[attempt]
            if (delay !== undefined && isCurrent()) timer = setTimeout(() => void query(attempt + 1), delay)
        }
        const query = async (attempt: number): Promise<void> => {
            const endMs = Date.now()
            try {
                const data = await TaskServiceClient.getTaskRateMetrics(
                    GetTaskRateMetricsRequest.create({
                        taskId,
                        taskInstanceId,
                        resolution: ProtoResolution.TASK_RATE_METRICS_RESOLUTION_ROUND,
                        startMs: endMs - ROUND_WINDOW_MS,
                        endMs,
                        maxPoints: MAX_ROUNDS,
                    }),
                )
                if (!isCurrent()) return
                if (data.taskId !== taskId || data.taskInstanceId !== taskInstanceId) {
                    warn("Ignored a response for another Task opening.")
                    retry(attempt)
                    return
                }
                if (data.degraded || data.truncated)
                    warn("Round coverage is degraded or truncated; unavailable figures remain absent.")
                const previous = retained.current.openingKey === openingKey ? retained.current.binding : EMPTY_FOLD_USAGE
                const binding = bindFoldUsage(requests, data.points, previous, data.degraded)
                retained.current = { openingKey, binding }
                setState(retained.current)
                const provisional = data.points.some(
                    (point) =>
                        point.provisional ||
                        (point.usageQuality !== TaskRateUsageQuality.TASK_RATE_USAGE_QUALITY_EXACT &&
                            point.usageQuality !== TaskRateUsageQuality.TASK_RATE_USAGE_QUALITY_LEGACY),
                )
                if (binding.byRequest.size < expected || provisional || data.degraded) retry(attempt)
            } catch {
                if (!isCurrent()) return
                warn("Round query unavailable; retaining the last bound figures during bounded recovery.")
                retry(attempt)
            }
        }
        void query(0)
        return () => {
            active = false
            if (timer !== undefined) clearTimeout(timer)
        }
    }, [queryKey, openingKey, snapshotKey, taskId, taskInstanceId, enabled])

    // Same-opening updates retain already bound values; a new opening never does.
    return enabled && state.openingKey === openingKey ? state.binding.byRequest : EMPTY_FOLD_USAGE.byRequest
}
