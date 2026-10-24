import { randomBytes } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { removeStaleAtomicTempFiles, writeJsonAtomic } from "@shared/storage/atomic-file"
import {
    type AtomicDeviceGrant,
    parseAtomicDeviceGrant,
    sameAtomicDeviceGrant,
    serializeAtomicDeviceGrant,
    validateAtomicDeviceGrant,
} from "@/services/telemetry/remote/contracts/deviceGrant"
import type { RemoteProfile } from "@/services/telemetry/remote/contracts/wire"
import { FileLock } from "../backend/jsonl/FileLock"
import type { OtelStorageLayout } from "./OtelStorageLayout"
import { OWNER_ONLY_DIRECTORY_MODE, purgeQuarantine, type QuarantineObserver, quarantineDocument } from "./quarantine"

export const DEVICE_CREDENTIAL_SCHEMA_VERSION = 1
const CREDENTIAL_FILE_MODE = 0o600
const DEVICE_SECRET_BYTES = 32
const BASE64URL_43_PATTERN = /^[A-Za-z0-9_-]{43}$/
const MAX_DEVICE_ID_LENGTH = 128
const REMOTE_PROFILES: readonly RemoteProfile[] = ["usage", "production", "development"]
/**
 * Credential writes are rare but every window may start at once after an update;
 * about five seconds of 100 ms attempts lets them queue instead of failing.
 */
const LOCK_ACQUIRE_ATTEMPTS = 50
const KNOWN_DOCUMENT_KEYS = new Set([
    "schema_version",
    "device_secret",
    "created_at",
    "generation",
    "tokens",
    "grants",
    "enrollment",
    "refresh_claim",
])

/** A bearer token the service issued for one profile of this device. */
export interface StoredDeviceToken {
    readonly accessToken: string
    readonly deviceId: string
    /** Server epoch milliseconds. */
    readonly expiresAt: number
    /** Local epoch milliseconds when the exchange returned. */
    readonly obtainedAt: number
}

/** Machine-wide wait after the service refused an enrollment; the refusal holds the whole machine, so every instance honours it. */
export interface EnrollmentBackoff {
    readonly notBefore: number
    readonly consecutiveFailures: number
}

/** One instance announcing it is exchanging a token, so the others wait instead of spending enrollment budget. */
export interface RefreshClaim {
    readonly ownerId: string
    readonly profile: RemoteProfile
    readonly expiresAt: number
}

export interface DeviceCredentialState {
    readonly tokens: Readonly<Partial<Record<RemoteProfile, StoredDeviceToken>>>
    /** Omitted by legacy token-only mutations; the repository preserves only grants still matching their token projection. */
    readonly grants?: Readonly<Partial<Record<RemoteProfile, AtomicDeviceGrant>>>
    readonly enrollment?: EnrollmentBackoff
    readonly refreshClaim?: RefreshClaim
}

export interface DeviceCredentialDocument extends DeviceCredentialState {
    readonly grants: Readonly<Partial<Record<RemoteProfile, AtomicDeviceGrant>>>
    readonly deviceSecret: string
    readonly createdAt: number
    /** Increases on every write, so a caller can tell whether the document changed since it read it. */
    readonly generation: number
}

export type DeviceCredentialReadResult =
    | { readonly status: "valid"; readonly document: DeviceCredentialDocument }
    | { readonly status: "missing" }
    | { readonly status: "malformed" }
    /** Written by a newer Dline; left untouched, and remote delivery stays off rather than downgrading it. */
    | { readonly status: "unsupported" }

export type DeviceCredentialEnsureResult =
    | { readonly status: "valid"; readonly document: DeviceCredentialDocument }
    | { readonly status: "unsupported" }

export type DeviceCredentialMutateResult<T> =
    | { readonly status: "valid"; readonly document: DeviceCredentialDocument; readonly value: T }
    | { readonly status: "missing" }
    | { readonly status: "unsupported" }

/** What a mutation decided after seeing the latest document; omit `next` to leave the document unchanged. */
export interface DeviceCredentialDecision<T> {
    readonly next?: DeviceCredentialState
    readonly value: T
}

