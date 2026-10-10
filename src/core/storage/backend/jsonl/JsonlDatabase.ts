import { mkdir, readdir, rm, truncate } from "node:fs/promises"
import path from "node:path"
import Mutex from "p-mutex"
import type { EntitySchema } from "../api/EntitySchema"
import type { TransactionalUnifyStoreBackend, TransactionalUnifyStoreDatabase, UnifyStoreCollectionInfo } from "../api/UnifyStore"
import { UnifyStoreCorruptionError } from "../api/UnifyStoreErrors"
import {
    assertCollectionSchema,
    type IndexedDatabaseChanges,
    type IndexedDatabaseView,
    type IndexedStorageEngine,
    IndexedUnifyStoreDatabase,
} from "../core/IndexedUnifyStoreDatabase"
import { primaryKeyOf } from "../core/UnifyStoreKeys"
import { compareCodePoints } from "../core/UnifyStoreQueryEvaluator"
import { UnifyStoreRowIndex } from "../core/UnifyStoreRowIndex"
import { FileLock } from "./FileLock"
import {
    appendRows,
    dataFileName,
    discardUncommittedTail,
    emptyManifest,
    isDataFileName,
    type JsonlCollectionEntry,
    type JsonlManifest,
    MANIFEST_FILE_NAME,
    readManifest,
    readRows,
    writeManifest,
    writeRows,
} from "./JsonlDatabaseFiles"

/** Attempts, 100 ms apart, to take the write lock from another process: about ten seconds. */
const WRITE_LOCK_ATTEMPTS = 100
/** Reads retried when a concurrent writer in another process replaced a file mid-read. */
const READ_ATTEMPTS = 3

/**
 * UnifyStore backend that keeps each database as a directory of JSON Lines files.
 *
 * It offers everything the SQLite backend does: primary and unique keys, the same query
 * ordering, single-collection and cross-collection transactions that commit or roll back
 * as a unit, schema versioning, and crash recovery that never exposes an uncommitted write.
 * Rows are held in memory once read, so it suits the per-task databases rather than
 * unbounded ones. See `JsonlDatabaseFiles.ts` for the on-disk format.
 */
export class JsonlUnifyStoreBackend implements TransactionalUnifyStoreBackend {
    async open(location: string): Promise<TransactionalUnifyStoreDatabase> {
        return new IndexedUnifyStoreDatabase(await registry.acquire(location), location)
    }
}

interface RegistryEntry {
    readonly state: JsonlDatabaseState
    references: number
}

/** One shared state per directory in this process, so every handle sees the same cache and in-process lock. */
class JsonlDatabaseRegistry {
    private readonly entries = new Map<string, RegistryEntry>()

    async acquire(location: string): Promise<IndexedStorageEngine> {
        const key = normalizeLocation(location)
        let entry = this.entries.get(key)
        if (!entry) {
            entry = { state: new JsonlDatabaseState(location), references: 0 }
            this.entries.set(key, entry)
        }
        entry.references += 1
        const acquired = entry
        let released = false
        const release = () => {
            if (released) return
            released = true
            acquired.references -= 1
            if (acquired.references === 0 && this.entries.get(key) === acquired) this.entries.delete(key)
        }
        try {
            await acquired.state.ready
        } catch (error) {
            release()
            throw error
        }
        const state = acquired.state
        const guard = <T>(operation: () => Promise<T>): Promise<T> =>
            released ? Promise.reject(new Error(`JSONL UnifyStore database ${location} is closed`)) : operation()
        return {
            read: (operation) => guard(() => state.read(operation)),
            write: (operation) => guard(() => state.write(operation)),
            ensureCollection: (schema) => guard(() => state.ensureCollection(schema)),
            collections: () => guard(() => state.collections()),
            close: async () => release(),
        }
    }

    getReferenceCount(location: string): number {
        return this.entries.get(normalizeLocation(location))?.references ?? 0
    }
}

interface CachedCollection {
    entry: JsonlCollectionEntry
    readonly index: UnifyStoreRowIndex<object>
}

/**
 * Committed state of one JSONL database directory in this process.
 *
 * Operations are serialized by an in-process mutex. Writers also take a lock file next
 * to `database.json` so writers in other processes are serialized too. Readers never
 * take it: every read starts from the latest `database.json`, and committed bytes are
 * never rewritten in place, so a read always sees one complete commit.
 */
class JsonlDatabaseState {
    readonly ready: Promise<void>
    private readonly mutex = new Mutex()
    private readonly fileLock = new FileLock({ maxAcquireAttempts: WRITE_LOCK_ATTEMPTS })
    private readonly manifestPath: string
    private manifest: JsonlManifest = emptyManifest()
    private readonly cache = new Map<string, CachedCollection>()
    private recovered = false

    constructor(private readonly directory: string) {
        this.manifestPath = path.join(directory, MANIFEST_FILE_NAME)
        this.ready = prepareDirectory(directory)
    }

