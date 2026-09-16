import { apiFormatToJSON } from "@shared/proto/dline/models/metadata"
import type { ObservabilityAttributes } from "@/services/telemetry/service/pipeline-port"
import type { ApiHandler, ApiHandlerContext, ApiRequestOptions } from "../index"
import type { ApiProviderStreamChunk } from "../transform/stream"

/** Only counts and declared configuration cross the telemetry boundary, never request content. */
export function requestMetadata(
	handler: ApiHandler,
	context: ApiHandlerContext,
	messageCount: number,
	toolCount: number,
	options?: ApiRequestOptions,
): ObservabilityAttributes {
	const format = handler.getSelectedApiFormat?.()
	return {
		provider: context.profile.provider,
		model: handler.getModel().id,
		api_format: format === undefined ? "unknown" : apiFormatToJSON(format),
		mode: context.mode,
		api_retry_owner: options?.retryOwner ?? "provider",
		api_generation_purpose: options?.generation?.purpose ?? "ordinary",
		api_message_count: messageCount,
		api_tool_count: toolCount,
		api_server_tool_count: options?.serverTools?.length ?? 0,
		api_parallel_tools: context.enableParallelToolCalling === true,
		...(finiteNonnegative(context.requestTimeoutMs) ? { api_timeout_ms: context.requestTimeoutMs } : {}),
		...(finiteNonnegative(options?.generation?.maxOutputTokens)
			? { api_max_output_tokens: options.generation.maxOutputTokens }
			: {}),
	}
}

/** Request-local stream progress; authoritative Task state remains in TaskTurnTelemetry. */
export class ApiRequestProgress {
	private chunkCount = 0
	private firstChunkAt: number | undefined
	private lastChunkAt: number | undefined
	private lastChunkType = "none"
	private usageSeen = false
	private readonly tokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }

	constructor(private readonly startedAt: number) {}

	observe(chunk: ApiProviderStreamChunk, now: number): void {
		this.chunkCount += 1
		this.firstChunkAt ??= now
		this.lastChunkAt = now
		this.lastChunkType = chunk.type
		if (chunk.type !== "usage") return
		this.usageSeen = true
		const values = {
			input: chunk.inputTokens,
			output: chunk.outputTokens,
			cacheRead: chunk.cacheReadTokens,
			cacheWrite: chunk.cacheWriteTokens,
		}
		for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
			const value = values[key]
			if (!finiteNonnegative(value)) continue
			const total = chunk.usageMode === "delta" ? this.tokens[key] + value : value
			if (Number.isFinite(total)) this.tokens[key] = total
		}
	}

	attributes(now: number): ObservabilityAttributes {
		return {
			api_progress_version: 1,
			api_request_phase: this.chunkCount === 0 ? "awaiting_first_chunk" : "streaming",
			api_chunk_count: this.chunkCount,
			api_last_chunk_type: this.lastChunkType,
			api_duration_ms: Math.max(0, now - this.startedAt),
			...(this.firstChunkAt === undefined ? {} : { api_first_chunk_ms: Math.max(0, this.firstChunkAt - this.startedAt) }),
			...(this.lastChunkAt === undefined ? {} : { api_last_chunk_age_ms: Math.max(0, now - this.lastChunkAt) }),
			api_usage_seen: this.usageSeen,
			...(this.usageSeen
				? {
						api_input_tokens: this.tokens.input,
						api_output_tokens: this.tokens.output,
						api_cache_read_tokens: this.tokens.cacheRead,
						api_cache_write_tokens: this.tokens.cacheWrite,
					}
				: {}),
		}
	}
}

function finiteNonnegative(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0
}
