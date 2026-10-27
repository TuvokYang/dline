import fs from "node:fs/promises"
import path from "node:path"
import { backupPathOf } from "@shared/storage/atomic-file"
import { FileLock } from "../backend/jsonl/FileLock"
import { type OtelStorageLayout, resolveOtelStorageLayout } from "./OtelStorageLayout"
import { discardDocument, recordDiscard } from "./quarantine"

/** A file an earlier build wrote that no current owner reads. */
interface RetiredDocument {
    /** Stable label used in the loss evidence. */
    readonly document: string
    readonly filePath: string
    /** Builds that wrote it held this file lock while writing; the discard takes it too. */
    readonly locked: boolean
}

/** Usage observation shards of the earlier logical intake; the current spool writes only `*.attempts*.jsonl`. */
const SHARD_SUFFIX = ".jsonl"
const ATTEMPT_SHARD_PATTERN = /\.attempts(?:\.sealed)?\.jsonl$/

/**
 * Delete telemetry state that earlier builds wrote and the contract 5 client
 * never reads, leaving metadata-only loss evidence for each.
 *
 * It runs whatever the current consent: nothing in this state may be sent under
 * the current contract, and keeping it would only retain a credential or records
 * the user can no longer act on. The names live here rather than in the layout,
 * which describes current state only. Safe to run on every start: once the files
 * are gone it reads two directories and writes nothing.
 */
export async function retireLegacyTelemetryState(dataDir: string, now: number = Date.now()): Promise<void> {
    const layout = resolveOtelStorageLayout(dataDir)
    for (const retired of retiredDocuments(dataDir, layout)) {
        await retireDocument(retired, layout.remoteQuarantineDir, now)
    }
    await retireObservationShards(layout, now)
}

function retiredDocuments(dataDir: string, layout: OtelStorageLayout): readonly RetiredDocument[] {
    return [
        {
            // The one-time pairing code of the retired local collector design; nothing ever redeemed it.
            document: "pairing-credential",
            filePath: path.join(path.resolve(dataDir), "secrets", "telemetry-authorization.json"),
            locked: false,
        },
        {
            // The journal of the retired support control plane.
            document: "support-operation",
            filePath: path.join(layout.secretsDir, "support-operation.json"),
            locked: false,
        },
        {
            // The diagnostics queue of builds before the stable outbox name, encoded under an earlier contract.
            document: "diagnostics-outbox-v2",
            filePath: path.join(layout.remoteDir, "diagnostics", "outbox-v2.json"),
            locked: true,
        },
    ]
}

async function retireDocument(retired: RetiredDocument, quarantineDir: string, now: number): Promise<void> {
    // The usual start finds nothing; it then takes no lock and creates nothing.
    if (!(await exists(retired.filePath)) && !(await exists(backupPathOf(retired.filePath)))) return
    const discard = () =>
        discardDocument(retired.filePath, quarantineDir, { document: retired.document, reason: "retired_document" }, now)
    if (retired.locked) await new FileLock().withLock(retired.filePath, discard)
    else await discard()
}

async function retireObservationShards(layout: OtelStorageLayout, now: number): Promise<void> {
    let names: string[]
    try {
        names = await fs.readdir(layout.usageObservationsDir)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return
        throw error
    }
    const retired = names.filter((name) => name.endsWith(SHARD_SUFFIX) && !ATTEMPT_SHARD_PATTERN.test(name))
    if (retired.length === 0) return
    await recordDiscard(
        layout.remoteQuarantineDir,
        { document: "usage-observation-shards", reason: "retired_document", counts: { shards: retired.length } },
        now,
    )
    for (const name of retired) {
        await fs.rm(path.join(layout.usageObservationsDir, name), { force: true })
    }
}

function exists(filePath: string): Promise<boolean> {
    return fs.access(filePath).then(
        () => true,
        () => false,
    )
}
