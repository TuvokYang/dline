/** The report form and the private status link must name the same repository. */
export const REPORT_ISSUE_OWNER = "TuvokYang"
export const REPORT_ISSUE_REPOSITORY = "dline"

/** Accept only a canonical HTTPS Issue URL, never an arbitrary external target. */
export function isReportIssueUrl(value: unknown): value is string {
    if (typeof value !== "string" || value.length > 256) return false
    try {
        const url = new URL(value)
        if (
            url.href !== value ||
            url.protocol !== "https:" ||
            url.hostname !== "github.com" ||
            url.username ||
            url.password ||
            url.port ||
            url.search ||
            url.hash
        )
            return false
        const match = /^\/([^/]+)\/([^/]+)\/issues\/([1-9][0-9]*)$/u.exec(url.pathname)
        if (
            !match ||
            match[1].toLowerCase() !== REPORT_ISSUE_OWNER.toLowerCase() ||
            match[2].toLowerCase() !== REPORT_ISSUE_REPOSITORY.toLowerCase()
        )
            return false
        const number = Number(match[3])
        return Number.isSafeInteger(number) && number > 0 && String(number) === match[3]
    } catch {
        return false
    }
}
