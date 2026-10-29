import { randomUUID } from "node:crypto"
import path from "node:path"
import type { UiMessage } from "@/shared/ExtensionMessage"
import { Logger } from "@/shared/services/Logger"
import type { EntityFieldRef, StoredEntityClass } from "../backend/api/EntitySchema"
import type {
    TransactionalUnifyStoreDatabase,
    UnifyStore,
    UnifyStoreCollectionTransaction,
    UnifyStoreDatabaseTransaction,
    UnifyStoreResult,
    UnifyStoreStats,
    UnifyStoreTransaction,
    UnifyStoreWriteHint,
} from "../backend/api/UnifyStore"
import { and, asc, desc, eq, gte, lt, type UnifyStoreQuery } from "../backend/api/UnifyStoreQuery"
import type { BufferedTailReplacement } from "../backend/core/BufferedUnifyStore"
import {
    decodeUiMessage,
    encodeUiMessage,
    UI_MESSAGE_COMMIT_STATE_KEY,
    UiMessageAttachmentRow,
    UiMessageCommitRow,
    UiMessageCommitStateRow,
    type UiMessageRecord,
    UiMessageRow,
} from "./UiMessageRows"

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

/** Commit log entries kept in `messages.db`; older entries fold into the floor of the state row. */
export const UI_MESSAGE_COMMIT_RETENTION = 1024

interface ReadAccess {
    readonly rows: Pick<UnifyStoreTransaction<UiMessageRow>, "query">
    readonly attachments: Pick<UnifyStoreTransaction<UiMessageAttachmentRow>, "query">
}

interface CollectionAccess extends ReadAccess {
    readonly rows: Pick<UnifyStoreCollectionTransaction<UiMessageRow>, "query" | "insert" | "replaceAll" | "deleteWhere">
    readonly attachments: Pick<
        UnifyStoreCollectionTransaction<UiMessageAttachmentRow>,
        "query" | "insert" | "replaceAll" | "deleteWhere"
    >
    readonly commits: Pick<UnifyStoreCollectionTransaction<UiMessageCommitRow>, "query" | "insert" | "deleteWhere">
    readonly commitState: Pick<UnifyStoreCollectionTransaction<UiMessageCommitStateRow>, "query" | "upsert">
}

/** Whether the counts describe a tail that can exist: whole, non-negative, and covering every replaced row. */
function isValidTailReplacement(tailStart: number, replacedCount: number, expectedLength: number): boolean {
    return (
        Number.isSafeInteger(tailStart) &&
        tailStart >= 0 &&
        Number.isSafeInteger(replacedCount) &&
        replacedCount >= 0 &&
        replacedCount <= expectedLength
    )
}

