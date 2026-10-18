import type { FeatureFlagsCache } from "../remote/FeatureFlagsCacheFile"
import type { FeatureFlagsSource } from "../remote/FeatureFlagsHttpSource"
import type { FeatureFlagPayload, FeatureFlagsSettings, IFeatureFlagsProvider } from "./IFeatureFlagsProvider"

/** Wait before asking again after a failed fetch; the service being down must not turn into a request loop. */
export const FEATURE_FLAGS_RETRY_DELAY_MS = 15 * 60_000

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
    readonly now?: () => number
    readonly scheduler?: FeatureFlagsScheduler
    readonly log?: (level: "debug" | "warn", message: string) => void
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
        if (!cached) return 0
        this.apply(cached.document.flags)
        return cached.fetchedAt + cached.document.ttlSeconds * 1000 - this.now()
    }

    /** Drop the answers here and for every window, then look again later; checking is local and asks nothing. */
    private async withdraw(): Promise<void> {
        this.apply({})
        await this.options.cache.clear().catch((error: unknown) => {
            this.options.log?.("warn", `[FeatureFlags] Failed to clear cached feature flags: ${describe(error)}`)
        })
        this.schedule(FEATURE_FLAGS_RETRY_DELAY_MS)
    }

    private async fetchAndApply(): Promise<void> {
        let ttlMs = FEATURE_FLAGS_RETRY_DELAY_MS
        try {
            const document = await this.options.source.fetchFlags(this.abort.signal)
            if (this.abort.signal.aborted) return
            // Participation may have ended while the request was out; its answer must not outlive it.
            if (!this.options.participates()) return await this.withdraw()
            this.apply(document.flags)
            ttlMs = document.ttlSeconds * 1000
            await this.options.cache.write({ document, fetchedAt: this.now() }).catch((error: unknown) => {
                this.options.log?.("warn", `[FeatureFlags] Failed to cache feature flags: ${describe(error)}`)
            })
        } catch (error) {
            if (this.abort.signal.aborted) return
            // The service is not reachable until it is deployed; keep the last answers quietly.
            this.options.log?.("debug", `[FeatureFlags] Keeping previous feature flags: ${describe(error)}`)
        }
        this.schedule(ttlMs)
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
