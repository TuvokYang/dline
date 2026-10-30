import type { ApiProviderStreamChunk } from "@/core/api/transform/stream"

/**
 * Forwards one Provider attempt's chunks to the caller, buffering the chunks
 * that commit the attempt until the response is known to be replayable.
 *
 * A native `tool_calls` delta and a `usage` snapshot have side effects only once
 * the whole response is final, so they stay buffered until either the stream
 * ends or an unreplayable chunk is forwarded. Reasoning and whitespace-only text
 * are replayable scaffolding and pass through immediately.
 */

/** Attempt-local accounting and native tool deltas are committed only at EOF or on commit. */
export function isAttemptCommitChunk(
    chunk: ApiProviderStreamChunk,
): chunk is Extract<ApiProviderStreamChunk, { type: "usage" | "tool_calls" }> {
    return chunk.type === "usage" || chunk.type === "tool_calls"
}

/**
 * What this classifier reads: a chunk's kind, and the text of a text chunk.
 *
 * Declaring the minimum keeps the rule usable from callers that only hold a
 * kind, without letting them pretend to hold a full Provider payload.
 */
export interface ReplayabilityInput {
    readonly type: ApiProviderStreamChunk["type"]
    readonly text?: string
}

/**
 * Whether forwarding this chunk makes the attempt unreplayable.
 *
 * Treating every non-usage chunk as observable disabled the whole backoff
 * sequence for adaptive-thinking models, because the scaffolding always precedes
 * the failure.
 */
export function producesUnreplayableOutput(chunk: ReplayabilityInput): boolean {
    switch (chunk.type) {
        // Attempt-local accounting and native tool deltas are committed only after EOF.
        case "usage":
        case "tool_calls":
            return false
        // Forwarded to progress only and never written back into the conversation.
        case "reasoning":
            return false
        // Whitespace-only text is a block separator, not an answer.
        case "text":
            return (chunk.text ?? "").trim().length > 0
        // A hosted tool lifecycle is observable from its first phase: the started event is
        // already forwarded to progress and counted in the tool-call stats, so replaying the
        // attempt would duplicate both the rendered row and the count.
        case "server_tool":
            return true
    }
}

/**
 * Forward one attempt, then delegate the rest of the stream.
 *
 * The iterator is owned here, so this generator must close it on every exit: the
 * decorated stream above it commits accumulated Provider usage in its own
 * `finally`, and a generator that is abandoned without `return()` never runs it.
 * Delegation is guarded so the delegated range is not closed twice.
 */
export async function* forwardProviderAttempt(
    iterator: AsyncIterator<ApiProviderStreamChunk>,
): AsyncGenerator<ApiProviderStreamChunk> {
    const bufferedCommitChunks: Array<Extract<ApiProviderStreamChunk, { type: "usage" | "tool_calls" }>> = []
    let delegated = false
    try {
        while (true) {
            const nextChunk = await iterator.next()
            if (nextChunk.done) {
                for (const bufferedChunk of bufferedCommitChunks) yield bufferedChunk
                return
            }
            if (isAttemptCommitChunk(nextChunk.value)) {
                bufferedCommitChunks.push(nextChunk.value)
                continue
            }
            if (!producesUnreplayableOutput(nextChunk.value)) {
                yield nextChunk.value
                continue
            }

            for (const bufferedChunk of bufferedCommitChunks) yield bufferedChunk
            yield nextChunk.value
            delegated = true
            yield* { [Symbol.asyncIterator]: () => iterator }
            return
        }
    } finally {
        // `yield*` closes the iterator it delegates to; the ranges before it do not.
        if (!delegated) await closeQuietly(iterator)
    }
}

/**
 * Close an iterator this generator owns.
 *
 * The closing step is the only thing that runs the Provider wrapper's own
 * `finally`, which is where an interrupted send commits its usage. A stream that
 * fails to close must not replace the failure that already ended the run.
 */
async function closeQuietly(iterator: AsyncIterator<ApiProviderStreamChunk>): Promise<void> {
    try {
        await iterator.return?.(undefined)
    } catch {
        // Closing is best effort: the run has already ended for another reason.
    }
}
