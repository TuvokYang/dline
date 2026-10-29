import { readdir, stat, unlink } from "node:fs/promises"
import { join } from "node:path"

/**
 * Bounds the session journal directory.
 *
 * Each extension host run writes its own file and the session id is new every
 * time, so without this the directory grows by one file per start and never
 * shrinks. The per-file size budget in `SessionJournal` does not help: it caps
 * how large one journal gets, not how many exist.
 *
 * The two limits are independent and both apply.
 */

/**
 * Journals kept, newest first.
 *
 * With the default 1 MiB per-session cap this limits retained runtime event
 * history to roughly 8 MiB even when no Collector has ever existed.
 */
export const MAX_SESSIONS = 8

/** Journals older than this are removed regardless of how few there are. */
export const MAX_AGE_DAYS = 3

const MS_PER_DAY = 24 * 60 * 60 * 1000

export interface JournalRetentionOptions {
    /** Directory holding one `.jsonl` per session. */
    readonly directory: string
    /**
     * Journal of the run in progress.
     *
     * Excluded from deletion even when it sorts into the eviction range:
     * removing the file being written would destroy the evidence for whatever
     * is happening right now.
     */
    readonly activeSessionId?: string
    readonly maxSessions?: number
    readonly maxAgeDays?: number
    /** Injectable so age boundaries are testable without waiting. */
    readonly now?: () => number
}

export interface JournalRetentionResult {
    readonly deleted: number
    readonly retained: number
    /** Files that could not be removed, for example because they are locked. */
    readonly failed: number
}

interface JournalFile {
    readonly path: string
    readonly modifiedAt: number
}

/**
 * Delete expired and surplus journals.
 *
 * Never rejects. Retention failing must not stop telemetry from starting, so
 * problems are counted and reported rather than thrown.
 */
export async function enforceJournalRetention(options: JournalRetentionOptions): Promise<JournalRetentionResult> {
    const maxSessions = options.maxSessions ?? MAX_SESSIONS
    const maxAgeDays = options.maxAgeDays ?? MAX_AGE_DAYS
    const now = options.now?.() ?? Date.now()
    const activeFileName = options.activeSessionId ? `${options.activeSessionId}.jsonl` : undefined

    const files = await listJournals(options.directory, activeFileName)
    if (files.length === 0) return { deleted: 0, retained: 0, failed: 0 }

    // Newest first, so the surplus to drop is a suffix of the list.
    const sorted = [...files].sort((left, right) => right.modifiedAt - left.modifiedAt)
    const expiryThreshold = now - maxAgeDays * MS_PER_DAY

    const doomed = sorted.filter((file, index) => index >= maxSessions || file.modifiedAt < expiryThreshold)

    let deleted = 0
    let failed = 0
    for (const file of doomed) {
        try {
            await unlink(file.path)
            deleted += 1
        } catch {
            // A locked or already-removed file is not worth failing over.
            failed += 1
        }
    }

    return { deleted, retained: sorted.length - deleted, failed }
}

/**
 * Collect candidate journals.
 *
 * The filter is deliberately narrow: this runs against a user data directory,
 * so only `.jsonl` files directly inside the sessions directory are eligible.
 */
async function listJournals(directory: string, activeFileName: string | undefined): Promise<JournalFile[]> {
    let entries: string[]
    try {
        entries = await readdir(directory)
    } catch {
        // A missing directory is the normal case before the first session.
        return []
    }

    const files: JournalFile[] = []
    for (const entry of entries) {
        if (!entry.endsWith(".jsonl") || entry === activeFileName) continue
        const path = join(directory, entry)
        try {
            const stats = await stat(path)
            if (!stats.isFile()) continue
            files.push({ path, modifiedAt: stats.mtimeMs })
        } catch {
            // Vanished between listing and stat; nothing to retain.
        }
    }
    return files
}
