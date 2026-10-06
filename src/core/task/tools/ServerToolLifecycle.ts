import { isHostedToolRouted, type WebSearchRoutingPlan } from "@core/api/server-tools"
import type { ApiStreamServerToolChunk } from "@core/api/transform/stream"
import { ServerTool } from "@shared/proto/dline/models/metadata"
import { type HostedWebSearchOperation, normalizeHostedWebSearchOperation } from "@shared/web-tools"

/** `deferred` is durable but not terminal: the call completes or fails in a later response. */
export type HostedServerToolUpdateStatus = "started" | "deferred" | "completed" | "failed"

/** A deferred hosted call handed from the response that announced it to the response that may run it. */
export interface DeferredServerToolCall {
	readonly dlineTid: string
	readonly functionId: string
	readonly tool: ServerTool
	readonly query: string
	readonly operation: HostedWebSearchOperation
	readonly input?: unknown
}

export interface HostedServerToolUpdate {
	/**
	 * Set only on the update where the provider first ends the call, so consumers count each call
	 * the provider ran exactly once. Calls Dline closes itself, because the stream ended or no
	 * request resumed them, never carry it.
	 */
	readonly settled?: true
	readonly dlineTid: string
	readonly functionId: string
	readonly tool: ServerTool
	readonly status: HostedServerToolUpdateStatus
	readonly partial: boolean
	readonly query: string
	readonly operation: HostedWebSearchOperation
	readonly result?: unknown
	readonly error?: string
	/**
	 * Provider-native call input, forwarded verbatim.
	 *
	 * `operation` and `query` are Web Search projections and cannot express a
	 * sandbox invocation, so a consumer rendering code execution needs the raw
	 * payload to recover the code or command that actually ran.
	 */
	readonly input?: unknown
	/** Provider-native failure payload, forwarded verbatim for error-code recovery. */
	readonly errorDetail?: unknown
}

interface HostedServerToolState {
	readonly functionId: string
	readonly tool: ServerTool
	phase: ApiStreamServerToolChunk["phase"]
	query: string
	operation: HostedWebSearchOperation
	/** Last non-empty provider input seen for this call. */
	input: unknown
	terminal: boolean
	resultEmitted: boolean
}

/** Fallback label for a call that ends before the provider described its work. */
const HOSTED_TOOL_LABEL: Readonly<Partial<Record<ServerTool, string>>> = {
	[ServerTool.CODE_EXECUTION]: "Provider-hosted code execution",
	[ServerTool.WEB_FETCH]: "Provider-hosted web fetch",
}

function defaultQueryFor(tool: ServerTool): string {
	return HOSTED_TOOL_LABEL[tool] ?? "Provider-hosted web search"
}

function defaultFailureFor(tool: ServerTool): string {
	return `${defaultQueryFor(tool)} failed`
}

const PHASE_RANK: Readonly<Record<ApiStreamServerToolChunk["phase"], number>> = {
	started: 0,
	in_progress: 1,
	preview: 1,
	searching: 1,
	deferred: 2,
	completed: 3,
	failed: 3,
}

function statusOf(phase: ApiStreamServerToolChunk["phase"]): HostedServerToolUpdateStatus {
	switch (phase) {
		case "failed":
			return "failed"
		case "completed":
			return "completed"
		case "deferred":
			return "deferred"
		default:
			return "started"
	}
}

/** Keys that name what a hosted call worked on; a fetch names its target by URL. */
const SUBJECT_KEYS = ["query", "q", "search_query", "url"] as const
/** Keys that may carry a readable failure; a URL in an error payload is its subject, not its cause. */
const ERROR_TEXT_KEYS = ["query", "q", "search_query"] as const

function textFromKeys(value: unknown, keys: readonly string[]): string | undefined {
	if (typeof value === "string" && value.trim().length > 0) return value.trim()
	if (!value || typeof value !== "object" || Array.isArray(value)) return undefined

	const record = value as Record<string, unknown>
	for (const key of keys) {
		const text = textFromKeys(record[key], keys)
		if (text) return text
	}
	return textFromKeys(record.action, keys)
}

function textFromUnknown(value: unknown): string | undefined {
	return textFromKeys(value, SUBJECT_KEYS)
}

function errorFromUnknown(value: unknown, fallback: string): string {
	return textFromKeys(value, ERROR_TEXT_KEYS) ?? fallback
}

function isKnownOperation(operation: HostedWebSearchOperation): boolean {
	return operation.type !== "unknown"
}

