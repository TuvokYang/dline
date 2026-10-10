import { InMemoryLogRecordExporter, SimpleLogRecordProcessor } from "@opentelemetry/sdk-logs"
import { ATTR_SERVICE_INSTANCE_ID, ATTR_SERVICE_NAME } from "@opentelemetry/semantic-conventions/incubating"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { RUNTIME_SCOPE_NAME, USAGE_SCOPE_NAME } from "../scopes"
import {
    attachScopedProcessors,
    configureSharedTelemetryResource,
    detachScope,
    getSharedLoggerProvider,
    resetSharedLoggerProviderForTesting,
} from "../shared-logger-provider"

/**
 * Product analytics and runtime diagnostics share one `LoggerProvider`, so the
 * isolation between them is no longer a consequence of them being separate
 * objects — it is a property this module has to enforce.
 *
 * The failure these tests exist to prevent is a silent one: a provider
 * broadcasts every record to every registered processor, so a mistake here
 * would ship runtime diagnostics to whichever collector an organization
 * configured for usage statistics, with nothing failing to indicate it.
 */

describe("shared logger provider", () => {
    let productExporter: InMemoryLogRecordExporter
    let runtimeExporter: InMemoryLogRecordExporter

    beforeEach(() => {
        resetSharedLoggerProviderForTesting()
        productExporter = new InMemoryLogRecordExporter()
        runtimeExporter = new InMemoryLogRecordExporter()
    })

    afterEach(() => {
        resetSharedLoggerProviderForTesting()
    })

    function attachBoth(): void {
        attachScopedProcessors(USAGE_SCOPE_NAME, "product", [new SimpleLogRecordProcessor(productExporter)])
        attachScopedProcessors(RUNTIME_SCOPE_NAME, "runtime", [new SimpleLogRecordProcessor(runtimeExporter)])
    }

    function bodies(exporter: InMemoryLogRecordExporter): unknown[] {
        return exporter.getFinishedLogRecords().map((record) => record.body)
    }

    it("delivers a record only to the scope that emitted it", () => {
        attachBoth()
        const provider = getSharedLoggerProvider()
        expect(provider).toBeDefined()

        provider?.getLogger(USAGE_SCOPE_NAME).emit({ body: "product.event" })
        provider?.getLogger(RUNTIME_SCOPE_NAME).emit({ body: "runtime.event" })

        expect(bodies(productExporter)).toEqual(["product.event"])
        expect(bodies(runtimeExporter)).toEqual(["runtime.event"])
    })

    it("hands both subsystems the same provider instance", () => {
        const first = attachScopedProcessors(USAGE_SCOPE_NAME, "product", [new SimpleLogRecordProcessor(productExporter)])
        const second = attachScopedProcessors(RUNTIME_SCOPE_NAME, "runtime", [new SimpleLogRecordProcessor(runtimeExporter)])

        expect(second).toBe(first)
    })

    it("publishes one service identity for every scope", () => {
        configureSharedTelemetryResource({ sessionId: "instance-42" })
        attachBoth()
        const provider = getSharedLoggerProvider()

        provider?.getLogger(USAGE_SCOPE_NAME).emit({ body: "product.event" })
        provider?.getLogger(RUNTIME_SCOPE_NAME).emit({ body: "runtime.event" })

        const [productRecord] = productExporter.getFinishedLogRecords()
        const [runtimeRecord] = runtimeExporter.getFinishedLogRecords()

        expect(productRecord.resource.attributes[ATTR_SERVICE_NAME]).toBe("dline")
        expect(runtimeRecord.resource.attributes[ATTR_SERVICE_NAME]).toBe("dline")
        expect(runtimeRecord.resource.attributes[ATTR_SERVICE_INSTANCE_ID]).toBe("instance-42")
    })

    it("stops one scope without silencing the other", () => {
        attachBoth()
        const provider = getSharedLoggerProvider()

        detachScope(RUNTIME_SCOPE_NAME, "runtime")
        provider?.getLogger(USAGE_SCOPE_NAME).emit({ body: "product.event" })
        provider?.getLogger(RUNTIME_SCOPE_NAME).emit({ body: "runtime.event" })

        expect(bodies(productExporter)).toEqual(["product.event"])
        expect(runtimeExporter.getFinishedLogRecords()).toHaveLength(0)
    })

    it("replaces a scope's processors when the same owner re-attaches", () => {
        attachScopedProcessors(RUNTIME_SCOPE_NAME, "runtime", [new SimpleLogRecordProcessor(runtimeExporter)])

        // A pipeline that stops and starts again must not leave its previous
        // processor behind, or every event would be exported twice.
        const replacement = new InMemoryLogRecordExporter()
        attachScopedProcessors(RUNTIME_SCOPE_NAME, "runtime", [new SimpleLogRecordProcessor(replacement)])

        getSharedLoggerProvider()?.getLogger(RUNTIME_SCOPE_NAME).emit({ body: "runtime.event" })

        expect(runtimeExporter.getFinishedLogRecords()).toHaveLength(0)
        expect(bodies(replacement)).toEqual(["runtime.event"])
    })

    it("keeps independent collectors on one scope from displacing each other", () => {
        // A user-configured and an organization-configured collector can both
        // be active; keying routes by scope alone would let the second silently
        // disconnect the first.
        const organization = new InMemoryLogRecordExporter()
        attachScopedProcessors(USAGE_SCOPE_NAME, "user-collector", [new SimpleLogRecordProcessor(productExporter)])
        attachScopedProcessors(USAGE_SCOPE_NAME, "org-collector", [new SimpleLogRecordProcessor(organization)])

        getSharedLoggerProvider()?.getLogger(USAGE_SCOPE_NAME).emit({ body: "product.event" })

        expect(bodies(productExporter)).toEqual(["product.event"])
        expect(bodies(organization)).toEqual(["product.event"])
    })

    it("ignores records from a scope nothing is listening to", () => {
        attachScopedProcessors(USAGE_SCOPE_NAME, "product", [new SimpleLogRecordProcessor(productExporter)])

        expect(() => getSharedLoggerProvider()?.getLogger("dline.unregistered").emit({ body: "stray" })).not.toThrow()
        expect(productExporter.getFinishedLogRecords()).toHaveLength(0)
    })

    it("builds no provider until a subsystem attaches", () => {
        expect(getSharedLoggerProvider()).toBeUndefined()
    })

    it("adopts a new session identity once every subsystem has detached", () => {
        // A host can stop and restart telemetry within one process. The SDK
        // binds the resource when the provider is constructed, so a provider
        // held past the last detach would keep stamping the previous session
        // id and make the next run's records unattributable to it.
        configureSharedTelemetryResource({ sessionId: "first-session" })
        attachScopedProcessors(RUNTIME_SCOPE_NAME, "runtime", [new SimpleLogRecordProcessor(runtimeExporter)])
        detachScope(RUNTIME_SCOPE_NAME, "runtime")

        configureSharedTelemetryResource({ sessionId: "second-session" })
        const replacement = new InMemoryLogRecordExporter()
        attachScopedProcessors(RUNTIME_SCOPE_NAME, "runtime", [new SimpleLogRecordProcessor(replacement)])
        getSharedLoggerProvider()?.getLogger(RUNTIME_SCOPE_NAME).emit({ body: "runtime.event" })

        const [record] = replacement.getFinishedLogRecords()
        expect(record.resource.attributes[ATTR_SERVICE_INSTANCE_ID]).toBe("second-session")
    })
})
