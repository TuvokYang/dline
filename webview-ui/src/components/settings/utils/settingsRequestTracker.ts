export class SettingsRequestTracker {
    private readonly pendingRequests = new Set<Promise<unknown>>()
    private readonly pendingRequestKeys = new Map<Promise<unknown>, readonly string[]>()
    private readonly latestRequestIds = new Map<string, number>()
    private readonly failures = new Map<string, unknown>()
    private readonly requestTails = new Map<string, Promise<void>>()
    private nextRequestId = 0

    trackQueued<T>(requestKeys: readonly string[], request: () => Promise<T>, errorMessage: string): Promise<T> {
        const dependencies = [
            ...new Set(
                requestKeys
                    .map((requestKey) => this.requestTails.get(requestKey))
                    .filter((dependency): dependency is Promise<void> => dependency !== undefined),
            ),
        ]
        const started = Promise.allSettled(dependencies).then(request)
        const tracked = this.track(requestKeys, started, errorMessage)
        const tail = tracked.then(
            () => undefined,
            () => undefined,
        )
        for (const requestKey of requestKeys) {
            this.requestTails.set(requestKey, tail)
        }
        void tail.finally(() => {
            for (const requestKey of requestKeys) {
                if (this.requestTails.get(requestKey) === tail) this.requestTails.delete(requestKey)
            }
        })
        return tracked
    }

    track<T>(requestKeys: readonly string[], request: Promise<T>, errorMessage: string): Promise<T> {
        const requestId = ++this.nextRequestId
        for (const requestKey of requestKeys) {
            this.latestRequestIds.set(requestKey, requestId)
        }

        const tracked = request.then(
            (value) => {
                for (const requestKey of requestKeys) {
                    if (this.latestRequestIds.get(requestKey) === requestId) {
                        this.failures.delete(requestKey)
                    }
                }
                return value
            },
            (error: unknown) => {
                console.error(errorMessage, error)
                for (const requestKey of requestKeys) {
                    if (this.latestRequestIds.get(requestKey) === requestId) {
                        this.failures.set(requestKey, error)
                    }
                }
                throw error
            },
        )

        this.pendingRequests.add(tracked)
        this.pendingRequestKeys.set(tracked, requestKeys)
        void tracked
            .finally(() => {
                this.pendingRequests.delete(tracked)
                this.pendingRequestKeys.delete(tracked)
            })
            .catch(() => undefined)
        return tracked
    }

    async flushPrefix(requestKeyPrefix: string): Promise<void> {
        await this.flushMatching((requestKey) => requestKey.startsWith(requestKeyPrefix))
    }

    async flush(): Promise<void> {
        await this.flushMatching(() => true)
    }

    private async flushMatching(matches: (requestKey: string) => boolean): Promise<void> {
        while (true) {
            const matchingRequests = [...this.pendingRequests].filter((request) =>
                this.pendingRequestKeys.get(request)?.some(matches),
            )
            if (matchingRequests.length === 0) break
            await Promise.allSettled(matchingRequests)
        }

        const failures = [...new Set([...this.failures].filter(([requestKey]) => matches(requestKey)).map(([, error]) => error))]
        if (failures.length === 1) {
            throw failures[0]
        }
        if (failures.length > 1) {
            throw new AggregateError(failures, "Multiple Settings updates failed")
        }
    }
}
