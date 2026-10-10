import { randomInt, timingSafeEqual } from "node:crypto"

/**
 * One-time pairing between this extension host session and a local collector.
 *
 * Runtime telemetry is only useful when something outside the extension can
 * read it, but an always-open local endpoint would let any process on the
 * machine claim a developer's diagnostic stream. A short-lived code the user
 * copies deliberately keeps the decision with the user.
 *
 * The code is not a credential for anything else: it authorizes one collector
 * to attach, is valid once, and expires on its own.
 */

/** Characters that survive being read aloud and retyped. */
const CODE_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"
const GROUP_LENGTH = 4
const DEFAULT_TTL_MS = 5 * 60 * 1000

export enum PairingRejection {
    /** No code is active, or the supplied value does not match the active one. */
    Unknown = "unknown",
    /** The active code passed its expiry. */
    Expired = "expired",
    /** The active code was already exchanged for a pairing. */
    AlreadyRedeemed = "already_redeemed",
}

export interface IssuedPairingCode {
    readonly code: string
    readonly issuedAt: number
    readonly expiresAt: number
}

export interface PairingStatus {
    /** Whether a code is waiting to be redeemed. Never the code itself. */
    readonly hasPendingCode: boolean
    /** When the pending code stops being accepted. */
    readonly expiresAt?: number
    /** When a collector successfully paired, if one did. */
    readonly pairedAt?: number
}

export interface PairingAuthorizationOptions {
    readonly ttlMs?: number
    /** Wall clock, injectable so expiry can be tested without waiting. */
    readonly now?: () => number
}

interface PendingCode {
    readonly value: string
    readonly expiresAt: number
    redeemed: boolean
}

function generateGroup(): string {
    let group = ""
    for (let index = 0; index < GROUP_LENGTH; index++) {
        group += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)]
    }
    return group
}

/**
 * Compare without leaking how many characters matched.
 *
 * The code is short and guessable by brute force only if an attacker can also
 * measure comparison time, so the constant-time path costs nothing and closes
 * that door.
 */
function matches(expected: string, supplied: string): boolean {
    const expectedBytes = Buffer.from(expected, "utf8")
    const suppliedBytes = Buffer.from(supplied, "utf8")
    if (expectedBytes.length !== suppliedBytes.length) return false
    return timingSafeEqual(expectedBytes, suppliedBytes)
}

function normalize(code: string): string {
    return code.trim().toUpperCase()
}

export class PairingAuthorization {
    private readonly ttlMs: number
    private readonly now: () => number

    private pending: PendingCode | undefined
    private pairedAt: number | undefined

    constructor(options: PairingAuthorizationOptions = {}) {
        this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS
        this.now = options.now ?? (() => Date.now())
    }

    get status(): PairingStatus {
        const pending = this.pending
        return {
            hasPendingCode: pending !== undefined && !pending.redeemed && pending.expiresAt > this.now(),
            expiresAt: pending?.expiresAt,
            pairedAt: this.pairedAt,
        }
    }

    /**
     * Produce a fresh code, invalidating any earlier one.
     *
     * Replacing rather than accumulating means a user who clicks twice cannot
     * accidentally leave an older code usable.
     */
    issue(): IssuedPairingCode {
        const issuedAt = this.now()
        const value = `${generateGroup()}-${generateGroup()}`
        this.pending = { value, expiresAt: issuedAt + this.ttlMs, redeemed: false }
        return { code: value, issuedAt, expiresAt: this.pending.expiresAt }
    }

    /** Exchange a code for a pairing. Returns the rejection reason, if any. */
    redeem(code: string): PairingRejection | undefined {
        const pending = this.pending
        if (!pending) return PairingRejection.Unknown
        if (!matches(pending.value, normalize(code))) return PairingRejection.Unknown
        if (pending.redeemed) return PairingRejection.AlreadyRedeemed
        if (pending.expiresAt <= this.now()) return PairingRejection.Expired

        pending.redeemed = true
        this.pairedAt = this.now()
        return undefined
    }

    /** Drop the pairing and any pending code. */
    revoke(): void {
        this.pending = undefined
        this.pairedAt = undefined
    }
}
