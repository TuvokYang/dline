// @vitest-environment jsdom
import type { TaskViewPhase, UiMessage } from "@shared/ExtensionMessage"
import { act, renderHook } from "@testing-library/react"
import { useState } from "react"
import { describe, expect, it } from "vitest"
import { useStoppedReasoningExpansion } from "./useStoppedReasoningExpansion"

const REQUEST: UiMessage = { ts: 1, type: "say", say: "api_req_started", text: "{}" }
const STREAMING_REASONING: UiMessage = { ts: 2, type: "say", say: "reasoning", text: "thinking", partial: true }
const SETTLED_REASONING: UiMessage = { ...STREAMING_REASONING, partial: false }
const RESUME_ASK: UiMessage = { ts: 3, type: "ask", ask: "resume_task", text: "" }

interface Props {
	readonly messages: readonly UiMessage[]
	readonly phase?: TaskViewPhase
	readonly taskId?: string
}

function renderExpansion(initial: Props) {
	return renderHook(
		({ messages, phase, taskId }: Props) => {
			const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({})
			useStoppedReasoningExpansion(messages, phase, taskId, setExpandedRows)
			return { expandedRows, setExpandedRows }
		},
		{ initialProps: initial },
	)
}

describe("useStoppedReasoningExpansion", () => {
	it("keeps the reasoning of a stopped reply open until the task resumes", () => {
		const hook = renderExpansion({ messages: [REQUEST, STREAMING_REASONING], phase: "streaming", taskId: "task-1" })
		expect(hook.result.current.expandedRows).toEqual({})

		hook.rerender({ messages: [REQUEST, STREAMING_REASONING], phase: "cancelling", taskId: "task-1" })
		hook.rerender({ messages: [REQUEST, SETTLED_REASONING, RESUME_ASK], phase: "paused", taskId: "task-1" })
		expect(hook.result.current.expandedRows).toEqual({ 2: true })

		hook.rerender({ messages: [REQUEST, SETTLED_REASONING, RESUME_ASK], phase: "resuming", taskId: "task-1" })
		expect(hook.result.current.expandedRows).toEqual({})
	})

	it("opens the reasoning even when the stop settles the row before the phase moves", () => {
		const hook = renderExpansion({ messages: [REQUEST, STREAMING_REASONING], phase: "streaming", taskId: "task-1" })

		hook.rerender({ messages: [REQUEST, SETTLED_REASONING], phase: "streaming", taskId: "task-1" })
		hook.rerender({ messages: [REQUEST, SETTLED_REASONING, RESUME_ASK], phase: "aborted", taskId: "task-1" })

		expect(hook.result.current.expandedRows).toEqual({ 2: true })
	})

	it("leaves reasoning collapsed when the reply had moved on to prose", () => {
		const text: UiMessage = { ts: 4, type: "say", say: "text", text: "answer", partial: true }
		const hook = renderExpansion({
			messages: [REQUEST, SETTLED_REASONING, text],
			phase: "streaming",
			taskId: "task-1",
		})

		hook.rerender({ messages: [REQUEST, SETTLED_REASONING, text, RESUME_ASK], phase: "paused", taskId: "task-1" })

		expect(hook.result.current.expandedRows).toEqual({})
	})

	it("does not open reasoning of a task reopened from history", () => {
		const hook = renderExpansion({ messages: [REQUEST, SETTLED_REASONING, RESUME_ASK], phase: "paused", taskId: "task-1" })

		expect(hook.result.current.expandedRows).toEqual({})
	})

	it("forgets a watched row when the task changes", () => {
		const hook = renderExpansion({ messages: [REQUEST, STREAMING_REASONING], phase: "streaming", taskId: "task-1" })

		hook.rerender({ messages: [REQUEST, SETTLED_REASONING, RESUME_ASK], phase: "paused", taskId: "task-2" })

		expect(hook.result.current.expandedRows).toEqual({})
	})

	it("lets the user collapse the opened row and never reopens it during the same stop", () => {
		const hook = renderExpansion({ messages: [REQUEST, STREAMING_REASONING], phase: "streaming", taskId: "task-1" })
		hook.rerender({ messages: [REQUEST, SETTLED_REASONING, RESUME_ASK], phase: "paused", taskId: "task-1" })
		expect(hook.result.current.expandedRows).toEqual({ 2: true })

		act(() => hook.result.current.setExpandedRows((rows) => ({ ...rows, 2: false })))
		hook.rerender({ messages: [REQUEST, SETTLED_REASONING, RESUME_ASK], phase: "aborted", taskId: "task-1" })

		expect(hook.result.current.expandedRows).toEqual({ 2: false })
	})
})
