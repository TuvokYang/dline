import type { FeatureFlagsCache } from "../remote/FeatureFlagsCacheFile"
import type { FeatureFlagsSource } from "../remote/FeatureFlagsHttpSource"
import type { FeatureFlagPayload, FeatureFlagsSettings, IFeatureFlagsProvider } from "./IFeatureFlagsProvider"

/**
 * How often a device asks the service, whatever the outcome and whoever asks:
 * the next refresh after an answer, the retry after a failure, and the next
 * look while the device takes no part. The service's `ttl_seconds` does not
 * set the pace, so a service that is down cannot turn into a request loop.
 */
export const FEATURE_FLAGS_POLL_INTERVAL_MS = 30 * 60_000
/** A development build polls every minute, so a rollout change shows up while it is being tried. */
export const FEATURE_FLAGS_DEV_POLL_INTERVAL_MS = 60_000

export function rolloutPollIntervalMs(developmentBuild: boolean): number {
    return developmentBuild ? FEATURE_FLAGS_DEV_POLL_INTERVAL_MS : FEATURE_FLAGS_POLL_INTERVAL_MS
}

export type FeatureFlagsLogLevel = "debug" | "info" | "warn"

export interface FeatureFlagsScheduler {
    setTimeout(callback: () => void, delayMs: number): unknown
    clearTimeout(handle: unknown): void
}

export interface RemoteFeatureFlagsStartOptions {
    readonly source: FeatureFlagsSource
    readonly cache: FeatureFlagsCache
    /**
     * Whether this device takes part in rollouts now. A rollout must be
     * measurable, so only a device that reports usage takes part; while this
     * is false the answers and the shared cache are dropped and nothing is asked.
     */
    readonly participates: () => boolean
    /** Minimum time between two requests and between a request and the next look; see {@link rolloutPollIntervalMs}. */
    readonly pollIntervalMs: number
    readonly now?: () => number
    readonly scheduler?: FeatureFlagsScheduler
    readonly log?: (level: FeatureFlagsLogLevel, message: string) => void
}

const defaultScheduler: FeatureFlagsScheduler = {
    setTimeout: (callback, delayMs) => {
        const handle = setTimeout(callback, delayMs)
        // A pending refresh must not keep a host process alive on its own.
        handle.unref?.()
        return handle
    },
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
}

/**
 * Answers the rollout switches from the Dline feature service.
 *
 * Reads are synchronous and served from the last answers, because the callers
 * sit on paths that cannot await a request. Until {@link start} loads the cache
 * or a fetch succeeds it has no opinion, so the switches stay at their
 * defaults. A failed fetch keeps the last answers; nothing here turns a
 * network problem into a switch change. A device that stops taking part loses
 * its answers at once, so its switches return to their defaults.
 *
 * Only the eligible switches are ever answered, whatever the service sends.
 */
export class RemoteFeatureFlagsProvider implements IFeatureFlagsProvider {
    private readonly eligible: ReadonlySet<string>
    private answers: Readonly<Record<string, boolean>> = {}
    private readonly listeners = new Set<() => void>()
    private session: RefreshSession | undefined

    constructor(eligibleFlags: readonly string[]) {
        this.eligible = new Set(eligibleFlags)
    }

    resolveFlags(flagKeys: readonly string[]): Record<string, FeatureFlagPayload> {
        const flags: Record<string, FeatureFlagPayload> = {}
        for (const key of flagKeys) {
            if (this.eligible.has(key) && Object.hasOwn(this.answers, key)) {
                flags[key] = this.answers[key]
            }
        }
        return flags
    }

    /** Called after the answers change; returns the unsubscribe function. */
    onDidChange(listener: () => void): () => void {
        this.listeners.add(listener)
        return () => this.listeners.delete(listener)
    }

    /**
     * Load the cached answers and keep them current. Resolves once the cache
     * has been applied; fetching continues in the background. Starting again
     * replaces the previous session.
     */
    async start(options: RemoteFeatureFlagsStartOptions): Promise<void> {
        this.session?.stop()
        const session = new RefreshSession(options, (flags) => this.apply(flags))
        this.session = session
        await session.begin()
    }

    /**
     * Check participation and the shared cache now, fetching when the answers
     * are due; call it when participation may have changed.
     */
    revalidate(): Promise<void> {
        return this.session?.revalidate() ?? Promise.resolve()
    }

    isEnabled(): boolean {
        return this.session !== undefined
    }

    getSettings(): FeatureFlagsSettings {
        return { enabled: this.isEnabled() }
    }

    async dispose(): Promise<void> {
        this.session?.stop()
        this.session = undefined
        this.listeners.clear()
    }

    private apply(flags: Readonly<Record<string, boolean>>): void {
        const next: Record<string, boolean> = {}
        for (const [key, answer] of Object.entries(flags)) {
            if (this.eligible.has(key)) next[key] = answer
        }
        if (sameAnswers(this.answers, next)) return
        this.answers = next
        for (const listener of this.listeners) listener()
    }
}