export interface DeviceCredentialRepositoryOptions {
    readonly clock?: () => number
    /** Told when an unreadable credential document was moved aside; the device enrolls again. */
    readonly onQuarantine?: QuarantineObserver
}

type ValidParsedDocument = {
    readonly status: "valid"
    readonly document: DeviceCredentialDocument
    readonly raw: Record<string, unknown>
}
type ParsedDocument = ValidParsedDocument | { readonly status: "malformed" } | { readonly status: "unsupported" }
/** What a locked writer sees: an unreadable document has already been quarantined and reads as missing. */
type LatestDocument = ValidParsedDocument | { readonly status: "missing" } | { readonly status: "unsupported" }

/**
 * Owner of the machine's remote telemetry device secret and its bearer tokens.
 *
 * Every VS Code window on the machine shares one document: an exchange may
 * retire tokens issued earlier for the same device, so per-window credentials
 * would revoke each other. Writes run under a short
 * cross-process lock that never spans network I/O; callers re-read the latest
 * document inside {@link mutate} and decide from it, which makes every write a
 * compare-and-swap against what another window may have stored meanwhile.
 */
export class DeviceCredentialRepository {
    private readonly lock = new FileLock({ maxAcquireAttempts: LOCK_ACQUIRE_ATTEMPTS })
    private readonly clock: () => number
    private readonly onQuarantine: QuarantineObserver | undefined

    constructor(
        private readonly layout: OtelStorageLayout,
        options: DeviceCredentialRepositoryOptions = {},
    ) {
        this.clock = options.clock ?? Date.now
        this.onQuarantine = options.onQuarantine
    }

    /** Read without locking; atomic replacement guarantees a complete document. */
    async read(): Promise<DeviceCredentialReadResult> {
        const parsed = await this.readParsed()
        return parsed.status === "valid" ? { status: "valid", document: parsed.document } : parsed
    }

    /** Return the device document, creating a fresh secret when none exists or the stored one is unreadable. */
    async ensure(): Promise<DeviceCredentialEnsureResult> {
        return this.withDocumentLock(async () => {
            await removeStaleAtomicTempFiles(this.layout.secretsDir)
            const current = await this.readLatestForWrite()
            if (current.status === "unsupported") return current
            if (current.status === "valid") return { status: "valid", document: current.document }
            const created: DeviceCredentialDocument = {
                deviceSecret: randomBytes(DEVICE_SECRET_BYTES).toString("base64url"),
                createdAt: this.clock(),
                generation: 1,
                tokens: {},
                grants: {},
            }
            await this.write(created, {})
            return { status: "valid", document: created }
        })
    }

    /**
     * Apply a decision to the latest stored document under the lock.
     *
     * The device secret and creation time are immutable here; a new identity
     * requires {@link resetIdentity}. Returns `missing` when no device exists,
     * so a mutation can never resurrect an identity the user reset.
     */
    async mutate<T>(
        decide: (current: DeviceCredentialDocument) => DeviceCredentialDecision<T>,
    ): Promise<DeviceCredentialMutateResult<T>> {
        return this.withDocumentLock(async () => {
            const current = await this.readLatestForWrite()
            if (current.status !== "valid") return current
            const decision = decide(current.document)
            if (!decision.next) return { status: "valid", document: current.document, value: decision.value }
            const next: DeviceCredentialDocument = {
                ...normalizeState(decision.next, current.document.grants),
                deviceSecret: current.document.deviceSecret,
                createdAt: current.document.createdAt,
                generation: current.document.generation + 1,
            }
            await this.write(next, current.raw)
            return { status: "valid", document: next, value: decision.value }
        })
    }

