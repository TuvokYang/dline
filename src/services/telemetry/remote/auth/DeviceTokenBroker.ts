import { randomUUID } from "node:crypto"
import type {
    DeviceCredentialDocument,
    DeviceCredentialRepository,
    DeviceCredentialState,
    StoredDeviceToken,
} from "@/core/storage/telemetry-remote/DeviceCredentialRepository"
import type { StopScope } from "../contracts/classification"
import type { AtomicDeviceGrant, DeviceGrantProfile } from "../contracts/deviceGrant"
import { type DeviceGrantAttempt, type DeviceGrantClient, DeviceGrantRefusalError } from "./DeviceGrantPort"

/** How long one window may hold the refresh before another may take over; bounds a crashed or hung grant request. */
export const REFRESH_CLAIM_TTL_MS = 30_000
/** Longest a caller waits before checking again whether another window finished its grant request. */
const REFRESH_POLL_MS = 5_000
const ENROLLMENT_BACKOFF_BASE_MS = 60_000
const ENROLLMENT_BACKOFF_MAX_MS = 60 * 60_000

export type TokenAcquisition =
    | { readonly status: "ready"; readonly token: StoredDeviceToken }
    /** No token now; try again at `retryAt` instead of spending enrollment budget. */
    | { readonly status: "deferred"; readonly retryAt: number; readonly reason: "enrollment_backoff" | "refresh_in_progress" }
    /** The service refused this device; the caller records the stop in the remote policy. */
    | { readonly status: "stopped"; readonly scope: StopScope; readonly code: string }
    /** No device identity to use: a newer Dline owns the document, or the identity was reset meanwhile. */
    | { readonly status: "unavailable" }

export interface AcquireOptions {
    /** A token the service just rejected with 401; it is not reused even if it looks unexpired. */
    readonly rejectedAccessToken?: string
    readonly signal?: AbortSignal
}

export interface DeviceTokenBrokerOptions {
    readonly repository: DeviceCredentialRepository
    /** The device grant issuer client; every profile's token comes from `/auth/device/grant`. */
    readonly grantClient: DeviceGrantClient
    readonly clock?: () => number
    /** Identity of this process in refresh claims; tests inject one per simulated window. */
    readonly ownerId?: string
}

type Claim =
    | { readonly kind: "claimed"; readonly document: DeviceCredentialDocument }
    | { readonly kind: "settled"; readonly acquisition: TokenAcquisition }

/**
 * Hands out the machine-wide bearer token of a device grant profile.
 *
 * A new grant may retire tokens issued earlier for the same device, and a
 * refused enrollment holds the whole machine, so windows must not request
 * grants independently. Within a process concurrent callers share one
 * acquisition; across processes a persisted refresh claim lets exactly one
 * window request while the others defer, and every write re-reads the latest
 * document under the repository lock. The grant request itself always runs
 * outside the lock.
 */
export class DeviceTokenBroker {
    private readonly clock: () => number
    private readonly ownerId: string
    private readonly inflight = new Map<DeviceGrantProfile, Promise<TokenAcquisition>>()

    constructor(private readonly options: DeviceTokenBrokerOptions) {
        this.clock = options.clock ?? Date.now
        this.ownerId = options.ownerId ?? randomUUID()
    }

    async acquire(profile: DeviceGrantProfile, options: AcquireOptions = {}): Promise<TokenAcquisition> {
        const shared = this.inflight.get(profile)
        if (shared) {
            const result = await shared
            if (result.status !== "ready" || result.token.accessToken !== options.rejectedAccessToken) return result
        }
        const running = this.acquireOnce(profile, options).finally(() => {
            if (this.inflight.get(profile) === running) this.inflight.delete(profile)
        })
        this.inflight.set(profile, running)
        return running
    }

    private async acquireOnce(profile: DeviceGrantProfile, options: AcquireOptions): Promise<TokenAcquisition> {
        const ensured = await this.options.repository.ensure()
        if (ensured.status !== "valid") return { status: "unavailable" }
        const active = await this.options.grantClient.readActiveGrant(profile, this.clock())
        if (active && active.accessToken !== options.rejectedAccessToken) return this.fromAtomicGrant(active)

        const claim = await this.claimRefresh(profile, options.rejectedAccessToken)
        if (claim.kind === "settled") return claim.acquisition
        const deviceSecret = claim.document.deviceSecret
        let attempt: DeviceGrantAttempt
        try {
            attempt = await this.options.grantClient.ensureActiveGrant(profile, deviceSecret, {
                rejectedAccessToken: options.rejectedAccessToken,
                signal: options.signal,
            })
        } catch (error) {
            if (!(error instanceof DeviceGrantRefusalError)) {
                await this.releaseClaim(deviceSecret)
                throw error
            }
            if (error.refusal.kind === "reset_credential") {
                // The service revoked this device; every token it issued is dead. The identity stays
                // until the user resets it, so the machine is not silently re-enrolled.
                await this.mutateSameDevice(deviceSecret, (current) => ({
                    ...current,
                    tokens: {},
                    grants: {},
                    refreshClaim: undefined,
                }))
                return { status: "stopped", scope: "all", code: error.refusal.code }
            }
            await this.releaseClaim(deviceSecret)
            return { status: "stopped", scope: error.refusal.scope, code: error.refusal.code }
        }
        if (attempt.kind === "deferred") return this.backOff(deviceSecret, attempt.retryAfterMs)
        if (attempt.grant.accessToken === options.rejectedAccessToken) return this.backOff(deviceSecret, undefined)
        await this.clearEnrollmentAndClaim(deviceSecret)
        return this.fromAtomicGrant(attempt.grant)
    }

