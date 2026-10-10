import type { TransactionalUnifyStoreDatabase, UnifyStore } from "@core/storage/backend/api/UnifyStore"
import { eq } from "@core/storage/backend/api/UnifyStoreQuery"
import type { Command } from "../../kernel"
import type {
    BackgroundDeliveryLedger,
    BackgroundDeliveryRecord,
    CommandPublicationStore,
    ConversationJournal,
    JournalAppendInput,
    JournalAppendResult,
    JournalEntry,
    JournalEntryKind,
    JournalWatermark,
    TaskPayloadStore,
} from "../contracts"
import { journalOperationFingerprint } from "../JournalOperationIdentity"
import { compareJournalWatermarks, rebuildJournalProjection } from "../JournalProjection"
import { assertTaskPayloadRef, taskPayloadRef } from "../payload/TaskPayloadRef"
import { BackgroundDeliveryRow, CommandPublicationRow, JournalEntryRow, PayloadRow } from "./entities"

type EntryContent = Omit<JournalEntry, "version" | "operationId" | "kind" | "watermark">

/**
 * Identity of an operation's content. Key order and absent fields do not matter,
 * so a retried call and the row reloaded after a restart compare equal.
 */
function fingerprintOf(kind: JournalEntryKind, content: EntryContent): string {
    return journalOperationFingerprint(kind, content)
}

function contentOf(entry: JournalEntry): EntryContent {
    const { version: _version, operationId: _operationId, kind: _kind, watermark: _watermark, ...content } = entry
    return content
}

/**
 * The conversation journal of one task, stored in `journal.db`.
 *
 * Every record is one committed SQLite transaction, so a crash leaves either the
 * whole record or none of it; there is no torn tail to repair. The journal is
 * loaded once and served from memory, and writes are serialized so sequence
 * numbers stay contiguous.
 */
export class SqliteConversationJournal implements ConversationJournal {
    private current: JournalWatermark = { seq: 0 }
    private readonly entries: JournalEntry[] = []
    private readonly operations = new Map<string, { readonly fingerprint: string; readonly entry: JournalEntry }>()
    private readonly transient = new Set<string>()
    private writeTail: Promise<void> = Promise.resolve()

    private constructor(private readonly store: UnifyStore<JournalEntryRow>) {}

    /** @throws when the stored sequence has a gap or repeats an operation. */
    static async open(store: UnifyStore<JournalEntryRow>): Promise<SqliteConversationJournal> {
        const journal = new SqliteConversationJournal(store)
        const { records } = await store.query()
        for (const row of records) journal.adopt(row.toEntry())
        rebuildJournalProjection(journal.entries, journal.current)
        return journal
    }

    watermark(): JournalWatermark {
        return this.current
    }

    append(input: JournalAppendInput): Promise<JournalAppendResult> {
        return this.enqueue(() =>
            this.record("message", input.operationId, {
                payloadRef: input.payloadRef,
                source: input.source,
                causation: input.causation,
            }),
        )
    }

    async read(after?: JournalWatermark, through?: JournalWatermark): Promise<readonly JournalEntry[]> {
        await this.writeTail
        return this.entries.filter(
            (entry) =>
                (!after || compareJournalWatermarks(entry.watermark, after) > 0) &&
                (!through || compareJournalWatermarks(entry.watermark, through) <= 0),
        )
    }

    async findByOperation(operationId: string): Promise<JournalEntry | undefined> {
        await this.writeTail
        return this.operations.get(operationId)?.entry
    }

    async project(through?: JournalWatermark) {
        await this.writeTail
        return rebuildJournalProjection(this.entries, through ?? this.current)
    }

    appendTransient(transientId: string): void {
        this.transient.add(transientId)
    }

    discardTransient(transientId: string): void {
        this.transient.delete(transientId)
    }

    finalizeTransient(input: JournalAppendInput & { readonly transientId: string }): Promise<JournalAppendResult> {
        return this.enqueue(async () => {
            const content = {
                payloadRef: input.payloadRef,
                source: input.source,
                causation: input.causation,
                transientId: input.transientId,
            }
            const existing = this.idempotent(input.operationId, "message", content)
            if (existing) return existing
            if (!this.transient.has(input.transientId)) throw new Error(`Unknown transient journal entry: ${input.transientId}`)
            const result = await this.record("message", input.operationId, content)
            this.transient.delete(input.transientId)
            return result
        })
    }

