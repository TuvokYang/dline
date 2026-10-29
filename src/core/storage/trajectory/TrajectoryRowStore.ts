import { randomUUID } from "node:crypto"
import { stableJsonStringify } from "@/shared/stable-json"
import type {
    TransactionalUnifyStoreDatabase,
    UnifyStoreCollectionTransaction,
    UnifyStoreDatabaseTransaction,
} from "../backend/api/UnifyStore"
import { asc, desc, eq, gte, lt } from "../backend/api/UnifyStoreQuery"
import {
    TRAJECTORY_META_KEY,
    TRAJECTORY_PAYLOAD_VERSION,
    TrajectoryMetaRow,
    type TrajectoryToolCount,
    TrajectoryTurnRow,
} from "./TrajectoryRows"

export const TRAJECTORY_STATES = ["building", "ready", "error"] as const

/** `unknown` marks a meta row this build cannot interpret; the caller clears and rebuilds it. */
export type TrajectoryState = (typeof TRAJECTORY_STATES)[number] | "unknown"

/** Resumable position of an unfinished rebuild or catch-up; `carry` is owned by the fold. */
export interface TrajectoryJob {
    readonly fromSeq: number
    readonly nextOrdinal: number
    readonly targetSeq: number
    readonly carry: Readonly<Record<string, unknown>>
}

export interface TrajectoryMeta {
    readonly payloadVersion: number
    readonly builderVersion: number
    readonly logId: string | null
    readonly buildId: string
    readonly state: TrajectoryState
    readonly revision: number
    readonly appliedCommitSeq: number
    readonly job: TrajectoryJob | null
    readonly turnCount: number
    readonly errorTs: number | null
}

export interface TrajectoryTurnInput {
    readonly seq: number
    readonly attemptSeq: number
    readonly anchorTs: number
    readonly anchorOrdinal: number
    readonly prompt: string
    readonly rounds: number
    readonly toolUsage: readonly TrajectoryToolCount[]
    readonly endsAttempt: boolean
    readonly tailTs: number
    readonly tailAskKind: string | null
}

export interface TrajectoryTurn extends TrajectoryTurnInput {
    readonly revision: number
}

/**
 * What a writer last observed. Every write compares it with the stored meta and
 * writes nothing when another write happened in between.
 */
export interface TrajectoryStamp {
    readonly revision: number
    readonly buildId: string
    readonly job: TrajectoryJob | null
}

/** The meta fields an incremental or rebuild write may change. */
export interface TrajectoryMetaUpdate {
    readonly state: Exclude<TrajectoryState, "unknown">
    readonly appliedCommitSeq: number
    readonly job: TrajectoryJob | null
    readonly errorTs: number | null
}

export interface TrajectoryClearRequest {
    readonly logId: string | null
    readonly builderVersion: number
}

export type TrajectoryWriteResult =
    | { readonly applied: true; readonly meta: TrajectoryMeta }
    | { readonly applied: false; readonly meta: TrajectoryMeta | null }

export interface TrajectorySnapshot {
    readonly meta: TrajectoryMeta | null
    /** Turns written after `sinceRevision`, in seq order; empty when the payload version is not current. */
    readonly turns: readonly TrajectoryTurn[]
}

const SEQ = TrajectoryTurnRow.storage.fields.seq
const ANCHOR_ORDINAL = TrajectoryTurnRow.storage.fields.anchorOrdinal
const REVISION = TrajectoryTurnRow.storage.fields.revision
const META_KEY = TrajectoryMetaRow.storage.fields.key

type TurnAccess = UnifyStoreCollectionTransaction<TrajectoryTurnRow>
type MetaAccess = UnifyStoreCollectionTransaction<TrajectoryMetaRow>

function isState(value: string): value is Exclude<TrajectoryState, "unknown"> {
    return (TRAJECTORY_STATES as readonly string[]).includes(value)
}

function isWholeNumber(value: unknown): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0
}

function toJob(value: Readonly<Record<string, unknown>> | null): TrajectoryJob | null | undefined {
    if (value === null) return null
    const { fromSeq, nextOrdinal, targetSeq, carry } = value
    const valid =
        isWholeNumber(fromSeq) &&
        isWholeNumber(nextOrdinal) &&
        isWholeNumber(targetSeq) &&
        typeof carry === "object" &&
        carry !== null &&
        !Array.isArray(carry)
    return valid ? { fromSeq, nextOrdinal, targetSeq, carry: carry as Record<string, unknown> } : undefined
}

function toMeta(row: TrajectoryMetaRow): TrajectoryMeta {
    const job = toJob(row.job)
    const state: TrajectoryState = isState(row.state) && job !== undefined ? row.state : "unknown"
    return {
        payloadVersion: row.payloadVersion,
        builderVersion: row.builderVersion,
        logId: row.logId,
        buildId: row.buildId,
        state,
        revision: row.revision,
        appliedCommitSeq: row.appliedCommitSeq,
        job: job ?? null,
        turnCount: row.turnCount,
        errorTs: row.errorTs,
    }
}