function operationsEqual(left: HostedWebSearchOperation, right: HostedWebSearchOperation): boolean {
	if (left.type !== right.type) return false
	switch (left.type) {
		case "search":
			return (
				right.type === "search" &&
				left.queries.length === right.queries.length &&
				left.queries.every((query, index) => query === right.queries[index])
			)
		case "open_page":
			return right.type === "open_page" && left.url === right.url
		case "find_in_page":
			return right.type === "find_in_page" && left.url === right.url && left.pattern === right.pattern
		case "unknown":
			return right.type === "unknown" && left.providerType === right.providerType
	}
}

function operationText(operation: HostedWebSearchOperation): string | undefined {
	switch (operation.type) {
		case "search":
			return operation.queries.join("\n")
		case "open_page":
			return operation.url
		case "find_in_page":
			return `${operation.pattern}\n${operation.url}`
		case "unknown":
			return undefined
	}
}

function resolveOperation(chunk: ApiStreamServerToolChunk, existing?: HostedWebSearchOperation): HostedWebSearchOperation {
	const inputOperation = normalizeHostedWebSearchOperation(chunk.input)
	if (isKnownOperation(inputOperation)) return inputOperation

	const resultOperation = normalizeHostedWebSearchOperation(chunk.result)
	if (isKnownOperation(resultOperation)) return resultOperation

	const errorOperation = normalizeHostedWebSearchOperation(chunk.error)
	if (isKnownOperation(errorOperation)) return errorOperation

	if (existing) return existing
	if (inputOperation.type === "unknown" && inputOperation.providerType) return inputOperation
	if (resultOperation.type === "unknown" && resultOperation.providerType) return resultOperation
	return errorOperation
}

/**
 * Owns one provider-hosted server-tool lifecycle for one API response.
 * It admits only tools whose own frozen route is hosted and permits one late result enrichment
 * when a provider emits a result-free completion before its final output item.
 */
export class ServerToolLifecycle {
	private readonly calls = new Map<string, HostedServerToolState>()

	constructor(
		private readonly routingPlan: WebSearchRoutingPlan | undefined,
		private readonly enabled: boolean,
		private readonly onUpdate: (update: HostedServerToolUpdate) => Promise<void> | void,
	) {}

	private accepts(chunk: ApiStreamServerToolChunk): boolean {
		return (
			this.enabled &&
			this.routingPlan !== undefined &&
			isHostedToolRouted(this.routingPlan, chunk.tool) &&
			typeof chunk.dline_tid === "string" &&
			chunk.dline_tid.length > 0 &&
			typeof chunk.function_id === "string" &&
			chunk.function_id.length > 0
		)
	}

	private async emit(update: HostedServerToolUpdate): Promise<void> {
		try {
			await this.onUpdate(update)
		} catch {
			// UI teardown/abort must not turn a provider stream into a second failure.
		}
	}

