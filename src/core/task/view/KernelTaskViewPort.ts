import type { TaskState } from "../kernel"
import type { TaskViewPort } from "../stores"
import type { CanonicalTaskViewProjection } from "./canonical/CanonicalTaskViewProjection"
import { projectCanonicalTaskView } from "./canonical/projectCanonicalTaskView"

export interface KernelTaskViewSink {
    publishCommitted(projection: CanonicalTaskViewProjection): Promise<void>
    publishTransient(taskId: string, projection: Readonly<Record<string, unknown>>): void
}

export function projectKernelTaskView(state: Readonly<TaskState>): CanonicalTaskViewProjection {
    return projectCanonicalTaskView(state)
}

export class KernelTaskViewPort implements TaskViewPort {
    constructor(private readonly sink: KernelTaskViewSink) {}

    notifyCommitted(state: TaskState): Promise<void> {
        return this.sink.publishCommitted(projectKernelTaskView(state))
    }

    notifyTransient(taskId: string, projection: Readonly<Record<string, unknown>>): void {
        this.sink.publishTransient(taskId, projection)
    }
}
