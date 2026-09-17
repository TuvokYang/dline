/**
 * Concurrency ceilings shared by the settings UI and the execution runtime.
 *
 * The bounds live here rather than beside either consumer because a limit that
 * the UI validates differently from the runtime is a limit the user cannot
 * trust. A persisted document, a remote configuration or an older build can all
 * supply a value outside the range, so the range is enforced on read instead of
 * only at the point of editing.
 */

/** Default and maximum number of tool calls executed at once. */
export const DEFAULT_MAX_PARALLEL_TOOL_CALLS = 32
export const MAX_PARALLEL_TOOL_CALLS = 32

/** Default and maximum number of subagents executed at once. */
export const DEFAULT_MAX_PARALLEL_SUBAGENTS = 64
export const MAX_PARALLEL_SUBAGENTS = 64

/** Lowest usable limit: one execution at a time, never zero. */
export const MIN_PARALLEL_EXECUTIONS = 1

/**
 * Largest batch a single `use_subagents` call may request.
 *
 * This bounds the shape of one request, not how much runs at once, and the two
 * are set independently: how many items a call may describe is a prompt and
 * payload concern, while how many execute together is `maxParallelSubagents`.
 * A batch may therefore be accepted in full and still queue.
 */
export const MAX_SUBAGENTS_PER_BATCH = 32

/**
 * Clamp a configured limit into a usable range.
 *
 * @param value Configured value, possibly absent, fractional or out of range.
 * @param maximum Upper bound for this particular pool.
 * @param fallback Value to use when nothing usable was configured.
 * @returns An integer in `[MIN_PARALLEL_EXECUTIONS, maximum]`.
 */
function clampLimit(value: number | undefined, maximum: number, fallback: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) {
		return fallback
	}
	// Truncating rather than rounding keeps a fractional value from exceeding a
	// ceiling the user explicitly set.
	const whole = Math.trunc(value)
	if (whole < MIN_PARALLEL_EXECUTIONS) {
		return MIN_PARALLEL_EXECUTIONS
	}
	return Math.min(whole, maximum)
}

/**
 * Resolve the effective tool-call concurrency limit.
 *
 * @param configured Persisted `maxParallelToolCalls`.
 * @param parallelToolCallingEnabled Whether parallel tool calling is on.
 * @returns 1 when parallel tool calling is disabled, otherwise the clamped limit.
 */
export function resolveMaxParallelToolCalls(configured: number | undefined, parallelToolCallingEnabled: boolean): number {
	if (!parallelToolCallingEnabled) {
		// The toggle is the stronger statement: turning parallel tool calling
		// off must produce serial execution regardless of the stored ceiling,
		// so the ceiling is not silently restored when the toggle comes back.
		return MIN_PARALLEL_EXECUTIONS
	}
	return clampLimit(configured, MAX_PARALLEL_TOOL_CALLS, DEFAULT_MAX_PARALLEL_TOOL_CALLS)
}

/**
 * Resolve the effective subagent concurrency limit.
 *
 * Deliberately independent of the tool-call toggle and limit: subagents are
 * throttled to protect provider capacity, which is a different resource from
 * the local ones tool calls contend for.
 *
 * @param configured Persisted `maxParallelSubagents`.
 * @returns The clamped limit.
 */
export function resolveMaxParallelSubagents(configured: number | undefined): number {
	return clampLimit(configured, MAX_PARALLEL_SUBAGENTS, DEFAULT_MAX_PARALLEL_SUBAGENTS)
}
