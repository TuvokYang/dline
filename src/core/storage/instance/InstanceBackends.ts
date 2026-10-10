import { access, rm } from "node:fs/promises"
import path from "node:path"
import { Logger } from "@/shared/services/Logger"
import type { TransactionalUnifyStoreBackend } from "../backend/api/UnifyStore"
import { copyGenerationOf } from "../backend/core/UnifyStoreCopy"
import { JsonlUnifyStoreBackend } from "../backend/jsonl/JsonlDatabase"
import { SqliteUnifyStoreBackend } from "../backend/sqlite/SqliteUnifyStore"
import type { InstanceDatabase, InstanceLayout } from "./InstanceLayout"

/** Physical format of the instance databases. Both offer the same UnifyStore contract. */
export const InstanceBackend = {
    Sqlite: "sqlite",
    Jsonl: "jsonl",
} as const

export type InstanceBackend = (typeof InstanceBackend)[keyof typeof InstanceBackend]

/** Selects the backend of newly created instance databases and the target of a backend switch. */
export const INSTANCE_BACKEND_ENV = "DLINE_INSTANCE_STORAGE_BACKEND"

const BACKENDS: Record<InstanceBackend, TransactionalUnifyStoreBackend> = {
    [InstanceBackend.Sqlite]: new SqliteUnifyStoreBackend(),
    [InstanceBackend.Jsonl]: new JsonlUnifyStoreBackend(),
}

const SQLITE_SIDE_FILES = ["-wal", "-shm", "-journal"] as const

export function isInstanceBackend(value: unknown): value is InstanceBackend {
    return value === InstanceBackend.Sqlite || value === InstanceBackend.Jsonl
}

/** The configured backend; SQLite unless {@link INSTANCE_BACKEND_ENV} names another one. */
export function configuredInstanceBackend(): InstanceBackend {
    const value = process.env[INSTANCE_BACKEND_ENV]?.trim().toLowerCase()
    if (!value) return InstanceBackend.Sqlite
    if (isInstanceBackend(value)) return value
    Logger.warn(`[InstanceStorage] Ignoring unknown ${INSTANCE_BACKEND_ENV}=${value}; using ${InstanceBackend.Sqlite}`)
    return InstanceBackend.Sqlite
}

export function instanceBackend(kind: InstanceBackend): TransactionalUnifyStoreBackend {
    return BACKENDS[kind]
}

/**
 * Where `database` lives under `backend`: `journal.db` is a SQLite file, and the same
 * database in JSONL form is the `journal/` directory next to it.
 */
export function databaseLocation(layout: InstanceLayout, database: InstanceDatabase, backend: InstanceBackend): string {
    const sqlitePath = layout.database(database)
    return backend === InstanceBackend.Sqlite ? sqlitePath : sqlitePath.replace(/\.db$/, "")
}

/** Backends that currently hold `database`, SQLite first. */
export async function existingBackends(layout: InstanceLayout, database: InstanceDatabase): Promise<InstanceBackend[]> {
    const found: InstanceBackend[] = []
    for (const backend of [InstanceBackend.Sqlite, InstanceBackend.Jsonl]) {
        if (await pathExists(databaseLocation(layout, database, backend))) found.push(backend)
    }
    return found
}

/** Whether `database` exists in any backend. Checking only `journal.db` would miss a JSONL instance. */
export async function instanceDatabaseExists(layout: InstanceLayout, database: InstanceDatabase): Promise<boolean> {
    return (await existingBackends(layout, database)).length > 0
}

/**
 * The backend whose copy of `database` is authoritative.
 *
 * A database that does not exist yet is created in `preferred`. When a switch could not
 * remove its source, for example because another window still had it open, both copies
 * exist; the one with the higher copy generation holds the latest data.
 */
export async function resolveDatabaseBackend(
    layout: InstanceLayout,
    database: InstanceDatabase,
    preferred: InstanceBackend,
): Promise<InstanceBackend> {
    const existing = await existingBackends(layout, database)
    if (existing.length === 0) return preferred
    if (existing.length === 1) return existing[0]
    const generations = await Promise.all(existing.map((backend) => generationAt(layout, database, backend)))
    if (generations[0] === generations[1]) {
        Logger.warn(`[InstanceStorage] ${database} exists in both backends with generation ${generations[0]}; using ${preferred}`)
        return preferred
    }
    return generations[0] > generations[1] ? existing[0] : existing[1]
}

async function generationAt(layout: InstanceLayout, database: InstanceDatabase, backend: InstanceBackend): Promise<number> {
    const opened = await instanceBackend(backend).open(databaseLocation(layout, database, backend))
    try {
        return await copyGenerationOf(opened)
    } finally {
        await opened.close()
    }
}

/**
 * Deletes the files of one database location. Every handle must be closed first.
 * @throws when a file cannot be removed, for example because another process holds it open.
 */
export async function removeDatabaseLocation(location: string, backend: InstanceBackend): Promise<void> {
    if (backend === InstanceBackend.Jsonl) {
        await rm(location, { recursive: true, force: true })
        return
    }
    await rm(location, { force: true })
    for (const suffix of SQLITE_SIDE_FILES) await rm(`${location}${suffix}`, { force: true })
}

/** Staging location next to `location`, removed or renamed into place by the switch. */
export function stagingLocation(location: string): string {
    return path.join(path.dirname(location), `${path.basename(location)}.switching`)
}

async function pathExists(location: string): Promise<boolean> {
    try {
        await access(location)
        return true
    } catch {
        return false
    }
}
