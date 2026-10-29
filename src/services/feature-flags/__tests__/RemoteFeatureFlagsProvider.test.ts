import { describe, expect, it, vi } from "vitest"
import {
    type FeatureFlagsScheduler,
    RemoteFeatureFlagsProvider,
    type RemoteFeatureFlagsStartOptions,
    rolloutPollIntervalMs,
} from "../providers/RemoteFeatureFlagsProvider"
import type { CachedFeatureFlags, FeatureFlagsCache, FeatureFlagsRequestClaim } from "../remote/FeatureFlagsCacheFile"
import type { FeatureFlagsSource } from "../remote/FeatureFlagsHttpSource"
import type { FeatureFlagsDocument } from "../remote/flagsDocument"

const NOW = 1_000_000_000_000
/** The cadence these tests run at; production and development cadences are checked separately. */
const INTERVAL = 30 * 60_000

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

    /** Another window's claim this cache reports, or undefined to grant every claim. */
    deniedUntil: number | undefined
    readonly grantedIds: string[] = []

    async claimRequest(): Promise<FeatureFlagsRequestClaim> {
        if (this.deniedUntil !== undefined) return { granted: false, recheckAt: this.deniedUntil }
        const requestId = `request-${this.grantedIds.length + 1}`
        this.grantedIds.push(requestId)
        return { granted: true, requestId }
    }
}

/** Start a session of a device that reports usage, at {@link INTERVAL}, unless the test says otherwise. */
function start(
    provider: RemoteFeatureFlagsProvider,
    options: Omit<RemoteFeatureFlagsStartOptions, "participates" | "pollIntervalMs"> &
        Partial<Pick<RemoteFeatureFlagsStartOptions, "participates" | "pollIntervalMs">>,
): Promise<void> {
    return provider.start({ participates: () => true, pollIntervalMs: INTERVAL, ...options })
}

function document(flags: Record<string, boolean>, ttlSeconds = 3_600): FeatureFlagsDocument {
    return { flags, ttlSeconds }
}

