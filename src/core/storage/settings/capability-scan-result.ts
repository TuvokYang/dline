/**
 * Outcome of one capability discovery pass.
 *
 * Discovery is the only source that can tell whether a stored preference still
 * refers to a resource that exists. Pruning an override is destructive, so the
 * decision must not rest on a scan that silently degraded: an unreadable
 * directory and a genuinely empty one produce the same list of resources but
 * carry opposite meanings.
 */
export interface CapabilityScanResult<T> {
    readonly items: readonly T[]
    /**
     * True only when every source directory was read without error.
     *
     * A single failed root turns the whole pass incomplete, because the caller
     * cannot tell which resources that root would have contributed.
     */
    readonly complete: boolean
}

export function completeScan<T>(items: readonly T[]): CapabilityScanResult<T> {
    return { items, complete: true }
}

export function incompleteScan<T>(items: readonly T[]): CapabilityScanResult<T> {
    return { items, complete: false }
}

/** Merge scan results from several roots; one incomplete root taints the whole. */
export function mergeScans<T>(results: readonly CapabilityScanResult<T>[]): CapabilityScanResult<T> {
    const items: T[] = []
    let complete = true
    for (const result of results) {
        items.push(...result.items)
        if (!result.complete) complete = false
    }
    return { items, complete }
}
