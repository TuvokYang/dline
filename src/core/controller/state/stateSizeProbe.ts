/**
 * Attributes an oversized state payload to the field that caused it.
 *
 * A 12.5 MB push logs only its total size, which says a payload is too large
 * but not which field made it so. Attribution otherwise means guessing from
 * feature history, and with several tasks broadcasting concurrently the guess
 * is what decides whether the fix targets the right field at all.
 */

/** Fields reported individually; everything else is summed as `other`. */
export interface FieldSize {
    field: string
    bytes: number
}

export interface StateSizeBreakdown {
    totalBytes: number
    /** Largest first, so the dominant contributor reads off the front. */
    fields: FieldSize[]
}

/**
 * Measures each top-level field of an already-serialized state object.
 *
 * Serializing per field costs roughly as much as serializing the whole state
 * again, so callers must gate this on a size threshold rather than run it on
 * every push. A field that cannot be serialized at all is reported as zero
 * rather than aborting the breakdown: a probe that throws on one bad field
 * would withhold the measurement of every other one.
 */
export function measureStateFieldSizes(state: object, totalBytes: number): StateSizeBreakdown {
    const fields: FieldSize[] = []

    for (const [field, value] of Object.entries(state)) {
        if (value === undefined) {
            continue
        }
        let bytes = 0
        try {
            bytes = Buffer.byteLength(JSON.stringify(value) ?? "", "utf8")
        } catch {
            // Cyclic or otherwise unserializable; the whole-state serialization
            // that produced totalBytes already succeeded, so this is the field's
            // own problem and must not hide the rest of the breakdown.
            bytes = 0
        }
        fields.push({ field, bytes })
    }

    fields.sort((left, right) => right.bytes - left.bytes)
    return { totalBytes, fields }
}

/**
 * Renders the breakdown as a single log line, keeping only the largest fields.
 *
 * The tail of a wide state object is noise once the dominant field is an order
 * of magnitude ahead, and a line listing every field would be unreadable in
 * the log it is meant to clarify.
 */
export function formatStateSizeBreakdown(breakdown: StateSizeBreakdown, topFieldCount = 5): string {
    const top = breakdown.fields.slice(0, topFieldCount)
    const rendered = top.map(({ field, bytes }) => `${field}=${bytes}`).join(" ")
    const remainderBytes = breakdown.fields.slice(topFieldCount).reduce((sum, entry) => sum + entry.bytes, 0)
    const remainder = remainderBytes > 0 ? ` other=${remainderBytes}` : ""
    return `totalBytes=${breakdown.totalBytes} ${rendered}${remainder}`
}
