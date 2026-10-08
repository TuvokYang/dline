import type { ClineAskResponse } from "@shared/WebviewMessage"

/** Facts available when a response arrives without an active ask receiver. */
export interface UnroutedAskResponseContext {
	taskId: string
	response: ClineAskResponse
	text?: string
	images?: string[]
	files?: string[]
	/** Conversation length, or -1 when the task could not report one. */
	messageCount: number
	phase: string
}

/** Render an actionable diagnostic without echoing user-provided response text. */
export function formatUnroutedAskResponse(context: UnroutedAskResponseContext): string {
	return (
		`[Task ${context.taskId}] Ask response arrived while no ask was listening; refused: ` +
		`response=${context.response}, hasText=${Boolean(context.text)}, images=${context.images?.length ?? 0}, ` +
		`files=${context.files?.length ?? 0}, messages=${context.messageCount}, phase=${context.phase}`
	)
}