    /** Publish the token and its complete schema capability in one credential generation. */
    async publishDeviceGrantAtomically(grant: AtomicDeviceGrant): Promise<void> {
        const validated = validateAtomicDeviceGrant(grant)
        const result = await this.mutate((current) => {
            const obtainedAt = this.clock()
            if (validated.expiresAt <= obtainedAt) throw new Error("Refusing to publish an expired device grant")
            const token: StoredDeviceToken = {
                accessToken: validated.accessToken,
                deviceId: validated.deviceId,
                expiresAt: validated.expiresAt,
                obtainedAt,
            }
            const currentGrant = current.grants[validated.profile]
            if (
                currentGrant &&
                sameAtomicDeviceGrant(currentGrant, validated) &&
                tokenMatchesGrant(current.tokens[validated.profile], validated)
            ) {
                return { value: undefined }
            }
            return {
                next: {
                    ...current,
                    tokens: { ...current.tokens, [validated.profile]: token },
                    grants: { ...current.grants, [validated.profile]: validated },
                },
                value: undefined,
            }
        })
        if (result.status === "missing") throw new Error("Cannot publish a device grant after the device identity was reset")
        if (result.status === "unsupported")
            throw new Error("Cannot publish a device grant into a credential owned by a newer Dline")
    }

    /** Return a complete, unexpired grant only when its compatibility token projection matches the same generation. */
    async readActiveDeviceGrant(now: number, profile: RemoteProfile = "usage"): Promise<AtomicDeviceGrant | null> {
        if (!isTimestamp(now)) throw new Error("Device grant read time must be a non-negative safe integer")
        const stored = await this.read()
        if (stored.status !== "valid") return null
        const grant = stored.document.grants[profile]
        if (!grant || grant.expiresAt <= now || !tokenMatchesGrant(stored.document.tokens[profile], grant)) return null
        return grant
    }

    /**
     * Remove bearer tokens while keeping the device secret so the machine
     * principal stays stable. With `profiles`, only those streams lose their
     * token, so turning one stream off leaves the other running; without it every
     * token goes, including any inside quarantined copies.
     */
    async clearTokens(profiles?: readonly RemoteProfile[]): Promise<void> {
        if (profiles) {
            await this.withDocumentLock(async () => {
                const current = await this.readLatestForWrite()
                if (
                    current.status !== "valid" ||
                    !profiles.some((profile) => current.document.tokens[profile] || current.document.grants[profile])
                ) {
                    return
                }
                const tokens = { ...current.document.tokens }
                const grants = { ...current.document.grants }
                for (const profile of profiles) {
                    delete tokens[profile]
                    delete grants[profile]
                }
                await this.write(
                    { ...current.document, generation: current.document.generation + 1, tokens, grants },
                    current.raw,
                )
            })
            return
        }
        await this.withDocumentLock(async () => {
            const current = await this.readLatestForWrite()
            if (current.status === "valid" && hasTokenState(current.document)) {
                await this.write(
                    {
                        deviceSecret: current.document.deviceSecret,
                        createdAt: current.document.createdAt,
                        generation: current.document.generation + 1,
                        tokens: {},
                        grants: {},
                        ...(current.document.enrollment ? { enrollment: current.document.enrollment } : {}),
                    },
                    current.raw,
                )
            }
            await purgeQuarantine(this.layout.secretsQuarantineDir)
        })
    }

    /** Forget the device: the next {@link ensure} creates a new secret, which the service sees as a new device. */
    async resetIdentity(): Promise<void> {
        await this.withDocumentLock(async () => {
            const current = await this.readParsed()
            if (current.status === "unsupported") {
                throw new Error("Remote telemetry identity was written by a newer Dline and cannot be reset by this version")
            }
            await fs.rm(this.layout.deviceCredentialPath, { force: true })
            await purgeQuarantine(this.layout.secretsQuarantineDir)
        })
    }

