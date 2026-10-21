/**
 * Call-site identity of a failure.
 *
 * A bundled build compiles every module into one file, so an error's source
 * frame names that file and nothing more, and errors without a code or status
 * all share one fingerprint. A site names where a failure was caught, from a
 * fixed catalog, so failures group by cause and the identity can leave the
 * device without carrying a path.
 *
 * Each value is `area.operation` in lowercase with underscores, at most 64
 * characters.
 */
export const DIAGNOSTIC_SITES = ["ripgrep.search", "task_history.update", "mcp.connect"] as const

export type DiagnosticSite = (typeof DIAGNOSTIC_SITES)[number]

const CATALOG: ReadonlySet<string> = new Set(DIAGNOSTIC_SITES)

/** Weak, so tagging a caught error never extends its lifetime and never mutates it. */
const sitesByError = new WeakMap<object, DiagnosticSite>()

/**
 * Record where an error was caught and return it, so a catch block can tag and
 * log in one expression. The first site recorded wins: the innermost catch is
 * the most specific.
 */
export function withDiagnosticSite<T>(error: T, site: DiagnosticSite): T {
    if (typeof error === "object" && error !== null && !sitesByError.has(error)) sitesByError.set(error, site)
    return error
}

/** The site recorded for an error, if any. */
export function diagnosticSiteOf(error: unknown): DiagnosticSite | undefined {
    return typeof error === "object" && error !== null ? sitesByError.get(error) : undefined
}

/** Whether a value is a catalog site, for a site read back from a record. */
export function isDiagnosticSite(value: unknown): value is DiagnosticSite {
    return typeof value === "string" && CATALOG.has(value)
}
