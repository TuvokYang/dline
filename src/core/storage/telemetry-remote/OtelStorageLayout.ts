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
    /** Malformed credential documents, kept for diagnosis instead of being overwritten. */
    readonly secretsQuarantineDir: string
    readonly remoteDir: string
    readonly policyPath: string
    readonly remoteQuarantineDir: string
    readonly usageDir: string
    /** Process-sharded observation segments; each extension host appends only to its own. */
    readonly usageObservationsDir: string
    /** Sender lease, delivery gate, pending minutes and the inflight manifest, changed under one lock. */
    readonly usageOutboxPath: string
    /** Exact request bodies, named by request ID, so an unknown outcome replays the same bytes. */
    readonly usageInflightDir: string
}

export function resolveOtelStorageLayout(dataDir: string): OtelStorageLayout {
    const root = path.resolve(dataDir)
    const secretsDir = path.join(root, "secrets", "otel")
    const remoteDir = path.join(root, "telemetry", "remote")
    const usageDir = path.join(remoteDir, "usage")
    return {
        secretsDir,
        deviceCredentialPath: path.join(secretsDir, "device.json"),
        secretsQuarantineDir: path.join(secretsDir, "quarantine"),
        remoteDir,
        policyPath: path.join(remoteDir, "policy.json"),
        remoteQuarantineDir: path.join(remoteDir, "quarantine"),
        usageDir,
        usageObservationsDir: path.join(usageDir, "observations"),
        usageOutboxPath: path.join(usageDir, "outbox.json"),
        usageInflightDir: path.join(usageDir, "inflight"),
    }
}