	/** Consume one normalized provider event. Returns false when it is not admitted. */
	async consume(chunk: ApiStreamServerToolChunk): Promise<boolean> {
		if (!this.accepts(chunk)) return false

		const existing = this.calls.get(chunk.dline_tid)
		if (existing?.functionId !== undefined && existing.functionId !== chunk.function_id) return false
		// One trace identity belongs to one hosted call; a different tool under the same
		// identity would otherwise overwrite an unrelated call's state.
		if (existing !== undefined && existing.tool !== chunk.tool) return false
		if (existing?.terminal) {
			if (existing.phase !== "completed" || chunk.phase === "failed") return true

			const enrichedOperation = resolveOperation(chunk, existing.operation)
			const enrichedQuery =
				operationText(enrichedOperation) ??
				textFromUnknown(chunk.input) ??
				textFromUnknown(chunk.result) ??
				existing.query
			const operationChanged = !operationsEqual(enrichedOperation, existing.operation)
			const queryChanged = enrichedQuery !== existing.query
			const hasNewResult = chunk.phase === "completed" && chunk.result !== undefined && !existing.resultEmitted
			// Only a first-time input is worth re-emitting for. Provider payloads are
			// fresh objects on every event, so comparing them by reference would treat
			// an unchanged input as new and duplicate the terminal update.
			const gainedInput = chunk.input !== undefined && existing.input === undefined
			const enrichedInput = chunk.input ?? existing.input
			if (!operationChanged && !queryChanged && !hasNewResult && !gainedInput) return true

			existing.operation = enrichedOperation
			existing.query = enrichedQuery
			existing.input = enrichedInput
			if (hasNewResult) existing.resultEmitted = true
			await this.emit({
				dlineTid: chunk.dline_tid,
				functionId: chunk.function_id,
				tool: chunk.tool,
				status: "completed",
				partial: false,
				query: enrichedQuery,
				operation: enrichedOperation,
				...(enrichedInput === undefined ? {} : { input: enrichedInput }),
				...(hasNewResult ? { result: chunk.result } : {}),
			})
			return true
		}

		const operation = resolveOperation(chunk, existing?.operation)
		const query = operationText(operation) ?? textFromUnknown(chunk.input) ?? existing?.query ?? defaultQueryFor(chunk.tool)
		const currentRank = existing ? PHASE_RANK[existing.phase] : -1
		if (existing && PHASE_RANK[chunk.phase] < currentRank) return true
		if (existing && PHASE_RANK[chunk.phase] === currentRank && chunk.phase !== "completed" && chunk.phase !== "failed") {
			if (query !== existing.query) existing.query = query
			return true
		}

		// A later event may omit input that an earlier one carried; keeping the last
		// non-empty payload preserves the code across the call's whole lifecycle.
		const input = chunk.input ?? existing?.input

		const state: HostedServerToolState = existing ?? {
			functionId: chunk.function_id,
			tool: chunk.tool,
			phase: chunk.phase,
			query,
			operation,
			input,
			terminal: false,
			resultEmitted: false,
		}
		state.phase = chunk.phase
		state.query = query
		state.operation = operation
		state.input = input
		state.terminal = chunk.phase === "completed" || chunk.phase === "failed"
		state.resultEmitted = chunk.phase === "completed" && chunk.result !== undefined
		this.calls.set(chunk.dline_tid, state)

		const status = statusOf(chunk.phase)
		await this.emit({
			dlineTid: chunk.dline_tid,
			functionId: chunk.function_id,
			tool: chunk.tool,
			status,
			...(state.terminal ? { settled: true } : {}),
			// A deferred row must survive the response that parks it, so it is written durably.
			partial: status === "started",
			query,
			operation,
			...(input === undefined ? {} : { input }),
			...(status === "completed" && chunk.result !== undefined ? { result: chunk.result } : {}),
			...(status === "failed"
				? {
						error: errorFromUnknown(chunk.error, defaultFailureFor(chunk.tool)),
						...(chunk.error === undefined ? {} : { errorDetail: chunk.error }),
					}
				: {}),
		})
		return true
	}

	/**
	 * Take over calls an earlier response deferred, so the result this response brings completes them under
	 * their original identity instead of opening new calls.
	 */
	adopt(calls: readonly DeferredServerToolCall[]): void {
		for (const call of calls) {
			if (!this.enabled || this.routingPlan === undefined || !isHostedToolRouted(this.routingPlan, call.tool)) continue
			this.calls.set(call.dlineTid, {
				functionId: call.functionId,
				tool: call.tool,
				phase: "deferred",
				query: call.query,
				operation: call.operation,
				input: call.input,
				terminal: false,
				resultEmitted: false,
			})
		}
	}

	/** Calls still waiting for a later response to run them. */
	deferredCalls(): DeferredServerToolCall[] {
		return [...this.calls]
			.filter(([, state]) => state.phase === "deferred")
			.map(([dlineTid, state]) => ({
				dlineTid,
				functionId: state.functionId,
				tool: state.tool,
				query: state.query,
				operation: state.operation,
				...(state.input === undefined ? {} : { input: state.input }),
			}))
	}

	/**
	 * Close every started call when a response ends, is cancelled, or is retried.
	 *
	 * Deferred calls stay open: they belong to the conversation, and only the next request decides whether
	 * the provider still runs them. Close them with `failDeferred` once no request can.
	 */
	async finalizeOpen(reason: string): Promise<void> {
		await this.failWhere((state) => state.phase !== "deferred", reason)
	}

	/** Close the deferred calls no later request will resume. */
	async failDeferred(reason: string): Promise<void> {
		await this.failWhere((state) => state.phase === "deferred", reason)
	}

	private async failWhere(selects: (state: HostedServerToolState) => boolean, reason: string): Promise<void> {
		for (const [dlineTid, state] of this.calls) {
			if (state.terminal || !selects(state)) continue
			state.phase = "failed"
			state.terminal = true
			await this.emit({
				dlineTid,
				functionId: state.functionId,
				tool: state.tool,
				status: "failed",
				partial: false,
				query: state.query,
				operation: state.operation,
				...(state.input === undefined ? {} : { input: state.input }),
				error: reason,
			})
		}
	}

	reset(): void {
		this.calls.clear()
	}
}
