import { TaskActivityRowStore } from "@core/storage/activities/TaskActivityRowStore"
import { Logger } from "@shared/services/Logger"
import type { TaskActivityEvent, TaskActivityRecord } from "@shared/task-activity"

const ACTIVITY_SCHEMA_VERSION = 2

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

function sanitizeActivities(values: readonly unknown[], taskId: string): TaskActivityRecord[] {
    return values
        .map((activity) => sanitizeActivity(activity, taskId))
        .filter((activity): activity is TaskActivityRecord => Boolean(activity))
}

/** Activities of a legacy `activities.json`, or an empty list when it belongs elsewhere or is unreadable. */
function decodeLegacyActivities(text: string, taskId: string): TaskActivityRecord[] {
    const parsed: unknown = JSON.parse(text)
    if (!isRecord(parsed) || parsed.taskId !== taskId) return []
    if (parsed.schemaVersion !== 1 && parsed.schemaVersion !== ACTIVITY_SCHEMA_VERSION) return []
    return Array.isArray(parsed.activities) ? sanitizeActivities(parsed.activities, taskId) : []
}

/**
 * Persists activity snapshots in the task's `activities.db` without serializing runtime cancellers.
 *
 * This is the only writer of that database. A legacy `activities.json` is imported on the first
 * load and renamed to `.migrated`; loading never fails, so a damaged history shows as empty.
 */
export class TaskActivityPersistence {
    private storePromise?: Promise<TaskActivityRowStore>

    constructor(private readonly taskId: string) {}

    async load(): Promise<TaskActivityRecord[]> {
        try {
            const store = await this.store()
            const stored = await store.read()
            if (stored.length > 0) return sanitizeActivities(stored, this.taskId)
            return await this.importLegacy(store)
        } catch (error) {
            Logger.warn("[TaskActivityPersistence] Failed to load activity history", error)
            return []
        }
    }

    /**
     * History-display read that lets a lifecycle promotion interrupt large payload hydration.
     * A cancelled read returns no partial snapshot; the active Task will hydrate the same
     * durable rows after its provider request reaches the wire.
     */
    async loadIncrementally(shouldContinue: () => boolean): Promise<TaskActivityRecord[]> {
        try {
            const store = await this.store()
            const stored = await store.readIncrementally(shouldContinue)
            if (!shouldContinue()) return []
            if (stored.length > 0) return sanitizeActivities(stored, this.taskId)
            return await this.importLegacy(store)
        } catch (error) {
            Logger.warn("[TaskActivityPersistence] Failed to load activity history incrementally", error)
            return []
        }
    }

    /** Writes the activities that changed; activities not passed keep their stored rows. */
    async upsert(activities: readonly TaskActivityRecord[]): Promise<void> {
        await (await this.store()).upsert(activities)
    }

    /** Releases `activities.db`; the next load or save reopens it. */
    async close(): Promise<void> {
        const pending = this.storePromise
        this.storePromise = undefined
        if (!pending) return
        await (await pending).close()
    }

    private store(): Promise<TaskActivityRowStore> {
        this.storePromise ??= TaskActivityRowStore.open(this.taskId).catch((error) => {
            this.storePromise = undefined
            throw error
        })
        return this.storePromise
    }

    private async importLegacy(store: TaskActivityRowStore): Promise<TaskActivityRecord[]> {
        const legacy = await store.readLegacy()
        if (!legacy) return []
        let activities: TaskActivityRecord[]
        try {
            activities = decodeLegacyActivities(legacy.text, this.taskId)
        } catch (error) {
            // Unreadable JSON stays in place for inspection; the task opens with no history.
            Logger.warn(`[TaskActivityPersistence] Keeping unreadable ${legacy.file}`, error)
            return []
        }
        // Only an empty database imports, so writing every legacy activity loses nothing.
        await store.upsert(activities)
        const stored = await store.read()
        if (stored.length !== activities.length) {
            Logger.error(
                `[TaskActivityPersistence] ${legacy.file} imported ${stored.length} of ${activities.length} activities; keeping the file`,
            )
            return activities
        }
        await store.retireLegacy(legacy.file)
        return activities
    }
}
