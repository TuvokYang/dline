interface ActivityRecord {
    signals?: readonly string[]
}

/** Count canonical API seconds independently from production metrics code. */
export function countApiSeconds(records: readonly ActivityRecord[]): number {
    const apiSignals = new Set(["provider_active", "request_start", "stream_tokens", "exact_usage"])
    return records.filter((record) => record.signals?.some((signal) => apiSignals.has(signal))).length
}
