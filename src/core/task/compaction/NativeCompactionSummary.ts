/** Accumulated `summarize_task` arguments, keyed by the provider's call identity. */
export type NativeCompactionSummaryState = Readonly<Record<string, unknown>>

/** One streamed tool-call chunk, reduced to what a summary needs from it. */
export interface NativeCompactionToolCall {
    readonly functionId: string
    readonly name?: string
    readonly arguments?: unknown
    /** Providers stream argument deltas unless they declare complete snapshots. */
    readonly argumentsMode?: "delta" | "snapshot"
}

const SUMMARIZE_TOOL_NAME = "summarize_task"

/**
 * Folds a streamed tool call into the summary accumulated so far.
 *
 * A provider that supports native tools answers the compaction request with a
 * `summarize_task` call rather than XML prose, so the summary never appears in
 * the text channel. Accumulating by call identity keeps a delta-streamed
 * argument string whole, and ignores any other tool the model happens to emit.
 */
export function foldNativeCompactionSummary(
    state: NativeCompactionSummaryState,
    call: NativeCompactionToolCall,
): NativeCompactionSummaryState {
    if (call.name && call.name !== SUMMARIZE_TOOL_NAME) return state
    const previous = state[call.functionId]
    if (call.argumentsMode === "snapshot") return { ...state, [call.functionId]: call.arguments ?? previous ?? "" }
    if (typeof call.arguments === "string") {
        const base = typeof previous === "string" ? previous : ""
        return { ...state, [call.functionId]: `${base}${call.arguments}` }
    }
    if (call.arguments && typeof call.arguments === "object") {
        const base = previous && typeof previous === "object" ? previous : {}
        return { ...state, [call.functionId]: { ...base, ...call.arguments } }
    }
    return call.functionId in state ? state : { ...state, [call.functionId]: previous ?? "" }
}

/**
 * The summary text a completed native call carried, when one is usable.
 *
 * Returns undefined rather than an empty summary so the caller can fall back to
 * the text channel instead of compacting the conversation into nothing.
 */
export function readNativeCompactionSummary(state: NativeCompactionSummaryState): string | undefined {
    for (const value of Object.values(state)) {
        const context = readContext(value)
        if (context) return context
    }
    return undefined
}

function readContext(value: unknown): string | undefined {
    const record = typeof value === "string" ? parseJsonObject(value) : value
    if (!record || typeof record !== "object" || Array.isArray(record)) return undefined
    const context = (record as Record<string, unknown>).context
    if (typeof context !== "string") return undefined
    const trimmed = context.trim()
    return trimmed.length > 0 ? trimmed : undefined
}

function parseJsonObject(value: string): unknown {
    if (value.trim().length === 0) return undefined
    try {
        return JSON.parse(value)
    } catch {
        return undefined
    }
}
