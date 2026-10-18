import { describe, expect, it, vi } from "vitest"
import {
    FEATURE_FLAGS_RETRY_DELAY_MS,
    type FeatureFlagsScheduler,
    RemoteFeatureFlagsProvider,
    type RemoteFeatureFlagsStartOptions,
} from "../providers/RemoteFeatureFlagsProvider"
import type { CachedFeatureFlags, FeatureFlagsCache } from "../remote/FeatureFlagsCacheFile"
import type { FeatureFlagsSource } from "../remote/FeatureFlagsHttpSource"
import type { FeatureFlagsDocument } from "../remote/flagsDocument"

const NOW = 1_000_000_000_000

class ManualScheduler implements FeatureFlagsScheduler {
    readonly pending = new Map<number, { callback: () => void; delayMs: number }>()
    private nextHandle = 1

    setTimeout(callback: () => void, delayMs: number): unknown {
        const handle = this.nextHandle++
        this.pending.set(handle, { callback, delayMs })
        return handle
    }

    clearTimeout(handle: unknown): void {
        this.pending.delete(handle as number)
    }

    /** Delays of the timers still waiting. */
    delays(): number[] {
        return [...this.pending.values()].map((timer) => timer.delayMs)
    }

    /** Fire every waiting timer and let the work it starts settle. */
    async fireAll(): Promise<void> {
        const timers = [...this.pending.entries()]
        this.pending.clear()
        for (const [, timer] of timers) timer.callback()
        await flush()
    }
}

class MemoryCache implements FeatureFlagsCache {
    constructor(public entry: CachedFeatureFlags | undefined = undefined) {}
    readonly writes: CachedFeatureFlags[] = []

    async read(): Promise<CachedFeatureFlags | undefined> {
        return this.entry
    }

    async write(entry: CachedFeatureFlags): Promise<void> {
        this.writes.push(entry)
        this.entry = entry
    }

    async clear(): Promise<void> {
        this.entry = undefined
    }
}

/** Start a session of a device that reports usage unless the test says otherwise. */
function start(
    provider: RemoteFeatureFlagsProvider,
    options: Omit<RemoteFeatureFlagsStartOptions, "participates"> & Partial<Pick<RemoteFeatureFlagsStartOptions, "participates">>,
): Promise<void> {
    return provider.start({ participates: () => true, ...options })
}

function document(flags: Record<string, boolean>, ttlSeconds = 3_600): FeatureFlagsDocument {
    return { flags, ttlSeconds }
}

function sourceAnswering(...answers: Array<FeatureFlagsDocument | Error>): FeatureFlagsSource & { calls: number } {
    const source = {
        calls: 0,
        async fetchFlags(): Promise<FeatureFlagsDocument> {
            const answer = answers[Math.min(source.calls, answers.length - 1)]
            source.calls++
            if (answer instanceof Error) throw answer
            return answer
        },
    }
    return source
}

async function flush(): Promise<void> {
    for (let i = 0; i < 10; i++) await Promise.resolve()
}

