import {
    normalizeTaskCapabilityToggles,
    reconcileTaskCapabilityToggles,
    type TaskCapabilityToggleKey,
    type TaskCapabilityToggles,
    updateTaskCapabilityToggle,
} from "@shared/TaskCapabilityToggles"

type TaskSnapshotListener = () => void

type PendingToggleIntent = {
    readonly key: TaskCapabilityToggleKey
    readonly resourceId: string
    readonly enabled: boolean
    readonly startRevision: number
    persisted: boolean
}

type TaskMutationState = {
    authoritative: TaskCapabilityToggles
    authoritativeRevision: number
    pending: Map<string, PendingToggleIntent>
    queue?: Promise<void>
    listeners: Set<TaskSnapshotListener>
}

export interface UpdateTaskCapabilityToggleInput {
    readonly taskId: string
    readonly authoritative: TaskCapabilityToggles
    readonly authoritativeRevision: number
    readonly key: TaskCapabilityToggleKey
    readonly resourceId: string
    readonly enabled: boolean
    readonly persist: (snapshot: TaskCapabilityToggles) => Promise<void>
    readonly publish: (snapshot: TaskCapabilityToggles) => void
}

export interface ReconcileTaskCapabilitiesInput {
    readonly taskId: string
    readonly authoritative: TaskCapabilityToggles
    readonly authoritativeRevision: number
    readonly discovered: Partial<TaskCapabilityToggles>
    readonly persist: (snapshot: TaskCapabilityToggles) => Promise<void>
    readonly publish: (snapshot: TaskCapabilityToggles) => void
}

function intentKey(key: TaskCapabilityToggleKey, resourceId: string): string {
    return `${key}\u0000${resourceId}`
}

function applyPending(state: TaskMutationState): TaskCapabilityToggles {
    let snapshot = state.authoritative
    for (const intent of state.pending.values()) {
        snapshot = updateTaskCapabilityToggle(snapshot, intent.key, intent.resourceId, intent.enabled)
    }
    return snapshot
}

export class TaskCapabilityMutationCoordinator {
    private readonly tasks = new Map<string, TaskMutationState>()

    private getOrCreateState(
        taskId: string,
        authoritative: TaskCapabilityToggles,
        authoritativeRevision: number,
    ): TaskMutationState {
        const existing = this.tasks.get(taskId)
        if (existing) return existing
        const created: TaskMutationState = {
            authoritative: normalizeTaskCapabilityToggles(authoritative),
            authoritativeRevision,
            pending: new Map(),
            listeners: new Set(),
        }
        this.tasks.set(taskId, created)
        return created
    }

    private notify(state: TaskMutationState): void {
        for (const listener of state.listeners) listener()
    }

    private updateAuthoritativeState(
        state: TaskMutationState,
        authoritative: TaskCapabilityToggles,
        authoritativeRevision: number,
    ): void {
        if (authoritativeRevision < state.authoritativeRevision) return
        state.authoritative = normalizeTaskCapabilityToggles(authoritative)
        state.authoritativeRevision = authoritativeRevision
        for (const [identity, intent] of state.pending) {
            if (
                intent.persisted &&
                authoritativeRevision > intent.startRevision &&
                state.authoritative[intent.key][intent.resourceId] === intent.enabled
            ) {
                state.pending.delete(identity)
            }
        }
    }

    observe(taskId: string, authoritative: TaskCapabilityToggles, authoritativeRevision: number): TaskCapabilityToggles {
        const state = this.getOrCreateState(taskId, authoritative, authoritativeRevision)
        this.updateAuthoritativeState(state, authoritative, authoritativeRevision)
        return applyPending(state)
    }

    getSnapshot(taskId: string): TaskCapabilityToggles | undefined {
        const state = this.tasks.get(taskId)
        return state ? applyPending(state) : undefined
    }

    subscribe(taskId: string, listener: TaskSnapshotListener): () => void {
        const state = this.tasks.get(taskId)
        if (!state) return () => undefined
        state.listeners.add(listener)
        return () => state.listeners.delete(listener)
    }

    async updateToggle(input: UpdateTaskCapabilityToggleInput): Promise<void> {
        const state = this.getOrCreateState(input.taskId, input.authoritative, input.authoritativeRevision)
        this.updateAuthoritativeState(state, input.authoritative, input.authoritativeRevision)
        const identity = intentKey(input.key, input.resourceId)
        state.pending.set(identity, {
            key: input.key,
            resourceId: input.resourceId,
            enabled: input.enabled,
            startRevision: input.authoritativeRevision,
            persisted: false,
        })
        input.publish(applyPending(state))
        this.notify(state)

        const execute = async () => {
            const snapshot = applyPending(state)
            try {
                await input.persist(snapshot)
                const current = state.pending.get(identity)
                if (current?.enabled === input.enabled) current.persisted = true
            } catch (error) {
                const current = state.pending.get(identity)
                if (current?.enabled === input.enabled) state.pending.delete(identity)
                input.publish(applyPending(state))
                this.notify(state)
                throw error
            }
        }
        const previous = state.queue
        const operation = previous ? previous.then(execute) : execute()
        const tracked = operation.catch(() => undefined)
        state.queue = tracked
        void tracked.finally(() => {
            if (state.queue === tracked) state.queue = undefined
        })
        await operation
    }

    async reconcile(input: ReconcileTaskCapabilitiesInput): Promise<void> {
        const state = this.getOrCreateState(input.taskId, input.authoritative, input.authoritativeRevision)
        this.updateAuthoritativeState(state, input.authoritative, input.authoritativeRevision)
        const current = applyPending(state)
        const next = reconcileTaskCapabilityToggles(current, input.discovered)
        if (JSON.stringify(next) === JSON.stringify(current)) return
        state.authoritative = next
        input.publish(next)
        this.notify(state)
        const persist = () => input.persist(applyPending(state))
        const previous = state.queue
        const operation = previous ? previous.then(persist) : persist()
        const tracked = operation.catch(() => undefined)
        state.queue = tracked
        void tracked.finally(() => {
            if (state.queue === tracked) state.queue = undefined
        })
        await operation
    }

    reset(): void {
        this.tasks.clear()
    }
}

export const taskCapabilityMutationCoordinator = new TaskCapabilityMutationCoordinator()
