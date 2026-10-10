/**
 * TelemetryAuthorizationStore — dedicated storage for the runtime telemetry
 * one-time client pairing credential (WS-017 AC-002 / AC-003).
 *
 * The pairing code is deliberately kept out of the general secrets store,
 * settings, ExtensionState, remote config, logs, journals and export bundles.
 * Only an irreversible fingerprint plus creation time are ever projected to
 * the UI. The current local OTLP transport never reads the code; it exists so
 * a future HTTPS transport can exchange it once for a remote access credential.
 */
import { createHash, randomBytes } from "node:crypto"
import path from "node:path"
import { ClineFileStorage } from "@shared/storage/ClineFileStorage"
import { getDlineDataDir } from "../disk"

const CREDENTIAL_FILE = "telemetry-authorization.json"
const CREDENTIAL_KEY = "pairingCredential"
const CODE_BYTE_LENGTH = 32
const FINGERPRINT_LENGTH = 12

/** Persisted shape of the one-time pairing credential. */
export interface RuntimeTelemetryPairingCredential {
    readonly schemaVersion: 1
    readonly code: string
    readonly createdAtMs: number
    readonly state: "unclaimed"
}

/** Public projection safe to expose to the webview and diagnostics. */
export interface RuntimeTelemetryAuthorizationStatus {
    readonly authorizationCodeConfigured: boolean
    readonly createdAtMs?: number
    readonly fingerprint?: string
}

export interface TelemetryAuthorizationStoreOptions {
    /** Overrides the Dline data directory. Tests use a temporary directory. */
    readonly dataDir?: string
    /** Injectable clock for deterministic tests. */
    readonly now?: () => number
}

function isPairingCredential(value: unknown): value is RuntimeTelemetryPairingCredential {
    if (typeof value !== "object" || value === null) {
        return false
    }
    const record = value as Record<string, unknown>
    return (
        record.schemaVersion === 1 &&
        typeof record.code === "string" &&
        record.code.length > 0 &&
        typeof record.createdAtMs === "number" &&
        Number.isFinite(record.createdAtMs) &&
        record.state === "unclaimed"
    )
}

export class TelemetryAuthorizationStore {
    private readonly storage: ClineFileStorage<RuntimeTelemetryPairingCredential>
    private readonly now: () => number

    constructor(options: TelemetryAuthorizationStoreOptions = {}) {
        const dataDir = options.dataDir ?? getDlineDataDir()
        this.storage = new ClineFileStorage<RuntimeTelemetryPairingCredential>(
            path.join(dataDir, "secrets", CREDENTIAL_FILE),
            "TelemetryAuthorizationStore",
            { fileMode: 0o600 },
        )
        this.now = options.now ?? Date.now
    }

    /**
     * Returns the current unclaimed credential, issuing one when telemetry is
     * enabled for the first time or after a revoke. Reloads reuse the existing
     * code so the pairing target does not rotate on every extension start.
     */
    ensurePairingCode(): RuntimeTelemetryPairingCredential {
        const existing = this.peekPairingCode()
        if (existing) {
            return existing
        }

        const credential: RuntimeTelemetryPairingCredential = {
            schemaVersion: 1,
            code: randomBytes(CODE_BYTE_LENGTH).toString("base64url"),
            createdAtMs: this.now(),
            state: "unclaimed",
        }
        this.storage.set(CREDENTIAL_KEY, credential)
        return credential
    }

    /** Returns the stored credential without consuming it, or undefined. */
    peekPairingCode(): RuntimeTelemetryPairingCredential | undefined {
        const stored = this.storage.get(CREDENTIAL_KEY)
        if (isPairingCredential(stored)) {
            return stored
        }
        if (stored !== undefined) {
            // Unreadable or hand-edited content is discarded rather than trusted.
            this.storage.delete(CREDENTIAL_KEY)
        }
        return undefined
    }

    /**
     * Hands the code to a future remote exchange exactly once. The credential is
     * deleted immediately so it can never be replayed as a long-lived bearer token.
     */
    consumePairingCode(): string | undefined {
        const credential = this.peekPairingCode()
        if (!credential) {
            return undefined
        }
        this.storage.delete(CREDENTIAL_KEY)
        return credential.code
    }

    /** Drops an unclaimed code, used when the user disables telemetry. */
    revokePairingCode(): void {
        this.storage.delete(CREDENTIAL_KEY)
    }

    /** Projection safe for the webview: presence, creation time, fingerprint. */
    getStatus(): RuntimeTelemetryAuthorizationStatus {
        const credential = this.peekPairingCode()
        if (!credential) {
            return { authorizationCodeConfigured: false }
        }
        return {
            authorizationCodeConfigured: true,
            createdAtMs: credential.createdAtMs,
            fingerprint: fingerprintPairingCode(credential.code),
        }
    }
}

/** Irreversible short fingerprint used for support conversations and UI. */
export function fingerprintPairingCode(code: string): string {
    return createHash("sha256").update(code).digest("hex").slice(0, FINGERPRINT_LENGTH)
}
