import { describe, expect, it } from "vitest"
import { ServerTool } from "@/shared/proto/dline/models/metadata"
import { createIdentityFactory } from "../block-identity"
import type { ApiRawStreamServerToolChunk, ApiRawStreamToolCallsChunk } from "../stream"
import { createStreamNormalizer } from "../stream-identity-normalizer"

/**
 * Create a deterministic identity source for stream normalization tests.
 *
 * @param values Ordered identity suffixes.
 * @returns Function returning the next suffix.
 */
function createSource(values: string[]): () => string {
	let index = 0
	return () => {
		const value = values[index]
		index += 1
		if (value === undefined) throw new Error("Identity source exhausted")
		return value
	}
}

/**
 * Create a raw native tool chunk.
 *
 * @param functionId Provider function pairing identity.
 * @param index Provider response-local tool position.
 * @param argumentsText Tool argument delta.
 * @returns Raw provider tool chunk.
 */
function createToolChunk(functionId: string, index: number, argumentsText: string, itemId?: string): ApiRawStreamToolCallsChunk {
	return {
		type: "tool_calls",
		function_id: functionId,
		provider_metadata: itemId ? { item_id: itemId } : undefined,
		tool_index: index,
		tool_call: {
			function: {
				name: "read_file",
				arguments: argumentsText,
			},
		},
	}
}

describe("StreamIdentityNormalizer", () => {
	it("preserves provider function identity while allocating Dline identities", () => {
		const factory = createIdentityFactory(createSource(["TRACE"]))
		const normalizer = createStreamNormalizer(factory)

		const chunk = normalizer.normalize(createToolChunk("call_provider_1", 0, "{}", "fc_item_1"))

		expect(chunk.type).toBe("tool_calls")
		if (chunk.type !== "tool_calls") throw new Error("Expected tool chunk")
		expect(chunk.function_id).toBe("call_provider_1")
		expect(chunk.provider_metadata?.item_id).toBe("fc_item_1")
		expect(chunk.dline_tid).toBe("dline_tid_TRACE")
	})

	it("reuses identities for interleaved deltas of the same tool index", () => {
		const factory = createIdentityFactory(createSource(["TRACE0", "TRACE1"]))
		const normalizer = createStreamNormalizer(factory)

		const first = normalizer.normalize(createToolChunk("call_0", 0, '{"path":', "fc_item_0"))
		const second = normalizer.normalize(createToolChunk("call_1", 1, '{"path":"b"}', "fc_item_1"))
		const finalFirst = normalizer.normalize(createToolChunk("call_0", 0, '"a"}', "fc_item_0"))

		if (first.type !== "tool_calls" || second.type !== "tool_calls" || finalFirst.type !== "tool_calls") {
			throw new Error("Expected tool chunks")
		}
		expect(finalFirst.provider_metadata?.item_id).toBe(first.provider_metadata?.item_id)
		expect(finalFirst.dline_tid).toBe(first.dline_tid)
		expect(second.provider_metadata?.item_id).not.toBe(first.provider_metadata?.item_id)
		expect(second.dline_tid).not.toBe(first.dline_tid)
	})

	it("reuses one Dline identity across a hosted server-tool lifecycle", () => {
		const factory = createIdentityFactory(createSource(["SERVER_TRACE"]))
		const normalizer = createStreamNormalizer(factory)
		const started: ApiRawStreamServerToolChunk = {
			type: "server_tool",
			function_id: "ws_1",
			provider_metadata: { item_id: "ws_1" },
			tool: ServerTool.WEB_SEARCH,
			phase: "started",
			input: { query: "Dline" },
		}
		const completed: ApiRawStreamServerToolChunk = {
			...started,
			phase: "completed",
			result: [{ url: "https://example.com" }],
		}

		const first = normalizer.normalize(started)
		const final = normalizer.normalize(completed)

		expect(first.type).toBe("server_tool")
		expect(final.type).toBe("server_tool")
		if (first.type !== "server_tool" || final.type !== "server_tool") {
			throw new Error("Expected server tool chunks")
		}
		expect(first.dline_tid).toBe("dline_tid_SERVER_TRACE")
		expect(final.dline_tid).toBe(first.dline_tid)
		expect(final.function_id).toBe("ws_1")
	})

	it("gives a hosted call carried from an earlier response its original identity", () => {
		const factory = createIdentityFactory(createSource(["NEW_TRACE"]))
		const normalizer = createStreamNormalizer(factory, {
			carriedServerToolTraceId: (functionId) => (functionId === "srvtoolu_deferred" ? "dline_tid_CARRIED" : undefined),
		})
		const resumed: ApiRawStreamServerToolChunk = {
			type: "server_tool",
			function_id: "srvtoolu_deferred",
			tool: ServerTool.WEB_SEARCH,
			phase: "completed",
			result: [{ url: "https://example.com" }],
		}

		const carried = normalizer.normalize(resumed)
		const fresh = normalizer.normalize({ ...resumed, function_id: "srvtoolu_new", phase: "started" })

		if (carried.type !== "server_tool" || fresh.type !== "server_tool") throw new Error("Expected server tool chunks")
		expect(carried.dline_tid).toBe("dline_tid_CARRIED")
		expect(fresh.dline_tid).toBe("dline_tid_NEW_TRACE")
	})
})
