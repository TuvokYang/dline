/**
 * Content-free failure classification for one context-compaction Provider attempt.
 *
 * Core retry selection, diagnostics, telemetry, and the Webview compaction card all read
 * this single union, so a new kind must be handled in each consumer.
 */

/** Reasons a compaction reply arrived but cannot be accepted as a `<summarize_task>` summary. */
export type CompactionSummaryFailureKind =
	| "empty_response"
	| "missing_block"
	| "foreign_tool_call"
	| "missing_context"
	| "empty_context"
	| "unclosed_context"
	| "unclosed_block"
	| "output_limit"

/** Every terminal outcome of one compaction Provider attempt that did not yield a summary. */
export type CompactionFailureKind = CompactionSummaryFailureKind | "provider_error" | "authorization_failed" | "cancelled"
