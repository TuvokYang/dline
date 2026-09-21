import type { ToolResponse } from "./ToolResponse"

/** Data-only successor directive executed only after the canonical tool result and turn are closed. */
export interface StartSuccessorTaskPostCommitDirective {
	readonly type: "start_successor_task"
	readonly context: string
	readonly functionId: string
	readonly dlineTid: string
}

export type ToolPostCommitDirective = StartSuccessorTaskPostCommitDirective

/** Extended handler result that preserves existing ToolResponse source compatibility. */
export interface ToolExecutionResult {
	readonly response: ToolResponse
	readonly postCommit?: ToolPostCommitDirective
}

export type ToolHandlerResult = ToolResponse | ToolExecutionResult

/** Return whether a handler value carries an explicit post-commit envelope. */
export function isToolExecutionResult(result: ToolHandlerResult): result is ToolExecutionResult {
	return !Array.isArray(result) && typeof result === "object" && result !== null && "response" in result
}

/** Normalize legacy handler responses into one execution envelope. */
export function normalizeToolExecutionResult(result: ToolHandlerResult): ToolExecutionResult {
	return isToolExecutionResult(result) ? result : { response: result }
}
