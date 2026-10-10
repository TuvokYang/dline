import type { FlowPhase } from "../kernel"

export type TaskIncarnationId = string & { readonly __taskIncarnationId: unique symbol }
export type RegistrationGeneration = number & { readonly __registrationGeneration: unique symbol }

export interface TaskDescriptor {
    readonly taskId: string
    readonly taskIncarnationId: TaskIncarnationId
    readonly registrationGeneration: RegistrationGeneration
    readonly createdAt: string
    readonly kind: "main" | "spawned"
}

export interface ActiveWriteIntent {
    readonly intentId: string
    readonly paths: readonly string[]
    readonly state: "declared" | "in_progress" | "released"
    readonly declaredAt: string
    readonly expiresAt: string
}

export interface TaskStatusProjection {
    readonly taskIncarnationId: TaskIncarnationId
    readonly registrationGeneration: RegistrationGeneration
    readonly statusRevision: number
    readonly summary: string
    readonly phase: FlowPhase
    readonly activeWriteIntents: readonly ActiveWriteIntent[]
}

export interface RegisteredTask {
    readonly descriptor: TaskDescriptor
    readonly status: TaskStatusProjection
}

export interface TaskDirectory {
    list(): readonly RegisteredTask[]
    find(taskId: string): RegisteredTask | undefined
}

export interface CoTaskIngressSnapshot {
    readonly closing: boolean
    readonly pending: number
    readonly limit: number
}

export interface CoTaskIngressEntry {
    readonly entryId: string
    readonly payloadRef: string
    readonly sourceTaskId: string
    readonly dedupeKey: string
}

export interface InternalCoTaskIngress {
    snapshot(): CoTaskIngressSnapshot
    accept(entry: CoTaskIngressEntry): Promise<void>
}

interface InternalRoute {
    readonly descriptor: TaskDescriptor
    readonly ingress: InternalCoTaskIngress
}

export interface TaskIngressResolver {
    resolve(taskId: string): InternalRoute | undefined
}

export interface TaskRegistration {
    readonly descriptor: TaskDescriptor
    publishStatus(status: TaskStatusProjection): boolean
    dispose(): void
}

export interface TaskDirectoryRegistrar {
    register(input: {
        readonly taskId: string
        readonly taskIncarnationId: TaskIncarnationId
        readonly createdAt: string
        readonly kind: TaskDescriptor["kind"]
        readonly initialStatus: Omit<TaskStatusProjection, "registrationGeneration">
        readonly ingress: InternalCoTaskIngress
    }): TaskRegistration
}

interface RecordState {
    readonly token: symbol
    readonly descriptor: TaskDescriptor
    status: TaskStatusProjection
    readonly ingress: InternalCoTaskIngress
}

function snapshot(record: RecordState): RegisteredTask {
    return {
        descriptor: { ...record.descriptor },
        status: {
            ...record.status,
            activeWriteIntents: record.status.activeWriteIntents.map((intent) => ({ ...intent, paths: [...intent.paths] })),
        },
    }
}

export function createTaskDirectoryRegistry(): {
    readonly directory: TaskDirectory
    readonly registrar: TaskDirectoryRegistrar
    readonly ingressResolver: TaskIngressResolver
} {
    const records = new Map<string, RecordState>()
    const generations = new Map<string, number>()

    const directory: TaskDirectory = {
        list: () => [...records.values()].map(snapshot),
        find: (taskId) => {
            const record = records.get(taskId)
            return record ? snapshot(record) : undefined
        },
    }
    const ingressResolver: TaskIngressResolver = {
        resolve: (taskId) => {
            const record = records.get(taskId)
            return record ? { descriptor: { ...record.descriptor }, ingress: record.ingress } : undefined
        },
    }
    const registrar: TaskDirectoryRegistrar = {
        register: (input) => {
            if (records.has(input.taskId)) throw new Error(`TaskAlreadyRegistered:${input.taskId}`)
            const generation = ((generations.get(input.taskId) ?? 0) + 1) as RegistrationGeneration
            generations.set(input.taskId, generation)
            const token = Symbol(input.taskId)
            const descriptor: TaskDescriptor = {
                taskId: input.taskId,
                taskIncarnationId: input.taskIncarnationId,
                registrationGeneration: generation,
                createdAt: input.createdAt,
                kind: input.kind,
            }
            const record: RecordState = {
                token,
                descriptor,
                status: { ...input.initialStatus, registrationGeneration: generation },
                ingress: input.ingress,
            }
            records.set(input.taskId, record)
            return {
                descriptor,
                publishStatus: (status) => {
                    const current = records.get(input.taskId)
                    if (
                        current?.token !== token ||
                        status.taskIncarnationId !== descriptor.taskIncarnationId ||
                        status.registrationGeneration !== descriptor.registrationGeneration ||
                        status.statusRevision <= current.status.statusRevision
                    )
                        return false
                    current.status = status
                    return true
                },
                dispose: () => {
                    if (records.get(input.taskId)?.token === token) records.delete(input.taskId)
                },
            }
        },
    }
    return { directory, registrar, ingressResolver }
}
