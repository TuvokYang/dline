import { describe, expect, expectTypeOf, it } from "vitest"
import { type MetricsEmitter, NoopEmitter, noopEmitter } from "../emitter"
import type { MetricsEvent, PerformanceEvent } from "../events"
import { executionPerformanceEventId, providerPerformanceEventId, usageEventId } from "../identity"
import { accumulatePerformance, emptyPerformanceRowBody } from "../merge"
import { executionRpm, totalsOfPerformance } from "../query"
import type { PerformanceRow } from "../types"

const identity = {
    observedAtMs: Date.UTC(2026, 10, 4, 10, 0, 0),
    sequence: 1,
    workspaceId: "workspace-a",
    taskId: "task-a",
    profileId: "profile-a",
    providerId: "anthropic",
    modelId: "model-a",
    keyFingerprint: "fingerprint-a",
    logicalRequestId: "logical-a",
    roundId: "round-a",
}

function performance(overrides: Partial<PerformanceEvent> = {}): PerformanceEvent {
    return {
        ...identity,
        eventId: providerPerformanceEventId("round-a"),
        kind: "performance",
        factKind: "provider",
        providerDurationMs: 1000,
        status: "completed",
        perfQuality: "exact",
        ...overrides,
    }
}

describe("emitter contract", () => {
    /**
     * The return type is the contract: a Promise would invite an `await` on the Task's
     * hot path. TypeScript cannot forbid `await` on a `void` expression, so the real
     * call sites are audited by TASK-12303 instead of being claimed safe here.
     */
    it("declares emit as a synchronous void contract", () => {
        expectTypeOf<MetricsEmitter["emit"]>().returns.toBeVoid()
        expectTypeOf<MetricsEmitter["emit"]>().parameter(0).toEqualTypeOf<MetricsEvent>()
    })

    it("does not accept or return anything from a no-op emitter", () => {
        const emitter = new NoopEmitter()

        expect(emitter.emit(performance())).toBeUndefined()
        expect(noopEmitter.emit(performance())).toBeUndefined()
    })

    it("can be used wherever the interface is expected", () => {
        const emitter: MetricsEmitter = noopEmitter

        expect(() => emitter.emit(performance())).not.toThrow()
    })
})

describe("canonical fact identities", () => {
    it("gives a round's usage and provider facts distinct ids", () => {
        expect(usageEventId("round-a")).not.toBe(providerPerformanceEventId("round-a"))
    })

    it("gives an execution fact an id derived from the execution, not the round", () => {
        expect(executionPerformanceEventId("exec-a")).toBe("execution:exec-a")
        expect(executionPerformanceEventId("exec-a")).not.toBe(providerPerformanceEventId("round-a"))
    })

    it("needs no persisted sequence to deduplicate a repeated fact", () => {
        const first = usageEventId("round-a")
        const second = usageEventId("round-a")

        expect(first).toBe(second)
    })
})

describe("fact kinds stay apart", () => {
    function row(factKind: "provider" | "execution"): PerformanceRow {
        return {
            scopeId: "task-a",
            resolution: "minute",
            bucketStartMs: 0,
            modelId: "model-a",
            taskId: "task-a",
            profileId: "profile-a",
            keyFingerprint: "fingerprint-a",
            providerId: "anthropic",
            factKind,
            aggregatedAt: "2026-11-04T10:00:00.000Z",
            ...accumulatePerformance(
                emptyPerformanceRowBody(),
                performance(
                    factKind === "execution"
                        ? { factKind, executionId: "exec-a", executionDurationMs: 2000, providerDurationMs: undefined }
                        : {},
                ),
            ),
        }
    }

    it("increments only the counter that belongs to the fact kind", () => {
        expect(row("provider").providerRoundCount).toBe(1)
        expect(row("provider").executionCount).toBe(0)
        expect(row("execution").executionCount).toBe(1)
        expect(row("execution").providerRoundCount).toBe(0)
    })

    it("keeps execution duration as the RPM denominator", () => {
        const providerOnly = totalsOfPerformance([row("provider")])

        expect(providerOnly.executionCount).toBe(0)
        // No execution duration was measured, so throughput is unknown rather than zero:
        // reporting 0 would read as "measured no throughput", which is a different fact.
        expect(executionRpm(providerOnly)).toBeUndefined()
    })

    it("measures RPM from the execution row, not from the provider row", () => {
        const both = totalsOfPerformance([row("provider"), row("execution")])

        expect(both.executionCount).toBe(1)
        expect(executionRpm(both)).toBeCloseTo(30, 10)
    })

    it("records a zero-tool execution as a real execution", () => {
        const execution = row("execution")

        expect(execution.executionCount).toBe(1)
        expect(execution.requestCount).toBe(1)
        expect(execution.executionDurationMs).toBe(2000)
    })
})
