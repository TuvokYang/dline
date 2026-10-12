import type { ToolResultAttachments } from "@integrations/misc/extract-text"
import { REPLY_AS_TYPED, submittedInputRow } from "@shared/input-semantics/submitted-input"
import type { ClineAskResponse } from "@shared/WebviewMessage"
import type { InteractionOutcome } from "../../interaction/InteractionProtocol"
import type { TaskConfig } from "../types/TaskConfig"

/**
 * Load files the user attached while answering a tool.
 *
 * The handler returns the documents with its result (see `withToolDocuments`), so the
 * journal records them beside the result and the provider request places them after it
 * as native documents within the request's document budget.
 * @param files Attached file paths, if any.
 * @returns `<file_content>` text for the tool result and the PDFs that follow it; both empty when nothing was attached.
 */
export async function attachToolFeedbackFiles(files: string[] | undefined): Promise<ToolResultAttachments> {
    if (!files?.length) return { text: "", documents: [] }
    // Loaded on demand: the extractor pulls in the PDF and spreadsheet parsers.
    const { processFilesForToolResult } = await import("@integrations/misc/extract-text")
    return processFilesForToolResult(files)
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
 * @param presentation The outcome the feedback came from. A structured draft in
 *   it is shown as the user submitted it, not as the text and attachments the
 *   receiver resolved from it.
 * @returns Promise resolved after optional UI feedback rendering.
 */
export async function sayFeedbackOnce(
    config: Pick<TaskConfig, "callbacks" | "taskState">,
    response: ClineAskResponse,
    text?: string,
    images?: string[],
    files?: string[],
    presentation?: Pick<InteractionOutcome, "feedbackPresented" | "draft">,
): Promise<void> {
    if (presentation?.feedbackPresented) return
    if (!isAckedFeedback(config, response, text, images, files)) {
        const draft = presentation?.draft
        if (draft?.semanticInput) {
            // A dialog reply reaches its receiver as typed; a command its owner
            // claimed was already taken out of this document. The draft's own
            // flat attachments travel with it; the resolved ones never do.
            await config.callbacks.sayUserReply(
                submittedInputRow(
                    [{ semanticInput: draft.semanticInput, images: draft.images, files: draft.files }],
                    REPLY_AS_TYPED,
                ),
            )
        } else {
            await config.callbacks.say("user_feedback", text ?? "", images, files)
        }
    }
    config.taskState.ackedFeedback = undefined
}
