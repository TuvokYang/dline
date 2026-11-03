import type { FoldRoundUsage } from "@shared/chat/foldUsage"
import type { UiApiReqInfo, UiMessage } from "@shared/ExtensionMessage"
import type { TaskRateMetricPoint } from "@shared/proto/dline/task"
import { projectRoundUsage } from "./roundUsageProjection"
import { isSettledTurnEnd } from "./turnEndRows"

export type FoldUsageByRequest = ReadonlyMap<number, readonly FoldRoundUsage[]>

export interface FoldUsageRequest {
    readonly ts: number
    readonly finished: boolean
    /** Usage revisions invalidate a query; streamed prose and tool output do not. */
    readonly revision: string
}

export interface FoldUsageBinding {
    readonly byRequest: FoldUsageByRequest
    readonly requestByRoundId: ReadonlyMap<string, number>
}

export const EMPTY_FOLD_USAGE: FoldUsageBinding = { byRequest: new Map(), requestByRoundId: new Map() }

/** Capture actual sends, not the task/user-feedback buckets used by grouping. */
export function captureFoldUsageRequests(messages: readonly UiMessage[]): FoldUsageRequest[] {
    // A live message window may still hold the opening-only API payload after
    // persistence settles it. Reuse the transcript's actual completion proofs.
    const closedByTranscript = new Set<number>()
    let completionAhead = false
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index]
        if (isSettledTurnEnd(message)) completionAhead = true
        if (message.say !== "api_req_started") continue
        if (completionAhead) closedByTranscript.add(message.ts)
        completionAhead = true
    }
    return messages.flatMap((message) => {
        if (message.say !== "api_req_started") return []
        let info: UiApiReqInfo
        try {
            info = JSON.parse(message.text ?? "{}") ?? {}
        } catch {
            info = {}
        }
        return [
            {
                ts: message.ts,
                finished:
                    closedByTranscript.has(message.ts) ||
                    (message.partial !== true &&
                        (info.cost !== undefined || Boolean(info.cancelReason) || Boolean(info.streamingFailedMessage))),
                revision: JSON.stringify([
                    message.partial,
                    info.cost,
                    info.cancelReason,
                    Boolean(info.streamingFailedMessage),
                    info.tokensIn,
                    info.tokensOut,
                    info.cacheReads,
                    info.cacheWrites,
                ]),
            },
        ]
    })
}

/**
 * Bind a response to the send snapshot that requested it. Known round identities
 * never slide when a later send appears. Timing disambiguates current sends;
 * legacy records without compatible timing retain the accepted completed-tail
 * approximation. Empty records consume their slot before figure projection.
 */
export function bindFoldUsage(
    requests: readonly FoldUsageRequest[],
    points: readonly TaskRateMetricPoint[],
    previous: FoldUsageBinding = EMPTY_FOLD_USAGE,
    preserveMissing = false,
): FoldUsageBinding {
    const finished = new Set(requests.filter((request) => request.finished).map((request) => request.ts))
    const assigned = new Map<TaskRateMetricPoint, number>()
    const fallback: TaskRateMetricPoint[] = []
    for (const point of points) {
        if (!point.roundId) continue
        const known = previous.requestByRoundId.get(point.roundId)
        if (known !== undefined) {
            if (finished.has(known)) assigned.set(point, known)
            continue
        }
        const start = point.startedAtMs
        if (start !== undefined && Number.isFinite(start) && requests.length > 0 && start >= requests[0].ts) {
            let request: FoldUsageRequest | undefined
            for (let index = requests.length - 1; index >= 0; index -= 1) {
                if (requests[index].ts > start) continue
                request = requests[index]
                break
            }
            // A terminal metric may race ahead of its UI row. It must not be
            // shifted onto an older completed send while that row is still live.
            if (request?.finished) assigned.set(point, request.ts)
            continue
        }
        fallback.push(point)
    }
    const reserved = new Set(assigned.values())
    const candidates =
        fallback.length === 0
            ? []
            : requests.filter((request) => request.finished && !reserved.has(request.ts)).slice(-fallback.length)
    const offset = fallback.length - candidates.length
    candidates.forEach((request, index) => assigned.set(fallback[index + offset], request.ts))

    const byRequest = new Map<number, readonly FoldRoundUsage[]>(
        preserveMissing ? [...previous.byRequest].filter(([ts]) => finished.has(ts)) : [],
    )
    // Retain only lightweight identities across window changes, not metric history.
    const requestByRoundId = new Map(previous.requestByRoundId)
    for (const [point, ts] of assigned) {
        if (!point.roundId) continue
        requestByRoundId.set(point.roundId, ts)
        const figures = projectRoundUsage([point])
        if (preserveMissing && figures.length === 0) continue
        const others = (byRequest.get(ts) ?? []).filter((usage) => usage.roundId !== point.roundId)
        if (figures.length > 0 || others.length > 0) byRequest.set(ts, [...others, ...figures])
        else byRequest.delete(ts)
    }
    return { byRequest, requestByRoundId }
}
