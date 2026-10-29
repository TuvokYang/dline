import fs from "node:fs/promises"
import path from "node:path"
import { column, defineEntity, type EntitySchema, type StoredEntityClass } from "../api/EntitySchema"
import type {
    BufferedUnifyStore as BufferedUnifyStoreContract,
    UnifyStore,
    UnifyStoreResult,
    UnifyStoreStats,
} from "../api/UnifyStore"
import { BufferedUnifyStore, type BufferedUnifyStoreOptions } from "../core/BufferedUnifyStore"
import { UnifyStoreCore, type UnifyStoreDriver, type UnifyStoreDriverTransaction } from "../core/UnifyStoreCore"
import { evaluateUnifyStoreQuery, type NormalizedUnifyStoreQuery } from "../core/UnifyStoreQueryEvaluator"
import { FileLock } from "./FileLock"
import type { JsonlRecordCodec } from "./JsonlRecordCodec"
import { appendJsonl, canAppendJsonl, readJsonl, replaceJsonlTail, truncateJsonlTail, writeJsonl } from "./jsonl-utils"

/**
 * Single-file JSONL stores for the legacy per-task message files.
 *
 * These read and write one pre-existing `.jsonl` file in its historical format and are
 * kept only so legacy task files stay readable. Durable databases use
 * {@link import("./JsonlDatabase").JsonlUnifyStoreBackend} instead.
 */

interface BufferedJsonlRow {
    readonly ordinal: number
    readonly timestamp: number
    readonly payload: object
}

export interface OpenBufferedJsonlStoreOptions<TItem extends { ts: number }>
    extends Omit<BufferedUnifyStoreOptions<TItem>, "subscriptionKey"> {
    readonly schemaId: string
}

// biome-ignore lint/complexity/noStaticOnlyClass: Preserve the existing JsonlUnifyStore.openRaw namespace API.
export class JsonlUnifyStore {
    static async openRaw<TEntity extends object, TPersisted>(options: {
        filePath: string
        entity: StoredEntityClass<TEntity>
        codec: JsonlRecordCodec<TEntity, TPersisted>
        appendOnlyInsert?: boolean
        fileLock?: FileLock
    }): Promise<UnifyStore<TEntity>> {
        await fs.mkdir(path.dirname(options.filePath), { recursive: true })
        await fs.appendFile(options.filePath, "", "utf8")
        return createJsonlStore(
            options.entity.storage,
            options.filePath,
            options.codec,
            options.fileLock ?? new FileLock(),
            options.appendOnlyInsert,
        )
    }
}

export async function openBufferedJsonlStore<TItem extends { ts: number }>(
    filePath: string,
    options: OpenBufferedJsonlStoreOptions<TItem>,
): Promise<BufferedUnifyStoreContract<TItem>> {
    const RowEntity = createBufferedJsonlRowEntity(options.schemaId)
    const fileLock = new FileLock()
    const durableStore = await JsonlUnifyStore.openRaw({
        filePath,
        entity: RowEntity,
        appendOnlyInsert: true,
        fileLock,
        codec: {
            decode: (value, ordinal) => {
                if (!isTimestampedItem<TItem>(value)) throw new Error(`Invalid buffered JSONL item for ${options.schemaId}`)
                return new RowEntity(ordinal, value.ts, value)
            },
            encode: (row) => row.payload,
        },
    })
    return await BufferedUnifyStore.open({
        store: durableStore,
        mapping: {
            ordinal: RowEntity.storage.fields.ordinal,
            timestamp: RowEntity.storage.fields.timestamp,
            toItem: (row) => {
                if (!isTimestampedItem<TItem>(row.payload)) throw new Error(`Invalid buffered JSONL item for ${options.schemaId}`)
                return row.payload
            },
            toEntity: (item, ordinal) => new RowEntity(ordinal, item.ts, item),
        },
        bufferOptions: {
            ...options,
            subscriptionKey: normalizeSubscriptionKey(filePath),
            storeKind: bufferedStoreKind(options.schemaId),
            truncateTail: (keepCount, expectedCount) =>
                fileLock.withLock(filePath, () => truncateJsonlTail(filePath, keepCount, expectedCount)),
            // Buffered rows persist their payload as the line itself, so the
            // items can be written without going through the row codec.
            replaceTail: ({ expectedTailTimestamps, replacedCount, entries }) =>
                fileLock.withLock(filePath, () =>
                    replaceJsonlTail(filePath, { expectedTailTimestamps, replacedLineCount: replacedCount, entries }),
                ),
        },
    })
}

function createJsonlStore<TEntity extends object, TPersisted>(
    schema: EntitySchema<TEntity>,
    dataPath: string,
    codec: JsonlRecordCodec<TEntity, TPersisted>,
    fileLock = new FileLock(),
    appendOnlyInsert = false,
): UnifyStore<TEntity> {
    return new UnifyStoreCore(schema, new JsonlUnifyStoreDriver(schema, dataPath, codec, fileLock, appendOnlyInsert))
}

class JsonlUnifyStoreDriver<TEntity extends object, TPersisted> implements UnifyStoreDriver<TEntity> {
    private closed = false
    private closePromise: Promise<void> | undefined

