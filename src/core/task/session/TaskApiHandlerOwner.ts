import { type ApiHandler, buildApiHandlerFromProfile } from "@core/api"
import type { StateManager } from "@core/storage/StateManager"
import type { ApiConfiguration } from "@shared/api"
import { Logger } from "@shared/services/Logger"
import type { Mode } from "@shared/storage/types"
import {
    type ApiProfileRecoveryResult,
    createUnavailableApiHandler,
    resolveTaskApiProfile,
    resolveTaskApiProfileFresh,
    validateApiProfileCredentials,
} from "../ApiProfileRecovery"
import type { TaskStateManager } from "../TaskStateManager"

/** Informed once the task's requests are served by a newly built handler. */
export type ApiHandlerRebuiltListener = (handler: ApiHandler) => void

export interface TaskApiHandlerOwnerOptions {
    readonly taskId: string
    readonly taskIncarnationId: string
    readonly stateManager: StateManager
    readonly settings: TaskStateManager
}

const UNRESOLVED_PROFILE_MESSAGE = "Profile not valid: resolved Profile is unavailable."

export interface TaskApiHandlerRebuildOptions {
    /** Abort the request the replaced handler is serving. */
    readonly abortPrevious?: boolean
    /**
     * Also check the resolved Profile's credentials at the provider boundary.
     *
     * A request about to be sent asks for this, as dev did before every request,
     * so an expired sign-in fails before reaching the provider.
     */
    readonly validateCredentials?: boolean
}

/** Owns the replaceable provider handler for one task incarnation. */
export class TaskApiHandlerOwner {
    private handler: ApiHandler
    private readonly rebuiltListeners = new Set<ApiHandlerRebuiltListener>()
    /** Rebuilds read the Catalog asynchronously; chaining them keeps the last request the one that wins. */
    private rebuilding: Promise<unknown> = Promise.resolve()

    constructor(private readonly options: TaskApiHandlerOwnerOptions) {
        const mode = this.options.settings.mode
        const resolution = resolveTaskApiProfile(this.configuration(), mode)
        this.handler = this.build(resolution, mode)
        // A Profile renamed since the task last ran is resolved by its stable ID;
        // binding the current name now keeps History Resume on that Profile.
        this.adoptResolvedIdentity(resolution, mode)
    }

    current(): ApiHandler {
        return this.handler
    }

    /**
     * Observes every handler replacement, whichever setting caused it.
     *
     * A Mode, Profile, or configuration change all end in a rebuild, so this is
     * the one place that knows the task now runs under a different scope.
     */
    onRebuilt(listener: ApiHandlerRebuiltListener): () => void {
        this.rebuiltListeners.add(listener)
        return () => this.rebuiltListeners.delete(listener)
    }

    /**
     * Replace the handler from the latest persisted Profile Catalog.
     *
     * A rebuild follows a Profile, Mode or configuration change, so it reads the
     * Catalog fresh instead of trusting the process cache that change may not
     * have reached yet.
     */
    rebuild(options: TaskApiHandlerRebuildOptions = {}): Promise<ApiHandler> {
        const rebuilt = this.rebuilding.then(() => this.rebuildNow(options))
        this.rebuilding = rebuilt.catch(() => undefined)
        return rebuilt
    }

    abort(): void {
        this.handler.abort?.()
    }

    /** An observer only reflects the new scope; its failure must not undo the switch that caused it. */
    private notifyRebuilt(handler: ApiHandler): void {
        for (const listener of this.rebuiltListeners) {
            try {
                listener(handler)
            } catch (error) {
                Logger.warn(
                    `[TaskApiHandlerOwner] ${this.options.taskId}: rebuild observer failed: ${error instanceof Error ? error.message : String(error)}`,
                )
            }
        }
    }

    private async rebuildNow(options: TaskApiHandlerRebuildOptions): Promise<ApiHandler> {
        const mode = this.options.settings.mode
        const resolution = await resolveTaskApiProfileFresh(this.configuration(), mode)
        const credentialsError = options.validateCredentials ? await this.credentialsError(resolution) : undefined
        const previous = this.handler
        const next = credentialsError ? createUnavailableApiHandler(credentialsError) : this.build(resolution, mode)
        this.handler = next
        if (options.abortPrevious) previous.abort?.()
        this.adoptResolvedIdentity(resolution, mode)
        this.notifyRebuilt(next)
        return next
    }

    /**
     * Bind the task to the Profile the rebuild resolved, as dev did.
     *
     * The binding is what History Resume and later rebuilds read, so it must
     * follow the Profile now serving requests. A session fallback serves
     * requests without becoming the binding.
     */
    private adoptResolvedIdentity(resolution: ApiProfileRecoveryResult, mode: Mode): void {
        if (resolution.usedFallback || !resolution.resolvedProfileId || !resolution.resolvedProfile) return
        this.options.settings.adoptResolvedProfileIdentity(mode, resolution.resolvedProfileId, resolution.resolvedProfile)
    }

    private async credentialsError(resolution: ApiProfileRecoveryResult): Promise<string | undefined> {
        if (resolution.error || !resolution.resolvedApiProfile) return undefined
        const validity = await validateApiProfileCredentials(resolution.resolvedApiProfile)
        return validity.status === "invalid" ? (validity.message ?? UNRESOLVED_PROFILE_MESSAGE) : undefined
    }

    private configuration(): ApiConfiguration {
        return {
            ...this.options.stateManager.getApiConfigurationForTask(this.options.taskId),
            ulid: this.options.taskIncarnationId,
        }
    }

    /**
     * A Profile that cannot serve requests still yields a handler, as in dev:
     * the task stays readable and its next request fails before reaching any
     * provider with the reason the user has to fix.
     */
    private build(resolution: ApiProfileRecoveryResult, mode: Mode): ApiHandler {
        if (resolution.error || !resolution.resolvedApiProfile) {
            return createUnavailableApiHandler(resolution.error ?? UNRESOLVED_PROFILE_MESSAGE)
        }
        if (resolution.usedFallback) {
            Logger.warn(
                `[TaskApiHandlerOwner] ${this.options.taskId}: no ${mode} Profile is bound; using "${resolution.resolvedProfile}" for this session without changing the binding.`,
            )
        }
        return buildApiHandlerFromProfile(resolution.configuration, mode, resolution.resolvedApiProfile)
    }
}
