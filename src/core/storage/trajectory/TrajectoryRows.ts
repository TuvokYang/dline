import { column, defineEntity } from "../backend/api/EntitySchema"

/**
 * Version of the turn and job payloads stored in `trajectory.db`.
 *
 * The physical schema of both collections is frozen; payload changes bump this
 * number instead, and a store whose meta carries another version is cleared and
 * rebuilt from `messages.db` rather than migrated.
 */
export const TRAJECTORY_PAYLOAD_VERSION = 1

/** Key of the single meta row. */
export const TRAJECTORY_META_KEY = "meta"

type JsonObject = Record<string, unknown>

function isJsonObject(value: unknown): value is JsonObject {
    return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Loose on purpose: an older payload must still hydrate so its version can be read and the cache cleared. */
function isJsonArray(value: unknown): value is readonly TrajectoryToolCount[] {
    return Array.isArray(value)
}

export interface TrajectoryToolCount {
    readonly tool: string
    readonly count: number
}

export interface TrajectoryTurnRowValues {
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
    /** Meta revision of the write that last stored this row; snapshot deltas select by it. */
    readonly revision: number
}

/** One closed or open turn of the trajectory, keyed by its dense `seq`. */
export class TrajectoryTurnRow implements TrajectoryTurnRowValues {
    static readonly storage = defineEntity<TrajectoryTurnRow>()({
        schemaId: "trajectory-turn",
        version: 1,
        columns: {
            seq: column.integer({ primary: true }),
            attemptSeq: column.integer(),
            anchorTs: column.real(),
            anchorOrdinal: column.integer({ indexed: true }),
            prompt: column.text(),
            rounds: column.integer(),
            toolUsage: column.json({ validate: isJsonArray }),
            endsAttempt: column.boolean(),
            tailTs: column.real(),
            tailAskKind: column.text({ nullable: true }),
            revision: column.integer({ indexed: true }),
        },
        defaultOrder: [{ field: "seq", direction: "asc" }],
        hydrate: (values) => new TrajectoryTurnRow(values),
    })

    declare readonly seq: number
    declare readonly attemptSeq: number
    declare readonly anchorTs: number
    declare readonly anchorOrdinal: number
    declare readonly prompt: string
    declare readonly rounds: number
    declare readonly toolUsage: readonly TrajectoryToolCount[]
    declare readonly endsAttempt: boolean
    declare readonly tailTs: number
    declare readonly tailAskKind: string | null
    declare readonly revision: number

    constructor(values: TrajectoryTurnRowValues) {
        Object.assign(this, values)
    }
}

export interface TrajectoryMetaRowValues {
    readonly key: string
    readonly payloadVersion: number
    readonly builderVersion: number
    /** Commit log identity of the `messages.db` the turns were folded from. */
    readonly logId: string | null
    /** New on every clear, so a stamp captured before a rebuild never matches after it. */
    readonly buildId: string
    /** Text rather than an enum column so a state written by a newer build still hydrates. */
    readonly state: string
    /** Increases on every write, across clears. */
    readonly revision: number
    readonly appliedCommitSeq: number
    readonly job: JsonObject | null
    readonly turnCount: number
    /** The violating ts when the projection stopped on a ts order error; nothing else is kept. */
    readonly errorTs: number | null
}

/** The single row describing the state of the projection. */
export class TrajectoryMetaRow implements TrajectoryMetaRowValues {
    static readonly storage = defineEntity<TrajectoryMetaRow>()({
        schemaId: "trajectory-meta",
        version: 1,
        columns: {
            key: column.text({ primary: true }),
            payloadVersion: column.integer(),
            builderVersion: column.integer(),
            logId: column.text({ nullable: true }),
            buildId: column.text(),
            state: column.text(),
            revision: column.integer(),
            appliedCommitSeq: column.integer(),
            job: column.json({ nullable: true, validate: isJsonObject }),
            turnCount: column.integer(),
            errorTs: column.real({ nullable: true }),
        },
        hydrate: (values) => new TrajectoryMetaRow(values),
    })

    declare readonly key: string
    declare readonly payloadVersion: number
    declare readonly builderVersion: number
    declare readonly logId: string | null
    declare readonly buildId: string
    declare readonly state: string
    declare readonly revision: number
    declare readonly appliedCommitSeq: number
    declare readonly job: JsonObject | null
    declare readonly turnCount: number
    declare readonly errorTs: number | null

    constructor(values: TrajectoryMetaRowValues) {
        Object.assign(this, values)
    }
}