    constructor(
        private readonly schema: EntitySchema<TEntity>,
        private readonly dataPath: string,
        private readonly codec: JsonlRecordCodec<TEntity, TPersisted>,
        private readonly fileLock: FileLock,
        private readonly appendOnlyInsert = false,
    ) {}

    async query(query: NormalizedUnifyStoreQuery<TEntity>): Promise<UnifyStoreResult<TEntity>> {
        this.assertOpen()
        return await this.fileLock.withLock(this.dataPath, async () => {
            this.assertOpen()
            const records = await this.readRecords()
            return {
                records: evaluateUnifyStoreQuery(this.schema, records, query),
                stats: await createStats(this.dataPath, records.length),
            }
        })
    }

    async insert(records: readonly TEntity[]): Promise<void> {
        this.assertOpen()
        await this.fileLock.withLock(this.dataPath, async () => {
            this.assertOpen()
            if (this.appendOnlyInsert && (await canAppendJsonl(this.dataPath))) {
                assertNoPrimaryConflicts(this.schema, [], records)
                // Encoded before the await so the conflict check and the bytes
                // written describe the same records.
                const encoded = records.map((record) => this.codec.encode(record))
                await appendJsonl(this.dataPath, encoded)
                return
            }
            const current = await this.readRecords()
            assertNoPrimaryConflicts(this.schema, current, records)
            await this.writeRecords([...current, ...records])
        })
    }

    async upsert(records: readonly TEntity[]): Promise<void> {
        this.assertOpen()
        await this.fileLock.withLock(this.dataPath, async () => {
            this.assertOpen()
            await this.writeRecords(upsertRecords(this.schema, await this.readRecords(), records))
        })
    }

    async replaceAll(records: readonly TEntity[]): Promise<void> {
        this.assertOpen()
        await this.fileLock.withLock(this.dataPath, async () => {
            this.assertOpen()
            assertNoPrimaryConflicts(this.schema, [], records)
            await this.writeRecords(records)
        })
    }

    async transaction<TResult>(
        operation: (transaction: UnifyStoreDriverTransaction<TEntity>) => TResult | Promise<TResult>,
    ): Promise<TResult> {
        this.assertOpen()
        return await this.fileLock.withLock(this.dataPath, async () => {
            this.assertOpen()
            const committed = await this.readRecords()
            let working = committed
            // Pins the records this transaction read, so the commit can tell a
            // pure tail growth from a result whose leading records moved.
            const committedSnapshot = [...committed]
            // Query hands the operation the very entities held in `working`, so a
            // caller can edit one in place. Capturing the keys before the
            // operation runs keeps them describing what the file actually holds:
            // an edited key would otherwise move out of the way and let a
            // duplicate of the original key through. Holding one set across the
            // whole transaction also replaces the full pass over the collection
            // that rebuilding it on every insert used to cost.
            let primaryKeys = collectPrimaryKeys(this.schema, committed)
            // Tracked separately so a transaction that only grew the tail can be
            // committed by appending those lines instead of rewriting the whole
            // file, which for a long conversation meant rewriting tens of
            // megabytes to add one entry.
            // Encoded at insert time rather than at commit: the caller keeps a
            // reference to the record it handed over, and editing it afterwards
            // would otherwise change what gets written after the conflict check
            // already passed. The SQLite driver writes during insert, so
            // capturing here is also what keeps the two backends interchangeable.
            let appended: TPersisted[] = []
            let replaced = false
            const transaction: UnifyStoreDriverTransaction<TEntity> = {
                query: async (query) => evaluateUnifyStoreQuery(this.schema, working, query),
                insert: async (records) => {
                    assertNoPrimaryConflictsAgainst(this.schema, primaryKeys, records)
                    const encoded = records.map((record) => this.codec.encode(record))
                    working = [...working, ...records]
                    appended = [...appended, ...encoded]
                },
                upsert: async (records) => {
                    working = upsertRecords(this.schema, working, records)
                    primaryKeys = collectPrimaryKeys(this.schema, working)
                    // An in-place replacement cannot be expressed as a tail append.
                    replaced = true
                    appended = []
                },
                replaceAll: async (records) => {
                    primaryKeys = new Set()
                    assertNoPrimaryConflictsAgainst(this.schema, primaryKeys, records)
                    working = [...records]
                    // A replacement invalidates the tail-append shortcut even when
                    // inserts follow it.
                    replaced = true
                    appended = []
                },
            }
            // A throw leaves the file untouched: nothing is written before the
            // operation returns, on either commit path.
            const result = await operation(transaction)
            // A query-only transaction, including a buffered logical no-op, must
            // leave the physical file untouched just like the SQLite backend.
            if (!replaced && appended.length === 0) return result
            // Appending is only sound when the committed records this transaction
            // read are still the exact leading records of the result, and when the
            // file can physically carry another line. Either check failing means a
            // rewrite, which always produces a well-formed file. An entity edited
            // in place is deliberately not written by this path: a store that
            // never handed the edit back through insert or replaceAll did not ask
            // for it to be persisted, which is also how the SQLite driver behaves.
            const canAppend =
                this.appendOnlyInsert &&
                !replaced &&
                appended.length > 0 &&
                working.length === committedSnapshot.length + appended.length &&
                committedSnapshot.every((record, index) => working[index] === record) &&
                (await canAppendJsonl(this.dataPath))
            if (canAppend) {
                await appendJsonl(this.dataPath, appended)
                return result
            }
            await this.writeRecords(working)
            return result
        })
    }

