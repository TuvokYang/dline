/**
 * The metrics worker entry.
 *
 * Everything that touches `metrics.db` runs here: the ledger open and every write
 * transaction. The extension host only hands over events and reads already committed
 * rows, so a busy or slow disk cannot stall a Task's turn.
 *
 * This file must stay free of extension-host services. It receives a scope descriptor
 * and nothing else, because a worker has no VS Code API and must not try to resolve
 * one.
 */

import { parentPort, workerData } from "node:worker_threads"
import type { MetricsEvent } from "@shared/metrics/events"
import type { MetricsWorkerCommand, MetricsWorkerReply } from "./MetricsFlushHost"
import { MetricsLedger } from "./MetricsLedger"
import type { MetricsScope } from "./MetricsScope"

interface MetricsWorkerData {
    readonly scope: MetricsScope
}

const port = parentPort

if (!port) {
    throw new Error("The metrics worker must be started as a worker thread")
}

const { scope } = workerData as MetricsWorkerData

let ledger: MetricsLedger | undefined
let opening: Promise<MetricsLedger> | undefined
let closing = false

function openLedger(): Promise<MetricsLedger> {
    // A failed open must not be remembered. Opening touches the schema, so a contended
    // `SQLITE_BUSY` can fail here rather than in the commit; caching that rejection
    // would make every later flush fail without touching the file again, which would
    // turn a transient lock into a permanent loss of the retry the host just kept.
    opening ??= MetricsLedger.open({ scope }).catch((error: unknown) => {
        opening = undefined
        throw error
    })
    return opening
}

async function handle(command: MetricsWorkerCommand): Promise<MetricsWorkerReply> {
    // Every reply echoes the id it answers: the host decides from it whether the batch
    // it is still waiting for was the one just written.
    const { requestId } = command
    if (command.type === "flush") {
        if (closing) return { type: "failed", requestId, message: "metrics worker is closing" }
        try {
            const target = await openLedger()
            const outcome = await target.commitBatch(command.events)
            return { type: "flushed", requestId, storedEvents: outcome.accepted, lostEvents: 0 }
        } catch (error) {
            return {
                type: "failed",
                requestId,
                message: error instanceof Error ? error.message : "metrics write failed",
            }
        }
    }

    closing = true
    const current = ledger ?? (await opening?.catch(() => undefined))
    ledger = undefined
    opening = undefined
    await current?.close()
    return { type: "stopped", requestId }
}

port.on("message", (command: MetricsWorkerCommand) => {
    void handle(command)
        .then((reply) => {
            if (reply.type === "stopped") closing = true
            port.postMessage(reply)
            if (reply.type === "stopped") {
                // Let the reply leave the port before the thread ends.
                setImmediate(() => process.exit(0))
            }
        })
        .catch((error: unknown) => {
            // This path has no command to answer, so it can only report the failure. A
            // reply without a matching id is ignored by the host, which then reaches its
            // own deadline and requeues the batch instead of assuming it was written.
            port.postMessage({
                type: "failed",
                requestId: -1,
                message: error instanceof Error ? error.message : "metrics worker failed",
            } satisfies MetricsWorkerReply)
        })
})

/** Keep the event type reachable for the host's message contract. */
export type { MetricsEvent }
