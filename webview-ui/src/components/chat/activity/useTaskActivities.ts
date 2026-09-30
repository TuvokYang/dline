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
import { getTaskViewKey } from "@/services/task-messages"

type Opening = { taskId: string; taskInstanceId: string }
type ActivitySubscriber = {
	opening: Opening
	listeners: Set<(activities: TaskActivity[]) => void>
	activities: Map<string, TaskActivity>
	unsubscribe?: () => void
	retryTimer?: ReturnType<typeof setTimeout>
	generation: number
	disposed: boolean
}
const subscriptions = new Map<string, ActivitySubscriber>()
const RESUBSCRIBE_DELAY_MS = 500

function publish(subscription: ActivitySubscriber): void {
	const activities = [...subscription.activities.values()]
	for (const listener of subscription.listeners) listener(activities)
}

function openSubscription(subscription: ActivitySubscriber): void {
	const generation = ++subscription.generation
	const isCurrent = () => !subscription.disposed && generation === subscription.generation
	const retry = () => {
		if (!isCurrent()) return
		subscription.generation++
		subscription.unsubscribe = undefined
		if (subscription.retryTimer) clearTimeout(subscription.retryTimer)
		subscription.retryTimer = setTimeout(() => {
			subscription.retryTimer = undefined
			if (!subscription.disposed) openSubscription(subscription)
		}, RESUBSCRIBE_DELAY_MS)
	}
	const unsubscribe = TaskServiceClient.subscribeToTaskActivities(
		TaskActivitySubscriptionRequest.create(subscription.opening),
		{
			onResponse: (update) => {
				if (!isCurrent() || getTaskViewKey(update) !== getTaskViewKey(subscription.opening)) return
				if (update.snapshot) subscription.activities.clear()
				for (const activity of update.activities) subscription.activities.set(activity.activityId, activity)
				publish(subscription)
			},
			onError: (error) => {
				if (!isCurrent()) return
				console.error("Task activity subscription failed", error)
				retry()
			},
			onComplete: retry,
		},
	)
	if (isCurrent()) subscription.unsubscribe = unsubscribe
	else unsubscribe()
}

function subscribe(opening: Opening, listener: (activities: TaskActivity[]) => void): () => void {
	const key = getTaskViewKey(opening)!
	let subscription = subscriptions.get(key)
	if (!subscription) {
		subscription = { opening, listeners: new Set(), activities: new Map(), generation: 0, disposed: false }
		subscriptions.set(key, subscription)
	}
	subscription.listeners.add(listener)
	listener([...subscription.activities.values()])
	if (!subscription.unsubscribe && !subscription.retryTimer) openSubscription(subscription)
	const owner = subscription
	return () => {
		owner.listeners.delete(listener)
		if (owner.listeners.size > 0) return
		owner.disposed = true
		owner.generation++
		if (owner.retryTimer) clearTimeout(owner.retryTimer)
		owner.unsubscribe?.()
		owner.activities.clear()
		if (subscriptions.get(key) === owner) subscriptions.delete(key)
	}
}

export async function cancelTaskActivities(taskId: string, activityIds: string[], taskInstanceId: string): Promise<string[]> {
	if (activityIds.length === 0) return []
	const response = await TaskServiceClient.cancelTaskActivities(
		CancelTaskActivitiesRequest.create({ taskId, taskInstanceId, activityIds }),
	)
	return response.cancelledActivityIds
}

/** Request soft completion for running subagents. */
export async function finishTaskActivities(taskId: string, activityIds: string[], taskInstanceId: string): Promise<string[]> {
	if (activityIds.length === 0) return []
	const response = await TaskServiceClient.finishTaskActivities(
		FinishTaskActivitiesRequest.create({ taskId, taskInstanceId, activityIds }),
	)
	return response.finishedActivityIds
}

/** Retry retained retryable subagents. */
export async function retryTaskActivities(taskId: string, activityIds: string[], taskInstanceId: string): Promise<string[]> {
	if (activityIds.length === 0) return []
	const response = await TaskServiceClient.retryTaskActivities(
		RetryTaskActivitiesRequest.create({ taskId, taskInstanceId, activityIds }),
	)
	return response.retriedActivityIds
}

export async function moveCommandToBackground(taskId: string, activityId: string, taskInstanceId: string): Promise<boolean> {
	const response = await TaskServiceClient.moveCommandToBackground(
		MoveCommandToBackgroundRequest.create({ taskId, taskInstanceId, activityId }),
	)
	return response.moved
}

export async function moveSubagentToBackground(taskId: string, activityId: string, taskInstanceId: string): Promise<boolean> {
	return moveCommandToBackground(taskId, activityId, taskInstanceId)
}

/** Share transport only within the exact same Task opening; release it after the last consumer. */
export function useTaskActivities(
	taskId: string | undefined,
	taskInstanceId?: string,
): {
	activities: TaskActivity[]
	activeCount: number
	getById: (activityId: string) => TaskActivity | undefined
} {
	const key = getTaskViewKey({ taskId, taskInstanceId })
	const [view, setView] = useState<{ key?: string; activities: TaskActivity[] }>({ activities: [] })
	useEffect(() => {
		if (!taskId || !taskInstanceId) return
		return subscribe({ taskId, taskInstanceId }, (activities) => setView({ key, activities }))
	}, [taskId, taskInstanceId, key])
	const list = view.key === key ? view.activities : []
	const sorted = [...list].sort((a, b) => b.createdAt - a.createdAt || a.activityId.localeCompare(b.activityId))
	return {
		activities: sorted,
		activeCount: sorted.filter((activity) => ["awaiting_approval", "running", "cancelling"].includes(activity.status)).length,
		getById: (activityId) => list.find((activity) => activity.activityId === activityId),
	}
}