    async stats(): Promise<UnifyStoreStats> {
        this.assertOpen()
        return await this.fileLock.withLock(this.dataPath, async () => {
            this.assertOpen()
            return await createStats(this.dataPath, (await this.readRecords()).length)
        })
    }

    close(): Promise<void> {
        this.closePromise ??= Promise.resolve().then(() => {
            this.closed = true
        })
        return this.closePromise
    }

    private async readRecords(): Promise<TEntity[]> {
        return (await readJsonl<unknown>(this.dataPath)).map((value, ordinal) => this.codec.decode(value, ordinal))
    }

    private async writeRecords(records: readonly TEntity[]): Promise<void> {
        await writeJsonl(
            this.dataPath,
            records.map((record) => this.codec.encode(record)),
        )
    }

    private assertOpen(): void {
        if (this.closed) throw new Error("JSONL UnifyStore driver is closed")
    }
}

function assertNoPrimaryConflicts<TEntity extends object>(
    schema: EntitySchema<TEntity>,
    current: readonly TEntity[],
    incoming: readonly TEntity[],
): void {
    assertNoPrimaryConflictsAgainst(schema, collectPrimaryKeys(schema, current), incoming)
}

function upsertRecords<TEntity extends object>(
    schema: EntitySchema<TEntity>,
    current: readonly TEntity[],
    records: readonly TEntity[],
): TEntity[] {
    const next = [...current]
    const indexByKey = new Map(next.map((record, index) => [primaryKey(schema, record), index]))
    for (const record of records) {
        const key = primaryKey(schema, record)
        const existing = indexByKey.get(key)
        if (existing === undefined) {
            indexByKey.set(key, next.length)
            next.push(record)
        } else {
            next[existing] = record
        }
    }
    return next
}

function collectPrimaryKeys<TEntity extends object>(schema: EntitySchema<TEntity>, records: readonly TEntity[]): Set<string> {
    return new Set(records.map((record) => primaryKey(schema, record)))
}

/**
 * Reject an incoming batch that repeats a key the set already holds.
 *
 * The set is updated in place, so a caller that keeps it across several
 * batches both pays for one pass over the collection instead of one per batch
 * and keeps checking against the keys it captured rather than against records
 * that may have been edited since.
 */
function assertNoPrimaryConflictsAgainst<TEntity extends object>(
    schema: EntitySchema<TEntity>,
    keys: Set<string>,
    incoming: readonly TEntity[],
): void {
    for (const record of incoming) {
        const key = primaryKey(schema, record)
        if (keys.has(key)) throw new Error(`UnifyStore conflict for ${schema.schemaId}`)
        keys.add(key)
    }
}

function primaryKey<TEntity extends object>(schema: EntitySchema<TEntity>, record: TEntity): string {
    const values = schema.dehydrate(record)
    return schema.primaryFields.map((field) => serializeKey(values[field.name])).join("|")
}

function serializeKey(value: unknown): string {
    if (typeof value === "bigint") return `bigint:${value}`
    if (value instanceof Uint8Array) return `blob:${Buffer.from(value).toString("base64")}`
    return `${typeof value}:${JSON.stringify(value)}`
}

function createBufferedJsonlRowEntity(schemaId: string) {
    class BufferedJsonlRowEntity implements BufferedJsonlRow {
        static readonly storage = defineEntity<BufferedJsonlRow>()({
            schemaId,
            version: 1,
            columns: {
                ordinal: column.integer({ primary: true }),
                timestamp: column.real({ indexed: true }),
                payload: column.json<object>({ validate: isObjectRecord }),
            },
            defaultOrder: [{ field: "ordinal", direction: "asc" }],
            hydrate: (values) => new BufferedJsonlRowEntity(values.ordinal, values.timestamp, values.payload),
        })

        constructor(
            readonly ordinal: number,
            readonly timestamp: number,
            readonly payload: object,
        ) {}
    }
    return BufferedJsonlRowEntity
}

function isObjectRecord(value: unknown): value is object {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

function isTimestampedItem<TItem extends { ts: number }>(value: unknown): value is TItem {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        typeof (value as { ts?: unknown }).ts === "number" &&
        Number.isFinite((value as { ts: number }).ts)
    )
}

function bufferedStoreKind(schemaId: string): string {
    if (schemaId === "ui-message") return "ui_message"
    if (schemaId === "api-conversation-message") return "api_conversation"
    return "other"
}

function normalizeSubscriptionKey(filePath: string): string {
    const resolved = path.resolve(filePath)
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

async function createStats(dataPath: string, count: number): Promise<UnifyStoreStats> {
    const stat = await fs.stat(dataPath)
    return { storageBytes: stat.size, storedRecordCount: count, degraded: false }
}
