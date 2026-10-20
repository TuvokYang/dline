/**
 * Describe why a connection to an MCP server failed, for the server's error row.
 *
 * Node's fetch reports every network failure as "fetch failed" and keeps the
 * reason (refused, reset, unknown host) in `cause`; without it the row cannot
 * tell a server that is down from one that answered with an error.
 */
export function describeMcpConnectionError(error: unknown): string {
    if (!(error instanceof Error)) return String(error)
    const reason = describeCause(error.cause)
    return reason && !error.message.includes(reason) ? `${error.message}: ${reason}` : error.message
}

function describeCause(cause: unknown): string | undefined {
    if (!(cause instanceof Error)) return undefined
    const code = (cause as NodeJS.ErrnoException).code
    // A host that resolves to several addresses fails with one error per address.
    const first = cause instanceof AggregateError ? cause.errors.find((entry) => entry instanceof Error) : undefined
    const message = cause.message || (first instanceof Error ? first.message : "")
    if (!message) return code
    return code && !message.includes(code) ? `${code}: ${message}` : message
}
