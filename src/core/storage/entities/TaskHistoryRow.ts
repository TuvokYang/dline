import type { HistoryItem } from "@shared/HistoryItem"
import { column, defineEntity } from "../backend/api/EntitySchema"

/**
 * One durable task-history record, keyed by the task id.
 *
 * The task id is the primary key so the store itself guarantees that a task has
 * exactly one row. The previous append-structured layout keyed rows by their
 * ordinal, which let a task accumulate superseded revisions and pushed the
 * "latest row wins" rule into hand-written deduplication that read the oldest
 * row instead.
 *
 * Fields that the store has to filter, sort or compare are promoted to columns;
 * the remaining metadata stays in `payload` because no query depends on it.
 */
export interface TaskHistoryRowData {
    /** Task id; primary key. */
    id: string
    /** Timestamp of the latest persisted task activity, in milliseconds. */
    ts: number
    /** Revision that produced the completion projection, or null when never set. */
    completionRevision: number | null
    isCompleted: boolean
    isFavorited: boolean
    /** Remaining history metadata, validated at the persistence boundary. */
    payload: HistoryItem
}

/**
 * Reject persisted values that cannot be used as a history item.
 *
 * Stored rows are untrusted input: an older build, a partial write or a manual
 * edit can leave a shape the rest of the code would silently misread. Only the
 * fields every consumer depends on are required here; optional metadata is
 * intentionally not constrained so that adding a field stays backward
 * compatible.
 */
export function isHistoryItem(value: unknown): value is HistoryItem {
    if (typeof value !== "object" || value === null || Array.isArray(value)) return false
    const candidate = value as Record<string, unknown>
    return (
        typeof candidate.id === "string" &&
        candidate.id.length > 0 &&
        typeof candidate.ts === "number" &&
        Number.isFinite(candidate.ts) &&
        typeof candidate.task === "string"
    )
}

export class TaskHistoryRow implements TaskHistoryRowData {
    // The schema is declared over the class rather than the data interface so the
    // store's field refs and query types line up with the hydrated entity.
    // `EntityDataKey` filters out methods, so only the columns below participate.
    static readonly storage = defineEntity<TaskHistoryRow>()({
        schemaId: "task-history",
        version: 1,
        columns: {
            id: column.text({ primary: true }),
            ts: column.real({ indexed: true }),
            completionRevision: column.integer({ nullable: true }),
            isCompleted: column.boolean(),
            isFavorited: column.boolean(),
            payload: column.json<HistoryItem>({ validate: isHistoryItem }),
        },
        defaultOrder: [{ field: "ts", direction: "desc" }],
        hydrate: (values) =>
            new TaskHistoryRow(
                values.id,
                values.ts,
                values.completionRevision,
                values.isCompleted,
                values.isFavorited,
                values.payload,
            ),
    })

    constructor(
        readonly id: string,
        readonly ts: number,
        readonly completionRevision: number | null,
        readonly isCompleted: boolean,
        readonly isFavorited: boolean,
        readonly payload: HistoryItem,
    ) {}

    /**
     * Project a history item into its durable row.
     *
     * The completion projection is passed separately because it is owned by the
     * completion write path, not by ordinary metadata updates: an update that
     * carries a stale `isCompleted` must not retract a newer verdict.
     */
    static fromHistoryItem(item: HistoryItem, completion?: TaskCompletionProjection): TaskHistoryRow {
        const payload = withCompletionProjection(item, completion)
        return new TaskHistoryRow(
            item.id,
            item.ts,
            completion?.revision ?? null,
            completion?.isCompleted ?? false,
            item.isFavorited === true,
            payload,
        )
    }

    /** The history item this row represents, including its completion projection. */
    toHistoryItem(): HistoryItem {
        return this.payload
    }

    /** The canonical completion projection, or undefined when none was ever recorded. */
    completionProjection(): TaskCompletionProjection | undefined {
        if (this.completionRevision === null) return undefined
        return { isCompleted: this.isCompleted, revision: this.completionRevision }
    }

    /** A copy of this row carrying a new completion projection. */
    withCompletion(completion: TaskCompletionProjection): TaskHistoryRow {
        return new TaskHistoryRow(
            this.id,
            this.ts,
            completion.revision,
            completion.isCompleted,
            this.isFavorited,
            withCompletionProjection(this.payload, completion),
        )
    }
}

/** Canonical completion verdict of one task, together with the revision that produced it. */
export interface TaskCompletionProjection {
    isCompleted: boolean
    revision: number
}

/**
 * Keep the payload's completion fields in sync with the canonical projection.
 *
 * Both fields travel together: a bare `isCompleted` without a revision predates
 * the projection and is not authoritative, so consumers must not see one
 * without the other.
 */
function withCompletionProjection(item: HistoryItem, completion: TaskCompletionProjection | undefined): HistoryItem {
    const payload = { ...item }
    delete payload.isCompleted
    delete payload.completionStateRevision
    if (completion) {
        payload.isCompleted = completion.isCompleted
        payload.completionStateRevision = completion.revision
    }
    return payload
}
