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
}

export function resolveOtelStorageLayout(dataDir: string): OtelStorageLayout {
    const root = path.resolve(dataDir)
    const secretsDir = path.join(root, "secrets", "otel")
    const remoteDir = path.join(root, "telemetry", "remote")
    return {
        secretsDir,
        deviceCredentialPath: path.join(secretsDir, "device.json"),
        secretsQuarantineDir: path.join(secretsDir, "quarantine"),
        remoteDir,
        policyPath: path.join(remoteDir, "policy.json"),
        remoteQuarantineDir: path.join(remoteDir, "quarantine"),
        usageDir: path.join(remoteDir, "usage"),
    }
}