/** One cache-backed refresh loop; stopping it cancels the pending timer and any request in flight. */
class RefreshSession {
    private readonly now: () => number
    private readonly scheduler: FeatureFlagsScheduler
    private readonly abort = new AbortController()
    private timer: unknown
    private inFlight: Promise<void> | undefined
    /** No request before this time, so re-checking participation cannot hurry the next request. */
    private nextRequestAt = 0
    /** Last outcome logged at info, so a state that holds for hours is announced once. */
    private announcedOutcome: string | undefined

    constructor(
        private readonly options: RemoteFeatureFlagsStartOptions,
        private readonly apply: (flags: Readonly<Record<string, boolean>>) => void,
    ) {
        this.now = options.now ?? Date.now
        this.scheduler = options.scheduler ?? defaultScheduler
    }

    async begin(): Promise<void> {
        const remainingMs = await this.settleFromCache()
        if (remainingMs !== undefined) this.schedule(remainingMs)
    }

    /** Another window may have refreshed the shared cache meanwhile; use it rather than asking again. */
    async revalidate(): Promise<void> {
        const remainingMs = await this.settleFromCache()
        if (remainingMs === undefined) return
        if (remainingMs > 0) this.schedule(remainingMs)
        else await this.refresh()
    }

    refresh(): Promise<void> {
        this.inFlight ??= this.fetchAndApply().finally(() => {
            this.inFlight = undefined
        })
        return this.inFlight
    }

    stop(): void {
        this.abort.abort()
        if (this.timer !== undefined) this.scheduler.clearTimeout(this.timer)
        this.timer = undefined
    }

    private schedule(delayMs: number): void {
        if (this.abort.signal.aborted) return
        if (this.timer !== undefined) this.scheduler.clearTimeout(this.timer)
        this.timer = this.scheduler.setTimeout(
            () => {
                this.timer = undefined
                void this.revalidate()
            },
            Math.max(0, delayMs),
        )
    }

    /**
     * Apply the shared cache and return how long until it is due; `undefined`
     * when this session stopped or the device takes no part.
     */
    private async settleFromCache(): Promise<number | undefined> {
        if (this.abort.signal.aborted) return undefined
        if (!this.options.participates()) {
            await this.withdraw()
            return undefined
        }
        const cached = await this.readCache()
        if (this.abort.signal.aborted) return undefined
        if (cached) this.apply(cached.document.flags)
        const now = this.now()
        // Answers any window fetched are fresh for one interval; this window also waits out its own last request.
        const freshForMs = cached ? cached.fetchedAt + this.options.pollIntervalMs - now : 0
        return Math.max(0, freshForMs, this.nextRequestAt - now)
    }

    /** Drop the answers here and for every window, then look again later; checking is local and asks nothing. */
    private async withdraw(): Promise<void> {
        this.announce("withdrawn", "[FeatureFlags] Not taking part in rollouts while usage reporting is off")
        this.apply({})
        await this.options.cache.clear().catch((error: unknown) => {
            this.options.log?.("warn", `[FeatureFlags] Failed to clear cached feature flags: ${describe(error)}`)
        })
        this.schedule(this.options.pollIntervalMs)
    }

    private async fetchAndApply(): Promise<void> {
        this.nextRequestAt = this.now() + this.options.pollIntervalMs
        const nextIn = `${this.options.pollIntervalMs / 1000} s`
        try {
            const document = await this.options.source.fetchFlags(this.abort.signal)
            if (this.abort.signal.aborted) return
            // Participation may have ended while the request was out; its answer must not outlive it.
            if (!this.options.participates()) return await this.withdraw()
            this.announce("answered", `[FeatureFlags] Rollout answers received; next refresh in ${nextIn}`)
            this.apply(document.flags)
            await this.options.cache.write({ document, fetchedAt: this.now() }).catch((error: unknown) => {
                this.options.log?.("warn", `[FeatureFlags] Failed to cache feature flags: ${describe(error)}`)
            })
        } catch (error) {
            if (this.abort.signal.aborted) return
            // Printed when the failure changes, so a service that stays unreachable costs one line.
            const failure = describe(error)
            this.announce(
                `failed:${failure}`,
                `[FeatureFlags] Keeping previous feature flags: ${failure}; next attempt in ${nextIn}`,
            )
        }
        this.schedule(this.options.pollIntervalMs)
    }

    /** Log an outcome at info when it differs from the last one announced, at debug while it holds. */
    private announce(outcome: string, message: string): void {
        const level = outcome === this.announcedOutcome ? "debug" : "info"
        this.announcedOutcome = outcome
        this.options.log?.(level, message)
    }

    private async readCache() {
        try {
            return await this.options.cache.read()
        } catch (error) {
            this.options.log?.("warn", `[FeatureFlags] Failed to read cached feature flags: ${describe(error)}`)
            return undefined
        }
    }
}

function sameAnswers(left: Readonly<Record<string, boolean>>, right: Readonly<Record<string, boolean>>): boolean {
    const leftKeys = Object.keys(left)
    return leftKeys.length === Object.keys(right).length && leftKeys.every((key) => right[key] === left[key])
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error)
}
