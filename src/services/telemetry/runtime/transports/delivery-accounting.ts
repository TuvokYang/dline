export interface ExportResultLike {
    readonly code: number
    readonly error?: Error
}

export interface ExporterLike<T> {
    export(batch: T, callback: (result: ExportResultLike) => void): void
}

export interface DeliveryAccountingSnapshot {
    readonly enqueuedRecords: number
    readonly exportedBatches: number
    readonly exportedRecords: number
    readonly failedBatches: number
    readonly failedRecords: number
    readonly timedOutBatches: number
    readonly retried: "unobservable"
    readonly queueOverflowDropped: "unobservable"
}

interface MutableDeliveryAccounting {
    enqueuedRecords: number
    exportedBatches: number
    exportedRecords: number
    failedBatches: number
    failedRecords: number
    timedOutBatches: number
}

const accounting = new WeakMap<object, MutableDeliveryAccounting>()

/** Decorate only the official exporter callback boundary; SDK-private queues are intentionally not inspected. */
export function wrapExporterWithDeliveryAccounting<T>(
    exporter: ExporterLike<T>,
    countRecords: (batch: T) => number,
    timeoutMs: number,
): ExporterLike<T> {
    if (accounting.has(exporter as object)) return exporter
    const stats: MutableDeliveryAccounting = {
        enqueuedRecords: 0,
        exportedBatches: 0,
        exportedRecords: 0,
        failedBatches: 0,
        failedRecords: 0,
        timedOutBatches: 0,
    }
    accounting.set(exporter as object, stats)
    const original = exporter.export.bind(exporter)
    exporter.export = (batch, callback) => {
        const records = Math.max(0, countRecords(batch))
        stats.enqueuedRecords += records
        let settled = false
        const timer = setTimeout(() => {
            if (settled) return
            settled = true
            stats.timedOutBatches += 1
        }, timeoutMs)
        timer.unref?.()
        try {
            original(batch, (result) => {
                clearTimeout(timer)
                if (!settled) {
                    settled = true
                    if (result.code === 0) {
                        stats.exportedBatches += 1
                        stats.exportedRecords += records
                    } else {
                        stats.failedBatches += 1
                        stats.failedRecords += records
                    }
                }
                callback(result)
            })
        } catch (error) {
            clearTimeout(timer)
            if (!settled) {
                settled = true
                stats.failedBatches += 1
                stats.failedRecords += records
            }
            throw error
        }
    }
    return exporter
}

export function getDeliveryAccounting(exporter: object): DeliveryAccountingSnapshot {
    const stats = accounting.get(exporter) ?? {
        enqueuedRecords: 0,
        exportedBatches: 0,
        exportedRecords: 0,
        failedBatches: 0,
        failedRecords: 0,
        timedOutBatches: 0,
    }
    return { ...stats, retried: "unobservable", queueOverflowDropped: "unobservable" }
}
