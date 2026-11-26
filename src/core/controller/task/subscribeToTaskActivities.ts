import { estimateActivityRecordBytes } from "@core/storage/activities/TaskActivityRowStore"
import {
    TaskActivity as ProtoTaskActivity,
    TaskActivityEvent as ProtoTaskActivityEvent,
    TaskActivityMetrics as ProtoTaskActivityMetrics,
    TaskActivityRuntimeConfig as ProtoTaskActivityRuntimeConfig,
    TaskActivityUpdate as ProtoTaskActivityUpdate,
    TaskActivitySubscriptionRequest,
} from "@shared/proto/dline/task"
import type { TaskActivityEvent, TaskActivityRecord, TaskActivityUpdate } from "@shared/task-activity"
import type { Controller } from ".."
import { getRequestRegistry, type StreamingResponseHandler } from "../grpc-handler"
import { currentOpening } from "./opened-task"

/** Maximum estimated bytes carried by one initial activity snapshot frame over Webview IPC. */
export const MAX_ACTIVITY_SNAPSHOT_WIRE_BYTES = 2 * 1024 * 1024
const COMPACTED_TERMINAL_EVENT_LIMIT = 20
const COMPACTED_EVENT_TEXT_CHARS = 2 * 1024
const COMPACTED_TERMINAL_OUTPUT_CHARS = 8 * 1024

function isActiveActivity(activity: TaskActivityRecord): boolean {
    return activity.status === "awaiting_approval" || activity.status === "running" || activity.status === "cancelling"
}

function compactEventForWire(event: TaskActivityEvent): TaskActivityEvent {
    if ("text" in event && typeof event.text === "string" && event.text.length > COMPACTED_EVENT_TEXT_CHARS) {
        return { ...event, text: event.text.slice(-COMPACTED_EVENT_TEXT_CHARS) }
    }
    return event
}

function compactTerminalActivityForWire(activity: TaskActivityRecord): TaskActivityRecord {
    const compactedOutput =
        activity.output && activity.output.length > COMPACTED_TERMINAL_OUTPUT_CHARS
            ? activity.output.slice(-COMPACTED_TERMINAL_OUTPUT_CHARS)
            : activity.output
    const tailEvents =
        activity.events.length > COMPACTED_TERMINAL_EVENT_LIMIT
            ? activity.events.slice(-COMPACTED_TERMINAL_EVENT_LIMIT)
            : activity.events
    return {
        ...activity,
        output: compactedOutput,
        events: tailEvents.map(compactEventForWire),
    }
}

/**
 * Keep an initial activity snapshot within the Webview IPC budget.
 *
 * Normal snapshots fit comfortably and pass through untouched. On large historical
 * tasks, terminal activities are compacted oldest-first and, if still over budget,
 * oldest terminal entries are shed while keeping active work and the newest entry.
 */
export function boundSnapshotActivitiesForWire(
    activities: readonly TaskActivityRecord[],
    byteBudget = MAX_ACTIVITY_SNAPSHOT_WIRE_BYTES,
): TaskActivityRecord[] {
    const sizes = activities.map((activity) => estimateActivityRecordBytes(activity))
    let totalBytes = sizes.reduce((sum, size) => sum + size, 0)
    if (totalBytes <= byteBudget) return [...activities]

    const result = [...activities]
    // Compact oldest terminal activities first (list is newest-first).
    for (let index = result.length - 1; index >= 0 && totalBytes > byteBudget; index--) {
        const current = result[index]
        if (isActiveActivity(current)) continue
        const compacted = compactTerminalActivityForWire(current)
        const nextBytes = estimateActivityRecordBytes(compacted)
        if (nextBytes < sizes[index]) {
            totalBytes -= sizes[index] - nextBytes
            sizes[index] = nextBytes
            result[index] = compacted
        }
    }
    if (totalBytes <= byteBudget) return result

    const kept: TaskActivityRecord[] = []
    let keptBytes = 0
    for (let index = 0; index < result.length; index++) {
        const current = result[index]
        const size = sizes[index]
        if (index === 0 || isActiveActivity(current) || keptBytes + size <= byteBudget) {
            kept.push(current)
            keptBytes += size
        }
    }
    return kept
}

function toProtoMetrics(metrics: TaskActivityRecord["metrics"]): ProtoTaskActivityMetrics | undefined {
    return metrics
        ? ProtoTaskActivityMetrics.create({
              toolCalls: metrics.toolCalls ?? 0,
              inputTokens: metrics.inputTokens ?? 0,
              outputTokens: metrics.outputTokens ?? 0,
              cacheWriteTokens: metrics.cacheWriteTokens ?? 0,
              cacheReadTokens: metrics.cacheReadTokens ?? 0,
              cacheHitRate: metrics.cacheHitRate ?? 0,
              totalCost: metrics.totalCost ?? 0,
              currency: metrics.currency ?? "",
              contextTokens: metrics.contextTokens ?? 0,
              contextWindow: metrics.contextWindow ?? 0,
              lineCount: metrics.lineCount ?? 0,
          })
        : undefined
}

function toProtoRuntime(runtime: TaskActivityRecord["runtime"]): ProtoTaskActivityRuntimeConfig | undefined {
    return runtime
        ? ProtoTaskActivityRuntimeConfig.create({
              profileName: runtime.profileName,
              providerId: runtime.providerId ?? "",
              modelId: runtime.modelId ?? "",
              apiFormat: runtime.apiFormat,
              thinkingEnabled: runtime.thinkingEnabled,
              reasoningEffort: runtime.reasoningEffort,
              thinkingBudgetTokens: runtime.thinkingBudgetTokens,
          })
        : undefined
}

