import { describe, expect, it, vi } from "vitest"
import { type ExporterLike, getDeliveryAccounting, wrapExporterWithDeliveryAccounting } from "./delivery-accounting"

interface Batch {
    readonly records: readonly string[]
}

function exporter(result: { code: number }): ExporterLike<Batch> {
    return { export: (_batch, callback) => callback(result) }
}

describe("delivery accounting", () => {
    it("counts callback-level exported and failed batches without inventing SDK-private values", () => {
        const succeeded = exporter({ code: 0 })
        const failed = exporter({ code: 1 })
        wrapExporterWithDeliveryAccounting(succeeded, (batch) => batch.records.length, 1_000)
        wrapExporterWithDeliveryAccounting(failed, (batch) => batch.records.length, 1_000)

        succeeded.export({ records: ["a", "b"] }, () => undefined)
        failed.export({ records: ["c"] }, () => undefined)

        expect(getDeliveryAccounting(succeeded)).toEqual({
            enqueuedRecords: 2,
            exportedBatches: 1,
            exportedRecords: 2,
            failedBatches: 0,
            failedRecords: 0,
            timedOutBatches: 0,
            retried: "unobservable",
            queueOverflowDropped: "unobservable",
        })
        expect(getDeliveryAccounting(failed)).toMatchObject({ failedBatches: 1, failedRecords: 1 })
    })

    it("records a timeout once while leaving callback ownership with the exporter", () => {
        vi.useFakeTimers()
        const pending: ExporterLike<Batch> = { export: () => undefined }
        wrapExporterWithDeliveryAccounting(pending, (batch) => batch.records.length, 25)

        pending.export({ records: ["a"] }, () => undefined)
        vi.advanceTimersByTime(25)

        expect(getDeliveryAccounting(pending).timedOutBatches).toBe(1)
        vi.useRealTimers()
    })
})
