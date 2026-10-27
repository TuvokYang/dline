import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { backupPathOf, renameWithRetry, writeJsonAtomic } from "@shared/storage/atomic-file"

/** Quarantined copies kept per document; older ones are deleted so a recurring fault cannot fill the disk. */
export const MAX_QUARANTINED_DOCUMENTS = 3
export const OWNER_ONLY_DIRECTORY_MODE = 0o700

/**
 * Told the file name of a document this process just moved aside. A quarantine
 * restarts the document's state, so the owner reports it instead of letting the
 * reset pass silently.
 */
export type QuarantineObserver = (documentName: string) => void

/**
 * Move a document that failed validation aside instead of overwriting it.
 *
 * The caller holds the document's lock. The moved copy keeps its original bytes
 * and permissions for diagnosis, and the next write starts from a clean slate.
 * Returns whether this call moved the document.
 */
export async function quarantineDocument(filePath: string, quarantineDir: string, now: number): Promise<boolean> {
    await fs.mkdir(quarantineDir, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE })
    const { name, ext } = path.parse(filePath)
    try {
        await renameWithRetry(filePath, path.join(quarantineDir, `${name}.${now}.${randomUUID()}${ext}`))
    } catch (error) {
        // Another process quarantined or replaced it first.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
        throw error
    }
    await pruneQuarantine(quarantineDir, name)
    return true
}

/** Why telemetry state was deleted instead of read. */
export type DiscardReason = "retired_document" | "older_schema"

/**
 * Metadata-only evidence of telemetry state this build deleted without reading
 * it. `document` is a stable, file-name-safe label; it names the evidence file
 * and shares the per-document bound with quarantined copies of that name.
 */
export interface DiscardEvidence {
    readonly document: string
    readonly reason: DiscardReason
    /** Schema version the discarded state declared, when it declared one. */
    readonly schemaVersion?: number
    /** Bounded counts of what was lost, such as records or shards; never the content itself. */
    readonly counts?: Readonly<Record<string, number>>
}

const DISCARD_DOCUMENT_PATTERN = /^[a-z0-9-]{1,64}$/

/**
 * Leave loss evidence for state this build drops instead of migrating.
 *
 * Only metadata is written: discarded state may hold credentials or records the
 * user consented to send under an older contract, and neither may outlive the
 * decision to drop it.
 */
export async function recordDiscard(quarantineDir: string, evidence: DiscardEvidence, now: number): Promise<void> {
    if (!DISCARD_DOCUMENT_PATTERN.test(evidence.document)) throw new Error("Discard evidence document label is invalid")
    await fs.mkdir(quarantineDir, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE })
    await writeJsonAtomic(
        path.join(quarantineDir, `${evidence.document}.${now}.${randomUUID()}.discarded.json`),
        {
            schema_version: 1,
            kind: "telemetry_state_discarded",
            document: evidence.document,
            reason: evidence.reason,
            ...(evidence.schemaVersion === undefined ? {} : { found_schema_version: evidence.schemaVersion }),
            ...(evidence.counts ? { counts: { ...evidence.counts } } : {}),
            recorded_at: now,
        },
        { fsync: true },
    )
    await pruneQuarantine(quarantineDir, evidence.document)
}

/**
 * Delete a document and its backup after leaving metadata-only loss evidence.
 * The evidence is written first, so a crash in between repeats the discard
 * rather than losing its record. The caller holds the document's lock when
 * another writer may race. Returns whether anything was deleted.
 */
export async function discardDocument(
    filePath: string,
    quarantineDir: string,
    evidence: DiscardEvidence,
    now: number,
): Promise<boolean> {
    const backupPath = backupPathOf(filePath)
    if (!(await exists(filePath)) && !(await exists(backupPath))) return false
    await recordDiscard(quarantineDir, evidence, now)
    await Promise.all([fs.rm(filePath, { force: true }), fs.rm(backupPath, { force: true })])
    return true
}

/** Delete every quarantined copy, for example when they may still contain credentials the user revoked. */
export async function purgeQuarantine(quarantineDir: string): Promise<void> {
    await fs.rm(quarantineDir, { recursive: true, force: true })
}

async function pruneQuarantine(quarantineDir: string, documentName: string): Promise<void> {
    const prefix = `${documentName}.`
    const copies = (await fs.readdir(quarantineDir))
        .filter((entry) => entry.startsWith(prefix))
        .map((entry) => ({ entry, stamp: quarantineStamp(entry.slice(prefix.length)) }))
        .sort((left, right) => right.stamp - left.stamp)
    for (const { entry } of copies.slice(MAX_QUARANTINED_DOCUMENTS)) {
        await fs.rm(path.join(quarantineDir, entry), { force: true })
    }
}

function exists(filePath: string): Promise<boolean> {
    return fs.access(filePath).then(
        () => true,
        () => false,
    )
}

function quarantineStamp(suffix: string): number {
    const stamp = Number(suffix.split(".")[0])
    return Number.isFinite(stamp) ? stamp : 0
}
