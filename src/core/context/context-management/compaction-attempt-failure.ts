import { isOutputLimitExceededError } from "@core/api/stream/OutputLimitExceededError"
import type { ApiStopReason } from "@core/api/transform/stream"
import type { ToolUse } from "@core/assistant-message"
import { getPrompt } from "@core/prompts/i18n"
import type { CompactionProviderInput } from "@core/task/compaction/CompactionProviderInput"
import type { CompactionFailureKind, CompactionSummaryFailureKind } from "@shared/context-compaction-failure"
import cloneDeep from "clone-deep"

export type { CompactionFailureKind }

/** Raised when a compaction reply arrived but did not contain an acceptable summarize_task call. */
export class CompactionSummaryRejectedError extends Error {
	constructor(readonly failureKind: CompactionSummaryFailureKind) {
		super(`Internal compaction Pass did not return a usable <summarize_task> block (${failureKind})`)
		this.name = "CompactionSummaryRejectedError"
	}
}

/** What one settled compaction reply contained, as read by the standard tool parser. */
export interface SummarizeTaskReply {
	/** Last summarize_task call parsed from the reply text, closed or still partial. */
	call?: ToolUse
	text: string
	/** Native tool calls the Provider returned; summarize_task is never declared as one. */
	nativeToolCallNames: readonly string[]
	outputLimitReached: boolean
}

/**
 * Classify a reply that produced no closed summarize_task call with a non-empty context.
 *
 * A partial call keeps everything after `<context>` as its context value, so a written
 * `</context>` inside that value means only `</summarize_task>` is missing.
 */
export function classifySummarizeTaskReply(reply: SummarizeTaskReply): CompactionSummaryFailureKind {
	const { call } = reply
	if (!call) {
		if (reply.nativeToolCallNames.length > 0) return "foreign_tool_call"
		if (!reply.text.trim()) return "empty_response"
		return reply.outputLimitReached ? "output_limit" : "missing_block"
	}
	const context = call.params.context
	if (!call.partial) return context === undefined ? "missing_context" : "empty_context"
	if (reply.outputLimitReached) return "output_limit"
	if (context === undefined) return "missing_context"
	return context.includes("</context>") ? "unclosed_block" : "unclosed_context"
}

/** Raised when the explicit-instruction scope refuses to consume the accepted summary. */
export class CompactionAuthorizationError extends Error {
	constructor(readonly code: string) {
		super(`Internal compaction summarize_task authorization failed: ${code}`)
		this.name = "CompactionAuthorizationError"
	}
}

/**
 * Map a Pass failure to its failure kind.
 *
 * @param error The failure raised while settling one compaction attempt.
 * @returns The kind used for retry selection, diagnostics, and presentation.
 */
export function classifyCompactionFailure(error: unknown): CompactionFailureKind {
	if (error instanceof CompactionSummaryRejectedError) return error.failureKind
	if (error instanceof CompactionAuthorizationError) return "authorization_failed"
	if (isOutputLimitExceededError(error)) return "output_limit"
	if (isCancellationError(error)) return "cancelled"
	return "provider_error"
}

/**
 * Report whether a failure is a model-side reply problem that a reminder can correct.
 *
 * These failures are retried for every trigger, including user-started compaction, because
 * the same frozen input plus a targeted reminder is a different and recoverable request.
 */
export function isCorrectableCompactionFailure(error: unknown): boolean {
	const kind = classifyCompactionFailure(error)
	return kind !== "provider_error" && kind !== "authorization_failed" && kind !== "cancelled"
}

/** Map a Provider stop reason to whether output stopped at the token limit. */
export function isOutputLimitStop(stopReason: ApiStopReason | undefined): boolean {
	return stopReason === "output_limit"
}

const REMINDER_PROMPT_KEYS: Record<CompactionSummaryFailureKind, string> = {
	empty_response: "compactionRetryReminderEmptyResponse",
	missing_block: "compactionRetryReminderMissingBlock",
	foreign_tool_call: "compactionRetryReminderForeignToolCall",
	missing_context: "compactionRetryReminderMissingContext",
	empty_context: "compactionRetryReminderEmptyContext",
	unclosed_context: "compactionRetryReminderUnclosedContext",
	unclosed_block: "compactionRetryReminderUnclosedBlock",
	output_limit: "compactionRetryReminderOutputLimit",
}

/** Render the reminder sent with the next attempt after a correctable failure. */
export function renderCompactionRetryReminder(kind: CompactionSummaryFailureKind): string {
	return `${getPrompt("contextManagement", "compactionRetryReminderHeading")}\n${getPrompt("contextManagement", REMINDER_PROMPT_KEYS[kind])}`
}

/**
 * Build the next attempt's input from the frozen Pass input plus one failure-specific reminder.
 *
 * The reminder travels inside the final message, which carries the compaction instruction, so
 * the cached prompt prefix and the tool list stay byte-identical. Each retry starts again from
 * the frozen input, so reminders replace each other instead of accumulating.
 */
export function withCompactionRetryReminder(
	frozenProviderInput: CompactionProviderInput,
	kind: CompactionSummaryFailureKind,
): CompactionProviderInput {
	const reminded = cloneDeep(frozenProviderInput)
	const instructionMessage = reminded.messages.at(-1)
	if (!instructionMessage) return reminded
	const reminder = { type: "text" as const, text: renderCompactionRetryReminder(kind) }
	instructionMessage.content =
		typeof instructionMessage.content === "string"
			? [{ type: "text" as const, text: instructionMessage.content }, reminder]
			: [...instructionMessage.content, reminder]
	return reminded
}

/** Narrow a failure kind to the kinds that carry a reminder. */
export function toReminderKind(kind: CompactionFailureKind): CompactionSummaryFailureKind | undefined {
	return kind in REMINDER_PROMPT_KEYS ? (kind as CompactionSummaryFailureKind) : undefined
}

function isCancellationError(error: unknown): boolean {
	if (typeof error !== "object" || error === null) return false
	const name = (error as { name?: unknown }).name
	if (name === "AbortError" || name === "CanceledError") return true
	const message = (error as { message?: unknown }).message
	return typeof message === "string" && /\b(?:cancell?ed|aborted|became stale)\b/i.test(message)
}
