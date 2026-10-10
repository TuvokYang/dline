import { AsyncLocalStorage } from "node:async_hooks"
import type { RuntimeTelemetryContext } from "./types"

/**
 * Ambient identity for runtime telemetry.
 *
 * Producers deep in the call stack should not have to thread a task id through
 * every signature, so identity flows through AsyncLocalStorage. Detached work
 * such as an event listener registered during a task loses that storage, which
 * is why `capture` and `restore` exist: the caller keeps the identity it had
 * when the continuation was scheduled.
 *
 * Precedence is explicit > ambient > session fallback. An explicit value wins
 * because a producer that names its context knows more than the surrounding
 * stack, for example when reporting on behalf of another task.
 */

const storage = new AsyncLocalStorage<RuntimeTelemetryContext>()

/**
 * The part of a context a producer is allowed to establish.
 *
 * `sessionId` is absent by construction: it identifies the extension host
 * process and is owned by the holder, so no call site can set it.
 */
export type RuntimeTelemetryScope = Omit<RuntimeTelemetryContext, "sessionId">

export class RuntimeTelemetryContextHolder {
    private readonly fallback: RuntimeTelemetryContext

    constructor(sessionId: string) {
        this.fallback = { sessionId }
    }

    /**
     * Run `fn` with `scope` visible to every producer it reaches.
     *
     * The scope contributes task, controller, and workspace identity only. The
     * session id is supplied by this holder so that entering a scope cannot
     * relabel which extension host process produced the events.
     */
    run<T>(scope: RuntimeTelemetryScope, fn: () => T): T {
        const ambient = storage.getStore() ?? this.fallback
        const context: RuntimeTelemetryContext = {
            sessionId: this.fallback.sessionId,
            taskId: scope.taskId ?? ambient.taskId,
            controllerId: scope.controllerId ?? ambient.controllerId,
            workspaceId: scope.workspaceId ?? ambient.workspaceId,
        }
        return storage.run(context, fn)
    }

    /** Snapshot the current context so detached work can restore it later. */
    capture(): RuntimeTelemetryContext {
        return storage.getStore() ?? this.fallback
    }

    /**
     * Re-establish a captured context around a detached continuation.
     *
     * Unlike `run`, this accepts a full context because it replays one this
     * holder produced; the session id is still forced so a context captured by
     * another holder cannot leak across sessions.
     */
    restore<T>(context: RuntimeTelemetryContext, fn: () => T): T {
        return storage.run({ ...context, sessionId: this.fallback.sessionId }, fn)
    }

    /**
     * Resolve the context for one event.
     *
     * `sessionId` is never taken from the override: it identifies this
     * extension host process, and letting a producer change it would break
     * correlation across the session.
     */
    resolve(override?: Partial<RuntimeTelemetryContext>): RuntimeTelemetryContext {
        const ambient = storage.getStore() ?? this.fallback
        if (!override) return ambient

        return {
            sessionId: ambient.sessionId,
            taskId: override.taskId ?? ambient.taskId,
            controllerId: override.controllerId ?? ambient.controllerId,
            workspaceId: override.workspaceId ?? ambient.workspaceId,
        }
    }

    /** The session-only context used when nothing narrower is available. */
    get sessionContext(): RuntimeTelemetryContext {
        return this.fallback
    }
}
