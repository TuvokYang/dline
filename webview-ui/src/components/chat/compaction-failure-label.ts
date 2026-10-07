import type { CompactionFailureKind } from "@shared/context-compaction-failure"

const COMPACTION_FAILURE_LABELS: Record<CompactionFailureKind, string> = {
	empty_response: "The model returned an empty reply.",
	missing_block: "The reply did not contain a <summarize_task> block.",
	foreign_tool_call: "The model called a tool instead of writing the summary.",
	missing_context: "The <summarize_task> block had no <context> section.",
	empty_context: "The <context> section was empty.",
	unclosed_context: "The <context> section was not closed.",
	unclosed_block: "The <summarize_task> block was not closed.",
	output_limit: "The reply reached the output token limit before the summary was closed.",
	provider_error: "The provider request failed.",
	authorization_failed: "The summary could not be accepted for this compaction request.",
	cancelled: "Compaction was cancelled.",
}

/**
 * Describe why the latest compaction attempt was rejected.
 *
 * @param kind Content-free failure classification carried by the compaction card.
 * @returns A short English reason, or undefined when the card has no classified failure.
 */
export function describeCompactionFailure(kind: CompactionFailureKind | undefined): string | undefined {
	return kind ? COMPACTION_FAILURE_LABELS[kind] : undefined
}