    private async withDocumentLock<T>(operation: () => Promise<T>): Promise<T> {
        await fs.mkdir(this.layout.secretsDir, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE })
        return this.lock.withLock(this.layout.deviceCredentialPath, operation)
    }

    /** Latest document for a locked write; an unreadable one is moved aside so it is never silently overwritten. */
    private async readLatestForWrite(): Promise<LatestDocument> {
        const parsed = await this.readParsed()
        if (parsed.status !== "malformed") return parsed
        if (await quarantineDocument(this.layout.deviceCredentialPath, this.layout.secretsQuarantineDir, this.clock())) {
            this.onQuarantine?.(path.basename(this.layout.deviceCredentialPath))
        }
        return { status: "missing" }
    }

    private async readParsed(): Promise<ParsedDocument | { readonly status: "missing" }> {
        let raw: string
        try {
            raw = await fs.readFile(this.layout.deviceCredentialPath, "utf8")
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") return { status: "missing" }
            throw error
        }
        try {
            return parseDeviceCredentialDocument(JSON.parse(raw))
        } catch {
            return { status: "malformed" }
        }
    }

    private async write(document: DeviceCredentialDocument, previousRaw: Record<string, unknown>): Promise<void> {
        await writeJsonAtomic(
            this.layout.deviceCredentialPath,
            { ...preserveUnknownFields(previousRaw), ...serializeDocument(document) },
            { mode: CREDENTIAL_FILE_MODE, fsync: true },
        )
    }
}

function parseDeviceCredentialDocument(value: unknown): ParsedDocument {
    if (!isRecord(value)) return { status: "malformed" }
    const schemaVersion = value.schema_version
    if (!Number.isSafeInteger(schemaVersion) || (schemaVersion as number) < 1) return { status: "malformed" }
    if ((schemaVersion as number) > DEVICE_CREDENTIAL_SCHEMA_VERSION) return { status: "unsupported" }
    const { device_secret: deviceSecret, created_at: createdAt, generation } = value
    if (typeof deviceSecret !== "string" || !BASE64URL_43_PATTERN.test(deviceSecret)) return { status: "malformed" }
    if (!isTimestamp(createdAt) || !Number.isSafeInteger(generation) || (generation as number) < 1) return { status: "malformed" }
    const enrollment = parseEnrollment(value.enrollment)
    const refreshClaim = parseRefreshClaim(value.refresh_claim)
    return {
        status: "valid",
        raw: value,
        document: {
            deviceSecret,
            createdAt,
            generation: generation as number,
            // Tokens, backoff and claims are recoverable state: an unreadable entry is ignored rather
            // than costing the device its identity.
            tokens: parseTokens(value.tokens),
            grants: parseGrants(value.grants),
            ...(enrollment ? { enrollment } : {}),
            ...(refreshClaim ? { refreshClaim } : {}),
        },
    }
}

function parseTokens(value: unknown): Partial<Record<RemoteProfile, StoredDeviceToken>> {
    if (!isRecord(value)) return {}
    const tokens: Partial<Record<RemoteProfile, StoredDeviceToken>> = {}
    for (const profile of REMOTE_PROFILES) {
        const token = parseToken(value[profile])
        if (token) tokens[profile] = token
    }
    return tokens
}

function parseToken(value: unknown): StoredDeviceToken | undefined {
    if (!isRecord(value)) return undefined
    const { access_token: accessToken, device_id: deviceId, expires_at: expiresAt, obtained_at: obtainedAt } = value
    if (typeof accessToken !== "string" || !BASE64URL_43_PATTERN.test(accessToken)) return undefined
    if (typeof deviceId !== "string" || deviceId.length === 0 || deviceId.length > MAX_DEVICE_ID_LENGTH) return undefined
    if (!isTimestamp(expiresAt) || !isTimestamp(obtainedAt)) return undefined
    return { accessToken, deviceId, expiresAt, obtainedAt }
}

function parseGrants(value: unknown): Partial<Record<RemoteProfile, AtomicDeviceGrant>> {
    if (!isRecord(value)) return {}
    const grants: Partial<Record<RemoteProfile, AtomicDeviceGrant>> = {}
    for (const profile of REMOTE_PROFILES) {
        const grant = parseAtomicDeviceGrant(value[profile])
        if (grant?.profile === profile) grants[profile] = grant
    }
    return grants
}

function parseEnrollment(value: unknown): EnrollmentBackoff | undefined {
    if (!isRecord(value)) return undefined
    const { not_before: notBefore, consecutive_failures: consecutiveFailures } = value
    if (!isTimestamp(notBefore) || !Number.isSafeInteger(consecutiveFailures) || (consecutiveFailures as number) < 0) {
        return undefined
    }
    return { notBefore, consecutiveFailures: consecutiveFailures as number }
}

