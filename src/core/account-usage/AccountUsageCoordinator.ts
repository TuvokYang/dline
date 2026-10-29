import type { AccountUsage } from "@core/api"

interface CacheEntry {
    value: AccountUsage | undefined
    fetchedAt: number
    inFlight?: Promise<AccountUsage | undefined>
}

/**
 * Process-wide cache and in-flight deduplication for provider account usage.
 *
 * Controllers intentionally keep their own presentation timers, but identical
 * profiles share the same network request. This prevents one balance request
 * per editor tab while still allowing every tab to display the latest value.
 */
export class AccountUsageCoordinator {
    private readonly entries = new Map<string, CacheEntry>()

    constructor(
        private readonly ttlMs = 55_000,
        private readonly now: () => number = Date.now,
    ) {}

    async get(key: string, loader: () => Promise<AccountUsage | undefined>): Promise<AccountUsage | undefined> {
        const existing = this.entries.get(key)
        if (existing?.inFlight) {
            return existing.inFlight
        }
        if (existing && this.now() - existing.fetchedAt < this.ttlMs) {
            return existing.value
        }

        const entry: CacheEntry = existing ?? { value: undefined, fetchedAt: 0 }
        const inFlight = loader()
            .then((value) => {
                entry.value = value
                entry.fetchedAt = this.now()
                return value
            })
            .finally(() => {
                if (entry.inFlight === inFlight) {
                    entry.inFlight = undefined
                }
            })
        entry.inFlight = inFlight
        this.entries.set(key, entry)
        return inFlight
    }

    deleteByPrefix(prefix: string): void {
        for (const key of this.entries.keys()) {
            if (key.startsWith(prefix)) this.entries.delete(key)
        }
    }

    clear(): void {
        this.entries.clear()
    }
}

export const accountUsageCoordinator = new AccountUsageCoordinator()
