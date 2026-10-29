import type { ClineUserAttachedDocumentBlock } from "@shared/messages/content"
import type { ToolFailureObservation } from "../observability/tool-execution-observation"
import type { ToolResponse } from "./ToolResponse"

/** Data-only successor directive executed only after the canonical tool result and turn are closed. */
export interface StartSuccessorTaskPostCommitDirective {
    readonly type: "start_successor_task"
    /** What the successor is asked to do; it opens the successor as `<task>`. */
    readonly task: string
    /** What the successor needs to know; it follows the task as `<context>`. */
    readonly context: string
    readonly functionId: string
    readonly dlineTid: string
}

export type ToolPostCommitDirective = StartSuccessorTaskPostCommitDirective

/** What a call the user refused reports to the model, in its handler's own words. */
export interface ToolDenial {
    readonly text: string
    /**
     * Whether the model reads the refusal as a failed call.
     *
     * A refusal that is itself the user's answer, such as New Task feedback,
     * is an ordinary result: the conversation continues from what the user said.
     */
    readonly isError: boolean
}

/** Extended handler result that preserves existing ToolResponse source compatibility. */
export interface ToolExecutionResult {
    readonly response: ToolResponse
    /**
     * PDFs the user attached to this call's answer.
     *
     * A tool result carries only text and images, so documents travel beside it
     * and the provider request places them after the result they belong to.
     */
    readonly documents?: readonly ClineUserAttachedDocumentBlock[]
    /** Stable, content-free failure classification for lifecycle and OTel projection. */
    readonly failure?: ToolFailureObservation
    readonly postCommit?: ToolPostCommitDirective
}

export type ToolHandlerResult = ToolResponse | ToolExecutionResult
export type ObservedToolExecutionResult = ToolExecutionResult & { readonly failed?: true }

/** Return whether a handler value carries an explicit post-commit envelope. */
export function isToolExecutionResult(result: ToolHandlerResult): result is ToolExecutionResult {
    return !Array.isArray(result) && typeof result === "object" && result !== null && "response" in result
}

/** Normalize legacy handler responses into one execution envelope. */
export function normalizeToolExecutionResult(result: ToolHandlerResult): ToolExecutionResult {
    return isToolExecutionResult(result) ? result : { response: result }
}

/** Mark a structured handler failure before an observation reads the result. */
export function normalizeObservedToolExecutionResult(result: ToolHandlerResult): ObservedToolExecutionResult {
    const normalized = normalizeToolExecutionResult(result)
    return normalized.failure ? { ...normalized, failed: true } : normalized
}

/** Pair a response with the documents that follow it, keeping a bare response when there are none. */
export function withToolDocuments(
    response: ToolResponse,
    documents: readonly ClineUserAttachedDocumentBlock[],
): ToolHandlerResult {
    return documents.length === 0 ? response : { response, documents }
}
