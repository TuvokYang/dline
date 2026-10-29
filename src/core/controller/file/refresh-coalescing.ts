import type { Controller } from "../index"

/**
 * Coalesce concurrent capability discovery scans that belong to one controller.
 *
 * The capability panel polls several independent refresh RPCs on short timers
 * while task startup and state publishes trigger the same scans again. On a
 * large workspace a single scan can take seconds, so without coalescing dozens
 * of identical filesystem walks pile up and saturate the shared libuv thread
 * pool, which then delays unrelated I/O such as checkpoint Git work.
 *
 * Only in-flight work is shared; nothing is cached. Once a scan settles the
 * slot is released, so the next caller always starts a fresh scan and observes
 * current disk state.
 *
 * Entries are keyed per controller because discovery resolves against that
 * controller's stored preferences, and are held in a WeakMap so a disposed
 * controller does not keep its pending scans reachable.
 */
const inFlightScansByController = new WeakMap<Controller, Map<string, Promise<unknown>>>()

export function coalesceCapabilityScan<T>(controller: Controller, scanKey: string, scan: () => Promise<T>): Promise<T> {
    let scansByKey = inFlightScansByController.get(controller)
    if (!scansByKey) {
        scansByKey = new Map()
        inFlightScansByController.set(controller, scansByKey)
    }

    const existing = scansByKey.get(scanKey) as Promise<T> | undefined
    if (existing) {
        return existing
    }

    const pending = scan().finally(() => {
        if (scansByKey.get(scanKey) === pending) {
            scansByKey.delete(scanKey)
        }
    })
    scansByKey.set(scanKey, pending)
    return pending
}