    private fromAtomicGrant(grant: AtomicDeviceGrant): TokenAcquisition {
        return {
            status: "ready",
            token: {
                accessToken: grant.accessToken,
                deviceId: grant.deviceId,
                expiresAt: grant.expiresAt,
                obtainedAt: this.clock(),
            },
        }
    }

    /** Decide from the latest document whether this window requests a grant, waits, or can use another window's grant. */
    private async claimRefresh(profile: DeviceGrantProfile, rejectedAccessToken: string | undefined): Promise<Claim> {
        const result = await this.options.repository.mutate<Claim | undefined>((current) => {
            const now = this.clock()
            const published = current.grants[profile]
            if (published && published.expiresAt > now && published.accessToken !== rejectedAccessToken) {
                return { value: { kind: "settled", acquisition: this.fromAtomicGrant(published) } }
            }
            if (current.enrollment && current.enrollment.notBefore > now) {
                return {
                    value: {
                        kind: "settled",
                        acquisition: { status: "deferred", retryAt: current.enrollment.notBefore, reason: "enrollment_backoff" },
                    },
                }
            }
            const claim = current.refreshClaim
            if (claim && claim.ownerId !== this.ownerId && claim.expiresAt > now) {
                const retryAt = Math.min(claim.expiresAt, now + REFRESH_POLL_MS)
                return { value: { kind: "settled", acquisition: { status: "deferred", retryAt, reason: "refresh_in_progress" } } }
            }
            return {
                next: { ...current, refreshClaim: { ownerId: this.ownerId, profile, expiresAt: now + REFRESH_CLAIM_TTL_MS } },
                value: undefined,
            }
        })
        if (result.status !== "valid") return { kind: "settled", acquisition: { status: "unavailable" } }
        return result.value ?? { kind: "claimed", document: result.document }
    }

    /** Record a machine-wide enrollment delay; a refusal holds the whole machine, so every window waits it out. */
    private async backOff(deviceSecret: string, retryAfterMs: number | undefined): Promise<TokenAcquisition> {
        const now = this.clock()
        const result = await this.mutateSameDevice(deviceSecret, (current) => {
            const failures = (current.enrollment?.consecutiveFailures ?? 0) + 1
            const delay = retryAfterMs ?? Math.min(ENROLLMENT_BACKOFF_BASE_MS * 2 ** (failures - 1), ENROLLMENT_BACKOFF_MAX_MS)
            return {
                ...current,
                enrollment: { notBefore: now + delay, consecutiveFailures: failures },
                refreshClaim: this.withoutOwnClaim(current),
            }
        })
        if (!result) return { status: "unavailable" }
        const notBefore = result.enrollment?.notBefore ?? now
        return { status: "deferred", retryAt: notBefore, reason: "enrollment_backoff" }
    }

    private async releaseClaim(deviceSecret: string): Promise<void> {
        await this.mutateSameDevice(deviceSecret, (current) => ({ ...current, refreshClaim: this.withoutOwnClaim(current) }))
    }

    /** The service accepted this device again: omitting the enrollment backoff clears it. */
    private async clearEnrollmentAndClaim(deviceSecret: string): Promise<void> {
        await this.mutateSameDevice(deviceSecret, (current) => {
            const { enrollment: _enrollment, ...accepted } = current
            return { ...accepted, refreshClaim: this.withoutOwnClaim(current) }
        })
    }

    private withoutOwnClaim(current: DeviceCredentialDocument): DeviceCredentialDocument["refreshClaim"] {
        return current.refreshClaim?.ownerId === this.ownerId ? undefined : current.refreshClaim
    }

    /** Apply a change only while the device this window requested a grant for still exists. */
    private async mutateSameDevice(
        deviceSecret: string,
        change: (current: DeviceCredentialDocument) => DeviceCredentialState,
    ): Promise<DeviceCredentialDocument | undefined> {
        const result = await this.options.repository.mutate<boolean>((current) =>
            current.deviceSecret === deviceSecret ? { next: change(current), value: true } : { value: false },
        )
        return result.status === "valid" && result.value ? result.document : undefined
    }
}
