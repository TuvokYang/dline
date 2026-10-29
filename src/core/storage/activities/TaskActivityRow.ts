import type { TaskActivityRecord } from "@shared/task-activity"
import { column, defineEntity } from "../backend/api/EntitySchema"

function isActivityRecord(value: unknown): value is TaskActivityRecord {
    return (
        typeof value === "object" &&
        value !== null &&
        !Array.isArray(value) &&
        typeof (value as { activityId?: unknown }).activityId === "string"
    )
}

/**
 * One activity of a task in `activities.db`.
 *
 * The record is stored whole and written per activity, so a save touches only
 * the activities that changed. `createdAt` never changes, so the newest-first
 * order the activity list is shown in survives writes of single rows.
 */
export class TaskActivityRow {
    static readonly storage = defineEntity<TaskActivityRow>()({
        schemaId: "task-activity",
        version: 1,
        columns: {
            activityId: column.text({ primary: true }),
            createdAt: column.integer({ indexed: true }),
            record: column.json({ validate: isActivityRecord }),
        },
        defaultOrder: [{ field: "createdAt", direction: "desc" }],
        hydrate: (values) => new TaskActivityRow(values.record),
    })

    readonly activityId: string
    readonly createdAt: number

    constructor(readonly record: TaskActivityRecord) {
        this.activityId = record.activityId
        this.createdAt = record.createdAt
    }
}
