import fs from "node:fs/promises"
import path from "node:path"
import { ensureTaskDirectoryExists, GlobalFileNames } from "@core/storage/disk"
import { Logger } from "@shared/services/Logger"
import type { TaskActivityEvent, TaskActivityRecord } from "@shared/task-activity"

const ACTIVITY_SCHEMA_VERSION = 2

interface PersistedTaskActivities {
	schemaVersion: 2
	taskId: string
	activities: TaskActivityRecord[]
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

function sanitizeEvent(value: unknown): TaskActivityEvent | undefined {
	if (!isRecord(value) || typeof value.kind !== "string") return undefined
	if (!Number.isSafeInteger(value.sequence) || typeof value.timestamp !== "number") return undefined
	return {
		...value,
		attempt: Number.isSafeInteger(value.attempt) && Number(value.attempt) > 0 ? Number(value.attempt) : 1,
	} as unknown as TaskActivityEvent
}

function sanitizeActivity(value: unknown, taskId: string): TaskActivityRecord | undefined {
	if (!isRecord(value)) return undefined
	if (typeof value.activityId !== "string" || value.taskId !== taskId) return undefined
	if (value.kind !== "subagent" && value.kind !== "command") return undefined
	if (value.executionMode !== "foreground" && value.executionMode !== "background") return undefined
	if (typeof value.status !== "string" || typeof value.createdAt !== "number" || typeof value.updatedAt !== "number") {
		return undefined
	}
	if (typeof value.title !== "string") return undefined
	const events = Array.isArray(value.events)
		? value.events.map(sanitizeEvent).filter((event): event is TaskActivityEvent => Boolean(event))
		: []
	const retryRecipe =
		isRecord(value.retryRecipe) &&
		value.retryRecipe.kind === "subagent" &&
		typeof value.retryRecipe.task === "string" &&
		typeof value.retryRecipe.prompt === "string" &&
		typeof value.retryRecipe.timeoutSeconds === "number"
			? {
					kind: "subagent" as const,
					schemaVersion: 1 as const,
					subagentName: typeof value.retryRecipe.subagentName === "string" ? value.retryRecipe.subagentName : undefined,
					// Absent on records written before per-item Profiles existed;
					// those retries fall back to normal resolution.
					profileName: typeof value.retryRecipe.profileName === "string" ? value.retryRecipe.profileName : undefined,
					task: value.retryRecipe.task,
					prompt: value.retryRecipe.prompt,
					timeoutSeconds: value.retryRecipe.timeoutSeconds,
					retryable: value.retryRecipe.retryable === true,
				}
			: undefined
	return {
		...(value as unknown as TaskActivityRecord),
		schemaVersion: ACTIVITY_SCHEMA_VERSION,
		currentAttempt:
			Number.isSafeInteger(value.currentAttempt) && Number(value.currentAttempt) > 0 ? Number(value.currentAttempt) : 1,
		cancellationOwner: value.cancellationOwner === "explicit" ? "explicit" : "task",
		retryRecipe,
		retryUnavailableReason: typeof value.retryUnavailableReason === "string" ? value.retryUnavailableReason : undefined,
		events,
	}
}

/** Persists activity snapshots without serializing runtime cancellers. */
export class TaskActivityPersistence {
	constructor(private readonly taskId: string) {}

	async load(): Promise<TaskActivityRecord[]> {
		try {
			const taskDirectory = await ensureTaskDirectoryExists(this.taskId)
			const raw = await fs.readFile(path.join(taskDirectory, GlobalFileNames.taskActivities), "utf8")
			const parsed: unknown = JSON.parse(raw)
			if (
				!isRecord(parsed) ||
				(parsed.schemaVersion !== 1 && parsed.schemaVersion !== ACTIVITY_SCHEMA_VERSION) ||
				parsed.taskId !== this.taskId
			) {
				return []
			}
			return Array.isArray(parsed.activities)
				? parsed.activities
						.map((activity) => sanitizeActivity(activity, this.taskId))
						.filter((activity): activity is TaskActivityRecord => Boolean(activity))
				: []
		} catch (error) {
			if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
				Logger.warn("[TaskActivityPersistence] Failed to load activity history", error)
			}
			return []
		}
	}

	async save(activities: TaskActivityRecord[]): Promise<void> {
		const taskDirectory = await ensureTaskDirectoryExists(this.taskId)
		const filePath = path.join(taskDirectory, GlobalFileNames.taskActivities)
		const tempPath = `${filePath}.tmp.${Date.now()}`
		const payload: PersistedTaskActivities = {
			schemaVersion: ACTIVITY_SCHEMA_VERSION,
			taskId: this.taskId,
			activities,
		}
		try {
			await fs.writeFile(tempPath, JSON.stringify(payload), "utf8")
			await fs.rename(tempPath, filePath)
		} catch (error) {
			await fs.rm(tempPath, { force: true }).catch(() => undefined)
			throw error
		}
	}
}
