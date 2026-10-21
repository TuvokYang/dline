import { randomUUID } from "node:crypto"
import type {
    DeviceCredentialDocument,
    DeviceCredentialRepository,
    DeviceCredentialState,
    StoredDeviceToken,
} from "@/core/storage/telemetry-remote/DeviceCredentialRepository"
import { classifyExchangeResponse, type StopScope, type WireResponse } from "../contracts/classification"
import { buildDeviceExchangeRequest, type DeviceExchangeRequest, type DeviceGrant, type RemoteProfile } from "../contracts/wire"

/** How long one window may hold the refresh before another may take over; bounds a crashed or hung exchange. */
export const REFRESH_CLAIM_TTL_MS = 30_000
/** Longest a caller waits before checking again whether another window finished its exchange. */
const REFRESH_POLL_MS = 5_000
const ENROLLMENT_BACKOFF_BASE_MS = 60_000
const ENROLLMENT_BACKOFF_MAX_MS = 60 * 60_000
/** Refresh well before expiry: a tenth of the lifetime, at least five minutes. */
const MIN_REFRESH_MARGIN_MS = 5 * 60_000

/** Sends one device exchange. Implementations bound the request with their own timeout and honour `signal`. */
export interface DeviceExchangeTransport {
    exchange(request: DeviceExchangeRequest, signal?: AbortSignal): Promise<WireResponse>
}

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
    readonly transport: DeviceExchangeTransport
    readonly clientVersion: string
    readonly platform: string
    readonly clock?: () => number
    /** Identity of this process in refresh claims; tests inject one per simulated window. */
    readonly ownerId?: string
}

type Claim =
    | { readonly kind: "claimed"; readonly document: DeviceCredentialDocument }
    | { readonly kind: "settled"; readonly acquisition: TokenAcquisition }

/**
 * Hands out the machine-wide bearer token for a remote profile.
 *
 * An exchange may retire tokens issued earlier for the same device, and a
 * refused enrollment holds the whole machine, so windows must not exchange
 * independently. Within a
 * process concurrent callers share one acquisition; across processes a
 * persisted refresh claim lets exactly one window exchange while the others
 * defer, and every write re-reads the latest document under the repository
 * lock. The exchange itself always runs outside the lock.
 */
export class DeviceTokenBroker {
    private readonly clock: () => number
    private readonly ownerId: string
    private readonly inflight = new Map<RemoteProfile, Promise<TokenAcquisition>>()

    constructor(private readonly options: DeviceTokenBrokerOptions) {
        this.clock = options.clock ?? Date.now
        this.ownerId = options.ownerId ?? randomUUID()
    }

