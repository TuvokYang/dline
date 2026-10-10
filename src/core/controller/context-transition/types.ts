import type { ApiHandler } from "@core/api"
import type { ContextCompactionTransitionState } from "@core/task/ContextCompactionSession"
import type { ChatContent } from "@shared/ChatContent"
import type { Mode } from "@shared/storage/types"

/** Project one complete ordinary candidate through a pending target handler. */
export interface ContextPressureReader {
    read(targetApi: ApiHandler, targetMode: Mode, chatContent?: ChatContent): Promise<number>
}

export type ContextTransitionCompactionTrigger = "profile_switch" | "mode_switch"

/** Complete immutable request passed from the transition Engine to the Task compaction boundary. */
export interface TaskCompactionRequest {
    trigger: ContextTransitionCompactionTrigger
    operationId: string
    targetApi: ApiHandler
    targetMode: Mode
    chatContent?: ChatContent
    transition?: ContextCompactionTransitionState
}

/** Run target-profile compaction and control its completion barrier. */
export interface TaskCompactionPort {
    compact(request: TaskCompactionRequest): Promise<"completed" | "cancelled" | "failed">
    complete(operationId: string): Promise<void>
    abort(operationId: string, reason: string): Promise<void>
}
