import type { EntityFieldRef } from "../backend/api/EntitySchema"
import type {
    TransactionalUnifyStoreDatabase,
    UnifyStore,
    UnifyStoreDatabaseTransaction,
    UnifyStoreResult,
    UnifyStoreStats,
    UnifyStoreTransaction,
} from "../backend/api/UnifyStore"
import { and, asc, desc, eq, gte, lt, type UnifyStoreQuery } from "../backend/api/UnifyStoreQuery"
import { decodeUiMessage, encodeUiMessage, UiMessageAttachmentRow, type UiMessageRecord, UiMessageRow } from "./UiMessageRows"

/** Order field of {@link UiMessageRecord}; the only order the row store serves. */
export const UI_MESSAGE_ORDINAL: EntityFieldRef<UiMessageRecord, number> = Object.freeze({
    schemaId: UiMessageRow.storage.schemaId,
    name: "ordinal",
    kind: "integer",
    nullable: false,
})

export const UI_MESSAGE_TIMESTAMP: EntityFieldRef<UiMessageRecord, number> = Object.freeze({
    schemaId: UiMessageRow.storage.schemaId,
    name: "ts",
    kind: "real",
    nullable: false,
})

interface CollectionAccess {
    readonly rows: Pick<UnifyStoreTransaction<UiMessageRow>, "query" | "insert" | "replaceAll">
    readonly attachments: Pick<UnifyStoreTransaction<UiMessageAttachmentRow>, "query" | "insert" | "replaceAll">
}

/**
 * Rejects every query shape except "all rows in stored order", optionally limited.
 *
 * The buffered message store only ever asks for that; serving anything else would
 * need predicate translation across two collections that nothing uses.
 */
function assertOrderedQuery(query: UnifyStoreQuery<UiMessageRecord> | undefined): number | undefined {
    if (!query) return undefined
    if (query.where) throw new Error("UiMessageRowStore does not support filtered queries")
    const order = query.orderBy ?? []
    if (order.some((entry) => entry.field.name !== "ordinal" || entry.direction !== "asc")) {
        throw new Error("UiMessageRowStore only serves rows in ascending ordinal order")
    }
    return query.limit
}

function encodeAll(records: readonly UiMessageRecord[]) {
    const encoded = records.map((record) => encodeUiMessage(record.message, record.ordinal))
    return {
        rows: encoded.map((entry) => entry.row),
        attachments: encoded.flatMap((entry) => entry.attachments),
    }
}

const ROW_ORDINAL = UiMessageRow.storage.fields.ordinal
const ROW_TIMESTAMP = UiMessageRow.storage.fields.ts
const ROW_TYPE = UiMessageRow.storage.fields.type
const ROW_INTERACTION_ID = UiMessageRow.storage.fields.interactionId
const ATTACHMENT_ORDINAL = UiMessageAttachmentRow.storage.fields.ordinal

function toRecords(rows: readonly UiMessageRow[], attachments: readonly UiMessageAttachmentRow[]): UiMessageRecord[] {
    const attachmentsByOrdinal = new Map<number, UiMessageAttachmentRow[]>()
    for (const attachment of attachments) {
        const list = attachmentsByOrdinal.get(attachment.ordinal)
        if (list) list.push(attachment)
        else attachmentsByOrdinal.set(attachment.ordinal, [attachment])
    }
    return rows.map((row) => ({
        ordinal: row.ordinal,
        ts: row.ts,
        message: decodeUiMessage(row, attachmentsByOrdinal.get(row.ordinal) ?? []),
    }))
}

async function readRecords(access: CollectionAccess, limit: number | undefined): Promise<UiMessageRecord[]> {
    const rows = await access.rows.query({ orderBy: [asc(ROW_ORDINAL)], limit })
    if (rows.length === 0) return []
    return toRecords(rows, await access.attachments.query())
}

async function insertRecords(access: CollectionAccess, records: readonly UiMessageRecord[]): Promise<void> {
    if (records.length === 0) return
    const { rows, attachments } = encodeAll(records)
    await access.rows.insert(rows)
    if (attachments.length > 0) await access.attachments.insert(attachments)
}

async function replaceRecords(access: CollectionAccess, records: readonly UiMessageRecord[]): Promise<void> {
    const { rows, attachments } = encodeAll(records)
    await access.rows.replaceAll(rows)
    await access.attachments.replaceAll(attachments)
}

function transactionAccess(transaction: UnifyStoreDatabaseTransaction): CollectionAccess {
    return { rows: transaction.store(UiMessageRow), attachments: transaction.store(UiMessageAttachmentRow) }
}

/**
 * Chat rows of one instance in `messages.db`: one row per message plus its image and
 * file references, always written together in one transaction.
 */
