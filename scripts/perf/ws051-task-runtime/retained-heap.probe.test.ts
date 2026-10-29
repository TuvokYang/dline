import { BLOCKS_PER_FIXTURE, FIXTURE_REPLICAS, makeDenseFixture, validateDenseFixture } from "@perf/retained-fixture"
import { expect, it } from "vitest"

const HOLDER = Symbol.for("ws051.runtime.retained.heap")

function forceGc(): void {
    const gc = (globalThis as typeof globalThis & { gc?: () => void }).gc
    if (typeof gc !== "function") throw new Error("global.gc is unavailable; the probe must run with --expose-gc")
    gc()
    gc()
    gc()
}

it("measures recovered task-owned runtime authorities after forced GC", () => {
    let warmup: ReturnType<typeof makeDenseFixture> | undefined = makeDenseFixture("warmup")
    validateDenseFixture(warmup)
    warmup = undefined
    forceGc()

    const host = globalThis as typeof globalThis & Record<PropertyKey, unknown>
    host[HOLDER] = []
    forceGc()
    const before = process.memoryUsage().heapUsed
    const retained = Array.from({ length: FIXTURE_REPLICAS }, (_, index) => makeDenseFixture(`sample-${index}`))
    host[HOLDER] = retained
    forceGc()
    const retainedBytes = process.memoryUsage().heapUsed - before

    expect(retainedBytes).toBeGreaterThan(1_048_576)
    console.log(
        `WS051_SAMPLE ${JSON.stringify({
            metric: "retained_heap",
            variant: process.env.WS051_VARIANT,
            pid: process.pid,
            runId: process.env.WS051_RUN_ID,
            replicas: FIXTURE_REPLICAS,
            blocksPerFixture: BLOCKS_PER_FIXTURE,
            retainedBytes,
            bytesPerFixture: retainedBytes / FIXTURE_REPLICAS,
        })}`,
    )
})