function toTurn(row: TrajectoryTurnRow): TrajectoryTurn {
    return {
        seq: row.seq,
        attemptSeq: row.attemptSeq,
        anchorTs: row.anchorTs,
        anchorOrdinal: row.anchorOrdinal,
        prompt: row.prompt,
        rounds: row.rounds,
        toolUsage: row.toolUsage,
        endsAttempt: row.endsAttempt,
        tailTs: row.tailTs,
        tailAskKind: row.tailAskKind,
        revision: row.revision,
    }
}

/** The stamp a writer captures from `meta` to make its next write conditional on it. */
export function stampOf(meta: TrajectoryMeta): TrajectoryStamp {
    return { revision: meta.revision, buildId: meta.buildId, job: meta.job }
}

/** Jobs compare by value with sorted keys, so a backend returning another key order still matches. */
function matches(meta: TrajectoryMeta, expected: TrajectoryStamp): boolean {
    return (
        meta.revision === expected.revision &&
        meta.buildId === expected.buildId &&
        stableJsonStringify(meta.job) === stableJsonStringify(expected.job)
    )
}

/** Whether `meta` was written by this payload and builder version; otherwise the cache must be cleared. */
export function isCurrentTrajectory(meta: TrajectoryMeta, builderVersion: number): boolean {
    return (
        meta.payloadVersion === TRAJECTORY_PAYLOAD_VERSION && meta.builderVersion === builderVersion && meta.state !== "unknown"
    )
}

function assertDenseTurns(fromSeq: number, turns: readonly TrajectoryTurnInput[], turnCount: number): void {
    if (!isWholeNumber(fromSeq) || fromSeq > turnCount) {
        throw new Error(`TrajectoryInvalidWrite: fromSeq ${fromSeq} is outside the ${turnCount} stored turns`)
    }
    turns.forEach((turn, index) => {
        if (turn.seq !== fromSeq + index) {
            throw new Error(`TrajectoryInvalidWrite: turn ${index} has seq ${turn.seq}, expected ${fromSeq + index}`)
        }
    })
}

function metaRow(meta: TrajectoryMeta): TrajectoryMetaRow {
    return new TrajectoryMetaRow({
        key: TRAJECTORY_META_KEY,
        payloadVersion: meta.payloadVersion,
        builderVersion: meta.builderVersion,
        logId: meta.logId,
        buildId: meta.buildId,
        state: meta.state,
        revision: meta.revision,
        appliedCommitSeq: meta.appliedCommitSeq,
        job: meta.job as Record<string, unknown> | null,
        turnCount: meta.turnCount,
        errorTs: meta.errorTs,
    })
}

async function readMetaIn(meta: MetaAccess): Promise<TrajectoryMeta | null> {
    const [row] = await meta.query({ where: eq(META_KEY, TRAJECTORY_META_KEY), limit: 1 })
    return row ? toMeta(row) : null
}

interface Access {
    readonly turns: TurnAccess
    readonly meta: MetaAccess
}

function access(transaction: UnifyStoreDatabaseTransaction): Access {
    return { turns: transaction.store(TrajectoryTurnRow), meta: transaction.store(TrajectoryMetaRow) }
}

/**
 * Turns and meta of one instance in `trajectory.db`, a cache derived from
 * `messages.db` and written only by the trajectory maintainer.
 *
 * Every write is one transaction that first compares the stored meta with the
 * writer's {@link TrajectoryStamp} and writes nothing when they differ, so two
 * maintainers racing on the same file can never interleave their results.
 * `revision` increases on every write and survives clears; `buildId` changes on
 * every clear. Together they rule out a stamp matching a different rebuild.
 */
export class TrajectoryRowStore {
    private constructor(
        private readonly database: TransactionalUnifyStoreDatabase,
        private readonly release: () => Promise<void>,
    ) {}

    /** Opens both collections; `release` runs once when the store closes. */
    static async open(database: TransactionalUnifyStoreDatabase, release: () => Promise<void>): Promise<TrajectoryRowStore> {
        await database.openStore(TrajectoryTurnRow)
        await database.openStore(TrajectoryMetaRow)
        return new TrajectoryRowStore(database, release)
    }

    readMeta(): Promise<TrajectoryMeta | null> {
        return this.database.transaction((transaction) => readMetaIn(access(transaction).meta))
    }

    /**
     * Meta and the turns written after `sinceRevision`, read in one transaction.
     *
     * Pass -1 for every stored turn. Turns are omitted when the payload version is
     * not current, because they cannot be interpreted.
     */
    readSnapshot(sinceRevision: number): Promise<TrajectorySnapshot> {
        return this.database.transaction(async (transaction) => {
            const { turns, meta } = access(transaction)
            const current = await readMetaIn(meta)
            if (!current || current.payloadVersion !== TRAJECTORY_PAYLOAD_VERSION) return { meta: current, turns: [] }
            const rows = await turns.query({ where: gte(REVISION, sinceRevision + 1), orderBy: [asc(SEQ)] })
            return { meta: current, turns: rows.map(toTurn) }
        })
    }

