import type { Context } from "@opentelemetry/api"
import type { LogRecord, LogRecordProcessor } from "@opentelemetry/sdk-logs"

/**
 * Delivers each record only to the processors registered for its scope.
 *
 * Sharing a `LoggerProvider` between product analytics and runtime diagnostics
 * is only safe if each destination still sees exactly the records it is allowed
 * to see. A provider broadcasts every record to every registered processor, so
 * attaching both subsystems directly would send runtime diagnostics — task
 * identifiers, command names, error stacks — to whichever collector an
 * organization configured for product statistics. The workstream contract
 * forbids exactly that.
 *
 * The instrumentation scope is the right discriminator because the SDK stamps
 * it on the record at emit time from the logger that produced it, so a producer
 * cannot spoof it by setting an attribute.
 *
 * Routing is table-driven rather than one wrapper per subsystem because the SDK
 * offers no way to unregister a processor. A subsystem whose consent is revoked
 * and later granted again must be able to detach and re-attach; with fixed
 * wrappers each cycle would leave a dead processor behind and register a
 * duplicate alongside it.
 *
 * Routes are keyed by scope *and* by an owner id because one scope can have
 * several independent destinations: product analytics may report to a
 * user-configured collector and an organization-configured one at the same
 * time. Keying by scope alone would make the second registration evict the
 * first, silently stopping delivery to a collector that was still configured.
 */
export class ScopeRouterProcessor implements LogRecordProcessor {
    private readonly routes = new Map<string, Map<string, LogRecordProcessor[]>>()

    /**
     * Replaces the processors registered by one owner for one scope.
     *
     * Other owners on the same scope, and every other scope, are untouched.
     */
    setRoute(scopeName: string, ownerId: string, processors: readonly LogRecordProcessor[]): void {
        if (processors.length === 0) {
            this.clearRoute(scopeName, ownerId)
            return
        }
        const owners = this.routes.get(scopeName) ?? new Map<string, LogRecordProcessor[]>()
        owners.set(ownerId, [...processors])
        this.routes.set(scopeName, owners)
    }

    clearRoute(scopeName: string, ownerId: string): void {
        const owners = this.routes.get(scopeName)
        if (!owners) return
        owners.delete(ownerId)
        if (owners.size === 0) {
            this.routes.delete(scopeName)
        }
    }

    /** Number of scopes with at least one registered owner. */
    get scopeCount(): number {
        return this.routes.size
    }

    onEmit(logRecord: LogRecord, context?: Context): void {
        const owners = this.routes.get(logRecord.instrumentationScope.name)
        if (!owners) {
            return
        }
        for (const processors of owners.values()) {
            for (const processor of processors) {
                processor.onEmit(logRecord, context)
            }
        }
    }

    async forceFlush(): Promise<void> {
        await Promise.all(this.all().map((processor) => processor.forceFlush()))
    }

    async shutdown(): Promise<void> {
        const processors = this.all()
        this.routes.clear()
        await Promise.all(processors.map((processor) => processor.shutdown()))
    }

    private all(): LogRecordProcessor[] {
        return [...this.routes.values()].flatMap((owners) => [...owners.values()].flat())
    }
}