/** Whether `rows`, read from `start` onwards, are exactly the expected tail and nothing follows it. */
function isExpectedTail(rows: readonly UiMessageRow[], start: number, expectedTimestamps: readonly number[]): boolean {
    return (
        rows.length === expectedTimestamps.length &&
        rows.every((row, index) => row.ordinal === start + index && row.ts === expectedTimestamps[index])
    )
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
const COMMIT_SEQ = UiMessageCommitRow.storage.fields.seq
const COMMIT_STATE_KEY = UiMessageCommitStateRow.storage.fields.key

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

async function readRecords(access: ReadAccess, limit: number | undefined): Promise<UiMessageRecord[]> {
    const rows = await access.rows.query({ orderBy: [asc(ROW_ORDINAL)], limit })
    if (rows.length === 0) return []
    return toRecords(rows, await access.attachments.query())
}

/** Inserts the rows and attachments of `records` and returns the written rows. */
async function writeRecords(access: CollectionAccess, records: readonly UiMessageRecord[]): Promise<UiMessageRow[]> {
    if (records.length === 0) return []
    const { rows, attachments } = encodeAll(records)
    await access.rows.insert(rows)
    if (attachments.length > 0) await access.attachments.insert(attachments)
    return rows
}

async function insertRecords(access: CollectionAccess, records: readonly UiMessageRecord[], draft: CommitDraft): Promise<void> {
    draft.recordInsert(await writeRecords(access, records))
}

async function replaceRecords(
    access: CollectionAccess,
    records: readonly UiMessageRecord[],
    draft: CommitDraft,
    hint: UnifyStoreWriteHint | undefined,
): Promise<void> {
    const { rows, attachments } = encodeAll(records)
    await access.rows.replaceAll(rows)
    await access.attachments.replaceAll(attachments)
    draft.recordReplaceAll(rows, hint)
}

function transactionAccess(transaction: UnifyStoreDatabaseTransaction): CollectionAccess {
    return {
        rows: transaction.store(UiMessageRow),
        attachments: transaction.store(UiMessageAttachmentRow),
        commits: transaction.store(UiMessageCommitRow),
        commitState: transaction.store(UiMessageCommitStateRow),
    }
}

async function storedTimestampAt(rows: ReadAccess["rows"], ordinal: number): Promise<number | undefined> {
    const [row] = await rows.query({ where: eq(ROW_ORDINAL, ordinal), limit: 1 })
    return row?.ts
}

/**
 * What one row transaction changed, collected while it writes and appended to the
 * commit log before the transaction commits.
 */
class CommitDraft {
    private firstChanged = Number.POSITIVE_INFINITY
    private lengthAfter: number | undefined
    /** ts of each row whose order must be checked, by ordinal; a later write of an ordinal wins. */
    private readonly written = new Map<number, number>()

    get changed(): boolean {
        return this.firstChanged !== Number.POSITIVE_INFINITY
    }

    get firstChangedOrdinal(): number {
        return this.firstChanged
    }

    /** Row count after the transaction when its last write fixed it; otherwise it is read. */
    get knownLength(): number | undefined {
        return this.lengthAfter
    }

    recordInsert(rows: readonly UiMessageRow[]): void {
        if (rows.length === 0) return
        for (const row of rows) {
            this.firstChanged = Math.min(this.firstChanged, row.ordinal)
            this.written.set(row.ordinal, row.ts)
        }
        this.lengthAfter = undefined
    }

    /** Rows are dense from ordinal 0, so the hint index is also the first changed ordinal. */
    recordReplaceAll(rows: readonly UiMessageRow[], hint: UnifyStoreWriteHint | undefined): void {
        const requested = hint?.firstChangedIndex ?? 0
        const first = Number.isSafeInteger(requested) ? Math.min(Math.max(0, requested), rows.length) : 0
        this.firstChanged = Math.min(this.firstChanged, first)
        this.written.clear()
        for (const row of rows.slice(first)) this.written.set(row.ordinal, row.ts)
        this.lengthAfter = rows.length
    }

    recordTailReplace(firstReplaced: number, rows: readonly UiMessageRow[]): void {
        this.firstChanged = Math.min(this.firstChanged, firstReplaced)
        for (const ordinal of [...this.written.keys()]) {
            if (ordinal >= firstReplaced) this.written.delete(ordinal)
        }
        for (const row of rows) this.written.set(row.ordinal, row.ts)
        this.lengthAfter = firstReplaced + rows.length
    }

    /**
     * The first written ts that is not greater than the ts before it, or not less
     * than the ts after it, in the committed rows; null when the order holds.
     *
     * Only neighbours of each contiguous run of written rows are read, so the cost
     * does not grow with the history.
     */
    async findTsViolation(rows: ReadAccess["rows"], committedLength: number): Promise<number | null> {
        const ordinals = [...this.written.keys()].filter((ordinal) => ordinal < committedLength).sort((a, b) => a - b)
        let start = 0
        while (start < ordinals.length) {
            let end = start
            while (end + 1 < ordinals.length && ordinals[end + 1] === ordinals[end] + 1) end++
            const violation = await this.checkRun(rows, ordinals[start], ordinals[end], committedLength)
            if (violation !== null) return violation
            start = end + 1
        }
        return null
    }

    private async checkRun(
        rows: ReadAccess["rows"],
        first: number,
        last: number,
        committedLength: number,
    ): Promise<number | null> {
        const tsOf = (ordinal: number) => this.written.get(ordinal) as number
        if (first > 0) {
            const before = await storedTimestampAt(rows, first - 1)
            if (before !== undefined && tsOf(first) <= before) return tsOf(first)
        }
        for (let ordinal = first + 1; ordinal <= last; ordinal++) {
            if (tsOf(ordinal) <= tsOf(ordinal - 1)) return tsOf(ordinal)
        }
        if (last + 1 < committedLength) {
            const after = await storedTimestampAt(rows, last + 1)
            if (after !== undefined && after <= tsOf(last)) return after
        }
        return null
    }
}

async function readCommitState(
    commitState: Pick<UnifyStoreTransaction<UiMessageCommitStateRow>, "query">,
): Promise<UiMessageCommitStateRow | undefined> {
    const [state] = await commitState.query({ where: eq(COMMIT_STATE_KEY, UI_MESSAGE_COMMIT_STATE_KEY), limit: 1 })
    return state
}

async function storedLength(rows: ReadAccess["rows"]): Promise<number> {
    const [last] = await rows.query({ orderBy: [desc(ROW_ORDINAL)], limit: 1 })
    return last ? last.ordinal + 1 : 0
}

interface CommitFloor {
    readonly throughSeq: number
    readonly minOrdinal: number | null
}

/** Delete the entries that fell out of retention and fold their changes into the floor. */
async function trimCommits(
    access: CollectionAccess,
    headSeq: number,
    state: UiMessageCommitStateRow | undefined,
): Promise<CommitFloor> {
    const floor: CommitFloor = { throughSeq: state?.floorThroughSeq ?? 0, minOrdinal: state?.floorMinOrdinal ?? null }
    const trimThrough = headSeq - UI_MESSAGE_COMMIT_RETENTION
    if (trimThrough <= floor.throughSeq) return floor
    const trimmed = await access.commits.query({ where: lt(COMMIT_SEQ, trimThrough + 1) })
    let minOrdinal = floor.minOrdinal
    for (const entry of trimmed) {
        minOrdinal = minOrdinal === null ? entry.firstChangedOrdinal : Math.min(minOrdinal, entry.firstChangedOrdinal)
    }
    if (trimmed.length > 0) await access.commits.deleteWhere(lt(COMMIT_SEQ, trimThrough + 1))
    return { throughSeq: trimThrough, minOrdinal }
}

/**
 * Append the entry describing `draft`, inside the row transaction, and return the
 * violating ts it recorded. The rows are written either way: the history keeps
 * what was shown, and derived projections decide how to treat the violation.
 */
async function appendCommit(access: CollectionAccess, draft: CommitDraft): Promise<number | null> {
    const state = await readCommitState(access.commitState)
    const committedLength = draft.knownLength ?? (await storedLength(access.rows))
    const violation = await draft.findTsViolation(access.rows, committedLength)
    const seq = (state?.headSeq ?? 0) + 1
    const firstChangedOrdinal = Math.min(draft.firstChangedOrdinal, committedLength)
    await access.commits.insert([new UiMessageCommitRow(seq, firstChangedOrdinal, committedLength, violation)])
    const floor = await trimCommits(access, seq, state)
    await access.commitState.upsert([
        new UiMessageCommitStateRow(
            state?.logId ?? randomUUID(),
            seq,
            floor.throughSeq,
            floor.minOrdinal,
            state?.violationTs ?? violation,
        ),
    ])
    return violation
}

/** Identity and position of the commit log; `logId` is null until the first commit. */
export interface UiMessageCommitHead {
    readonly logId: string | null
    readonly headSeq: number
    /** The first violating ts ever written to this `messages.db`, or null. */
    readonly violationTs: number | null
}

export interface UiMessageCommitsSince extends UiMessageCommitHead {
    /**
     * Smallest first changed ordinal of the commits after the requested seq, counting
     * trimmed commits through the floor, so it never under-reports; null when none.
     */
    readonly minFirstChangedOrdinal: number | null
    /** A ts violation recorded by a retained commit after the requested seq, or null. */
    readonly tsViolation: number | null
}

/** Read side of the `messages.db` commit log, for projections derived from the chat rows. */
export interface CommitLogReader {
    head(): Promise<UiMessageCommitHead>
    since(seq: number): Promise<UiMessageCommitsSince>
}

/** No commits yet: what a log without its state row, or without its collections, reads as. */
const NO_COMMITS: UiMessageCommitsSince = {
    logId: null,
    headSeq: 0,
    violationTs: null,
    minFirstChangedOrdinal: null,
    tsViolation: null,
}

/**
 * Attempts at reading the log state and its entries with no commit landing in
 * between. Commits are milliseconds apart at most while a task streams, so a
 * collision rarely repeats; past the last attempt the answer falls back to a
 * conservative one instead of waiting.
 */
const COMMIT_READ_ATTEMPTS = 5

/**
 * Whether opening may create the collections a database lacks. Only the message
 * writer creates them; a reader opens what exists and never changes the schema
 * of a history it does not own.
 */
export type UiMessageCollections = "create" | "existing"

/** A reader found a `messages.db` without its chat row collections, so it holds no history. */
export class UiMessageRowsMissing extends Error {
    constructor() {
        super("messages.db holds no chat row collections")
        this.name = "UiMessageRowsMissing"
    }
}

async function holdsBoth<TFirst extends object, TSecond extends object>(
    database: TransactionalUnifyStoreDatabase,
    first: StoredEntityClass<TFirst>,
    second: StoredEntityClass<TSecond>,
): Promise<boolean> {
    return (await database.hasStore(first)) && (await database.hasStore(second))
}

async function openCommitLog(
    database: TransactionalUnifyStoreDatabase,
    collections: UiMessageCollections,
): Promise<CommitLogReader> {
    if (collections === "create") {
        return createCommitLogReader(
            await database.openStore(UiMessageCommitRow),
            await database.openStore(UiMessageCommitStateRow),
        )
    }
    return adoptingCommitLog(database)
}

/**
 * A reader's log over a history that may predate the commit log. While its
 * collections are absent it reads as no commits; once the writer creates them,
 * the next read adopts the real log, so a held reader keeps following commits.
 * Collections are only checked and opened, never created.
 */
function adoptingCommitLog(database: TransactionalUnifyStoreDatabase): CommitLogReader {
    let log: CommitLogReader | undefined
    const resolve = async (): Promise<CommitLogReader | undefined> => {
        if (log || !(await holdsBoth(database, UiMessageCommitRow, UiMessageCommitStateRow))) return log
        log = createCommitLogReader(
            await database.openStore(UiMessageCommitRow),
            await database.openStore(UiMessageCommitStateRow),
        )
        return log
    }
    return {
        async head() {
            const current = await resolve()
            if (!current) return { logId: NO_COMMITS.logId, headSeq: NO_COMMITS.headSeq, violationTs: NO_COMMITS.violationTs }
            return await current.head()
        },
        async since(seq) {
            const current = await resolve()
            return current ? await current.since(seq) : NO_COMMITS
        },
    }
}

function sameCommitState(a: UiMessageCommitStateRow | undefined, b: UiMessageCommitStateRow | undefined): boolean {
    return a?.logId === b?.logId && a?.headSeq === b?.headSeq
}

function summarizeCommits(
    state: UiMessageCommitStateRow,
    seq: number,
    entries: readonly UiMessageCommitRow[],
): UiMessageCommitsSince {
    let minFirstChangedOrdinal = seq < state.floorThroughSeq ? state.floorMinOrdinal : null
    let tsViolation: number | null = null
    for (const entry of entries) {
        minFirstChangedOrdinal =
            minFirstChangedOrdinal === null
                ? entry.firstChangedOrdinal
                : Math.min(minFirstChangedOrdinal, entry.firstChangedOrdinal)
        tsViolation ??= entry.tsViolation
    }
    return { logId: state.logId, headSeq: state.headSeq, violationTs: state.violationTs, minFirstChangedOrdinal, tsViolation }
}

/**
 * Reads only, outside any transaction: on JSONL a transaction takes the writer
 * lock and runs recovery, which a reader must never do. Each read sees one
 * committed state, and a commit changes the log state and its entries together,
 * so entries read between two equal states belong to that state.
 */
function createCommitLogReader(
    commits: UnifyStore<UiMessageCommitRow>,
    commitState: UnifyStore<UiMessageCommitStateRow>,
): CommitLogReader {
    const readState = async () =>
        (await commitState.query({ where: eq(COMMIT_STATE_KEY, UI_MESSAGE_COMMIT_STATE_KEY), limit: 1 })).records[0]
    return {
        async head() {
            const state = await readState()
            return { logId: state?.logId ?? null, headSeq: state?.headSeq ?? 0, violationTs: state?.violationTs ?? null }
        },
        // Between two separate reads a commit could trim an entry before the floor that
        // accounts for it is visible, hence the state is read again around the entries.
        async since(seq) {
            for (let attempt = 0; attempt < COMMIT_READ_ATTEMPTS; attempt++) {
                const state = await readState()
                if (!state) return NO_COMMITS
                const entries = (await commits.query({ where: gte(COMMIT_SEQ, seq + 1), orderBy: [asc(COMMIT_SEQ)] })).records
                if (sameCommitState(state, await readState())) return summarizeCommits(state, seq, entries)
            }
            // Commits kept landing: report everything as changed at the latest state. The rows
            // the caller reads next are at least that new, and its next read covers later commits.
            const state = await readState()
            if (!state) return NO_COMMITS
            return { ...summarizeCommits(state, seq, []), minFirstChangedOrdinal: 0 }
        },
    }
}

type UiMessageCommitListener = () => void

const commitListeners = new Map<string, Set<UiMessageCommitListener>>()

function commitKey(instanceRoot: string): string {
    const resolved = path.resolve(instanceRoot)
    return process.platform === "win32" ? resolved.toLowerCase() : resolved
}

/**
 * Call `listener` after every successful row transaction on the chat rows of
 * `instanceRoot` in this process, including a legacy import and generic
 * transactions. The wake-up carries no data; the listener reads the commit log.
 * Returns the function that stops delivery.
 */
export function subscribeUiMessageCommits(instanceRoot: string, listener: UiMessageCommitListener): () => void {
    const key = commitKey(instanceRoot)
    let listeners = commitListeners.get(key)
    if (!listeners) {
        listeners = new Set()
        commitListeners.set(key, listeners)
    }
    listeners.add(listener)
    return () => {
        const current = commitListeners.get(key)
        if (!current) return
        current.delete(listener)
        if (current.size === 0) commitListeners.delete(key)
    }
}

function publishUiMessageCommit(instanceRoot: string): void {
    const listeners = commitListeners.get(commitKey(instanceRoot))
    if (!listeners) return
    for (const listener of [...listeners]) {
        try {
            listener()
        } catch (error) {
            // A listener is a derived cache; its failure must never fail the write that woke it.
            Logger.warn(`[messages.db] UiMessageCommitListenerFailed: ${error instanceof Error ? error.message : String(error)}`)
        }
    }
}

function reportTsViolation(instanceRoot: string | undefined, ts: number): void {
    const instance = instanceRoot ? path.basename(instanceRoot) : "unknown"
    Logger.warn(`[messages.db] UiMessageTsOrderViolation: instance=${instance} ts=${ts}`)
}

/**
 * Chat rows of one instance in `messages.db`: one row per message plus its image and
 * file references, always written together in one transaction.
 *
 * Every row transaction also appends one entry to the commit log in the same
 * transaction and checks that the written timestamps keep increasing; after it
 * commits, subscribers of the instance root are woken.
 */
export class UiMessageRowStore implements UnifyStore<UiMessageRecord> {
    private constructor(
        private readonly database: TransactionalUnifyStoreDatabase,
        private readonly rows: UnifyStore<UiMessageRow>,
        private readonly attachments: UnifyStore<UiMessageAttachmentRow>,
        readonly commitLog: CommitLogReader,
        private readonly release: () => Promise<void>,
        private readonly instanceRoot: string | undefined,
    ) {}

    /**
     * Opens every collection; `release` runs once when the store closes.
     *
     * `instanceRoot` keys the commit signal and names the instance in diagnostics;
     * without it no subscriber is woken.
     *
     * With `"existing"` nothing is created: missing chat row collections throw
     * {@link UiMessageRowsMissing}, and missing commit log collections, as in a
     * history written before the log existed, read as an empty log.
     */
    static async open(
        database: TransactionalUnifyStoreDatabase,
        release: () => Promise<void>,
        instanceRoot?: string,
        collections: UiMessageCollections = "create",
    ): Promise<UiMessageRowStore> {
        if (collections === "existing" && !(await holdsBoth(database, UiMessageRow, UiMessageAttachmentRow))) {
            throw new UiMessageRowsMissing()
        }
        const rows = await database.openStore(UiMessageRow)
        const attachments = await database.openStore(UiMessageAttachmentRow)
        const commitLog = await openCommitLog(database, collections)
        return new UiMessageRowStore(database, rows, attachments, commitLog, release, instanceRoot)
    }

    async query(query?: UnifyStoreQuery<UiMessageRecord>): Promise<UnifyStoreResult<UiMessageRecord>> {
        const limit = assertOrderedQuery(query)
        const direct: ReadAccess = {
            rows: { query: async (q) => (await this.rows.query(q)).records },
            attachments: { query: async (q) => (await this.attachments.query(q)).records },
        }
        return { records: await readRecords(direct, limit), stats: await this.stats() }
    }

    insert(records: readonly UiMessageRecord[]): Promise<void> {
        return this.commitRows((access, draft) => insertRecords(access, records, draft))
    }

    /** Not offered: replacing one row by key would leave its old attachments behind. */
    upsert(): Promise<void> {
        return Promise.reject(new Error("UiMessageRowStore does not support upsert; use replaceAll"))
    }

    /** `hint` only bounds the commit log entry; the stored rows are the same without it. */
    replaceAll(records: readonly UiMessageRecord[], hint?: UnifyStoreWriteHint): Promise<void> {
        return this.commitRows((access, draft) => replaceRecords(access, records, draft, hint))
    }

    /**
     * Replace the last `replacedCount` stored messages with `entries`, rows and attachments
     * together in one transaction, provided the stored history still ends with
     * `expectedTailTimestamps` and holds exactly `durableCount` rows.
     *
     * Resolves false without writing otherwise, so the buffered store falls back to
     * reading and merging the whole history. On SQLite only the tail is read and
     * written, which keeps an edit near the end of a long task independent of its
     * length; the in-memory engine behind the JSONL backend still rewrites the
     * collection, as its merge did before.
     *
     * The check compares timestamps, not content: like the JSONL tail rewrite it
     * relies on the task holding the only writable handle on its messages.
     */
    replaceTail(replacement: BufferedTailReplacement<UiMessage>): Promise<boolean> {
        const { durableCount, expectedTailTimestamps, replacedCount, entries } = replacement
        const tailStart = durableCount - expectedTailTimestamps.length
        const firstReplaced = durableCount - replacedCount
        if (!isValidTailReplacement(tailStart, replacedCount, expectedTailTimestamps.length)) return Promise.resolve(false)
        return this.commitRows(async (access, draft) => {
            const tail = await access.rows.query({ where: gte(ROW_ORDINAL, tailStart), orderBy: [asc(ROW_ORDINAL)] })
            if (!isExpectedTail(tail, tailStart, expectedTailTimestamps)) return false
            if (replacedCount > 0) await access.rows.deleteWhere(gte(ROW_ORDINAL, firstReplaced))
            // Attachments are keyed by ordinal, so any left at or past the first new row,
            // including ones no row owns, would attach to the rows inserted below.
            await access.attachments.deleteWhere(gte(ATTACHMENT_ORDINAL, firstReplaced))
            const written = await writeRecords(
                access,
                entries.map((message, index) => ({ ordinal: firstReplaced + index, ts: message.ts, message })),
            )
            draft.recordTailReplace(firstReplaced, written)
            return true
        })
    }

    transaction<TResult>(
        operation: (transaction: UnifyStoreTransaction<UiMessageRecord>) => TResult | Promise<TResult>,
    ): Promise<TResult> {
        return this.commitRows(async (access, draft) =>
            operation({
                query: (query) => readRecords(access, assertOrderedQuery(query)),
                insert: (records) => insertRecords(access, records, draft),
                upsert: () => this.upsert(),
                replaceAll: (records, hint) => replaceRecords(access, records, draft, hint),
            }),
        )
    }

    /**
     * Run `write` in one database transaction and, when it changed rows, append its
     * commit log entry in that transaction. Only after the commit succeeds is a ts
     * violation reported and are subscribers woken; a failed transaction does neither.
     */
    private async commitRows<TResult>(
        write: (access: CollectionAccess, draft: CommitDraft) => Promise<TResult>,
    ): Promise<TResult> {
        const { value, commit } = await this.database.transaction(async (transaction) => {
            const access = transactionAccess(transaction)
            const draft = new CommitDraft()
            const result = await write(access, draft)
            if (!draft.changed) return { value: result, commit: undefined }
            return { value: result, commit: { violation: await appendCommit(access, draft) } }
        })
        if (commit) {
            if (commit.violation !== null) reportTsViolation(this.instanceRoot, commit.violation)
            if (this.instanceRoot) publishUiMessageCommit(this.instanceRoot)
        }
        return value
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
}