function toProtoActivity(
    activity: TaskActivityRecord,
    cancellable: boolean,
    finishable: boolean,
    retryable: boolean,
): ProtoTaskActivity {
    return ProtoTaskActivity.create({
        activityId: activity.activityId,
        taskId: activity.taskId,
        kind: activity.kind,
        executionMode: activity.executionMode,
        status: activity.status,
        createdAt: activity.createdAt,
        updatedAt: activity.updatedAt,
        finishedAt: activity.finishedAt,
        title: activity.title,
        detail: activity.detail,
        latestEvent: activity.latestEvent,
        timeoutSeconds: activity.timeoutSeconds,
        output: activity.output,
        result: activity.result,
        error: activity.error,
        logPath: activity.logPath,
        parentActivityId: activity.parentActivityId,
        cancellable,
        finishable,
        retryable,
        schemaVersion: activity.schemaVersion,
        currentAttempt: activity.currentAttempt,
        retryUnavailableReason: activity.retryUnavailableReason,
        metrics: toProtoMetrics(activity.metrics),
        runtime: toProtoRuntime(activity.runtime),
        events: activity.events.map((event) =>
            ProtoTaskActivityEvent.create({
                sequence: event.sequence,
                timestamp: event.timestamp,
                kind: event.kind,
                attempt: event.attempt,
                phase: "phase" in event ? event.phase : undefined,
                text: "text" in event ? event.text : undefined,
                toolCallId: "toolCallId" in event ? event.toolCallId : undefined,
                toolName: "toolName" in event ? event.toolName : undefined,
                toolStatus: "toolStatus" in event ? event.toolStatus : undefined,
                summary: "summary" in event ? event.summary : undefined,
                durationMs: "durationMs" in event ? event.durationMs : undefined,
                error: "error" in event ? event.error : undefined,
                status: "status" in event ? event.status : undefined,
                metrics: "metrics" in event ? toProtoMetrics(event.metrics) : undefined,
                retryAttempt: "retryAttempt" in event ? event.retryAttempt : undefined,
                maxRetries: "maxRetries" in event ? event.maxRetries : undefined,
                delayMs: "delayMs" in event ? event.delayMs : undefined,
                cumulativeDelayMs: "cumulativeDelayMs" in event ? event.cumulativeDelayMs : undefined,
            }),
        ),
    })
}

function toProtoUpdate(
    update: TaskActivityUpdate,
    capabilities: (activityId: string) => { cancellable: boolean; finishable: boolean; retryable: boolean },
): ProtoTaskActivityUpdate {
    const activities = update.snapshot ? boundSnapshotActivitiesForWire(update.activities) : update.activities
    return ProtoTaskActivityUpdate.create({
        sequence: update.sequence,
        snapshot: update.snapshot,
        activities: activities.map((activity) => {
            const activityCapabilities = capabilities(activity.activityId)
            return toProtoActivity(
                activity,
                activityCapabilities.cancellable,
                activityCapabilities.finishable,
                activityCapabilities.retryable,
            )
        }),
    })
}

/** Subscribe to the visible task surface's lightweight activity stream. */
export async function subscribeToTaskActivities(
    controller: Controller,
    request: TaskActivitySubscriptionRequest,
    responseStream: StreamingResponseHandler<ProtoTaskActivityUpdate>,
    requestId?: string,
): Promise<void> {
    // A stream that ends carries the opening it ends for, as an empty snapshot:
    // the Webview drops updates for another opening, so an unkeyed end left the
    // last activities of a closed or promoted surface on screen.
    const ended = () =>
        ProtoTaskActivityUpdate.create({
            sequence: 0,
            snapshot: true,
            activities: [],
            taskId: request.taskId,
            taskInstanceId: request.taskInstanceId,
        })
    const owner = currentOpening(controller, request)
    const activityStore = owner ? controller.getCurrentTaskActivityStore(request.taskId) : undefined
    if (!owner || !activityStore) {
        await responseStream(ended(), true)
        return
    }

    // A history surface owns no runtime, so it can cancel or finish nothing. Retry
    // promotes the display into the task's runtime first, so it stays offered
    // while that promotion is possible. Both are read per update because the
    // surface can change under a live subscription.
    const interactive = () => controller.task?.taskId === request.taskId
    const canRetry = () => interactive() || controller.canPromoteHistoryDisplay(request.taskId)
    const requestRegistry = getRequestRegistry()
    let completed = false
    let unsubscribe: () => void = () => undefined
    const complete = async () => {
        if (completed) return
        completed = true
        unsubscribe()
        try {
            await responseStream(ended(), true)
        } finally {
            if (requestId) requestRegistry.cancelRequest(requestId)
        }
    }
    unsubscribe = activityStore.subscribe(async (update) => {
        if (completed) return
        // Updates are incremental and never replayed, so one dropped here would
        // be missing for as long as the stream stayed open. Ending it instead
        // makes the Webview resubscribe and start again from a snapshot.
        if (controller.currentOpening() !== owner) {
            await complete()
            return
        }
        await responseStream(
            {
                ...toProtoUpdate(update, (activityId) => ({
                    cancellable: interactive() && activityStore.isCancellable(activityId),
                    finishable: interactive() && activityStore.isFinishable(activityId),
                    retryable: canRetry() && activityStore.isRetryable(activityId),
                })),
                taskId: owner.taskId,
                taskInstanceId: owner.taskInstanceId,
            },
            false,
            update.sequence,
        )
    }, complete)
    if (requestId && !completed) {
        requestRegistry.registerRequest(
            requestId,
            unsubscribe,
            { type: "task_activity_subscription", taskId: request.taskId },
            responseStream,
        )
    }
}