    async acquire(profile: RemoteProfile, options: AcquireOptions = {}): Promise<TokenAcquisition> {
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

    private async acquireOnce(profile: RemoteProfile, options: AcquireOptions): Promise<TokenAcquisition> {
        const ensured = await this.options.repository.ensure()
        if (ensured.status !== "valid") return { status: "unavailable" }
        const cached = this.usableToken(ensured.document, profile, options.rejectedAccessToken)
        if (cached) return { status: "ready", token: cached }

        const claim = await this.claimRefresh(profile, options.rejectedAccessToken)
        if (claim.kind === "settled") return claim.acquisition
        return this.exchange(profile, claim.document, options)
    }

    /** Decide from the latest document whether this window exchanges, waits, or can use another window's token. */
    private async claimRefresh(profile: RemoteProfile, rejectedAccessToken: string | undefined): Promise<Claim> {
        const result = await this.options.repository.mutate<Claim | undefined>((current) => {
            const now = this.clock()
            const refreshed = this.usableToken(current, profile, rejectedAccessToken)
            if (refreshed) return { value: { kind: "settled", acquisition: { status: "ready", token: refreshed } } }
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

    private async exchange(
        profile: RemoteProfile,
        claimed: DeviceCredentialDocument,
        options: AcquireOptions,
    ): Promise<TokenAcquisition> {
        const request = buildDeviceExchangeRequest({
            deviceSecret: claimed.deviceSecret,
            profile,
            clientVersion: this.options.clientVersion,
            platform: this.options.platform,
        })
        let response: WireResponse
        try {
            response = await this.options.transport.exchange(request, options.signal)
        } catch (error) {
            if (options.signal?.aborted) {
                await this.releaseClaim(claimed.deviceSecret)
                throw error
            }
            return this.backOff(claimed.deviceSecret, undefined)
        }

        const outcome = classifyExchangeResponse(response)
        switch (outcome.kind) {
            case "granted":
                return this.storeGrant(profile, claimed.deviceSecret, outcome.grant, options.rejectedAccessToken)
            case "backoff":
                return this.backOff(claimed.deviceSecret, outcome.retryAfterMs)
            case "reset_credential":
                // The service revoked this device; every token it issued is dead. The identity stays
                // until the user resets it, so the machine is not silently re-enrolled.
                await this.mutateSameDevice(claimed.deviceSecret, (current) => ({
                    ...current,
                    tokens: {},
                    refreshClaim: undefined,
                }))
                return { status: "stopped", scope: "all", code: outcome.code }
            case "stop":
                await this.releaseClaim(claimed.deviceSecret)
                return { status: "stopped", scope: outcome.scope, code: outcome.code }
        }
    }

    private async storeGrant(
        profile: RemoteProfile,
        deviceSecret: string,
        grant: DeviceGrant,
        rejectedAccessToken: string | undefined,
    ): Promise<TokenAcquisition> {
        const issued: StoredDeviceToken = {
            accessToken: grant.accessToken,
            deviceId: grant.deviceId,
            expiresAt: grant.expiresAt,
            obtainedAt: this.clock(),
        }
        const result = await this.options.repository.mutate<StoredDeviceToken | undefined>((current) => {
            // The identity was reset during the exchange: the grant belongs to a device that no longer exists here.
            if (current.deviceSecret !== deviceSecret) return { value: undefined }
            const ownsClaim = current.refreshClaim?.ownerId === this.ownerId
            // Our claim expired and another window stored a token meanwhile; keep theirs so both windows converge.
            const theirs = ownsClaim ? undefined : this.usableToken(current, profile, rejectedAccessToken)
            const token = theirs ?? issued
            return {
                // Omitting the enrollment backoff clears it: the service accepted this device again.
                next: {
                    tokens: { ...current.tokens, [profile]: token },
                    refreshClaim: ownsClaim ? undefined : current.refreshClaim,
                },
                value: token,
            }
        })
        if (result.status !== "valid" || !result.value) return { status: "unavailable" }
        return { status: "ready", token: result.value }
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

    private withoutOwnClaim(current: DeviceCredentialDocument): DeviceCredentialDocument["refreshClaim"] {
        return current.refreshClaim?.ownerId === this.ownerId ? undefined : current.refreshClaim
    }

    /** Apply a change only while the device this window exchanged for still exists. */
    private async mutateSameDevice(
        deviceSecret: string,
        change: (current: DeviceCredentialDocument) => DeviceCredentialState,
    ): Promise<DeviceCredentialDocument | undefined> {
        const result = await this.options.repository.mutate<boolean>((current) =>
            current.deviceSecret === deviceSecret ? { next: change(current), value: true } : { value: false },
        )
        return result.status === "valid" && result.value ? result.document : undefined
    }

    private usableToken(
        document: DeviceCredentialDocument,
        profile: RemoteProfile,
        rejectedAccessToken: string | undefined,
    ): StoredDeviceToken | undefined {
        const token = document.tokens[profile]
        if (!token || token.accessToken === rejectedAccessToken) return undefined
        const lifetime = Math.max(0, token.expiresAt - token.obtainedAt)
        const margin = Math.max(MIN_REFRESH_MARGIN_MS, Math.floor(lifetime / 10))
        return this.clock() < token.expiresAt - margin ? token : undefined
    }
}