function parseRefreshClaim(value: unknown): RefreshClaim | undefined {
    if (!isRecord(value)) return undefined
    const { owner_id: ownerId, profile, expires_at: expiresAt } = value
    if (typeof ownerId !== "string" || ownerId.length === 0) return undefined
    if (!REMOTE_PROFILES.includes(profile as RemoteProfile) || !isTimestamp(expiresAt)) return undefined
    return { ownerId, profile: profile as RemoteProfile, expiresAt }
}

function normalizeState(
    state: DeviceCredentialState,
    currentGrants: Readonly<Partial<Record<RemoteProfile, AtomicDeviceGrant>>>,
): DeviceCredentialState & { readonly grants: Readonly<Partial<Record<RemoteProfile, AtomicDeviceGrant>>> } {
    const tokens: Partial<Record<RemoteProfile, StoredDeviceToken>> = {}
    for (const profile of REMOTE_PROFILES) {
        const token = state.tokens[profile]
        if (token) {
            if (!parseToken(serializeToken(token))) throw new Error(`Refusing to store an invalid ${profile} token`)
            tokens[profile] = token
        }
    }
    const grants: Partial<Record<RemoteProfile, AtomicDeviceGrant>> = {}
    const candidates = state.grants ?? currentGrants
    for (const profile of REMOTE_PROFILES) {
        const grant = candidates[profile]
        if (!grant) continue
        const validated = validateAtomicDeviceGrant(grant)
        if (validated.profile === profile && tokenMatchesGrant(tokens[profile], validated)) grants[profile] = validated
    }
    return {
        tokens,
        grants,
        ...(state.enrollment ? { enrollment: state.enrollment } : {}),
        ...(state.refreshClaim ? { refreshClaim: state.refreshClaim } : {}),
    }
}

function serializeDocument(document: DeviceCredentialDocument): Record<string, unknown> {
    const tokens: Record<string, unknown> = {}
    const grants: Record<string, unknown> = {}
    for (const profile of REMOTE_PROFILES) {
        const token = document.tokens[profile]
        if (token) tokens[profile] = serializeToken(token)
        const grant = document.grants[profile]
        if (grant) grants[profile] = serializeAtomicDeviceGrant(grant)
    }
    return {
        schema_version: DEVICE_CREDENTIAL_SCHEMA_VERSION,
        device_secret: document.deviceSecret,
        created_at: document.createdAt,
        generation: document.generation,
        tokens,
        grants,
        ...(document.enrollment
            ? {
                  enrollment: {
                      not_before: document.enrollment.notBefore,
                      consecutive_failures: document.enrollment.consecutiveFailures,
                  },
              }
            : {}),
        ...(document.refreshClaim
            ? {
                  refresh_claim: {
                      owner_id: document.refreshClaim.ownerId,
                      profile: document.refreshClaim.profile,
                      expires_at: document.refreshClaim.expiresAt,
                  },
              }
            : {}),
    }
}

function serializeToken(token: StoredDeviceToken): Record<string, unknown> {
    return {
        access_token: token.accessToken,
        device_id: token.deviceId,
        expires_at: token.expiresAt,
        obtained_at: token.obtainedAt,
    }
}

/** Keep fields a newer Dline added, so rewriting the document here does not drop them. */
function preserveUnknownFields(value: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(Object.entries(value).filter(([key]) => !KNOWN_DOCUMENT_KEYS.has(key)))
}

function hasTokenState(document: DeviceCredentialDocument): boolean {
    return (
        Object.keys(document.tokens).length > 0 || Object.keys(document.grants).length > 0 || document.refreshClaim !== undefined
    )
}

function tokenMatchesGrant(token: StoredDeviceToken | undefined, grant: AtomicDeviceGrant): boolean {
    return token?.accessToken === grant.accessToken && token.deviceId === grant.deviceId && token.expiresAt === grant.expiresAt
}

function isTimestamp(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}
