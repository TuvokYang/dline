/**
 * Read the newest groups of a window without letting a group's revision count
 * shrink the covered history.
 *
 * A row cap cannot express "how many rounds do I want": a round owns several
 * revisions, so a fixed physical-row bound covers fewer rounds as revisions grow.
 * The scan therefore starts at the group budget and only widens when the slice it
 * read was saturated with fewer groups than requested. Each widening is one more
 * indexed query, so the total stays logarithmic in the revision density instead of
 * re-ranking the window per page.
 */
export interface NewestGroupScanRow<TRow> {
    readonly rows: readonly TRow[]
    /** True when the scan reached the window edge instead of stopping at a cap. */
    readonly reachedWindowStart: boolean
}

export interface NewestGroupScanOptions<TRow> {
    /** Groups the caller wants to keep, counted after de-duplication. */
    readonly targetGroups: number
    /** Hard ceiling on physical rows this scan may materialize, across every widening. */
    readonly maxScanRows: number
    /** Fetch up to `limit` rows, newest first, with the rows' own ordering applied. */
    fetch(limit: number): Promise<TRow[]>
    /** Identity of the group a row belongs to; typically the round or execution id. */
    keyOf(row: TRow): string
}

export async function scanNewestGroups<TRow>(options: NewestGroupScanOptions<TRow>): Promise<NewestGroupScanRow<TRow>> {
    if (!Number.isSafeInteger(options.targetGroups) || options.targetGroups < 1) {
        throw new Error("Newest group scan requires a positive integer group target")
    }
    let scanRows = Math.min(options.targetGroups, options.maxScanRows)
    while (true) {
        const rows = await options.fetch(scanRows)
        // A short page means the window held no more rows, so the newest slice is
        // the whole window and no widening can add groups.
        const reachedWindowStart = rows.length < scanRows
        const groups = new Set(rows.map((row) => options.keyOf(row))).size
        if (reachedWindowStart || groups >= options.targetGroups || scanRows >= options.maxScanRows) {
            return { rows, reachedWindowStart }
        }
        scanRows = Math.min(scanRows * 2, options.maxScanRows)
    }
}
