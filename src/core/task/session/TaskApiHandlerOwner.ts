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

/** Owns the replaceable provider handler for one task incarnation. */
export class TaskApiHandlerOwner {
	private handler: ApiHandler
	private readonly rebuiltListeners = new Set<ApiHandlerRebuiltListener>()
	/** Rebuilds read the Catalog asynchronously; chaining them keeps the last request the one that wins. */
	private rebuilding: Promise<unknown> = Promise.resolve()

	constructor(private readonly options: TaskApiHandlerOwnerOptions) {
		const mode = this.options.settings.mode
		this.handler = this.build(resolveTaskApiProfile(this.configuration(), mode), mode)
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
	rebuild(options: { readonly abortPrevious?: boolean } = {}): Promise<ApiHandler> {
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

	private async rebuildNow(options: { readonly abortPrevious?: boolean }): Promise<ApiHandler> {
		const mode = this.options.settings.mode
		const resolution = await resolveTaskApiProfileFresh(this.configuration(), mode)
		const previous = this.handler
		const next = this.build(resolution, mode)
		this.handler = next
		if (options.abortPrevious) previous.abort?.()
		this.notifyRebuilt(next)
		return next
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
