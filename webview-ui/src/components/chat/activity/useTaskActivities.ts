import {
	CancelTaskActivitiesRequest,
	FinishTaskActivitiesRequest,
	MoveCommandToBackgroundRequest,
	RetryTaskActivitiesRequest,
	type TaskActivity,
	TaskActivitySubscriptionRequest,
} from "@shared/proto/dline/task"
import { useEffect, useState } from "react"
import { TaskServiceClient } from "@/services/grpc-client"

let subscribedTaskId: string | undefined
let unsubscribe: (() => void) | undefined
let referenceCount = 0
let resubscribeTimer: ReturnType<typeof setTimeout> | undefined
const activities = new Map<string, TaskActivity>()
const listeners = new Set<() => void>()

/**
 * Delay before re-attaching a stream the backend closed on its own.
 *
 * The backend ends this stream immediately when the requested task is not yet
 * the controller's current task. That window is short, so a small fixed delay
 * reattaches quickly without spinning if the task never becomes current.
 */
const RESUBSCRIBE_DELAY_MS = 500

function notify(): void {
	for (const listener of listeners) listener()
}

function stopSubscription(): void {
	if (resubscribeTimer !== undefined) {
		clearTimeout(resubscribeTimer)
		resubscribeTimer = undefined
	}
	unsubscribe?.()
	unsubscribe = undefined
	subscribedTaskId = undefined
	activities.clear()
}

/**
 * Re-attach after the backend closed the stream by itself.
 *
 * Releasing `subscribedTaskId` is not enough on its own: nothing else calls
 * `ensureSubscription` again while the component stays mounted, so without this
 * the view would keep rendering whatever snapshot it already had.
 */
function scheduleResubscribe(taskId: string): void {
	if (resubscribeTimer !== undefined || referenceCount <= 0) return
	resubscribeTimer = setTimeout(() => {
		resubscribeTimer = undefined
		if (referenceCount > 0 && !unsubscribe) ensureSubscription(taskId)
	}, RESUBSCRIBE_DELAY_MS)
}

function ensureSubscription(taskId: string): void {
	if (subscribedTaskId === taskId && unsubscribe) return
	// stopSubscription also clears any pending reattach, so a switch to a
	// different task cannot be overwritten by a timer from the previous one.
	stopSubscription()
	subscribedTaskId = taskId
	unsubscribe = TaskServiceClient.subscribeToTaskActivities(TaskActivitySubscriptionRequest.create({ taskId }), {
		onResponse: (update) => {
			if (update.snapshot) activities.clear()
			for (const activity of update.activities) activities.set(activity.activityId, activity)
			notify()
		},
		onError: (error) => {
			console.error("Task activity subscription failed", error)
			// Release the identity as well. Keeping it would make every later
			// ensureSubscription call match the guard above and return early,
			// leaving this webview permanently without activity updates.
			if (subscribedTaskId === taskId) subscribedTaskId = undefined
			unsubscribe = undefined
			scheduleResubscribe(taskId)
		},
		onComplete: () => {
			// The backend ends this stream immediately when the task is not yet the
			// controller's current task. That is a startup race rather than a final
			// state, so the identity is released and the stream is re-attached.
			if (subscribedTaskId === taskId) subscribedTaskId = undefined
			unsubscribe = undefined
			scheduleResubscribe(taskId)
		},
	})
}

export async function cancelTaskActivities(taskId: string, activityIds: string[]): Promise<string[]> {
	if (activityIds.length === 0) return []
	const response = await TaskServiceClient.cancelTaskActivities(CancelTaskActivitiesRequest.create({ taskId, activityIds }))
	return response.cancelledActivityIds
}

/** Request soft completion for running subagents. */
export async function finishTaskActivities(taskId: string, activityIds: string[]): Promise<string[]> {
	if (activityIds.length === 0) return []
	const response = await TaskServiceClient.finishTaskActivities(FinishTaskActivitiesRequest.create({ taskId, activityIds }))
	return response.finishedActivityIds
}

/** Retry retained retryable subagents. */
export async function retryTaskActivities(taskId: string, activityIds: string[]): Promise<string[]> {
	if (activityIds.length === 0) return []
	const response = await TaskServiceClient.retryTaskActivities(RetryTaskActivitiesRequest.create({ taskId, activityIds }))
	return response.retriedActivityIds
}

/** Move one synchronous foreground command to background tracking. */
export async function moveCommandToBackground(taskId: string, activityId: string): Promise<boolean> {
	const response = await TaskServiceClient.moveCommandToBackground(
		MoveCommandToBackgroundRequest.create({ taskId, activityId }),
	)
	return response.moved
}

/** Move one foreground subagent to task-local background execution. */
export async function moveSubagentToBackground(taskId: string, activityId: string): Promise<boolean> {
	return moveCommandToBackground(taskId, activityId)
}

/** Shared per-webview task activity subscription. */
export function useTaskActivities(taskId: string | undefined): {
	activities: TaskActivity[]
	activeCount: number
	getById: (activityId: string) => TaskActivity | undefined
} {
	const [, setLocalRevision] = useState(0)
	useEffect(() => {
		if (!taskId) return
		referenceCount++
		const listener = () => setLocalRevision((value) => value + 1)
		listeners.add(listener)
		ensureSubscription(taskId)
		return () => {
			listeners.delete(listener)
			referenceCount--
			if (referenceCount <= 0) {
				referenceCount = 0
				stopSubscription()
			}
		}
	}, [taskId])

	const list = Array.from(activities.values()).sort(
		(a, b) => b.createdAt - a.createdAt || a.activityId.localeCompare(b.activityId),
	)
	return {
		activities: list,
		activeCount: list.filter((activity) => ["awaiting_approval", "running", "cancelling"].includes(activity.status)).length,
		getById: (activityId: string) => activities.get(activityId),
	}
}
