import path from "node:path"

/**
 * Canonical locations of remote telemetry state below the Dline data root.
 *
 * Every remote telemetry module resolves its files through this layout, so
 * credentials, policy and spools stay machine-scoped and never drift into Task
 * storage, general state or settings.
 */
export interface OtelStorageLayout {
    /** Owner-only directory holding the device secret and its bearer tokens. */
    readonly secretsDir: string
    readonly deviceCredentialPath: string
    /** Owner-only issue diagnostic token plus revoke/expiry tombstone. */
    readonly issueGrantPath: string
    /** Owner-only Report Authorization ticket: authorization code, public code and server-reported state. */
    readonly issueCredentialPath: string
    /** Malformed credential documents, kept for diagnosis instead of being overwritten. */
    readonly secretsQuarantineDir: string
    readonly remoteDir: string
    readonly policyPath: string
    readonly remoteQuarantineDir: string
    readonly usageDir: string
    /** Process-sharded observation segments; each extension host appends only to its own. */
    readonly usageObservationsDir: string
    /** Per-process attempts inside their token finalization window, with persisted deadlines for restart recovery. */
    readonly usageFinalizationDir: string
    /** Sender lease, delivery gate, pending minutes and the inflight manifest, changed under one lock. */
    readonly usageOutboxPath: string
    /** Exact request bodies, named by request ID, so an unknown outcome replays the same bytes. */
    readonly usageInflightDir: string
    /** Issue-only logs, metrics and traces; never shares production or Usage queue state. */
    readonly issueDiagnosticsOutboxPath: string
}

export function resolveOtelStorageLayout(dataDir: string): OtelStorageLayout {
    const root = path.resolve(dataDir)
    const secretsDir = path.join(root, "secrets", "otel")
    const remoteDir = path.join(root, "telemetry", "remote")
    const usageDir = path.join(remoteDir, "usage")
    return {
        secretsDir,
        deviceCredentialPath: path.join(secretsDir, "device.json"),
        issueGrantPath: path.join(secretsDir, "issue-grant.json"),
        issueCredentialPath: path.join(secretsDir, "issue-credential.json"),
        secretsQuarantineDir: path.join(secretsDir, "quarantine"),
        remoteDir,
        policyPath: path.join(remoteDir, "policy.json"),
        remoteQuarantineDir: path.join(remoteDir, "quarantine"),
        usageDir,
        usageObservationsDir: path.join(usageDir, "observations"),
        usageFinalizationDir: path.join(usageDir, "finalization"),
        usageOutboxPath: path.join(usageDir, "outbox.json"),
        usageInflightDir: path.join(usageDir, "inflight"),
        issueDiagnosticsOutboxPath: path.join(remoteDir, "diagnostics", "issue-outbox.json"),
    }
}
