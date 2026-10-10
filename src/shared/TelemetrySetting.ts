/**
 * A reporting consent: not yet answered, granted, or refused.
 *
 * `unset` is distinct from `disabled`: nothing is reported in either case, but
 * only `unset` means the user has still to be asked.
 */
export type TelemetrySetting = "unset" | "enabled" | "disabled"

/**
 * Usage and error reporting are separate consents.
 *
 * They were once a single switch, which forced a user who wanted to report
 * crashes to also accept product analytics. The two answer different questions
 * and are stored, gated and transported independently.
 */
export interface ReportingConsents {
    /** Product analytics events and metrics. */
    readonly usage: TelemetrySetting
    /** Crash, exception, and local runtime diagnostic signals. */
    readonly error: TelemetrySetting
}

export function isReportingAllowed(setting: TelemetrySetting): boolean {
    return setting === "enabled"
}
