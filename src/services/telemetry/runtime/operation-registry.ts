import { randomUUID } from "node:crypto"

export type RuntimeOperationKind = "api" | "tool" | "subagent" | "mcp_transport"

export interface RuntimeOperationDescriptor {
    readonly operationId: string
    readonly kind: RuntimeOperationKind
    readonly name: string
    readonly startedAt: number
    readonly taskId?: string
}

export interface RuntimeOperationHandle {
    readonly operationId: string
    complete(): void
}

/**
 * Process-local diagnostic index of operations that have started but not ended.
 *
 * It is not a task state authority and owns no files. The session ledger samples
 * this bounded view on its normal heartbeat so crash evidence does not create a
 * high-frequency disk log or an offline telemetry spool.
 */
class RuntimeOperationRegistry {
    private readonly active = new Map<string, RuntimeOperationDescriptor>()

    begin(input: Omit<RuntimeOperationDescriptor, "operationId" | "startedAt">): RuntimeOperationHandle {
        const operationId = randomUUID()
        this.active.set(operationId, {
            operationId,
            kind: input.kind,
            name: input.name,
            startedAt: Date.now(),
            ...(input.taskId ? { taskId: input.taskId } : {}),
        })
        let completed = false
        return {
            operationId,
            complete: () => {
                if (completed) return
                completed = true
                this.active.delete(operationId)
            },
        }
    }

    snapshot(): readonly RuntimeOperationDescriptor[] {
        return [...this.active.values()].map((operation) => ({ ...operation }))
    }

    resetForTesting(): void {
        this.active.clear()
    }
}

export const runtimeOperationRegistry = new RuntimeOperationRegistry()