export class UiMessageRowStore implements UnifyStore<UiMessageRecord> {
    private constructor(
        private readonly database: TransactionalUnifyStoreDatabase,
        private readonly rows: UnifyStore<UiMessageRow>,
        private readonly attachments: UnifyStore<UiMessageAttachmentRow>,
        private readonly release: () => Promise<void>,
    ) {}

    /** Opens both collections; `release` runs once when the store closes. */
    static async open(database: TransactionalUnifyStoreDatabase, release: () => Promise<void>): Promise<UiMessageRowStore> {
        const rows = await database.openStore(UiMessageRow)
        const attachments = await database.openStore(UiMessageAttachmentRow)
        return new UiMessageRowStore(database, rows, attachments, release)
    }

    async query(query?: UnifyStoreQuery<UiMessageRecord>): Promise<UnifyStoreResult<UiMessageRecord>> {
        const limit = assertOrderedQuery(query)
        const direct: CollectionAccess = {
            rows: {
                query: async (q) => (await this.rows.query(q)).records,
                insert: () => this.readOnly(),
                replaceAll: () => this.readOnly(),
            },
            attachments: {
                query: async (q) => (await this.attachments.query(q)).records,
                insert: () => this.readOnly(),
                replaceAll: () => this.readOnly(),
            },
        }
        return { records: await readRecords(direct, limit), stats: await this.stats() }
    }

    insert(records: readonly UiMessageRecord[]): Promise<void> {
        return this.database.transaction((transaction) => insertRecords(transactionAccess(transaction), records))
    }

    /** Not offered: replacing one row by key would leave its old attachments behind. */
    upsert(): Promise<void> {
        return Promise.reject(new Error("UiMessageRowStore does not support upsert; use replaceAll"))
    }

    replaceAll(records: readonly UiMessageRecord[]): Promise<void> {
        return this.database.transaction((transaction) => replaceRecords(transactionAccess(transaction), records))
    }

    transaction<TResult>(
        operation: (transaction: UnifyStoreTransaction<UiMessageRecord>) => TResult | Promise<TResult>,
    ): Promise<TResult> {
        return this.database.transaction((transaction) => {
            const access = transactionAccess(transaction)
            return operation({
                query: (query) => readRecords(access, assertOrderedQuery(query)),
                insert: (records) => insertRecords(access, records),
                upsert: () => this.upsert(),
                replaceAll: (records) => replaceRecords(access, records),
            })
        })
    }

    stats(): Promise<UnifyStoreStats> {
        return this.rows.stats()
    }

    /** Number of stored rows. */
    async count(): Promise<number> {
        return (await this.rows.stats()).storedRecordCount
    }

    /** Records whose ordinal is in `[start, end)`, in stored order, without reading the rest of the history. */
    async readRange(start: number, end: number): Promise<UiMessageRecord[]> {
        if (end <= start) return []
        const rows = (
            await this.rows.query({ where: and(gte(ROW_ORDINAL, start), lt(ROW_ORDINAL, end)), orderBy: [asc(ROW_ORDINAL)] })
        ).records
        if (rows.length === 0) return []
        const attachments = (
            await this.attachments.query({ where: and(gte(ATTACHMENT_ORDINAL, start), lt(ATTACHMENT_ORDINAL, end)) })
        ).records
        return toRecords(rows, attachments)
    }

    /** The last record stored with timestamp `ts`, which is the one the chat shows for it. */
    async findLastByTimestamp(ts: number): Promise<UiMessageRecord | undefined> {
        const [row] = (await this.rows.query({ where: eq(ROW_TIMESTAMP, ts), orderBy: [desc(ROW_ORDINAL)], limit: 1 })).records
        if (!row) return undefined
        const attachments = (await this.attachments.query({ where: eq(ATTACHMENT_ORDINAL, row.ordinal) })).records
        return toRecords([row], attachments)[0]
    }

    /** The last ask row revealed for `interactionId`, which is the row an interaction anchors to. */
    async findLastAskByInteractionId(interactionId: string): Promise<UiMessageRecord | undefined> {
        const [row] = (
            await this.rows.query({
                where: and(eq(ROW_TYPE, "ask"), eq(ROW_INTERACTION_ID, interactionId)),
                orderBy: [desc(ROW_ORDINAL)],
                limit: 1,
            })
        ).records
        if (!row) return undefined
        const attachments = (await this.attachments.query({ where: eq(ATTACHMENT_ORDINAL, row.ordinal) })).records
        return toRecords([row], attachments)[0]
    }

    close(): Promise<void> {
        return this.release()
    }

    private readOnly(): Promise<void> {
        return Promise.reject(new Error("UiMessageRowStore query access is read-only"))
    }
}