    read<TResult>(operation: (view: IndexedDatabaseView) => TResult | Promise<TResult>): Promise<TResult> {
        return this.mutex.withLock(async () => {
            for (let attempt = 1; ; attempt++) {
                try {
                    await this.refresh()
                    return await operation(this.view())
                } catch (error) {
                    // A writer in another process retired a file this read was still using.
                    if (!isMissingFile(error) || attempt >= READ_ATTEMPTS) throw error
                }
            }
        })
    }

    write<TResult>(
        operation: (view: IndexedDatabaseView) => Promise<{ readonly result: TResult; readonly changes: IndexedDatabaseChanges }>,
    ): Promise<TResult> {
        return this.mutex.withLock(() =>
            this.fileLock.withLock(this.manifestPath, async () => {
                await this.refresh()
                await this.recoverOnce()
                const { result, changes } = await operation(this.view())
                const changed = changes.filter((work) => work.changed)
                if (changed.length > 0) await this.commit(changed)
                return result
            }),
        )
    }

    ensureCollection<TEntity extends object>(schema: EntitySchema<TEntity>): Promise<void> {
        return this.mutex.withLock(async () => {
            await this.refresh()
            if (this.isRegistered(schema)) return
            await this.fileLock.withLock(this.manifestPath, async () => {
                await this.refresh()
                if (this.isRegistered(schema)) return
                await this.recoverOnce()
                const file = dataFileName(schema.schemaId)
                if (Object.values(this.manifest.collections).some((entry) => entry.file === file)) {
                    throw new Error(`JSONL data file ${file} is already used by another collection`)
                }
                await writeRows(schema, path.join(this.directory, file), [])
                await this.publish({
                    ...this.manifest,
                    generation: this.manifest.generation + 1,
                    collections: {
                        ...this.manifest.collections,
                        [schema.schemaId]: { version: schema.version, fingerprint: schema.fingerprint, file, size: 0, rows: 0 },
                    },
                })
            })
        })
    }

    collections(): Promise<readonly UnifyStoreCollectionInfo[]> {
        return this.mutex.withLock(async () => {
            await this.refresh()
            return Object.entries(this.manifest.collections)
                .map(([schemaId, entry]) => ({ schemaId, version: entry.version, fingerprint: entry.fingerprint }))
                .sort((left, right) => compareCodePoints(left.schemaId, right.schemaId))
        })
    }

    private view(): IndexedDatabaseView {
        const manifest = this.manifest
        return {
            registered: (schema) => this.isRegistered(schema),
            index: (schema) => this.index(schema),
            storageBytes: Object.values(manifest.collections).reduce((total, entry) => total + entry.size, 0),
        }
    }

    private isRegistered<TEntity extends object>(schema: EntitySchema<TEntity>): boolean {
        const entry = this.manifest.collections[schema.schemaId]
        if (!entry) return false
        assertCollectionSchema(schema, entry)
        return true
    }

    /**
     * Adopts the latest committed manifest, which another process may have replaced.
     * Cached rows are reconciled lazily by {@link index}.
     */
    private async refresh(): Promise<void> {
        this.manifest = (await readManifest(this.directory)) ?? emptyManifest()
    }

    /**
     * Committed rows of `schema`. A collection that another process only extended is
     * brought up to date by reading its new tail; any other change reloads it.
     */
    private async index<TEntity extends object>(schema: EntitySchema<TEntity>): Promise<UnifyStoreRowIndex<TEntity>> {
        const entry = this.manifest.collections[schema.schemaId]
        if (!entry) throw new Error(`UnifyStore collection ${schema.schemaId} is not registered`)
        assertCollectionSchema(schema, entry)
        const cached = this.cache.get(schema.schemaId)
        if (cached && cached.entry.file === entry.file && cached.entry.size === entry.size && cached.entry.rows === entry.rows) {
            return cached.index as unknown as UnifyStoreRowIndex<TEntity>
        }
        const filePath = path.join(this.directory, entry.file)
        if (cached && cached.entry.file === entry.file && cached.entry.size < entry.size) {
            try {
                const index = cached.index as unknown as UnifyStoreRowIndex<TEntity>
                const tail = await readRows(schema, filePath, cached.entry.size, entry.size, cached.entry.rows)
                for (const row of tail) {
                    if (index.conflicts(row, primaryKeyOf(schema, row))) {
                        throw new UnifyStoreCorruptionError(`Duplicate ${schema.schemaId} key in ${entry.file}`)
                    }
                    index.append(row)
                }
                assertRowCount(index.rows.length, entry)
                cached.entry = entry
                return index
            } catch (error) {
                // The cached rows may now be half extended; the next read reloads them.
                this.cache.delete(schema.schemaId)
                throw error
            }
        }
        this.cache.delete(schema.schemaId)
        const rows = await readRows(schema, filePath, 0, entry.size, 0)
        assertRowCount(rows.length, entry)
        const index = UnifyStoreRowIndex.load(schema, rows, entry.file)
        this.cache.set(schema.schemaId, { entry, index: index as unknown as UnifyStoreRowIndex<object> })
        return index
    }

