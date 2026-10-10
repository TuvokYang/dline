import type { Resource } from "@opentelemetry/resources"
import { LoggerProvider, type LogRecordProcessor } from "@opentelemetry/sdk-logs"
import { ScopeRouterProcessor } from "./scoped-log-record-processor"
import { createTelemetryResource } from "./telemetry-resource"

/**
 * The one `LoggerProvider` shared by product analytics and runtime diagnostics.
 *
 * The two subsystems previously each built their own provider, resource and
 * export stack. Consolidating them means a single service identity reaches the
 * backend and one place configures export, instead of two that could disagree.
 *
 * Sharing a provider does not merge the data: every subsystem attaches its own
 * processors under its own instrumentation scope, and the router delivers a
 * record only to the processors registered for the scope that produced it.
 * Consent therefore stays per-subsystem — attaching one has no effect on the
 * other, and detaching one leaves the other running.
 *
 * The provider is created on first attach rather than at import time so a host
 * where no subsystem is permitted to report never builds one at all.
 */

let provider: LoggerProvider | undefined
let router: ScopeRouterProcessor | undefined
let sharedResource: Resource | undefined

/**
 * Identifies the extension host run for every subsystem.
 *
 * Must be set before the first attach to appear on the resource; the SDK binds
 * the resource when the provider is constructed.
 */
export function configureSharedTelemetryResource(options: { sessionId?: string } = {}): void {
    if (provider) return
    sharedResource = createTelemetryResource(options)
}

/**
 * Route records from `scopeName` to `processors` and return the shared provider.
 *
 * `ownerId` identifies the registering component. Re-attaching with the same
 * owner replaces that owner's processors, so a subsystem that stops and
 * restarts does not accumulate duplicates, while a different owner on the same
 * scope — a second collector, for instance — is left connected.
 */
export function attachScopedProcessors(
    scopeName: string,
    ownerId: string,
    processors: readonly LogRecordProcessor[],
): LoggerProvider {
    const target = ensureProvider()
    router?.setRoute(scopeName, ownerId, processors)
    return target
}

/**
 * Stop routing records for one owner of one scope.
 *
 * The provider stays alive while any other subsystem is still reporting
 * through it. The caller remains responsible for shutting down the processors
 * it attached, since only it knows whether their buffers must be flushed first.
 *
 * When the last route goes away the provider is released rather than kept for
 * reuse. The SDK binds the resource at construction, so a provider held across
 * a restart would keep stamping the previous run's `service.instance.id` and
 * make the new session's records attributable to the old one. Releasing it is
 * safe precisely because nothing is listening at that point.
 */
export function detachScope(scopeName: string, ownerId: string): void {
    router?.clearRoute(scopeName, ownerId)
    if (router && router.scopeCount === 0) {
        const released = provider
        provider = undefined
        router = undefined
        sharedResource = undefined
        // No routes remain, so shutdown cannot affect another subsystem. The
        // detached owner closes its own processors separately.
        void released?.shutdown().catch(() => undefined)
    }
}

export function getSharedLoggerProvider(): LoggerProvider | undefined {
    return provider
}

/** Test seam: drops state without touching a provider owned by another test. */
export function resetSharedLoggerProviderForTesting(): void {
    provider = undefined
    router = undefined
    sharedResource = undefined
}

function ensureProvider(): LoggerProvider {
    if (provider) return provider

    const created = new LoggerProvider({ resource: sharedResource ?? createTelemetryResource() })
    const scopeRouter = new ScopeRouterProcessor()
    // The router is the provider's only processor: everything else hangs off
    // it, which is what keeps scope isolation from depending on registration
    // order at each call site.
    created.addLogRecordProcessor(scopeRouter)

    provider = created
    router = scopeRouter
    return created
}
