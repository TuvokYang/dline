import type { TaskViewState } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import { useCallback, useEffect, useRef, useState } from "react"
import { getTaskViewKey } from "@/services/task-messages"

export type HistoryTaskTarget = Pick<HistoryItem, "id" | "task">
export type HistoryTaskOpening = {
    target: HistoryTaskTarget
    status: "loading"
    previousKey?: string
    requestId: number
}

/** Local navigation feedback only; canonical Task identity and admission stay backend-owned. */
export function useHistoryTaskOpening({
    taskViewState,
    requestOpen,
    onOpenFailed,
}: {
    taskViewState?: TaskViewState
    requestOpen: (id: string) => Promise<unknown>
    onOpenFailed: (target: HistoryTaskTarget, error: unknown) => void
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
            void Promise.resolve()
                .then(() => requestOpen(target.id))
                .catch((error) => {
                    if (generation.current !== requestId) return
                    setHistoryTaskOpening(undefined)
                    onOpenFailed(target, error)
                })
        },
        [onOpenFailed, requestOpen],
    )

    const dismissHistoryTaskOpening = useCallback(() => {
        generation.current++
        setHistoryTaskOpening(undefined)
    }, [])

    useEffect(() => {
        if (historyTaskOpening?.status !== "loading" || !key || key === historyTaskOpening.previousKey) return
        if (taskViewState?.taskId !== historyTaskOpening.target.id) return
        setHistoryTaskOpening(undefined)
    }, [historyTaskOpening, key, taskViewState?.taskId])

    useEffect(
        () => () => {
            generation.current++
        },
        [],
    )
    return { historyTaskOpening, openHistoryTask, dismissHistoryTaskOpening }
}
