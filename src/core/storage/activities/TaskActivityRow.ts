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
 * The record is stored whole because it is written and read as one snapshot;
 * `position` keeps the order the activity list is shown in.
 */
export class TaskActivityRow {
	static readonly storage = defineEntity<TaskActivityRow>()({
		schemaId: "task-activity",
		version: 1,
		columns: {
			activityId: column.text({ primary: true }),
			position: column.integer({ indexed: true }),
			record: column.json({ validate: isActivityRecord }),
		},
		defaultOrder: [{ field: "position", direction: "asc" }],
		hydrate: (values) => new TaskActivityRow(values.position, values.record),
	})

	readonly activityId: string

	constructor(
		readonly position: number,
		readonly record: TaskActivityRecord,
	) {
		this.activityId = record.activityId
	}
}
