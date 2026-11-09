/**
 * One-time hand-off from the old per-Profile daily ledger to the unified usage table.
 *
 * The old ledger stored an *inclusive* daily total: its `inputTokens` already contains
 * whatever was cached. The unified table stores fresh input plus the cache segments
 * separately, so copying the old number into `inputTokens` would count the cached part
 * twice. The migration therefore freezes the old number as a legacy baseline instead of
 * inventing a split, and the reader that needs "today" adds that baseline explicitly.
 *
 * The baseline and its marker commit together: a marker without numbers would claim the
 * import happened while losing what it preserved, and numbers without a marker would be
 * imported a second time on the next start.
 */

import type { MetricsRepository } from "./MetricsRepository"

/** One Profile's frozen daily total, as the old ledger recorded it. */
export interface LegacyDailyEntry {
    readonly profileId: string
    /** Local calendar day, `YYYY-MM-DD`. */
    readonly day: string
    /** Inclusive input total; it is not fresh input. */
    readonly inputTokens: number
    readonly outputTokens: number
}

/** Reads the old ledger. Returns what is stored, and nothing if the ledger is absent. */
export interface LegacyDailySource {
    read(): Promise<readonly LegacyDailyEntry[]>
}

export interface MigrationResult {
    readonly migrated: number
    readonly skipped: number
    /** True when the marker already existed, so nothing was written. */
    readonly alreadyMigrated: boolean
}

/** The subject key a Profile's legacy baseline is stored under. */
export function legacySubjectKey(profileId: string, day: string): string {
    // `::` rather than NUL: SQLite truncates a TEXT value at U+0000, which would merge
    // every day of one Profile into a single baseline.
    return `${profileId}::${day}`
}

/**
 * Import every legacy day once.
 *
 * A day already carrying a baseline is skipped rather than re-imported, so a restart, a
 * crashed migration or a double invocation cannot double-count.
 */
export async function migrateLegacyDailyUsage(options: {
    readonly source: LegacyDailySource
    readonly repository: MetricsRepository
}): Promise<MigrationResult> {
    const entries = await options.source.read()
    if (entries.length === 0) return { migrated: 0, skipped: 0, alreadyMigrated: false }

    let migrated = 0
    let skipped = 0
    for (const entry of entries) {
        const subjectKey = legacySubjectKey(entry.profileId, entry.day)
        // The marker decides, not the baseline. A cleared scope keeps the marker and
        // drops the numbers, so asking for the numbers would write the cleared usage
        // back on the next run — the one thing a clear must prevent.
        const alreadyImported = await options.repository.hasLegacyImport(subjectKey)
        if (alreadyImported) {
            skipped += 1
            continue
        }
        await options.repository.recordLegacyImport({
            subjectKey,
            inputTokens: entry.inputTokens,
            outputTokens: entry.outputTokens,
        })
        migrated += 1
    }
    return { migrated, skipped, alreadyMigrated: migrated === 0 && entries.length > 0 }
}
