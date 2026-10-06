import type { ClineMessage, ClineSayTool } from "@shared/ExtensionMessage"
import type { ClineStorageMessage, HostedToolReplayProtocol } from "@shared/messages/content"
import { type DeferredHostedCallState, resolveDeferredHostedCalls } from "@shared/messages/hosted-tool-deferral"
import { ServerTool } from "@shared/proto/dline/models/metadata"
import type { HostedCallPresentation, HostedWebSearchOperation, WebToolSourcePresentation } from "@shared/web-tools"
import type { DeferredServerToolCall } from "./ServerToolLifecycle"

/** A deferred hosted call as its durable chat row records it. */
export interface DeferredHostedRow extends DeferredServerToolCall {
	/** Timestamp of the row, so the call finishes the row that announced it. */
	readonly ts: number
	/** Provider that ran the call, so a later failure keeps the row's original source. */
	readonly providerId?: string
}

export interface DeferredHostedRequest {
	/** Hosted protocol the next request replays; absent when it replays none. */
	protocol?: HostedToolReplayProtocol
	/** Hosted tool names the next request declares. */
	replayHostedTools?: ReadonlySet<string>
}

export interface DeferredHostedRowPlan {
	/** Rows whose call the next request resumes; their result completes them. */
	carried: DeferredHostedRow[]
	/** Rows whose call no request can run any more; they fail now. */
	abandoned: DeferredHostedRow[]
}

const UNKNOWN_OPERATION: HostedWebSearchOperation = { type: "unknown" }

/**
 * Read the hosted call a deferred Web Search or Web Fetch row is waiting on.
 *
 * Rows are the durable record of a deferral: they survive restarts with the conversation, so the request
 * that resumes a call reads them instead of trusting in-memory state.
 */
export function readDeferredHostedRow(message: ClineMessage): DeferredHostedRow | undefined {
	if (message.type !== "say" || message.say !== "tool" || !message.text?.includes('"deferred"')) return undefined
	const tool = parseSayTool(message.text)
	const search = tool?.tool === "webSearch" ? tool.webSearch : undefined
	const fetch = tool?.tool === "webFetch" ? tool.webFetch : undefined
	const presentation = search ?? fetch
	if (presentation?.status !== "deferred" || !isHostedCall(presentation.hostedCall)) return undefined

	const identity = {
		ts: message.ts,
		functionId: presentation.hostedCall.functionId,
		dlineTid: presentation.hostedCall.traceId,
		...providerOf(presentation.source),
	}
	if (search) {
		const query = search.query ?? tool?.path ?? ""
		return { ...identity, tool: ServerTool.WEB_SEARCH, query, operation: search.operation ?? UNKNOWN_OPERATION }
	}
	const url = fetch?.url ?? ""
	return { ...identity, tool: ServerTool.WEB_FETCH, query: url, operation: UNKNOWN_OPERATION, input: { url } }
}

/**
 * Decide, at the start of a request, which deferred rows it resumes and which can never finish.
 *
 * The decision comes from the same resolver that shapes the request, so a row is carried exactly when the
 * request keeps its call, and abandoned exactly when the request drops it.
 */
export function planDeferredHostedRows(
	messages: readonly ClineMessage[],
	history: readonly ClineStorageMessage[],
	request: DeferredHostedRequest,
): DeferredHostedRowPlan {
	const rows = messages.flatMap((message) => {
		const row = readDeferredHostedRow(message)
		return row ? [row] : []
	})
	return partitionDeferredHostedCalls(rows, history, request)
}

/** Split deferred calls into those the next request resumes and those no request can run any more. */
export function partitionDeferredHostedCalls<T extends DeferredServerToolCall>(
	calls: readonly T[],
	history: readonly ClineStorageMessage[],
	request: DeferredHostedRequest,
): { carried: T[]; abandoned: T[] } {
	const states = callStates(history, request)
	const carried: T[] = []
	const abandoned: T[] = []
	for (const call of calls) {
		const state = states.get(call.functionId)
		// A call history already resolved finished in a response whose row update was lost; it is not ours to fail.
		if (state === "resumed") continue
		if (state === "pending") carried.push(call)
		else abandoned.push(call)
	}
	return { carried, abandoned }
}

function callStates(
	history: readonly ClineStorageMessage[],
	request: DeferredHostedRequest,
): ReadonlyMap<string, DeferredHostedCallState> {
	if (request.protocol === undefined) return new Map()
	const calls = resolveDeferredHostedCalls(history, {
		protocol: request.protocol,
		replayHostedTools: request.replayHostedTools,
	})
	return new Map(calls.map((call) => [call.callId, call.state]))
}

function parseSayTool(text: string): ClineSayTool | undefined {
	try {
		const parsed: unknown = JSON.parse(text)
		return parsed && typeof parsed === "object" ? (parsed as ClineSayTool) : undefined
	} catch {
		return undefined
	}
}

function isHostedCall(value: unknown): value is HostedCallPresentation {
	const call = value as Partial<HostedCallPresentation> | undefined
	return typeof call?.functionId === "string" && call.functionId.length > 0 && typeof call.traceId === "string"
}

function providerOf(source: WebToolSourcePresentation | undefined): { providerId?: string } {
	return source?.provider ? { providerId: source.provider } : {}
}
