let processSessionId: string | undefined

/** Stable identity shared by every telemetry signal kind in one extension-host process. */
export function getProcessTelemetrySessionId(now: Date = new Date()): string {
    if (!processSessionId) {
        const stamp = now.toISOString().replaceAll(/[:.]/g, "-")
        const suffix = Math.random().toString(36).slice(2, 8)
        processSessionId = `${stamp}-${suffix}`
    }
    return processSessionId
}

export function resetProcessTelemetrySessionIdForTesting(): void {
    processSessionId = undefined
}