    rewind(input: { readonly operationId: string; readonly target: JournalWatermark }): Promise<JournalAppendResult> {
        return this.enqueue(() => this.record("rewind", input.operationId, { target: input.target }))
    }

    tombstone(input: { readonly operationId: string; readonly target: JournalWatermark }): Promise<JournalAppendResult> {
        return this.enqueue(() => this.record("tombstone", input.operationId, { target: input.target }))
    }

    truncateBoundary(input: { readonly operationId: string; readonly target: JournalWatermark }): Promise<JournalAppendResult> {
        return this.enqueue(() => this.record("truncate_boundary", input.operationId, { target: input.target }))
    }

    supersedeRange(input: {
        readonly operationId: string
        readonly from: JournalWatermark
        readonly to: JournalWatermark
        readonly replacementRef?: string
    }): Promise<JournalAppendResult> {
        return this.enqueue(() => {
            if (compareJournalWatermarks(input.from, input.to) > 0) throw new Error("Supersede range must be ordered")
            return this.record("supersede_range", input.operationId, {
                range: { from: input.from, to: input.to },
                ...(input.replacementRef === undefined ? {} : { payloadRef: input.replacementRef }),
            })
        })
    }

    checkpointMarker(input: { readonly operationId: string; readonly checkpointRef: string }): Promise<JournalAppendResult> {
        return this.enqueue(() => this.record("checkpoint_marker", input.operationId, { payloadRef: input.checkpointRef }))
    }

    private adopt(entry: JournalEntry): void {
        if (this.operations.has(entry.operationId)) throw new Error(`DuplicateJournalOperation: ${entry.operationId}`)
        this.entries.push(entry)
        this.operations.set(entry.operationId, { fingerprint: fingerprintOf(entry.kind, contentOf(entry)), entry })
        this.current = entry.watermark
    }

    private enqueue<T>(work: () => Promise<T> | T): Promise<T> {
        const result = this.writeTail.then(work)
        this.writeTail = result.then(
            () => undefined,
            () => undefined,
        )
        return result
    }

    private idempotent(operationId: string, kind: JournalEntryKind, content: EntryContent): JournalAppendResult | undefined {
        const existing = this.operations.get(operationId)
        if (!existing) return undefined
        if (existing.fingerprint !== fingerprintOf(kind, content)) throw new Error(`Journal operation conflict: ${operationId}`)
        return { watermark: existing.entry.watermark, disposition: "existing" }
    }

    private async record(kind: JournalEntryKind, operationId: string, content: EntryContent): Promise<JournalAppendResult> {
        const existing = this.idempotent(operationId, kind, content)
        if (existing) return existing
        const watermark = { seq: this.current.seq + 1 }
        const row = JournalEntryRow.fromEntry({ ...content, version: 1, operationId, kind, watermark })
        await this.store.insert([row])
        // Adopt only what was committed, in the shape a reload would produce.
        this.adopt(row.toEntry())
        return { watermark, disposition: "appended" }
    }
}

/** Effect keys of published commands, stored in `journal.db` and mirrored in memory. */
export class SqliteCommandPublicationStore implements CommandPublicationStore {
    private writeTail: Promise<void> = Promise.resolve()

    private constructor(
        private readonly store: UnifyStore<CommandPublicationRow>,
        private readonly published: Set<string>,
    ) {}

    static async open(store: UnifyStore<CommandPublicationRow>): Promise<SqliteCommandPublicationStore> {
        const { records } = await store.query()
        return new SqliteCommandPublicationStore(store, new Set(records.map((record) => record.effectKey)))
    }

    async has(effectKey: string): Promise<boolean> {
        await this.writeTail
        return this.published.has(effectKey)
    }

    mark(command: Command, effectKey = command.commandId): Promise<void> {
        const write = this.writeTail.then(async () => {
            if (this.published.has(effectKey)) return
            await this.store.upsert([CommandPublicationRow.of(command, effectKey)])
            this.published.add(effectKey)
        })
        this.writeTail = write.catch(() => undefined)
        return write
    }
}

/** Producer-owned background results retained across crashes until canonical intake accepts them. */
export class SqliteBackgroundDeliveryLedger implements BackgroundDeliveryLedger {
    private writeTail: Promise<void> = Promise.resolve()

    private constructor(
        private readonly store: UnifyStore<BackgroundDeliveryRow>,
        private readonly records: Map<string, BackgroundDeliveryRecord>,
    ) {}

