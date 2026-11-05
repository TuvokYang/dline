/**
 * The two metrics levels, parameterized by one scope contract.
 *
 * A scope names where a level stores rows and what value its `scopeId` column holds.
 * Nothing here reads another level: a scope is a storage address, not a hierarchy, so
 * deleting one level's database cannot affect another's.
 *
 * There is deliberately no workspace level. Usage is accounted per Profile and per
 * Task, and a workspace is neither: a Profile accumulates across every Task it ran,
 * while a Task owns the local facts that belong to its own lifecycle. Introducing a
 * third root would split the same fact into two files without a product meaning.
 */

import { globalMetricsDatabasePath, taskMetricsDatabasePath } from "./MetricsPaths"

/** One aggregation level. */
export interface MetricsScope {
    readonly level: "task" | "global"
    /** Value stored in the `scopeId` column; empty for the global level. */
    readonly scopeId: string
    /** Resolved database path for this level. */
    readonly databasePath: string
}

/** The Task level: rows live beside the Task's own metrics collections. */
export async function taskMetricsScope(taskId: string): Promise<MetricsScope> {
    return {
        level: "task",
        scopeId: taskId,
        databasePath: await taskMetricsDatabasePath(taskId),
    }
}

/**
 * The global level.
 *
 * `scopeId` is empty on purpose: there is exactly one global database, so a per-Profile
 * value here would either duplicate the database per Profile or make rows
 * indistinguishable from a workspace whose id happened to match.
 */
export function globalMetricsScope(): MetricsScope {
    return {
        level: "global",
        scopeId: "",
        databasePath: globalMetricsDatabasePath(),
    }
}

/** Stable key for a scope's database, used to key one ledger per file. */
export function scopeStorageKey(scope: MetricsScope): string {
    return scope.databasePath
}