    /**
     * Makes `works` durable as one commit: appends and replacement files are written and
     * flushed first, then `database.json` is replaced. Until that replacement nothing is
     * visible, and a failure removes what was written.
     */
    private async commit(works: IndexedDatabaseChanges): Promise<void> {
        const generation = this.manifest.generation + 1
        const collections: Record<string, JsonlCollectionEntry> = { ...this.manifest.collections }
        const created: string[] = []
        const extended: Array<{ readonly filePath: string; readonly size: number }> = []
        const retired: string[] = []
        try {
            for (const work of works) {
                const schema = work.schema
                const entry = collections[schema.schemaId]
                if (!entry) throw new Error(`UnifyStore collection ${schema.schemaId} is not registered`)
                if (work.rewrites) {
                    const file = dataFileName(schema.schemaId, generation)
                    created.push(file)
                    const rows = work.rows()
                    const size = await writeRows(schema, path.join(this.directory, file), rows)
                    collections[schema.schemaId] = { ...entry, file, size, rows: rows.length }
                    retired.push(entry.file)
                    continue
                }
                const filePath = path.join(this.directory, entry.file)
                await discardUncommittedTail(filePath, entry.size)
                extended.push({ filePath, size: entry.size })
                const bytes = await appendRows(schema, filePath, work.appended)
                collections[schema.schemaId] = { ...entry, size: entry.size + bytes, rows: entry.rows + work.appended.length }
            }
            await writeManifest(this.directory, { ...this.manifest, generation, collections })
        } catch (error) {
            await Promise.allSettled([
                ...extended.map(({ filePath, size }) => truncate(filePath, size)),
                ...created.map((file) => rm(path.join(this.directory, file), { force: true })),
            ])
            throw error
        }
        this.manifest = { ...this.manifest, generation, collections }
        for (const work of works) {
            this.cache.set(work.schema.schemaId, { entry: collections[work.schema.schemaId], index: work.apply() })
        }
        // A reader in another process may still hold a retired file; it retries on the new manifest.
        await Promise.allSettled(retired.map((file) => rm(path.join(this.directory, file), { force: true })))
    }

    private async publish(manifest: JsonlManifest): Promise<void> {
        await writeManifest(this.directory, manifest)
        this.manifest = manifest
    }

    /**
     * Removes what a writer that crashed before its commit left behind: temporary manifests
     * and replacement files no manifest references. Runs under the write lock, so no live
     * writer can be producing them.
     */
    private async recoverOnce(): Promise<void> {
        if (this.recovered) return
        const referenced = new Set(Object.values(this.manifest.collections).map((entry) => entry.file))
        const names = await readdir(this.directory)
        await Promise.allSettled(
            names
                .filter((name) => isAbandonedManifest(name) || (isDataFileName(name) && !referenced.has(name)))
                .map((name) => rm(path.join(this.directory, name), { force: true })),
        )
        this.recovered = true
    }
}

/** Retired layout: one `<collection>.jsonl` plus `<collection>.schema.json` per collection, without a manifest. */
const RETIRED_SCHEMA_FILE = /\.schema\.json$/

/**
 * Creates the directory and refuses one written in the retired layout: recovery would
 * otherwise take its data files for orphans of a crashed commit and remove them.
 */
async function prepareDirectory(directory: string): Promise<void> {
    await mkdir(directory, { recursive: true })
    const names = await readdir(directory)
    if (!names.includes(MANIFEST_FILE_NAME) && names.some((name) => RETIRED_SCHEMA_FILE.test(name))) {
        throw new Error(`${directory} uses the retired per-collection JSONL layout and cannot be opened as a database`)
    }
}

/** A manifest a writer began replacing but never renamed into place. */
function isAbandonedManifest(name: string): boolean {
    return name.startsWith(`${MANIFEST_FILE_NAME}.`) && name.endsWith(".tmp")
}

function assertRowCount(actual: number, entry: JsonlCollectionEntry): void {
    if (actual !== entry.rows) {
        throw new UnifyStoreCorruptionError(`${entry.file} holds ${actual} rows but ${entry.rows} were committed`)
    }
}

function isMissingFile(error: unknown): boolean {
    return (error as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
}

function normalizeLocation(location: string): string {
    const resolved = path.resolve(location)
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

const registry = new JsonlDatabaseRegistry()

/** Handles open on each JSONL database in this process; tests and storage moves use it. */
export const jsonlUnifyStoreRegistry = {
    getReferenceCount: (location: string) => registry.getReferenceCount(location),
}