    /** The turn whose anchor is the last one at or before `ordinal`, i.e. the turn that row belongs to. */
    async findTurnContaining(ordinal: number): Promise<TrajectoryTurn | undefined> {
        return this.database.transaction(async (transaction) => {
            const [row] = await access(transaction).turns.query({
                where: lt(ANCHOR_ORDINAL, ordinal + 1),
                orderBy: [desc(ANCHOR_ORDINAL)],
                limit: 1,
            })
            return row ? toTurn(row) : undefined
        })
    }

    async readTurn(seq: number): Promise<TrajectoryTurn | undefined> {
        return this.database.transaction(async (transaction) => {
            const [row] = await access(transaction).turns.query({ where: eq(SEQ, seq), limit: 1 })
            return row ? toTurn(row) : undefined
        })
    }

    /**
     * Replace every turn with seq >= `fromSeq` by `turns` and apply `update`, provided
     * the stored meta still matches `expected`.
     *
     * `turns` must be dense from `fromSeq`, and `fromSeq` may not leave a gap after the
     * stored turns. `appliedCommitSeq` may not decrease; only {@link clear} lowers it.
     */
    replaceFrom(
        fromSeq: number,
        turns: readonly TrajectoryTurnInput[],
        update: TrajectoryMetaUpdate,
        expected: TrajectoryStamp,
    ): Promise<TrajectoryWriteResult> {
        return this.database.transaction(async (transaction) => {
            const store = access(transaction)
            const current = await readMetaIn(store.meta)
            if (!current || !matches(current, expected)) return { applied: false, meta: current }
            assertDenseTurns(fromSeq, turns, current.turnCount)
            if (update.appliedCommitSeq < current.appliedCommitSeq) {
                throw new Error(
                    `TrajectoryCommitSeqRegression: ${update.appliedCommitSeq} is below the applied ${current.appliedCommitSeq}`,
                )
            }
            const revision = current.revision + 1
            if (fromSeq < current.turnCount) await store.turns.deleteWhere(gte(SEQ, fromSeq))
            if (turns.length > 0) await store.turns.upsert(turns.map((turn) => new TrajectoryTurnRow({ ...turn, revision })))
            const next: TrajectoryMeta = {
                ...current,
                ...update,
                revision,
                turnCount: fromSeq + turns.length,
            }
            await store.meta.upsert([metaRow(next)])
            return { applied: true, meta: next }
        })
    }

    /** Apply `update` without changing turns, under the same compare-and-set as {@link replaceFrom}. */
    updateMeta(update: TrajectoryMetaUpdate, expected: TrajectoryStamp): Promise<TrajectoryWriteResult> {
        return this.database.transaction(async (transaction) => {
            const store = access(transaction)
            const current = await readMetaIn(store.meta)
            if (!current || !matches(current, expected)) return { applied: false, meta: current }
            if (update.appliedCommitSeq < current.appliedCommitSeq) {
                throw new Error(
                    `TrajectoryCommitSeqRegression: ${update.appliedCommitSeq} is below the applied ${current.appliedCommitSeq}`,
                )
            }
            const next: TrajectoryMeta = { ...current, ...update, revision: current.revision + 1 }
            await store.meta.upsert([metaRow(next)])
            return { applied: true, meta: next }
        })
    }

    /**
     * Delete every turn and start a new build with a fresh `buildId`, provided the
     * stored meta still matches `expected` (`null` when no meta exists yet).
     *
     * This is also the recovery for a payload or builder version mismatch: the
     * physical schema is frozen, so the rows are deleted rather than migrated.
     */
    clear(request: TrajectoryClearRequest, expected: TrajectoryStamp | null): Promise<TrajectoryWriteResult> {
        return this.database.transaction(async (transaction) => {
            const store = access(transaction)
            const current = await readMetaIn(store.meta)
            const unchanged = current === null ? expected === null : expected !== null && matches(current, expected)
            if (!unchanged) return { applied: false, meta: current }
            await store.turns.deleteWhere(gte(SEQ, 0))
            const next: TrajectoryMeta = {
                payloadVersion: TRAJECTORY_PAYLOAD_VERSION,
                builderVersion: request.builderVersion,
                logId: request.logId,
                buildId: randomUUID(),
                state: "building",
                revision: (current?.revision ?? 0) + 1,
                appliedCommitSeq: 0,
                job: null,
                turnCount: 0,
                errorTs: null,
            }
            await store.meta.upsert([metaRow(next)])
            return { applied: true, meta: next }
        })
    }

    close(): Promise<void> {
        return this.release()
    }
}
