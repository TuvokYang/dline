import type { CollectCapabilitiesInput } from "@core/prompts/capabilities/CapabilitiesAggregator"
import { collectCapabilities } from "@core/prompts/capabilities/CapabilitiesAggregator"
import { renderCapabilitiesForContext } from "@core/prompts/capabilities/CapabilitiesSection"
import { PromptProfile } from "@core/prompts/profiles/types"
import type { SystemPromptContext } from "@core/prompts/system-prompt"
import { getSystemPrompt } from "@core/prompts/system-prompt"
import { getTaskContext, saveTaskContext } from "@core/storage/disk"
import type {
	FrozenPromptBuilderInfo,
	FrozenSystemPromptCache,
	SystemPromptRefreshReason,
	TaskContextCache,
} from "@core/storage/task-context-types"
import type { PromptFreshnessSnapshot } from "@shared/PromptFreshness"
import { emptyTaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import type { ClineTool } from "@shared/tools"
import Mutex from "p-mutex"
import { hashPromptContent } from "./hash"
import { buildPromptFreshnessBaseline, comparePromptFreshness } from "./PromptFreshnessProjection"

// 6: claude-code tools were frozen in the OpenAI function shape, which the
// Anthropic Messages API rejects. The provider identity is unchanged, so only
// a contract bump discards those stored projections for an in-flight task.
export const SYSTEM_PROMPT_CONTRACT_VERSION = 6

export interface BuiltSystemPrompt {
	readonly systemPrompt: string
	readonly tools?: readonly ClineTool[]
}

export interface SystemPromptCacheDeps {
	readonly getContext?: (taskId: string) => Promise<TaskContextCache>
	readonly saveContext?: (taskId: string, context: TaskContextCache) => Promise<void>
	readonly collectCapabilities?: (input: CollectCapabilitiesInput) => Promise<Awaited<ReturnType<typeof collectCapabilities>>>
	readonly buildSystemPrompt?: (context: SystemPromptContext) => Promise<BuiltSystemPrompt>
	readonly getPromptBuilderInfo?: (
		context: SystemPromptContext,
		tools: readonly ClineTool[] | undefined,
	) => FrozenPromptBuilderInfo
	readonly now?: () => number
}

export interface GetOrCreatePromptInput {
	readonly promptContext: SystemPromptContext
}

export interface RefreshSystemPromptInput extends GetOrCreatePromptInput {
	readonly reason: SystemPromptRefreshReason
}

/**
 * Manage task-level frozen system prompt cache stored in task context.json.
 */
export class SystemPromptCacheService {
	private readonly taskId: string
	private readonly getContext: (taskId: string) => Promise<TaskContextCache>
	private readonly saveContext: (taskId: string, context: TaskContextCache) => Promise<void>
	private readonly collectCapabilitiesFn: (
		input: CollectCapabilitiesInput,
	) => Promise<Awaited<ReturnType<typeof collectCapabilities>>>
	private readonly buildSystemPrompt: (context: SystemPromptContext) => Promise<BuiltSystemPrompt>
	private readonly getPromptBuilderInfo: (
		context: SystemPromptContext,
		tools: readonly ClineTool[] | undefined,
	) => FrozenPromptBuilderInfo
	private readonly now: () => number
	private readonly operationMutex = new Mutex()
	private lastTools?: readonly ClineTool[]
	private latestPromptFreshness: PromptFreshnessSnapshot = { status: "unknown", changes: [], checkedAt: 0 }
	private pendingGetOrCreate?: Promise<FrozenSystemPromptCache>

	/**
	 * Create a system prompt cache service for one task.
	 *
	 * @param params Service construction parameters.
	 */
	public constructor(params: { readonly taskId: string; readonly deps?: SystemPromptCacheDeps }) {
		this.taskId = params.taskId
		this.getContext = params.deps?.getContext ?? getTaskContext
		this.saveContext = params.deps?.saveContext ?? saveTaskContext
		this.collectCapabilitiesFn = params.deps?.collectCapabilities ?? collectCapabilities
		this.buildSystemPrompt = params.deps?.buildSystemPrompt ?? this.defaultBuildSystemPrompt
		this.getPromptBuilderInfo = params.deps?.getPromptBuilderInfo ?? this.buildPromptInfo
		this.now = params.deps?.now ?? Date.now
	}

	/**
	 * Return native tools from the last prompt build in this service instance.
	 *
	 * @returns Native tools produced by the last prompt build, if any.
	 */
	public getLastTools(): readonly ClineTool[] | undefined {
		return this.lastTools
	}

	/** Return the latest read-only prompt freshness projection. */
	public getPromptFreshness(): PromptFreshnessSnapshot {
		return this.latestPromptFreshness
	}

	/** Re-evaluate freshness without rebuilding or persisting the frozen prompt and tools. */
	public async reevaluateFreshness(input: GetOrCreatePromptInput): Promise<PromptFreshnessSnapshot> {
		return this.operationMutex.withLock(() => this.reevaluateFreshnessLocked(input))
	}

	/**
	 * Return an existing frozen prompt or create one for task start.
	 *
	 * @param input Prompt context input.
	 * @returns Frozen system prompt cache entry.
	 */
	public getOrCreate(input: GetOrCreatePromptInput): Promise<FrozenSystemPromptCache> {
		if (this.pendingGetOrCreate) return this.pendingGetOrCreate

		const pending = this.operationMutex.withLock(() => this.loadOrCreateLocked(input))
		this.pendingGetOrCreate = pending
		const clearPending = () => {
			if (this.pendingGetOrCreate === pending) this.pendingGetOrCreate = undefined
		}
		pending.then(clearPending, clearPending)
		return pending
	}

	/**
	 * Refresh the frozen system prompt for an explicit refresh reason.
	 *
	 * @param input Prompt refresh input.
	 * @returns Refreshed frozen system prompt cache entry.
	 */
	public async refresh(input: RefreshSystemPromptInput): Promise<FrozenSystemPromptCache> {
		return this.operationMutex.withLock(() => this.refreshLocked(input))
	}

	private async reevaluateFreshnessLocked(input: GetOrCreatePromptInput): Promise<PromptFreshnessSnapshot> {
		const context = await this.getContext(this.taskId)
		const cached = context.systemPrompt?.frozen
		if (!cached) {
			this.latestPromptFreshness = {
				status: "unknown",
				changes: [],
				checkedAt: this.now(),
			}
			return this.latestPromptFreshness
		}

		await this.updateFreshnessSnapshot(cached, input.promptContext)
		return this.latestPromptFreshness
	}

	private async refreshLocked(input: RefreshSystemPromptInput): Promise<FrozenSystemPromptCache> {
		const context = await this.getContext(this.taskId)
		const capabilities = await this.collectCapabilitiesFn({
			cwd: input.promptContext.cwd ?? process.cwd(),
			mcpHub: input.promptContext.mcpHub,
			...input.promptContext.capabilityToggleState,
		})
		const capabilitiesSection = renderCapabilitiesForContext(capabilities, {
			profile: input.promptContext.promptProfile,
			subagentsEnabled: input.promptContext.subagentsEnabled,
		})
		const capabilitiesHash = hashPromptContent(capabilitiesSection)
		const freshnessBaseline = buildPromptFreshnessBaseline(input.promptContext, capabilities)
		const promptContext: SystemPromptContext = {
			...input.promptContext,
			capabilities,
			capabilitiesSection,
		}
		const built = await this.buildSystemPrompt(promptContext)
		const now = this.now()
		const frozen: FrozenSystemPromptCache = {
			text: built.systemPrompt,
			tools: built.tools ?? null,
			capabilitiesHash,
			runtime: this.buildPromptRuntime(input.promptContext),
			freshnessBaseline,
			createdAt: context.systemPrompt?.frozen?.createdAt ?? now,
			refreshedAt: now,
			refreshReason: input.reason,
			promptBuilder: {
				...this.getPromptBuilderInfo(promptContext, built.tools),
				contractVersion: SYSTEM_PROMPT_CONTRACT_VERSION,
			},
		}
		await this.saveContext(this.taskId, {
			...context,
			updatedAt: now,
			systemPrompt: {
				...context.systemPrompt,
				frozen,
			},
		})
		this.lastTools = built.tools
		this.latestPromptFreshness = comparePromptFreshness(freshnessBaseline, freshnessBaseline, {
			checkedAt: now,
			frozenAt: frozen.refreshedAt,
		})
		return frozen
	}

	/** Load a valid frozen pair or rebuild and persist one complete replacement. */
	private async loadOrCreateLocked(input: GetOrCreatePromptInput): Promise<FrozenSystemPromptCache> {
		const context = await this.getContext(this.taskId)
		const cached = context.systemPrompt?.frozen
		if (cached) {
			const currentBuilder = {
				...this.getPromptBuilderInfo(input.promptContext, undefined),
				contractVersion: SYSTEM_PROMPT_CONTRACT_VERSION,
			}
			const cachedBuilder = cached.promptBuilder
			const providerProjectionChanged =
				cachedBuilder.contractVersion !== currentBuilder.contractVersion ||
				cachedBuilder.providerId !== currentBuilder.providerId ||
				cachedBuilder.modelId !== currentBuilder.modelId ||
				cachedBuilder.profile !== currentBuilder.profile ||
				cachedBuilder.nativeTools !== Boolean(input.promptContext.enableNativeToolCalls) ||
				cachedBuilder.apiFormat !== currentBuilder.apiFormat
			if (providerProjectionChanged) {
				return this.refreshLocked({ promptContext: input.promptContext, reason: "capability_change" })
			}
			await this.updateFreshnessSnapshot(cached, input.promptContext)
			this.lastTools = cached.tools ?? undefined
			return cached
		}
		return this.refreshLocked({ promptContext: input.promptContext, reason: "task_start" })
	}

	private buildPromptRuntime(context: SystemPromptContext): NonNullable<FrozenSystemPromptCache["runtime"]> {
		const browserEnabled = context.supportsBrowserUse === true && context.browserSettings?.disableToolUse !== true
		const capabilityToggles = context.taskCapabilityToggles ?? emptyTaskCapabilityToggles()
		if (!context.webSearchRoutingPlan) throw new Error("System prompt context is missing its Web Search routing plan")
		return {
			parallelToolsEnabled: context.enableParallelToolCalling === true,
			webToolsEnabled: context.clineWebToolsEnabled === true,
			webToolsMode: context.webSearchRoutingPlan.mode,
			webSearchRoute: context.webSearchRoutingPlan.route,
			webSearchLocalFallbackAvailable: context.webSearchRoutingPlan.localFallbackAvailable,
			serverTools: [...context.webSearchRoutingPlan.serverTools],
			focusChainEnabled: context.promptProfile === PromptProfile.Standard && context.focusChainSettings?.enabled === true,
			subagentsEnabled: context.promptProfile === PromptProfile.Standard && context.subagentsEnabled === true,
			capabilityToggles: {
				...capabilityToggles,
				mcpServers: context.mcpHub ? { ...capabilityToggles.mcpServers } : {},
			},
			browserEnabled,
			browserViewport: {
				width: browserEnabled ? (context.browserSettings?.viewport.width ?? 0) : 0,
				height: browserEnabled ? (context.browserSettings?.viewport.height ?? 0) : 0,
			},
		}
	}

	private async updateFreshnessSnapshot(cached: FrozenSystemPromptCache, promptContext: SystemPromptContext): Promise<void> {
		const capabilities = await this.collectCapabilitiesFn({
			cwd: promptContext.cwd ?? process.cwd(),
			mcpHub: promptContext.mcpHub,
			...promptContext.capabilityToggleState,
		})
		const currentBaseline = buildPromptFreshnessBaseline(promptContext, capabilities)
		this.latestPromptFreshness = comparePromptFreshness(cached.freshnessBaseline, currentBaseline, {
			checkedAt: this.now(),
			frozenAt: cached.refreshedAt,
		})
	}

	/**
	 * Build a prompt through the explicit-profile system prompt facade.
	 *
	 * @param context System prompt context.
	 * @returns Built prompt text and native tools.
	 */
	private async defaultBuildSystemPrompt(context: SystemPromptContext): Promise<BuiltSystemPrompt> {
		return getSystemPrompt(context)
	}

	/**
	 * Record stable prompt builder metadata for diagnostics.
	 *
	 * @param context System prompt context used for building.
	 * @param tools Native tools produced by the explicit-profile facade.
	 * @returns Prompt builder metadata persisted in task context cache.
	 */
	private buildPromptInfo(context: SystemPromptContext, tools: readonly ClineTool[] | undefined): FrozenPromptBuilderInfo {
		const webSearchRoutingPlan = context.webSearchRoutingPlan
		return {
			contractVersion: SYSTEM_PROMPT_CONTRACT_VERSION,
			providerId: context.providerInfo.providerId,
			modelId: context.providerInfo.model.id,
			profile: context.promptProfile,
			nativeTools: (tools?.length ?? 0) > 0,
			focusChainEnabled: context.focusChainSettings?.enabled === true,
			subagentsEnabled: context.promptProfile === PromptProfile.Standard && context.subagentsEnabled === true,
			...(webSearchRoutingPlan?.serverToolPlan.apiFormat === undefined
				? {}
				: { apiFormat: webSearchRoutingPlan.serverToolPlan.apiFormat }),
			webToolsEnabled: context.clineWebToolsEnabled === true,
			...(webSearchRoutingPlan === undefined
				? {}
				: {
						webSearchRoute: webSearchRoutingPlan.route,
						webToolsMode: webSearchRoutingPlan.mode,
						webSearchLocalFallbackAvailable: webSearchRoutingPlan.localFallbackAvailable,
					}),
			serverTools: webSearchRoutingPlan?.serverTools ?? [],
		}
	}
}
