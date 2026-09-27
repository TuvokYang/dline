import type { TaskViewPhase, UiMessage } from "@shared/ExtensionMessage"
import { type Dispatch, type SetStateAction, useLayoutEffect, useRef } from "react"

/** Phases in which the task waits for the user after its reply was cut short. */
const STOPPED_PHASES: ReadonlySet<TaskViewPhase> = new Set<TaskViewPhase>(["cancelling", "paused", "aborted"])

/**
 * What the newest streaming row says about the reasoning being watched.
 *
 * Only a live stream produces partial rows, so a task shown from history never
 * starts a watch. `undefined` means nothing is streaming: the previous
 * observation stands, because a stop may settle the row before the phase moves.
 * Once the reply streams prose or a tool, that newer row is what the user is
 * reading and the reasoning is no longer watched.
 */
function observeStreamingRow(messages: readonly UiMessage[]): { readonly reasoningTs?: number } | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]
		if (message.partial !== true) continue
		return { reasoningTs: message.say === "reasoning" ? message.ts : undefined }
	}
	return undefined
}

function withoutRow(rows: Record<number, boolean>, ts: number): Record<number, boolean> {
	if (!(ts in rows)) return rows
	const { [ts]: _removed, ...rest } = rows
	return rest
}

/**
 * Keeps the reasoning of a reply the user stopped open until the task moves on.
 *
 * A streaming reasoning row renders expanded. Stopping the reply settles that
 * row, and a settled row collapses by default, so the thinking the user was
 * reading vanished at the moment they chose to stop. The row stays open while
 * the task waits in a stopped phase and returns to its default once the task
 * resumes or completes. Only a stop observed live opens it: a task reopened from
 * history never streamed here and keeps every row collapsed.
 *
 * The expansion is written to `expandedRows`, the same state a manual toggle
 * uses, so a click during the stop collapses the row as the user expects.
 */
export function useStoppedReasoningExpansion(
	messages: readonly UiMessage[],
	phase: TaskViewPhase | undefined,
	taskId: string | undefined,
	setExpandedRows: Dispatch<SetStateAction<Record<number, boolean>>>,
): void {
	const watchedTsRef = useRef<number>()
	const openedTsRef = useRef<number>()
	const taskIdRef = useRef(taskId)

	// Layout, not passive: the stop commits the streamed row as settled, and a
	// passive effect would let that collapsed row paint before it is reopened.
	useLayoutEffect(() => {
		if (taskIdRef.current !== taskId) {
			// The parent clears expandedRows for a new task; only forget what was watched.
			taskIdRef.current = taskId
			watchedTsRef.current = undefined
			openedTsRef.current = undefined
		}

		if (phase !== undefined && STOPPED_PHASES.has(phase)) {
			const watchedTs = watchedTsRef.current
			watchedTsRef.current = undefined
			if (watchedTs === undefined || openedTsRef.current !== undefined) return
			openedTsRef.current = watchedTs
			setExpandedRows((rows) => (rows[watchedTs] === undefined ? { ...rows, [watchedTs]: true } : rows))
			return
		}

		const openedTs = openedTsRef.current
		if (openedTs !== undefined) {
			openedTsRef.current = undefined
			setExpandedRows((rows) => withoutRow(rows, openedTs))
		}

		if (phase === "completed") {
			watchedTsRef.current = undefined
			return
		}
		// Not gated on "streaming": the first round of a task streams while the
		// task is still initializing, and it can be stopped just the same.
		const observation = observeStreamingRow(messages)
		if (observation) watchedTsRef.current = observation.reasoningTs
	}, [messages, phase, setExpandedRows, taskId])
}
