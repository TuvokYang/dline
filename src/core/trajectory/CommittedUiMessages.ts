import type { OrdinalRow } from "./foldTrajectory"

/** Identity and position of the `messages.db` commit log; `logId` is null before the first commit. */
export interface CommitHead {
    readonly logId: string | null
    readonly headSeq: number
    /** The first non-increasing ts ever written to this history, or null. */
    readonly violationTs: number | null
}

/** What changed after a commit seq, never under-reporting entries the log has trimmed. */
export interface CommitsSince extends CommitHead {
    /** Smallest ordinal changed by a commit after the requested seq; null when nothing changed. */
    readonly minFirstChangedOrdinal: number | null
    /** A ts violation recorded by a retained commit after the requested seq, or null. */
    readonly tsViolation: number | null
}

/**
 * The task has no canonical `messages.db` yet, for example a history whose
 * legacy file only the lock holder may import. Nothing is created to answer;
 * the trajectory is unavailable until that import has run.
 */
export class CommittedUiMessagesMissing extends Error {
    constructor(readonly taskId: string) {
        super(`Committed chat rows of ${taskId} are not in messages.db yet`)
        this.name = "CommittedUiMessagesMissing"
    }
}

/**
 * Committed chat rows of one task as the trajectory maintainer reads them (C3).
 *
 * Everything here describes durable state: no writer's in-memory buffer is
 * involved, so a window that takes over a task never folds a stale baseline.
 */
export interface CommittedUiMessages {
    readonly log: {
        head(): Promise<CommitHead>
        since(seq: number): Promise<CommitsSince>
    }
    readonly rows: {
        /** Committed rows whose ordinal is in `[start, end)`, in ordinal order. */
        readRange(start: number, end: number): Promise<OrdinalRow[]>
    }
    readonly signals: {
        /** Wake `listener`, without data, after every committed row transaction of this task in this process. */
        subscribe(listener: () => void): () => void
    }
    close(): Promise<void>
}
