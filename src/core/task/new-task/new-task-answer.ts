import { getPrompt } from "@core/prompts/i18n"
import { formatResponse } from "@core/prompts/responses"
import type { StartSuccessorTaskPostCommitDirective } from "../tools/ToolExecutionResult"
import type { ToolResponse } from "../tools/ToolResponse"
import { NEW_TASK_FEEDBACK_CONTINUATION_MARKER } from "./new-task-continuation"

/**
 * How a `new_task` call is answered.
 *
 * The live handler and a dialog answered after a restart both settle the call
 * through these functions and hand off through the same `PostCommitPublisher`,
 * which records an approval's result only once the handoff is accepted. A
 * restored answer therefore reaches the model, and starts the successor, as a
 * live one does.
 */

/** The `new_task` call an answer settles. */
export interface NewTaskCall {
    readonly task: string
    readonly context: string
    readonly functionId: string
    readonly dlineTid: string
}

/** The source's tool result once the user approved the handoff. */
export function newTaskCreatedResponse(): ToolResponse {
    return formatResponse.toolResult(getPrompt("toolHandlers", "newTaskCreated"))
}

/** The directive that starts the successor once the approval is durable; it carries the task and context alone. */
export function successorDirective(call: NewTaskCall): StartSuccessorTaskPostCommitDirective {
    return {
        type: "start_successor_task",
        task: call.task,
        context: call.context,
        functionId: call.functionId,
        dlineTid: call.dlineTid,
    }
}

/**
 * The source's tool result once the user declined the handoff with feedback.
 *
 * The feedback answers this conversation and never travels to a successor. The
 * marker lets the next round call `new_task` again without the user repeating
 * `/newtask`; see `deriveNewTaskFeedbackContinuation`.
 */
export function declinedNewTaskResponse(feedback: string, images?: string[], fileContent?: string): ToolResponse {
    return formatResponse.toolResult(
        `${NEW_TASK_FEEDBACK_CONTINUATION_MARKER}\n${formatResponse.newTaskDeclinedFeedback(feedback)}`,
        images,
        fileContent,
    )
}

/**
 * The call a recorded `new_task` invocation made.
 *
 * Undefined when the record lacks either half: the live handler refuses such a
 * call before it opens the dialog, so a restored one cannot hand off either.
 */
export function newTaskCallOf(invocation: {
    readonly input: Readonly<Record<string, unknown>>
    readonly functionId: string
    readonly dlineTid: string
}): NewTaskCall | undefined {
    const { task, context } = invocation.input
    if (typeof task !== "string" || !task || typeof context !== "string" || !context) return undefined
    return { task, context, functionId: invocation.functionId, dlineTid: invocation.dlineTid }
}
