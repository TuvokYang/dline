/**
 * Expected cancellation: work that stopped because the user, the task or the
 * host asked it to, not because something broke. Observability reports it as a
 * cancelled outcome and never as a failure.
 */

/** Names the platform, VS Code and provider SDKs give an aborted operation. */
const CANCELLATION_ERROR_NAMES: ReadonlySet<string> = new Set(["AbortError", "CanceledError", "APIUserAbortError", "Canceled"])

/** Registered globally so every bundle that loads this module reads the same brand. */
const EXPECTED_CANCELLATION = Symbol.for("dline.expectedCancellation")

/**
 * Brand an error class as expected cancellation. Every instance of it, and of
 * its subclasses, then classifies as one regardless of its message.
 */
export function markExpectedCancellation(errorClass: abstract new (...args: never[]) => Error): void {
    Object.defineProperty(errorClass.prototype, EXPECTED_CANCELLATION, { value: true })
}

/** Whether an unknown failure is an expected cancellation rather than a fault. */
export function isExpectedCancellation(error: unknown): error is Error {
    if (!(error instanceof Error)) return false
    if ((error as Error & { [EXPECTED_CANCELLATION]?: unknown })[EXPECTED_CANCELLATION] === true) return true
    return CANCELLATION_ERROR_NAMES.has(error.name)
}

/** Whether the failure carries one of the abort names, as opposed to a branded lifecycle cancellation. */
export function isAbortNamedError(error: unknown): error is Error {
    return error instanceof Error && CANCELLATION_ERROR_NAMES.has(error.name)
}
