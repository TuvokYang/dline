import type { TaskViewPhase, UiMessage } from "@shared/ExtensionMessage"
import { type Dispatch, type SetStateAction, useEffect, useRef } from "react"

/** Phases in which the task waits for the user after its reply was cut short. */
const STOPPED_PHASES: ReadonlySet<TaskViewPhase> = new Set<TaskViewPhase>(["cancelling", "paused", "aborted"])

/** Rows a stop itself appends; they do not mean the reply went on past its reasoning. */
function isStopRow(message: UiMessage): boolean {
	return message.type === "ask" && (message.ask === "resume_task" || message.ask === "resume_completed_task")
}

/**
 * The reasoning row the reply is still on, if its thinking is the newest thing shown.
 *
 * Once the reply moves on to prose or a tool call, that newer row carries what
 * the user is reading, so the reasoning is no longer the reply's frontier.
 */
function frontierReasoningTs(messages: readonly UiMessage[]): number | undefined {
	for (let index = messages.length - 1; index >= 0; index--) {
		const message = messages[index]
		if (isStopRow(message)) continue
		return message.say === "reasoning" ? message.ts : undefined
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

	useEffect(() => {
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

		// Only a reply streaming right now can be stopped mid-thought; any other
		// phase means the reasoning already led somewhere.
		watchedTsRef.current = phase === "streaming" ? frontierReasoningTs(messages) : undefined
	}, [messages, phase, setExpandedRows, taskId])
}