function sourceAnswering(
    ...answers: Array<FeatureFlagsDocument | Error>
): FeatureFlagsSource & { calls: number; requestIds: string[] } {
    const source = {
        calls: 0,
        requestIds: [] as string[],
        async fetchFlags(requestId: string): Promise<FeatureFlagsDocument> {
            const answer = answers[Math.min(source.calls, answers.length - 1)]
            source.calls++
            source.requestIds.push(requestId)
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

    it("polls every hour, and every 5 minutes in a development build", () => {
        expect(rolloutPollIntervalMs(false)).toBe(3_600_000)
        expect(rolloutPollIntervalMs(true)).toBe(300_000)
    })

    it("applies the cached answers on start and asks again one interval after they were fetched", async () => {
        const scheduler = new ManualScheduler()
        const cache = new MemoryCache({ document: document({ account: true }, 600), fetchedAt: NOW - 100_000 })
        const provider = new RemoteFeatureFlagsProvider(["account"])

        await start(provider, { source: sourceAnswering(document({})), cache, scheduler, now: () => NOW })

        expect(provider.resolveFlags(["account"])).toEqual({ account: true })
        // The service's 600 s ttl does not set the pace; 100 s of the interval are already spent.
        expect(scheduler.delays()).toEqual([INTERVAL - 100_000])
    })

    it("sends the id of the request it claimed, a new one for each request", async () => {
        const scheduler = new ManualScheduler()
        const cache = new MemoryCache()
        const source = sourceAnswering(document({ account: true }))
        let now = NOW
        const provider = new RemoteFeatureFlagsProvider(["account"])

        await start(provider, { source, cache, scheduler, now: () => now })
        await scheduler.fireAll()
        now += INTERVAL
        await scheduler.fireAll()

        expect(source.requestIds).toEqual(["request-1", "request-2"])
    })

    it("does not ask while another window holds the interval's request, and looks at the shared cache when it said", async () => {
        const scheduler = new ManualScheduler()
        const cache = new MemoryCache()
        cache.deniedUntil = NOW + 15_000
        const source = sourceAnswering(document({ account: true }))
        let now = NOW
        const provider = new RemoteFeatureFlagsProvider(["account"])

        await start(provider, { source, cache, scheduler, now: () => now })
        await scheduler.fireAll()

        expect(source.calls).toBe(0)
        expect(scheduler.delays()).toEqual([15_000])

        // The other window's answer lands in the shared cache; this window applies it without asking.
        cache.entry = { document: document({ account: true }), fetchedAt: NOW + 2_000 }
        now = NOW + 15_000
        await scheduler.fireAll()

        expect(source.calls).toBe(0)
        expect(provider.resolveFlags(["account"])).toEqual({ account: true })
        expect(scheduler.delays()).toEqual([INTERVAL - 13_000])
    })

    it("answers only the eligible switches, whatever the service sends", async () => {
        const scheduler = new ManualScheduler()
        const provider = new RemoteFeatureFlagsProvider(["account"])

        await start(provider, {
            source: sourceAnswering(document({ account: true, "retired-flag": true })),
            cache: new MemoryCache(),
            scheduler,
            now: () => NOW,
        })
        await scheduler.fireAll()

        expect(provider.resolveFlags(["account", "retired-flag"])).toEqual({ account: true })
    })

    it("caches a successful answer, notifies once, and polls again one interval later whatever ttl the service sends", async () => {
        const scheduler = new ManualScheduler()
        const cache = new MemoryCache()
        const provider = new RemoteFeatureFlagsProvider(["account"])
        const onChange = vi.fn()
        provider.onDidChange(onChange)

        await start(provider, { source: sourceAnswering(document({ account: true }, 900)), cache, scheduler, now: () => NOW })
        await scheduler.fireAll()

        expect(onChange).toHaveBeenCalledTimes(1)
        expect(cache.writes).toEqual([{ document: document({ account: true }, 900), fetchedAt: NOW }])
        expect(scheduler.delays()).toEqual([INTERVAL])
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
        expect(scheduler.delays()).toEqual([INTERVAL])
    })

    it("asks at most once per interval, however often participation is re-checked", async () => {
        let now = NOW
        let reporting = true
        const scheduler = new ManualScheduler()
        const source = sourceAnswering(new Error("network"), document({ account: true }))
        const provider = new RemoteFeatureFlagsProvider(["account"])

        await start(provider, { source, cache: new MemoryCache(), scheduler, now: () => now, participates: () => reporting })
        await scheduler.fireAll()
        expect(source.calls).toBe(1)

        // Usage reporting re-announced itself a minute after a failure: the service keeps its interval.
        now += 60_000
        await provider.revalidate()
        expect(source.calls).toBe(1)
        expect(scheduler.delays()).toEqual([INTERVAL - 60_000])

        now += INTERVAL
        await provider.revalidate()
        expect(source.calls).toBe(2)
        expect(provider.resolveFlags(["account"])).toEqual({ account: true })

        // Leaving and rejoining within the interval of the last answer asks nothing either.
        reporting = false
        await provider.revalidate()
        reporting = true
        now += 60_000
        await provider.revalidate()
        expect(source.calls).toBe(2)
        expect(scheduler.delays()).toEqual([INTERVAL - 60_000])
    })

    it("logs each change of rollout outcome at info and a repeated outcome at debug", async () => {
        let now = NOW
        let reporting = true
        const levels: string[] = []
        const scheduler = new ManualScheduler()
        const source = sourceAnswering(new Error("status (404)"), new Error("status (404)"), document({ account: true }))
        const provider = new RemoteFeatureFlagsProvider(["account"])

        await start(provider, {
            source,
            cache: new MemoryCache(),
            scheduler,
            now: () => now,
            participates: () => reporting,
            log: (level) => levels.push(level),
        })
        for (let attempt = 0; attempt < 3; attempt++) {
            await scheduler.fireAll()
            now += INTERVAL
        }
        reporting = false
        await provider.revalidate()
        await provider.revalidate()

        expect(source.calls).toBe(3)
        // Failure, the same failure again, answers, leaving the rollout, still out of it.
        expect(levels).toEqual(["info", "debug", "info", "info", "debug"])
    })

    it("uses answers another window cached instead of asking again", async () => {
        const scheduler = new ManualScheduler()
        const cache = new MemoryCache({ document: document({ account: false }, 600), fetchedAt: NOW - INTERVAL })
        const source = sourceAnswering(document({ account: false }))
        const provider = new RemoteFeatureFlagsProvider(["account"])

        await start(provider, { source, cache, scheduler, now: () => NOW })
        // Another window refreshed the shared cache before this one's timer fired.
        cache.entry = { document: document({ account: true }, 600), fetchedAt: NOW }
        await scheduler.fireAll()

        expect(source.calls).toBe(0)
        expect(provider.resolveFlags(["account"])).toEqual({ account: true })
        expect(scheduler.delays()).toEqual([INTERVAL])
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
        expect(scheduler.delays()).toEqual([INTERVAL])
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
