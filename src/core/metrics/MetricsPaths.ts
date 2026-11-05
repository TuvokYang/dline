/**
 * Where each metrics level stores its database.
 *
 * This is the only place these paths are computed. Callers receive a resolved
 * directory and must not rebuild one, so a future move of the metrics root cannot
 * leave two answers in the codebase.
 */

import path from "node:path"
import { getDlineDataDir } from "@core/storage/disk"
import { getDlineDocumentsPath } from "@core/storage/documents-path"
import { InstanceDatabase, taskInstanceRoot } from "@core/storage/instance/InstanceLayout"

/** Subdirectory of the data root that holds the global metrics database. */
const GLOBAL_METRICS_DIRECTORY = "metrics"

/** File name of every level's database, shared with the task instance layout. */
const METRICS_DATABASE_NAME = InstanceDatabase.Metrics

/**
 * The task level's database: the same `metrics.db` the Task's own performance
 * collections already use, so one Task keeps one database file.
 */
export async function taskMetricsDatabasePath(taskId: string): Promise<string> {
    const documentsRoot = await getDlineDocumentsPath()
    return path.join(taskInstanceRoot(documentsRoot, taskId), METRICS_DATABASE_NAME)
}

/** The global level's database, under the resolved data root. */
export function globalMetricsDatabasePath(): string {
    return path.join(getDlineDataDir(), GLOBAL_METRICS_DIRECTORY, METRICS_DATABASE_NAME)
}
