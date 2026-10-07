import type { ApiProviderStreamChunk, ApiStopReason } from "@core/api/transform/stream"
import type { CompactionSummaryFailureKind } from "@shared/context-compaction-failure"
import type { ClineTool } from "@shared/tools"
import type { CompactionFailureKind } from "./compaction-attempt-failure"

/** Token usage of one compaction Provider attempt. */
export interface InternalCompactionUsage {
	inputTokens: number
	outputTokens: number
	cacheWriteTokens: number
	cacheReadTokens: number
	totalTokens: number
	/** Reasoning share of `outputTokens`, when the Provider reported it. */
	thoughtsTokens?: number
}

/** What the retry loop did after this attempt settled. */
export type CompactionAttemptNextAction = "accept" | "retry" | "fail"

/**
 * Content-free record of one compaction Provider attempt.
 *
 * It intentionally carries only counts, lengths, failure kinds, and declared tool names,
 * never reply text, so it can be logged and sent to telemetry without leaking conversation data.
 */
export interface CompactionAttemptDiagnostics {
	attemptIndex: number
	authorizationAttemptId: string
	outcome: "accepted" | "failed"
	/** Set by the retry loop once it decided how to continue; absent when reported by a single Pass. */
	nextAction?: CompactionAttemptNextAction
	failureKind?: CompactionFailureKind
	/** Reminder that accompanied this attempt because the previous attempt failed. */
	reminderKind?: CompactionSummaryFailureKind
	stopReason?: ApiStopReason
	providerOutputCap?: number
	textChunks: number
	textChars: number
	reasoningChunks: number
	reasoningChars: number
	toolCallChunks: number
	/** Native tool names the model called; names outside the request's tool list become `unknown`. */
	toolNames: string[]
	/** Characters ignored after the accepted summarize_task call closed. */
	trailingChars?: number
	usage?: InternalCompactionUsage
	providerTtfbMs: number
	streamMs: number
}

const UNKNOWN_TOOL_NAME = "unknown"

/** Accumulates one attempt's reply text for parsing and its content-free shape for diagnostics. */
export class CompactionReplyObservation {
	text = ""
	stopReason: ApiStopReason | undefined
	textChunks = 0
	reasoningChunks = 0
	reasoningChars = 0
	toolCallChunks = 0
	private readonly toolNames = new Set<string>()
	private readonly declaredToolNames: ReadonlySet<string>

	constructor(tools: readonly ClineTool[] | undefined) {
		this.declaredToolNames = collectDeclaredToolNames(tools)
	}

	record(chunk: ApiProviderStreamChunk): void {
		switch (chunk.type) {
			case "text":
				this.textChunks++
				this.text += chunk.text
				break
			case "reasoning":
				this.reasoningChunks++
				this.reasoningChars += chunk.reasoning.length
				break
			case "tool_calls": {
				this.toolCallChunks++
				const name = chunk.tool_call.function.name
				if (name) this.toolNames.add(this.declaredToolNames.has(name) ? name : UNKNOWN_TOOL_NAME)
				break
			}
			case "usage":
				if (chunk.stopReason) this.stopReason = chunk.stopReason
				break
			case "server_tool":
				break
		}
	}

	get calledToolNames(): string[] {
		return [...this.toolNames]
	}

	toDiagnostics(
		fields: Pick<
			CompactionAttemptDiagnostics,
			| "attemptIndex"
			| "authorizationAttemptId"
			| "outcome"
			| "failureKind"
			| "providerOutputCap"
			| "trailingChars"
			| "usage"
			| "providerTtfbMs"
			| "streamMs"
		>,
	): CompactionAttemptDiagnostics {
		return {
			...fields,
			...(this.stopReason ? { stopReason: this.stopReason } : {}),
			textChunks: this.textChunks,
			textChars: this.text.length,
			reasoningChunks: this.reasoningChunks,
			reasoningChars: this.reasoningChars,
			toolCallChunks: this.toolCallChunks,
			toolNames: this.calledToolNames,
		}
	}
}

function collectDeclaredToolNames(tools: readonly ClineTool[] | undefined): ReadonlySet<string> {
	const names = new Set<string>()
	for (const tool of tools ?? []) {
		const record = tool as { name?: unknown; function?: { name?: unknown } }
		const name = typeof record.name === "string" ? record.name : record.function?.name
		if (typeof name === "string") names.add(name)
	}
	return names
}
