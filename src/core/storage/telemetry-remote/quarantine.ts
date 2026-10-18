import { randomUUID } from "node:crypto"
import fs from "node:fs/promises"
import path from "node:path"
import { renameWithRetry } from "@shared/storage/atomic-file"

/** Quarantined copies kept per document; older ones are deleted so a recurring fault cannot fill the disk. */
export const MAX_QUARANTINED_DOCUMENTS = 3
export const OWNER_ONLY_DIRECTORY_MODE = 0o700

/**
 * Move a document that failed validation aside instead of overwriting it.
 *
 * The caller holds the document's lock. The moved copy keeps its original bytes
 * and permissions for diagnosis, and the next write starts from a clean slate.
 */
export async function quarantineDocument(filePath: string, quarantineDir: string, now: number): Promise<void> {
    await fs.mkdir(quarantineDir, { recursive: true, mode: OWNER_ONLY_DIRECTORY_MODE })
    const { name, ext } = path.parse(filePath)
    try {
        await renameWithRetry(filePath, path.join(quarantineDir, `${name}.${now}.${randomUUID()}${ext}`))
    } catch (error) {
        // Another process quarantined or replaced it first.
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return
        throw error
    }
    await pruneQuarantine(quarantineDir, name)
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

function quarantineStamp(suffix: string): number {
    const stamp = Number(suffix.split(".")[0])
    return Number.isFinite(stamp) ? stamp : 0
}
