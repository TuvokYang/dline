import type { IdentityFactory } from "./block-identity"
import type {
	ApiCanonicalStream,
	ApiRawStreamChunk,
	ApiRawStreamServerToolChunk,
	ApiRawStreamToolCallsChunk,
	ApiStream,
	ApiStreamChunk,
	ApiStreamServerToolChunk,
	ApiStreamToolCallsChunk,
} from "./stream"

/** Canonical identity allocated for one response-local native tool position. */
interface ToolIdentityState {
	dline_tid: string
	function_id: string
}

type RawIdentifiedChunk = ApiRawStreamToolCallsChunk | ApiRawStreamServerToolChunk
type CanonicalIdentifiedChunk = ApiStreamToolCallsChunk | ApiStreamServerToolChunk

/** Converts provider raw stream chunks into canonical Dline stream chunks. */
export interface StreamIdentityNormalizer {
	/**
	 * Normalize one provider stream chunk.
	 *
	 * @param chunk Provider-neutral raw stream chunk.
	 * @returns Canonical chunk with stable Dline identities.
	 */
	normalize(chunk: ApiRawStreamChunk): ApiStreamChunk
	/** Clear response-local block identity state. */
	endResponse(): void
}

/**
 * Convert a provider stream into a canonical runtime stream.
 *
 * @param stream Provider stream that may contain raw or legacy chunks.
 * @param normalizer Response-local identity normalizer.
 * @returns Canonical stream accepted by runtime consumers.
 */
export function normalizeApiStream(stream: ApiStream, normalizer: StreamIdentityNormalizer): ApiCanonicalStream {
	const normalized = (async function* (): AsyncGenerator<ApiStreamChunk> {
		try {
			for await (const chunk of stream) {
				yield normalizer.normalize(chunk)
			}
		} finally {
			normalizer.endResponse()
		}
	})() as ApiCanonicalStream
	return normalized
}

export interface StreamNormalizerOptions {
	/**
	 * Trace identity a hosted call already holds from an earlier response, looked up by provider function id.
	 *
	 * A provider may run a hosted call one response after announcing it; reusing the trace identity keeps
	 * both responses on one call instead of opening a second.
	 */
	carriedServerToolTraceId?: (functionId: string) => string | undefined
}

/**
 * Create a response-local canonical stream normalizer.
 *
 * @param factory Task-local allocator for Dline-owned identities.
 * @param options Identities carried in from earlier responses.
 * @returns Stream normalizer that preserves provider function identities.
 */
export function createStreamNormalizer(
	factory: IdentityFactory,
	options: StreamNormalizerOptions = {},
): StreamIdentityNormalizer {
	const toolStates = new Map<string, ToolIdentityState>()

	/**
	 * Determine whether a tool chunk is already canonical.
	 *
	 * @param chunk Provider stream chunk.
	 * @returns True when Dline trace identity has already been assigned.
	 */
	function isCanonicalTool(chunk: ApiRawStreamChunk): chunk is CanonicalIdentifiedChunk {
		return (chunk.type === "tool_calls" || chunk.type === "server_tool") && typeof chunk.dline_tid === "string"
	}

	/**
	 * Determine whether a tool chunk carries a provider function identity but no Dline trace identity.
	 *
	 * @param chunk Provider stream chunk.
	 * @returns True when the chunk is ready for canonical normalization.
	 */
	function isRawTool(chunk: ApiRawStreamChunk): chunk is RawIdentifiedChunk {
		return (
			(chunk.type === "tool_calls" || chunk.type === "server_tool") &&
			typeof chunk.function_id === "string" &&
			typeof chunk.dline_tid !== "string"
		)
	}

	/**
	 * Resolve a stable response-local key for a native tool chunk.
	 *
	 * @param chunk Raw native tool chunk.
	 * @returns Key that preserves interleaved tool identity.
	 */
	function getToolKey(chunk: RawIdentifiedChunk): string {
		if (chunk.type === "server_tool") {
			return `server:${chunk.function_id}`
		}
		return chunk.tool_index === undefined ? `function:${chunk.function_id}` : `index:${chunk.tool_index}`
	}

	/**
	 * Normalize a native tool chunk without changing its provider pairing ID.
	 *
	 * @param chunk Raw native tool chunk.
	 * @returns Canonical native tool chunk.
	 */
	function normalizeTool(chunk: ApiRawStreamToolCallsChunk): ApiStreamToolCallsChunk
	function normalizeTool(chunk: ApiRawStreamServerToolChunk): ApiStreamServerToolChunk
	function normalizeTool(chunk: RawIdentifiedChunk): CanonicalIdentifiedChunk {
		const key = getToolKey(chunk)
		const existing = toolStates.get(key)
		if (existing && existing.function_id !== chunk.function_id) {
			throw new Error(`Stream identity conflict for ${key}: ${existing.function_id} !== ${chunk.function_id}`)
		}
		const state =
			existing ??
			({
				dline_tid: carriedTraceId(chunk) ?? factory.nextTraceId(),
				function_id: chunk.function_id,
			} satisfies ToolIdentityState)
		toolStates.set(key, state)
		return {
			...chunk,
			dline_tid: state.dline_tid,
			function_id: state.function_id,
		}
	}

	function carriedTraceId(chunk: RawIdentifiedChunk): string | undefined {
		return chunk.type === "server_tool" ? options.carriedServerToolTraceId?.(chunk.function_id) : undefined
	}

	return {
		normalize(chunk: ApiRawStreamChunk): ApiStreamChunk {
			if (chunk.type !== "tool_calls" && chunk.type !== "server_tool") {
				return chunk
			}
			if (isCanonicalTool(chunk)) {
				return chunk
			}
			if (!isRawTool(chunk)) {
				throw new Error("Provider tool chunk reached runtime without function_id")
			}
			return chunk.type === "server_tool" ? normalizeTool(chunk) : normalizeTool(chunk)
		},
		endResponse(): void {
			toolStates.clear()
		},
	}
}
