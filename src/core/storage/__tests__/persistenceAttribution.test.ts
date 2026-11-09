import { describe, expect, it } from "vitest"
import {
    attributeSlowestStore,
    bucketMessageCount,
    classifyDirtyScope,
    type FlushStoreCosts,
    SLOW_FLUSH_THRESHOLD_MS,
} from "../persistence-attribution"

/**
 * Attribution guard for `settings.state_flush`.
 *
 * `flushPendingState` drains until nothing is pending, so one flush can write
 * several batches. Each batch publishes only its own complete sample, which made
 * the last batch that settled look like the cause: a slow task batch followed by
 * a fast settings batch was reported as `settings`. These assertions pin the
 * dimension to the store that actually consumed the flush.
 */
describe("attributeSlowestStore", () => {
    it("names the store that dominated a flush over several batches", () => {
        // Two drained batches: task was slow, settings finished quickly after.
        const costs: FlushStoreCosts = { global: 3, settings: 15, secrets: 2, workspace: 4, task: 240 }

        expect(attributeSlowestStore(400, costs)).toBe("task")
    })

    it("does not attribute a flush that finished under the threshold", () => {
        const costs: FlushStoreCosts = { task: SLOW_FLUSH_THRESHOLD_MS }

        // A fast flush has no interesting cause; naming one would be a false lead.
        expect(attributeSlowestStore(SLOW_FLUSH_THRESHOLD_MS - 1, costs)).toBe("not_applicable")
    })

    it("reports unknown when no batch cost was recorded", () => {
        // A slow flush with no sample must not guess a store.
        expect(attributeSlowestStore(SLOW_FLUSH_THRESHOLD_MS, undefined)).toBe("unknown")
        expect(attributeSlowestStore(SLOW_FLUSH_THRESHOLD_MS, {})).toBe("unknown")
    })

    it("accumulates repeated batches of the same store", () => {
        // Three drains of one store: the sum is what made the flush slow, and a
        // single-batch reading would have understated it.
        const costs: FlushStoreCosts = { task: 90 + 90 + 90, settings: 20 }

        expect(attributeSlowestStore(400, costs)).toBe("task")
    })
})

describe("classifyDirtyScope", () => {
    it("separates value stores, task stores, both, and neither", () => {
        expect(classifyDirtyScope({ settings: 0, secrets: 0, workspace: 0, tasks: 0 })).toBe("none")
        expect(classifyDirtyScope({ settings: 1, secrets: 0, workspace: 0, tasks: 0 })).toBe("settings")
        expect(classifyDirtyScope({ settings: 0, secrets: 0, workspace: 0, tasks: 2 })).toBe("task")
        expect(classifyDirtyScope({ settings: 0, secrets: 1, workspace: 0, tasks: 1 })).toBe("mixed")
    })
})

describe("bucketMessageCount", () => {
    it("switches bucket exactly at the documented boundaries", () => {
        // The bucket is a low-cardinality substitute for the message count, so an
        // off-by-one here would silently shift a whole population into the wrong
        // bucket.
        expect(bucketMessageCount(999)).toBe("<1000")
        expect(bucketMessageCount(1000)).toBe("<5000")
        expect(bucketMessageCount(4999)).toBe("<5000")
        expect(bucketMessageCount(5000)).toBe(">=5000")
    })
})
