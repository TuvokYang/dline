/** Per-Pass compaction phase timings used for diagnostics and performance regression gates. */
export interface ContextCompactionPhaseTiming {
    operationId: string
    passIndex: number
    boundaryProjectionMs: number
    logicalTurnIndexMs: number
    plannerMs: number
    candidateEstimateCount: number
    requestBuildMs: number
    providerTtfbMs: number
    streamMs: number
    reprojectionMs: number
}

/** Provider-facing timing captured through accepted summary completion. */
export interface InternalCompactionProviderTiming {
    providerTtfbMs: number
    streamMs: number
}

export function elapsedCompactionMs(startedAtMs: number, completedAtMs = performance.now()): number {
    return Math.max(0, Math.round(completedAtMs - startedAtMs))
}
