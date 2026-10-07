import type { TaskViewState } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import { useCallback, useEffect, useRef, useState } from "react"
import { getTaskViewKey } from "@/services/task-messages"

export type HistoryTaskTarget = Pick<HistoryItem, "id" | "task">
export type HistoryTaskOpening = {
	target: HistoryTaskTarget
	status: "loading" | "failed"
	previousKey?: string
	requestId: number
	rpcCompleted?: boolean
}

/** Local navigation feedback only; canonical Task identity and admission stay backend-owned. */
export function useHistoryTaskOpening({
	taskViewState,
	hasMessageSurface,
	requestOpen,
	navigateToChat,
}: {
	taskViewState?: TaskViewState
	hasMessageSurface: boolean
	requestOpen: (id: string) => Promise<unknown>
	navigateToChat: () => void
}) {
	const [historyTaskOpening, setHistoryTaskOpening] = useState<HistoryTaskOpening>()
	const generation = useRef(0)
	const key = getTaskViewKey(taskViewState)
	const currentKey = useRef(key)
	currentKey.current = key

	const openHistoryTask = useCallback(
		(target: HistoryTaskTarget) => {
			const requestId = ++generation.current
			setHistoryTaskOpening({ target, status: "loading", previousKey: currentKey.current, requestId })
			navigateToChat()
			void Promise.resolve()
				.then(() => requestOpen(target.id))
				.then(
					() => {
						if (generation.current !== requestId) return
						setHistoryTaskOpening((opening) =>
							opening?.requestId === requestId ? { ...opening, rpcCompleted: true } : opening,
						)
					},
					() => {
						if (generation.current !== requestId) return
						setHistoryTaskOpening((opening) => ({
							target,
							status: "failed",
							previousKey: opening?.previousKey,
							requestId,
						}))
					},
				)
		},
		[navigateToChat, requestOpen],
	)

	const dismissHistoryTaskOpening = useCallback(() => {
		generation.current++
		setHistoryTaskOpening(undefined)
	}, [])

	useEffect(() => {
		if (historyTaskOpening?.status !== "loading" || !key || key === historyTaskOpening.previousKey) return
		if (taskViewState?.taskId !== historyTaskOpening.target.id) return
		if (hasMessageSurface || historyTaskOpening.rpcCompleted) setHistoryTaskOpening(undefined)
	}, [hasMessageSurface, historyTaskOpening, key, taskViewState?.taskId])

	useEffect(
		() => () => {
			generation.current++
		},
		[],
	)
	return { historyTaskOpening, openHistoryTask, dismissHistoryTaskOpening }
}