    static async open(store: UnifyStore<BackgroundDeliveryRow>): Promise<SqliteBackgroundDeliveryLedger> {
        const { records } = await store.query()
        return new SqliteBackgroundDeliveryLedger(store, new Map(records.map((row) => [row.entryId, row.toRecord()])))
    }

    stage(delivery: Omit<BackgroundDeliveryRecord, "state">): Promise<BackgroundDeliveryRecord> {
        return this.enqueue(async () => {
            const existing = this.records.get(delivery.entryId)
            if (existing) {
                if (
                    existing.producerKind !== delivery.producerKind ||
                    existing.producerId !== delivery.producerId ||
                    existing.attempt !== delivery.attempt ||
                    existing.text !== delivery.text
                ) {
                    throw new Error(`BackgroundDeliveryConflict:${delivery.entryId}`)
                }
                return existing
            }
            const record: BackgroundDeliveryRecord = { ...delivery, state: "pending" }
            await this.store.insert([BackgroundDeliveryRow.fromRecord(record)])
            this.records.set(record.entryId, record)
            return record
        })
    }

    async listPending(): Promise<readonly BackgroundDeliveryRecord[]> {
        await this.writeTail
        return [...this.records.values()].filter((record) => record.state === "pending")
    }

    acknowledge(entryId: string): Promise<void> {
        return this.enqueue(async () => {
            const existing = this.records.get(entryId)
            if (!existing || existing.state === "acknowledged") return
            const acknowledged: BackgroundDeliveryRecord = { ...existing, state: "acknowledged" }
            await this.store.upsert([BackgroundDeliveryRow.fromRecord(acknowledged)])
            this.records.set(entryId, acknowledged)
        })
    }

    private enqueue<T>(operation: () => Promise<T>): Promise<T> {
        const result = this.writeTail.then(operation)
        this.writeTail = result.then(
            () => undefined,
            () => undefined,
        )
        return result
    }
}

/** Content-addressed payloads stored in `journal.db`; equal bytes are stored once. */
export class SqliteTaskPayloadStore implements TaskPayloadStore {
    constructor(private readonly store: UnifyStore<PayloadRow>) {}

    async put(payload: Uint8Array): Promise<string> {
        const payloadRef = taskPayloadRef(payload)
        await this.store.upsert([new PayloadRow(payloadRef, new Uint8Array(payload))])
        return payloadRef
    }

    /** @throws `InvalidTaskPayloadRef` for a malformed reference, `TaskPayloadNotFound` when nothing is stored under it. */
    async read(payloadRef: string): Promise<Uint8Array> {
        assertTaskPayloadRef(payloadRef)
        // A plain query, not a transaction: `BEGIN IMMEDIATE` would take the write lock and
        // make a window that only reads this task contend with its writer.
        const {
            records: [row],
        } = await this.store.query({ where: eq(PayloadRow.storage.fields.ref, payloadRef), limit: 1 })
        if (!row) throw new Error(`TaskPayloadNotFound: ${payloadRef}`)
        return row.bytes
    }
}

/** Opens only the content-addressed payload collection for read-mostly projections. */
export async function openTaskPayloadStore(database: TransactionalUnifyStoreDatabase): Promise<SqliteTaskPayloadStore> {
    return new SqliteTaskPayloadStore(await database.openStore(PayloadRow))
}

/** The kernel's durable stores of one task, all in the same `journal.db`. */
export interface TaskJournalStores {
    readonly journal: SqliteConversationJournal
    readonly publications: SqliteCommandPublicationStore
    readonly backgroundDeliveries: SqliteBackgroundDeliveryLedger
    readonly payloads: SqliteTaskPayloadStore
}

/** Opens the journal, publication and payload collections of `database` and loads what they hold. */
export async function openTaskJournalStores(database: TransactionalUnifyStoreDatabase): Promise<TaskJournalStores> {
    const entries = await database.openStore(JournalEntryRow)
    const publications = await database.openStore(CommandPublicationRow)
    const backgroundDeliveries = await database.openStore(BackgroundDeliveryRow)
    return {
        journal: await SqliteConversationJournal.open(entries),
        publications: await SqliteCommandPublicationStore.open(publications),
        backgroundDeliveries: await SqliteBackgroundDeliveryLedger.open(backgroundDeliveries),
        payloads: await openTaskPayloadStore(database),
    }
}
