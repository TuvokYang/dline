import type { IgnoreController } from "@core/ignore/IgnoreController"
import type { SystemPromptContext } from "@core/prompts/system-prompt"
import {
	PromptFreshnessInvalidationCoordinator,
	type PromptFreshnessInvalidationSource,
} from "@core/prompts/system-prompt-cache/PromptFreshnessInvalidationCoordinator"
import { SystemPromptCacheService } from "@core/prompts/system-prompt-cache/SystemPromptCacheService"
import {
	getWorkspacePromptInputWatcherRegistry,
	type PromptInputWatcherSubscription,
} from "@core/prompts/system-prompt-cache/WorkspacePromptInputWatcherRegistry"
import {
	ensureRulesDirectoryExists,
	getSkillsDirectoriesForScan,
	getSubagentsScanDirectories,
	getWorkflowsScanDirectories,
} from "@core/storage/disk"
import type { FrozenSystemPromptCache, SystemPromptRefreshReason } from "@core/storage/task-context-types"
import type { PromptFreshnessSnapshot } from "@shared/PromptFreshness"
import { Logger } from "@shared/services/Logger"
import type { ClineTool } from "@shared/tools"
import { recordPerfPhase } from "@/services/telemetry/instrumentation/duration-recorder"
import { PerfDomain } from "@/services/telemetry/instrumentation/perf-domains"

export interface TaskPromptLifecycleOptions {
	readonly taskId: string
	readonly cwd: string
	readonly ignoreController: IgnoreController
	readonly buildPromptContext: () => Promise<SystemPromptContext>
	readonly publishState: () => Promise<void>
}

/** Owns frozen-prompt freshness, invalidation and workspace watcher lifetime for one task. */
export class TaskPromptLifecycle {
	private readonly cache: SystemPromptCacheService
	private readonly invalidations: PromptFreshnessInvalidationCoordinator
	private watcher?: PromptInputWatcherSubscription
	private watcherInitialization?: Promise<void>
	private disposed = false
	private pendingRefreshReason?: SystemPromptRefreshReason

	constructor(private readonly options: TaskPromptLifecycleOptions) {
		this.cache = new SystemPromptCacheService({ taskId: options.taskId })
		this.invalidations = new PromptFreshnessInvalidationCoordinator({
			taskId: options.taskId,
			reevaluate: () => this.reevaluate(),
			publishState: options.publishState,
		})
	}

	start(): void {
		this.watcherInitialization ??= this.initializeWatcher()
	}

	beginDispose(): void {
		this.disposed = true
		this.invalidations.dispose()
	}

	async dispose(): Promise<void> {
		this.beginDispose()
		await this.watcherInitialization?.catch(() => undefined)
		const watcher = this.watcher
		this.watcher = undefined
		await watcher?.dispose()
	}

	getFreshness(): PromptFreshnessSnapshot {
		return this.cache.getPromptFreshness()
	}

	getLastTools(): readonly ClineTool[] | undefined {
		return this.cache.getLastTools()
	}

	getPendingRefreshReason(): SystemPromptRefreshReason | undefined {
		return this.pendingRefreshReason
	}

	requestRefresh(reason: SystemPromptRefreshReason): void {
		this.pendingRefreshReason = reason
	}

	invalidate(source: PromptFreshnessInvalidationSource): void {
		this.invalidations.invalidate(source)
	}

	flush(source: PromptFreshnessInvalidationSource): Promise<void> {
		return this.invalidations.flush(source)
	}

	async refreshManual(): Promise<void> {
		const promptContext = await this.options.buildPromptContext()
		await this.cache.refresh({ promptContext, reason: "manual" })
		await this.options.publishState()
	}

	async reevaluate(): Promise<void> {
		const startedAt = performance.now()
		const promptContext = await this.options.buildPromptContext()
		const buildMs = Math.round(performance.now() - startedAt)
		const cacheStartedAt = performance.now()
		await this.cache.reevaluateFreshness({ promptContext })
		const cacheMs = Math.round(performance.now() - cacheStartedAt)
		recordPerfPhase(
			PerfDomain.PromptFreshness,
			"reevaluate",
			performance.now() - startedAt,
			{ buildMs, cacheMs },
			{ taskId: this.options.taskId },
		)
		if (Logger.isDebugEnabled()) {
			Logger.debug(
				`[PromptFreshnessPerf] phase=reevaluate taskId=${this.options.taskId} buildMs=${buildMs} cacheMs=${cacheMs} totalMs=${Math.round(performance.now() - startedAt)}`,
			)
		}
	}

	async resolvePrompt(promptContext: SystemPromptContext, preview: boolean): Promise<FrozenSystemPromptCache> {
		const refreshReason = preview ? undefined : this.pendingRefreshReason
		if (!refreshReason) return this.cache.getOrCreate({ promptContext })
		try {
			return await this.cache.refresh({ promptContext, reason: refreshReason })
		} catch (error) {
			Logger.warn(`[Task ${this.options.taskId}] Failed to refresh frozen system prompt after ${refreshReason}:`, error)
			return this.cache.getOrCreate({ promptContext })
		} finally {
			if (!preview) this.pendingRefreshReason = undefined
		}
	}

	private async initializeWatcher(): Promise<void> {
		try {
			const globalRulesDirectory = await ensureRulesDirectoryExists()
			if (this.disposed) return
			const watcher = await getWorkspacePromptInputWatcherRegistry().subscribe({
				taskId: this.options.taskId,
				cwd: this.options.cwd,
				globalRulesDirectory,
				workflowDirectories: getWorkflowsScanDirectories(this.options.cwd).map((directory) => directory.path),
				skillDirectories: getSkillsDirectoriesForScan(this.options.cwd).map((directory) => directory.path),
				subagentDirectories: getSubagentsScanDirectories(this.options.cwd).map((directory) => directory.path),
				invalidate: () => this.invalidate("prompt_input_file"),
				shouldIgnoreDirectory: (absolutePath) => this.options.ignoreController.shouldIgnoreDirectory(absolutePath),
			})
			this.watcher = watcher
			if (this.disposed) {
				this.watcher = undefined
				await watcher.dispose()
			}
		} catch (error) {
			Logger.error(`[Task ${this.options.taskId}] Failed to initialize prompt input file watcher:`, error)
		}
	}
}
