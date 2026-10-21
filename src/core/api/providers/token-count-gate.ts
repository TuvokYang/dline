import { Logger } from "@/shared/services/Logger"

/** Statuses that mean the endpoint has no token-counting route at all. */
const ROUTE_ABSENT_STATUSES: ReadonlySet<number> = new Set([404, 405])

/**
 * Guards one handler's official token counting.
 *
 * Many compatible endpoints serve the generation route but not the counting
 * route. A 404 or 405 answer means the route is absent, so every later count
 * would fail the same way and only add a round trip and a warning. A handler
 * serves one profile and model, so the gate lives with the handler: after such
 * an answer it stops counting and callers fall back to their estimate. Any
 * other failure leaves the gate open, since it may be transient.
 */
export class TokenCountGate {
    private routeAbsent = false

    constructor(private readonly provider: string) {}

    /** Run one count, or return undefined without a request once the route is known absent. */
    async count(attempt: () => Promise<number | undefined>): Promise<number | undefined> {
        if (this.routeAbsent) return undefined
        try {
            return await attempt()
        } catch (error) {
            const status = httpStatusOf(error)
            if (status !== undefined && ROUTE_ABSENT_STATUSES.has(status)) {
                this.routeAbsent = true
                Logger.warn(`${this.provider} token counting is not available at this endpoint (HTTP ${status}); using estimates`)
            } else {
                Logger.warn(`${this.provider} token counting failed`, error)
            }
            return undefined
        }
    }
}

/** HTTP status an SDK error carries as a field; message text is not parsed. */
function httpStatusOf(error: unknown): number | undefined {
    if (typeof error !== "object" || error === null) return undefined
    const { status, statusCode } = error as { status?: unknown; statusCode?: unknown }
    const value = typeof status === "number" ? status : statusCode
    return typeof value === "number" && Number.isInteger(value) ? value : undefined
}
