import * as path from "node:path"
import type { HistoryItem } from "@shared/HistoryItem"
import type { TaskCompletionStateUpdate } from "@/core/storage/TaskHistory"

export interface WorkspaceHistoryWriter {
    upsertTaskHistory(item: HistoryItem): Promise<HistoryItem>
    setCompletionState(update: TaskCompletionStateUpdate): Promise<HistoryItem | undefined>
    flush(): Promise<void>
}

export interface WorkspaceHistoryManagerPorts {
    readCache(): HistoryItem[]
    writeCache(history: HistoryItem[]): void
    writer: WorkspaceHistoryWriter
    onError(error: unknown): void
}

export interface WorkspaceHistorySession {
    readonly workspaceKey: string
    readonly taskId: string
    readonly generation: number
}

function mergeMetadata(current: HistoryItem | undefined, incoming: HistoryItem): HistoryItem {
    const merged = { ...incoming }
    delete merged.isCompleted
    delete merged.completionStateRevision
    if (current?.completionStateRevision !== undefined) {
        merged.isCompleted = current.isCompleted
        merged.completionStateRevision = current.completionStateRevision
    }
    return merged
}

function replaceByTaskId(history: readonly HistoryItem[], item: HistoryItem): HistoryItem[] {
    const next = [...history]
    const index = next.findIndex((candidate) => candidate.id === item.id)
    if (index >= 0) next[index] = item
    else next.push(item)
    return next
}

export class WorkspaceHistoryManager {
    private readonly generations = new Map<string, number>()
    private persistenceQueue = Promise.resolve()

    constructor(
        readonly workspaceKey: string,
        private readonly ports: WorkspaceHistoryManagerPorts,
    ) {}

    beginTask(taskId: string): WorkspaceHistorySession {
        const generation = (this.generations.get(taskId) ?? 0) + 1
        this.generations.set(taskId, generation)
        return { workspaceKey: this.workspaceKey, taskId, generation }
    }

    closeTask(session: WorkspaceHistorySession): void {
        if (!this.isCurrent(session)) return
        this.generations.set(session.taskId, session.generation + 1)
    }

    publishMetadata(item: HistoryItem, session?: WorkspaceHistorySession): Promise<HistoryItem[]> {
        const effectiveSession = session ?? this.ensureSession(item.id)
        if (!this.isCurrent(effectiveSession)) return Promise.resolve(this.ports.readCache())

        const history = this.ports.readCache()
        const current = history.find((candidate) => candidate.id === item.id)
        const accepted = mergeMetadata(current, item)
        const next = replaceByTaskId(history, accepted)
        this.ports.writeCache(next)

        this.enqueue(effectiveSession, async () => {
            const persisted = await this.ports.writer.upsertTaskHistory(accepted)
            if (!this.isCurrent(effectiveSession)) return
            this.ports.writeCache(replaceByTaskId(this.ports.readCache(), persisted))
        })
        return Promise.resolve(next)
    }

    publishCompletion(update: TaskCompletionStateUpdate, session?: WorkspaceHistorySession): Promise<boolean> {
        const effectiveSession = session ?? this.ensureSession(update.taskId)
        if (!this.isCurrent(effectiveSession)) return Promise.resolve(false)

        const history = this.ports.readCache()
        const current = history.find((candidate) => candidate.id === update.taskId)
        if (!current) return Promise.resolve(false)
        if (
            current.completionStateRevision !== undefined &&
            (current.completionStateRevision >= update.revision || current.isCompleted === update.isCompleted)
        ) {
            return Promise.resolve(false)
        }

        const accepted: HistoryItem = {
            ...current,
            isCompleted: update.isCompleted,
            completionStateRevision: update.revision,
        }
        this.ports.writeCache(replaceByTaskId(history, accepted))
        this.enqueue(effectiveSession, async () => {
            const persisted = await this.ports.writer.setCompletionState(update)
            if (!persisted || !this.isCurrent(effectiveSession)) return
            this.ports.writeCache(replaceByTaskId(this.ports.readCache(), persisted))
        })
        return Promise.resolve(true)
    }

    async flush(): Promise<void> {
        await this.persistenceQueue
        await this.ports.writer.flush()
    }

    private ensureSession(taskId: string): WorkspaceHistorySession {
        const generation = this.generations.get(taskId) ?? 1
        this.generations.set(taskId, generation)
        return { workspaceKey: this.workspaceKey, taskId, generation }
    }

    private isCurrent(session: WorkspaceHistorySession): boolean {
        return session.workspaceKey === this.workspaceKey && this.generations.get(session.taskId) === session.generation
    }

    private enqueue(session: WorkspaceHistorySession, operation: () => Promise<void>): void {
        this.persistenceQueue = this.persistenceQueue.then(async () => {
            if (!this.isCurrent(session)) return
            await operation()
        })
        this.persistenceQueue = this.persistenceQueue.catch((error) => {
            this.ports.onError(error)
        })
    }
}

const managers = new Map<string, WorkspaceHistoryManager>()

function normalizeWorkspaceKey(workspacePath: string): string {
    const normalized = path.resolve(workspacePath)
    return process.platform === "win32" ? normalized.toLowerCase() : normalized
}

export function getWorkspaceHistoryManager(workspacePath: string, ports: WorkspaceHistoryManagerPorts): WorkspaceHistoryManager {
    const workspaceKey = normalizeWorkspaceKey(workspacePath)
    const existing = managers.get(workspaceKey)
    if (existing) return existing
    const manager = new WorkspaceHistoryManager(workspaceKey, ports)
    managers.set(workspaceKey, manager)
    return manager
}

/**
 * Drain every live manager's queued writes.
 *
 * Managers are process-static and one per workspace, so a shutdown barrier that
 * only drains the manager a single controller happens to hold would drop writes
 * still queued for the other workspaces. Callers must invoke this while the
 * store is still open.
 */
export async function flushAllWorkspaceHistoryManagers(): Promise<void> {
    await Promise.all([...managers.values()].map((manager) => manager.flush()))
}

export function clearWorkspaceHistoryManagersForTests(): void {
    managers.clear()
}
