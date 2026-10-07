import type { ClineContent } from "@shared/messages/content"
import type { ClineAskResponse } from "@shared/WebviewMessage"
import type { TaskConfig } from "../types/TaskConfig"

/**
 * Load files the user attached while answering a tool and return the text for its tool result.
 *
 * PDFs are queued in the pending user message instead, where they follow the tool results and reach the
 * model as native documents within the request's document budget.
 * @param userMessageContent Pending next-user-message content of the task.
 * @param files Attached file paths, if any.
 * @returns `<file_content>` text for the tool result; empty when nothing was attached.
 */
export async function attachToolFeedbackFiles(userMessageContent: ClineContent[], files: string[] | undefined): Promise<string> {
	if (!files?.length) return ""
	// Loaded on demand: the extractor pulls in the PDF and spreadsheet parsers.
	const { processFilesForToolResult } = await import("@integrations/misc/extract-text")
	const { text, documents } = await processFilesForToolResult(files)
	userMessageContent.push(...documents)
	return text
}

/**
 * Checks whether a received ask response has already been rendered as visible user feedback.
 * @param config Task configuration containing task state.
 * @param response Ask response associated with the user feedback.
 * @param text Optional feedback text.
 * @param images Optional feedback image payloads.
 * @param files Optional feedback file payloads.
 * @returns True when the same feedback was already acknowledged by the webview response path.
 */
export function isAckedFeedback(
	config: Pick<TaskConfig, "taskState">,
	response: ClineAskResponse,
	text?: string,
	images?: string[],
	files?: string[],
): boolean {
	const ackedFeedback = config.taskState.ackedFeedback
	return Boolean(
		ackedFeedback?.response === response &&
			ackedFeedback.text === text &&
			JSON.stringify(ackedFeedback.images ?? []) === JSON.stringify(images ?? []) &&
			JSON.stringify(ackedFeedback.files ?? []) === JSON.stringify(files ?? []),
	)
}

/**
 * Renders user feedback only if the same ask response was not already rendered.
 * @param config Task configuration with callbacks and task state.
 * @param response Ask response associated with the user feedback.
 * @param text Optional feedback text.
 * @param images Optional feedback image payloads.
 * @param files Optional feedback file payloads.
 * @returns Promise resolved after optional UI feedback rendering.
 */
export async function sayFeedbackOnce(
	config: Pick<TaskConfig, "callbacks" | "taskState">,
	response: ClineAskResponse,
	text?: string,
	images?: string[],
	files?: string[],
): Promise<void> {
	if (!isAckedFeedback(config, response, text, images, files)) {
		await config.callbacks.say("user_feedback", text ?? "", images, files)
	}
	config.taskState.ackedFeedback = undefined
}