describe("RemoteFeatureFlagsProvider", () => {
    it("has no opinion until it has answers", () => {
        const provider = new RemoteFeatureFlagsProvider(["account"])

        expect(provider.resolveFlags(["account"])).toEqual({})
    })

    it("applies the cached answers on start and fetches when they are due", async () => {
        const scheduler = new ManualScheduler()
        const cache = new MemoryCache({ document: document({ account: true }, 600), fetchedAt: NOW - 100_000 })
        const provider = new RemoteFeatureFlagsProvider(["account"])

        await start(provider, { source: sourceAnswering(document({})), cache, scheduler, now: () => NOW })

        expect(provider.resolveFlags(["account"])).toEqual({ account: true })
        // 600 s of validity, 100 s already spent.
        expect(scheduler.delays()).toEqual([500_000])
    })

    it("answers only the eligible switches, whatever the service sends", async () => {
        const scheduler = new ManualScheduler()
        const provider = new RemoteFeatureFlagsProvider(["account"])

        await start(provider, {
            source: sourceAnswering(document({ account: true, webtools: true })),
            cache: new MemoryCache(),
            scheduler,
            now: () => NOW,
        })
        await scheduler.fireAll()

        expect(provider.resolveFlags(["account", "webtools"])).toEqual({ account: true })
    })

    it("caches a successful answer, notifies once, and polls again after its ttl", async () => {
        const scheduler = new ManualScheduler()
        const cache = new MemoryCache()
        const provider = new RemoteFeatureFlagsProvider(["account"])
        const onChange = vi.fn()
        provider.onDidChange(onChange)

        await start(provider, { source: sourceAnswering(document({ account: true }, 900)), cache, scheduler, now: () => NOW })
        await scheduler.fireAll()

        expect(onChange).toHaveBeenCalledTimes(1)
        expect(cache.writes).toEqual([{ document: document({ account: true }, 900), fetchedAt: NOW }])
        expect(scheduler.delays()).toEqual([900_000])
    })

    it("does not notify when a refresh brings the same answers", async () => {
        const scheduler = new ManualScheduler()
        const provider = new RemoteFeatureFlagsProvider(["account"])
        const onChange = vi.fn()
        provider.onDidChange(onChange)

        await start(provider, {
            source: sourceAnswering(document({ account: true })),
            cache: new MemoryCache({ document: document({ account: true }), fetchedAt: NOW - 10_000_000 }),
            scheduler,
            now: () => NOW,
        })
        expect(onChange).toHaveBeenCalledTimes(1)

        await scheduler.fireAll()

        expect(onChange).toHaveBeenCalledTimes(1)
    })

    it("keeps the last answers when a fetch fails and retries later", async () => {
        const scheduler = new ManualScheduler()
        const source = sourceAnswering(new Error("network"))
        const provider = new RemoteFeatureFlagsProvider(["account"])

        await start(provider, {
            source,
            cache: new MemoryCache({ document: document({ account: true }), fetchedAt: NOW - 10_000_000 }),
            scheduler,
            now: () => NOW,
        })
        await scheduler.fireAll()

        expect(source.calls).toBe(1)
        expect(provider.resolveFlags(["account"])).toEqual({ account: true })
        expect(scheduler.delays()).toEqual([FEATURE_FLAGS_RETRY_DELAY_MS])
    })

    it("uses answers another window cached instead of asking again", async () => {
        const scheduler = new ManualScheduler()
        const cache = new MemoryCache({ document: document({ account: false }, 600), fetchedAt: NOW - 600_000 })
        const source = sourceAnswering(document({ account: false }))
        const provider = new RemoteFeatureFlagsProvider(["account"])

        await start(provider, { source, cache, scheduler, now: () => NOW })
        // Another window refreshed the shared cache before this one's timer fired.
        cache.entry = { document: document({ account: true }, 600), fetchedAt: NOW }
        await scheduler.fireAll()

        expect(source.calls).toBe(0)
        expect(provider.resolveFlags(["account"])).toEqual({ account: true })
        expect(scheduler.delays()).toEqual([600_000])
    })

    it("drops the answers and the shared cache of a device that does not report usage, asking nothing", async () => {
        const scheduler = new ManualScheduler()
        const cache = new MemoryCache({ document: document({ account: true }, 600), fetchedAt: NOW })
        const source = sourceAnswering(document({ account: true }))
        const provider = new RemoteFeatureFlagsProvider(["account"])

        await start(provider, { source, cache, scheduler, now: () => NOW, participates: () => false })
        await scheduler.fireAll()

        expect(provider.resolveFlags(["account"])).toEqual({})
        expect(cache.entry).toBeUndefined()
        expect(source.calls).toBe(0)
        expect(scheduler.delays()).toEqual([FEATURE_FLAGS_RETRY_DELAY_MS])
    })

    it("leaves the rollout at once when usage reporting is turned off", async () => {
        const scheduler = new ManualScheduler()
        const cache = new MemoryCache({ document: document({ account: true }, 600), fetchedAt: NOW })
        const provider = new RemoteFeatureFlagsProvider(["account"])
        const onChange = vi.fn()
        provider.onDidChange(onChange)
        let reporting = true

        await start(provider, {
            source: sourceAnswering(document({})),
            cache,
            scheduler,
            now: () => NOW,
            participates: () => reporting,
        })
        expect(provider.resolveFlags(["account"])).toEqual({ account: true })

        reporting = false
        await provider.revalidate()

        expect(provider.resolveFlags(["account"])).toEqual({})
        expect(onChange).toHaveBeenCalledTimes(2)
        expect(cache.entry).toBeUndefined()
    })

    it("joins at once when usage reporting is turned on", async () => {
        const scheduler = new ManualScheduler()
        const source = sourceAnswering(document({ account: true }))
        const provider = new RemoteFeatureFlagsProvider(["account"])
        let reporting = false

        await start(provider, { source, cache: new MemoryCache(), scheduler, now: () => NOW, participates: () => reporting })
        expect(source.calls).toBe(0)

        reporting = true
        await provider.revalidate()

        expect(source.calls).toBe(1)
        expect(provider.resolveFlags(["account"])).toEqual({ account: true })
    })

    it("discards an answer that arrives after usage reporting was turned off", async () => {
        const scheduler = new ManualScheduler()
        const cache = new MemoryCache()
        const provider = new RemoteFeatureFlagsProvider(["account"])
        let reporting = true
        const source: FeatureFlagsSource = {
            async fetchFlags() {
                reporting = false
                return document({ account: true })
            },
        }

        await start(provider, { source, cache, scheduler, now: () => NOW, participates: () => reporting })
        await scheduler.fireAll()

        expect(provider.resolveFlags(["account"])).toEqual({})
        expect(cache.writes).toEqual([])
    })

    it("stops polling once disposed", async () => {
        const scheduler = new ManualScheduler()
        const provider = new RemoteFeatureFlagsProvider(["account"])

        await start(provider, { source: sourceAnswering(document({})), cache: new MemoryCache(), scheduler, now: () => NOW })
        await provider.dispose()

        expect(scheduler.delays()).toEqual([])
    })
})
