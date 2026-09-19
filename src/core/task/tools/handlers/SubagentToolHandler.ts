import { resolveProvider } from "@core/api"
import type { ToolUse } from "@core/assistant-message"
import { readApiProfiles } from "@core/controller/file/getApiProfiles"
import { resolveProfileReference } from "@core/profiles/profile-binding"
import { getPrompt } from "@core/prompts/i18n"
import { formatResponse } from "@core/prompts/responses"
import {
	ClineAskUseSubagents,
	ClineSaySubagentStatus,
	ClineSubagentUsageInfo,
	SubagentStatusItem,
} from "@shared/ExtensionMessage"
import { telemetryService } from "@/services/telemetry"
import { calculateApiUsageStatistics } from "@/shared/api-usage"
import { Logger } from "@/shared/services/Logger"
import { ClineDefaultTool } from "@/shared/tools"
import type { BackgroundHandoffResult } from "../../activity/TaskActivityStore"
import type { ToolResponse } from "../../index"
import {
	type AgentBaseConfig,
	listEnabledAgentConfigs,
	type ResolveAgentConfigOptions,
	resolveAgentConfig,
} from "../subagent/AgentConfigLoader"
import { DEFAULT_SUBAGENT_NAME, isDefaultSubagentName } from "../subagent/DefaultSubagentConfig"
import {
	applyProfileOverride,
	type PlannedSubagentItem,
	planSubagentBatch,
	type RejectedSubagentItem,
	type SubagentBatchResolvers,
} from "../subagent/SubagentBatchPlanner"
import {
	runSubagent,
	type SubagentExecResult,
	type SubagentProgressUpdate,
	type SubagentRunStats,
} from "../subagent/SubagentExecutor"
import { getSubagentFanoutBudget, type SubagentFanoutBudget, type SubagentSlot } from "../subagent/SubagentFanoutBudget"
import { SubagentJobManager } from "../subagent/SubagentJobManager"
import { parseUseSubagentRequest, parseUseSubagentsRequest } from "../subagent/SubagentRequestParser"
import { SubagentRunner } from "../subagent/SubagentRunner"
import type { IFullyManagedTool, IPreparableToolHandler, ToolHandlerPreparationResult } from "../ToolExecutorCoordinator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"

const LATER_REQUEST_RESULT_NOTICE = "Its final result will be available only in a later model request."

/**
 * Summarise a partially streamed batch for the approval row.
 *
 * The array is normally still truncated mid-token while it streams, so parsing
 * is attempted but not required. When it fails the raw fragment is shown as one
 * entry: the user needs to see that a batch is arriving and be able to stop it,
 * which an empty row would not convey.
 *
 * @param streamed Raw `subagents` text received so far.
 * @returns One preview line per item, or a single line for the raw fragment.
 */
function previewBatchPrompts(streamed: string): string[] {
	try {
		const decoded = JSON.parse(streamed)
		if (Array.isArray(decoded)) {
			return decoded
				.map((item) => {
					if (!item || typeof item !== "object") return undefined
					const entry = item as Record<string, unknown>
					const task = typeof entry.task === "string" ? entry.task.trim() : ""
					const context = typeof entry.context === "string" ? entry.context.trim() : ""
					const parts = [task && `<task>\n${task}\n</task>`, context && `<context>\n${context}\n</context>`].filter(
						Boolean,
					)
					return parts.length > 0 ? parts.join("\n") : undefined
				})
				.filter((prompt): prompt is string => !!prompt)
		}
	} catch {
		// Incomplete JSON is the expected case while streaming, not an error.
	}
	return [streamed]
}

function backgroundSubagentResult(kind: "started" | "continued", target: "job" | "batch job", id: string): string {
	const verb = kind === "started" ? "Started" : "Continued"
	return `${verb} background subagent ${target}: ${id}. ${LATER_REQUEST_RESULT_NOTICE}`
}

/**
 * Get or create the task-local background subagent job manager.
 * @param config Current task config.
 * @returns Task-local subagent job manager instance.
 */
export function getSubagentJobManager(config: TaskConfig): SubagentJobManager {
	config.subagentJobManager ??= new SubagentJobManager()
	return config.subagentJobManager
}

/**
 * Build the lookups the batch planner needs from current task state.
 *
 * Resolution is injected rather than imported by the planner so the precedence
 * rules can be tested without a workspace on disk or a Profile catalogue.
 *
 * @param config Current task config.
 * @returns Agent and Profile lookups bound to this task.
 */
function getBatchResolvers(config: TaskConfig): SubagentBatchResolvers {
	return {
		resolveAgent: async (agentName) => (await resolveAgentConfig(config.cwd, agentName, getResolveOptions(config)))?.config,
		isProfileUsable: (profileName) => {
			const resolution = resolveProfileReference(readApiProfiles(), profileName)
			if (resolution.status !== "resolved") return false
			return resolution.profile.enabled && resolution.profile.usedFor.includes("subagents")
		},
		listAgentNames: () => getAvailableSubagentNames(config),
	}
}

/**
 * Build subagent config resolve options from current task state.
 * @param config Current task config.
 * @returns Local and global subagent toggle maps.
 */
function getResolveOptions(config: TaskConfig): ResolveAgentConfigOptions {
	return {
		subagentToggles: config.capabilityToggles.localSubagentsToggles,
		globalSubagentToggles: config.capabilityToggles.globalSubagentsToggles,
	}
}

/** Build the bounded diagnostic list for unknown named subagents. */
async function getAvailableSubagentNames(config: TaskConfig): Promise<string[]> {
	const configuredNames = (await listEnabledAgentConfigs(config.cwd, getResolveOptions(config))).map(
		(entry) => entry.config.name,
	)
	return Array.from(new Set([DEFAULT_SUBAGENT_NAME, ...configuredNames]))
		.sort((left, right) => left.localeCompare(right))
		.slice(0, 20)
}

/**
 * Normalize result text for tool summaries.
 *
 * Final subagent results are bounded by SubagentRunner in tokens. This helper
 * must not apply a second fixed character limit because that would override
 * the configured or dynamically resolved output budget.
 *
 * @param text Text to normalize.
 * @returns Trimmed text.
 */
/**
 * Statuses that count as a failed subagent outcome.
 *
 * A timeout is a failure to reach the goal, so the status card and the summary
 * returned to the model must agree on it. They previously disagreed, which made
 * the visible failure count differ from the one the model reasoned about.
 */
function isFailureStatus(status: SubagentStatusItem["status"]): boolean {
	return status === "failed" || status === "timeout"
}

function excerpt(text: string | undefined): string {
	return text?.trim() ?? ""
}

/**
 * Convert raw params into strings for prompt construction UI.
 * @param value Raw parameter value.
 * @returns Trimmed text when present.
 */
function readParam(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value.trim() : undefined
}

/**
 * Build an empty stats record for pending UI entries.
 * @returns Empty subagent stats.
 */
function emptyStats(): SubagentRunStats {
	return {
		toolCalls: 0,
		inputTokens: 0,
		outputTokens: 0,
		cacheWriteTokens: 0,
		cacheReadTokens: 0,
		totalCost: 0,
		currency: "",
		contextTokens: 0,
		contextWindow: 0,
		contextUsagePercentage: 0,
	}
}

/**
 * Apply runner stats to a Webview status item.
 * @param entry Status item to mutate.
 * @param stats Runner stats to copy.
 */
function applyStats(entry: SubagentStatusItem, stats: SubagentRunStats): void {
	entry.toolCalls = stats.toolCalls || 0
	entry.inputTokens = stats.inputTokens || 0
	entry.outputTokens = stats.outputTokens || 0
	entry.cacheWriteTokens = stats.cacheWriteTokens || 0
	entry.cacheReadTokens = stats.cacheReadTokens || 0
	entry.cacheHitRate = calculateApiUsageStatistics({
		inputTokens: entry.inputTokens,
		outputTokens: entry.outputTokens,
		cacheWriteTokens: entry.cacheWriteTokens,
		cacheReadTokens: entry.cacheReadTokens,
	}).cacheHitRatePercent
	entry.totalCost = stats.totalCost || 0
	entry.currency = stats.currency || ""
	entry.contextTokens = stats.contextTokens || 0
	entry.contextWindow = stats.contextWindow || 0
	entry.contextUsagePercentage = stats.contextUsagePercentage || 0
}

function updateActivityFromEntry(config: TaskConfig, entry: SubagentStatusItem): void {
	if (!entry.jobId) return
	config.activityStore?.update(entry.jobId, {
		status: entry.status === "pending" ? "awaiting_approval" : entry.status,
		latestEvent: entry.latestToolCall,
		result: entry.result,
		error: entry.error,
		finishedAt: entry.finishedAt,
		metrics: {
			toolCalls: entry.toolCalls,
			inputTokens: entry.inputTokens,
			outputTokens: entry.outputTokens,
			cacheWriteTokens: entry.cacheWriteTokens,
			cacheReadTokens: entry.cacheReadTokens,
			cacheHitRate: entry.cacheHitRate,
			totalCost: entry.totalCost,
			currency: entry.currency,
			contextTokens: entry.contextTokens,
			contextWindow: entry.contextWindow,
		},
	})
}

/**
 * Apply a live progress update from a running subagent.
 *
 * The runner reports its terminal status as soon as the run resolves, while
 * the job manager persists the authoritative record slightly later. Ignoring
 * the terminal update kept a finished subagent rendered as `running` until the
 * whole batch settled, so the status is mirrored here as an optimistic update.
 * `finishedAt` stays owned by the job manager to keep a single source of truth
 * for completion time.
 */
function applyProgress(config: TaskConfig, entry: SubagentStatusItem, update: SubagentProgressUpdate): void {
	if (update.status) entry.status = update.status
	if (update.latestToolCall) entry.latestToolCall = update.latestToolCall
	if (update.stats) applyStats(entry, update.stats)
	if (update.result) entry.result = update.result
	if (update.error) entry.error = update.error
	if (entry.jobId && update.runtime) {
		config.activityStore?.update(entry.jobId, { runtime: update.runtime })
	}
	if (entry.jobId && update.event) {
		const event = update.event
		if (event.kind === "thinking" || event.kind === "assistant_message") {
			if (event.text) {
				config.activityStore?.appendEvent(entry.jobId, {
					kind: event.kind,
					phase: event.phase ?? "delta",
					text: event.text,
				})
			}
		} else if (event.kind === "tool_call" && event.toolCallId && event.toolName && event.toolStatus) {
			config.activityStore?.appendEvent(entry.jobId, {
				kind: "tool_call",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				toolStatus: event.toolStatus,
				summary: event.summary,
				durationMs: event.durationMs,
				error: event.error,
			})
		} else if (event.kind === "tool_result" && event.toolCallId && event.toolName) {
			config.activityStore?.appendEvent(entry.jobId, {
				kind: "tool_result",
				toolCallId: event.toolCallId,
				toolName: event.toolName,
				text: event.text,
				error: event.error,
			})
		} else if (
			event.kind === "retry" &&
			event.retryAttempt !== undefined &&
			event.maxRetries !== undefined &&
			event.delayMs !== undefined &&
			event.cumulativeDelayMs !== undefined
		) {
			config.activityStore?.appendEvent(entry.jobId, {
				kind: "retry",
				retryAttempt: event.retryAttempt,
				maxRetries: event.maxRetries,
				delayMs: event.delayMs,
				cumulativeDelayMs: event.cumulativeDelayMs,
			})
		}
	}
	updateActivityFromEntry(config, entry)
}

/**
 * Describe why a preserved subagent stopped without a result.
 *
 * The raw provider error is deliberately excluded: it can carry account,
 * endpoint, or credential diagnostics that must not reach model context.
 * The full message stays on the Activity record for the user.
 *
 * @param result Terminal execution result.
 * @returns Short, non-sensitive reason.
 */
function describePausedReason(result: SubagentExecResult): string {
	if (result.status === "cancelled") return "Cancelled by the user"
	if (result.status === "timeout") return "Timed out"
	return "Retryable API failure"
}

/**
 * Build the tool result for a preserved, retryable subagent run.
 * @param subagentName Effective subagent name.
 * @param result Terminal execution result.
 * @param jobId Preserved activity/job identifier.
 * @returns Tool result text that points the user at the Retry control.
 */
function buildRetryablePausedResult(subagentName: string, result: SubagentExecResult, jobId: string): string {
	return getPrompt("toolHandlers", "subagentRetryablePaused")
		.replace("@SUBAGENT@", subagentName)
		.replace("@REASON@", describePausedReason(result))
		.replace("@JOB_ID@", jobId)
}

function statsFromActivity(config: TaskConfig, activityId: string): SubagentRunStats {
	const metrics = config.activityStore?.get(activityId)?.metrics
	const contextTokens = metrics?.contextTokens ?? 0
	const contextWindow = metrics?.contextWindow ?? 0
	return {
		toolCalls: metrics?.toolCalls ?? 0,
		inputTokens: metrics?.inputTokens ?? 0,
		outputTokens: metrics?.outputTokens ?? 0,
		cacheWriteTokens: metrics?.cacheWriteTokens ?? 0,
		cacheReadTokens: metrics?.cacheReadTokens ?? 0,
		totalCost: metrics?.totalCost ?? 0,
		currency: metrics?.currency ?? "USD",
		contextTokens,
		contextWindow,
		contextUsagePercentage: contextWindow > 0 ? (contextTokens / contextWindow) * 100 : 0,
	}
}

/**
 * Rebuild the Profile binding a retained item ran with.
 *
 * Only an explicit per-item Profile is replayed. When the recipe merely
 * recorded the subagent's own YAML Profile, the current document is the better
 * source: reapplying a stale copy would pin the retry to a value the user may
 * since have changed.
 *
 * @param agentConfig Freshly resolved subagent config, absent for the default.
 * @param subagentName Effective subagent name.
 * @param profileName Profile recorded on the retry recipe.
 * @returns Config carrying the Profile the original run used.
 */
function applyRecipeProfile(
	agentConfig: AgentBaseConfig | undefined,
	subagentName: string,
	profileName: string | undefined,
): AgentBaseConfig | undefined {
	if (!profileName || profileName === agentConfig?.profile) return agentConfig
	return applyProfileOverride(agentConfig ?? ({ name: subagentName } as AgentBaseConfig), profileName)
}

/** Rebind a persisted failed subagent activity to a fresh runner after Task reopen. */
export async function restoreSubagentActivityRetry(config: TaskConfig, activityId: string): Promise<boolean> {
	const activityStore = config.activityStore
	const activity = activityStore?.get(activityId)
	const recipe = activity?.retryRecipe
	if (!activity || activity.kind !== "subagent" || activity.status !== "failed" || !recipe) return false
	if (!recipe.retryable) return false

	const requestedName = recipe.subagentName ?? DEFAULT_SUBAGENT_NAME
	const usesDefault = isDefaultSubagentName(requestedName)
	const resolvedSubagent = await resolveAgentConfig(config.cwd, requestedName, getResolveOptions(config))
	if (!usesDefault && !resolvedSubagent) {
		activityStore?.setRetryUnavailableReason(
			activityId,
			`Retry unavailable: subagent '${requestedName}' is no longer enabled.`,
		)
		return false
	}
	const effectiveSubagentName = resolvedSubagent?.config.name ?? DEFAULT_SUBAGENT_NAME
	// An explicitly recorded Profile must still be usable. Without this check
	// the runner silently falls back to the parent Act Profile, so a retry of a
	// deleted or disabled Profile would quietly run on a different model
	// instead of telling the user why it cannot be replayed.
	const overriddenProfile =
		recipe.profileName && recipe.profileName !== resolvedSubagent?.config.profile ? recipe.profileName : undefined
	if (overriddenProfile && !getBatchResolvers(config).isProfileUsable(overriddenProfile)) {
		activityStore?.setRetryUnavailableReason(
			activityId,
			`Retry unavailable: API Profile '${overriddenProfile}' is no longer available or not enabled for subagents.`,
		)
		return false
	}
	// A batch item may have overridden the subagent's own Profile. Replaying
	// from the subagent config alone would retry on a different model, so the
	// recorded binding is reapplied before the runner is built.
	const retryAgentConfig = applyRecipeProfile(resolvedSubagent?.config, effectiveSubagentName, recipe.profileName)
	const runner = new SubagentRunner(config, effectiveSubagentName, retryAgentConfig, {
		inheritTaskAbort: false,
	})
	const entry: SubagentStatusItem = {
		index: 1,
		jobId: activityId,
		subagentName: effectiveSubagentName,
		profileName: recipe.profileName,
		task: recipe.task,
		prompt: recipe.prompt,
		background: true,
		backgroundHandoffAvailable: false,
		timeoutSeconds: recipe.timeoutSeconds,
		injectionState: "pending",
		status: "failed",
		startedAt: activity.createdAt,
		finishedAt: activity.finishedAt,
		error: activity.error,
		...statsFromActivity(config, activityId),
	}
	const manager = getSubagentJobManager(config)
	const bindRetry = (retryable: boolean) => {
		activityStore?.setRetry(
			activityId,
			retryable
				? async () => {
						config.activityStore?.setCancel(activityId, () => runner.abort())
						config.activityStore?.setFinish(activityId, () => runner.requestFinish("user"))
						return manager.retryJob(activityId)
					}
				: undefined,
		)
	}
	manager.retainRetryableJob({
		jobId: activityId,
		subagentName: effectiveSubagentName,
		task: recipe.task,
		prompt: recipe.prompt,
		timeoutSeconds: recipe.timeoutSeconds,
		startedAt: activity.createdAt,
		result: {
			status: "failed",
			error: activity.error ?? "Retryable subagent failure",
			retryable: true,
			stats: statsFromActivity(config, activityId),
		},
		// A retry after reopen is still subagent work and must queue behind the
		// same task-scoped budget as a fresh batch; running it unbudgeted lets
		// several restored activities exceed the configured parallel limit.
		runner: () =>
			runBudgetedSubagent(getSubagentFanoutBudget(config), config.ulid, runner, {
				prompt: recipe.prompt,
				timeoutSeconds: recipe.timeoutSeconds,
				onProgress: (update) => applyProgress(config, entry, update),
			}),
		onStatusChange: async (jobRecord) => {
			entry.status = jobRecord.status
			entry.result = jobRecord.result
			entry.error = jobRecord.error
			entry.finishedAt = jobRecord.finishedAt
			if (jobRecord.stats) applyStats(entry, jobRecord.stats)
			updateActivityFromEntry(config, entry)
			bindRetry(jobRecord.retryable === true)
		},
	})
	bindRetry(true)
	return activityStore?.isRetryable(activityId) === true
}

function createSubagentActivity(
	config: TaskConfig,
	entry: SubagentStatusItem,
	executionMode: "foreground" | "background",
	cancel: () => Promise<void>,
	parentActivityId?: string,
	continueInBackground?: () => Promise<BackgroundHandoffResult>,
	finish?: () => Promise<boolean>,
	retry?: () => Promise<boolean>,
	backgroundGroupIds?: string[],
): void {
	if (!entry.jobId) return
	config.activityStore?.create({
		activityId: entry.jobId,
		kind: "subagent",
		executionMode,
		cancellationOwner: executionMode === "background" ? "explicit" : "task",
		title: entry.subagentName || entry.task || `Subagent ${entry.index}`,
		detail: entry.prompt,
		parentActivityId,
		retryRecipe: {
			kind: "subagent",
			schemaVersion: 1,
			subagentName: entry.subagentName,
			profileName: entry.profileName,
			task: entry.task || entry.prompt,
			prompt: entry.prompt,
			timeoutSeconds: entry.timeoutSeconds || 0,
			retryable: Boolean(retry),
		},
		cancel,
		continueInBackground,
		backgroundGroupIds,
		finish,
		retry,
	})
}

/**
 * Build a status payload from current entries.
 * @param kind Single or batch status kind.
 * @param status Overall status.
 * @param entries Current item entries.
 * @param options Additional payload options.
 * @returns Webview subagent status payload.
 */
export function buildStatusPayload(
	kind: "single" | "batch",
	status: ClineSaySubagentStatus["status"],
	entries: SubagentStatusItem[],
	options: Pick<ClineSaySubagentStatus, "background" | "timeoutSeconds" | "jobId" | "batchJobId" | "injectionState">,
): ClineSaySubagentStatus {
	const completed = entries.filter((entry) => entry.status !== "pending" && entry.status !== "running").length
	const successes = entries.filter((entry) => entry.status === "completed").length
	const failures = entries.filter((entry) => isFailureStatus(entry.status)).length
	const toolCalls = entries.reduce((acc, entry) => acc + (entry.toolCalls || 0), 0)
	const inputTokens = entries.reduce((acc, entry) => acc + (entry.inputTokens || 0), 0)
	const outputTokens = entries.reduce((acc, entry) => acc + (entry.outputTokens || 0), 0)
	const contextWindow = entries.reduce((acc, entry) => Math.max(acc, entry.contextWindow || 0), 0)
	const maxContextTokens = entries.reduce((acc, entry) => Math.max(acc, entry.contextTokens || 0), 0)
	const maxContextUsagePercentage = entries.reduce((acc, entry) => Math.max(acc, entry.contextUsagePercentage || 0), 0)
	return {
		kind,
		status,
		...options,
		injectionState: options.injectionState ?? entries[0]?.injectionState ?? "pending",
		total: entries.length,
		completed,
		successes,
		failures,
		toolCalls,
		inputTokens,
		outputTokens,
		contextWindow,
		maxContextTokens,
		maxContextUsagePercentage,
		items: entries,
	}
}

/**
 * Format a foreground subagent result summary.
 * @param entries Final status entries.
 * @returns Text returned to the model.
 */
function formatSummary(entries: SubagentStatusItem[]): string {
	const failures = entries.filter((entry) => isFailureStatus(entry.status)).length
	const successCount = entries.filter((entry) => entry.status === "completed").length
	const cancellations = entries.filter((entry) => entry.status === "cancelled").length
	const totalToolCalls = entries.reduce((acc, entry) => acc + (entry.toolCalls || 0), 0)
	const maxContextUsagePercentage = entries.reduce((acc, entry) => Math.max(acc, entry.contextUsagePercentage || 0), 0)
	const maxContextTokens = entries.reduce((acc, entry) => Math.max(acc, entry.contextTokens || 0), 0)
	const contextWindow = entries.reduce((acc, entry) => Math.max(acc, entry.contextWindow || 0), 0)
	return [
		"Subagent results:",
		`Total: ${entries.length}`,
		`Succeeded: ${successCount}`,
		`Failed: ${failures}`,
		`Cancelled: ${cancellations}`,
		`Tool calls: ${totalToolCalls}`,
		`Peak context usage: ${maxContextTokens.toLocaleString()} / ${contextWindow.toLocaleString()} (${maxContextUsagePercentage.toFixed(1)}%)`,
		"",
		...entries.map((entry) => {
			const header = `[${entry.index}] ${entry.status.toUpperCase()} - ${entry.task || entry.prompt}`
			const detail = entry.status === "completed" ? excerpt(entry.result) : excerpt(entry.error)
			return detail ? `${header}\n${detail}` : header
		}),
	].join("\n")
}

/**
 * Capture usage telemetry for a subagent tool approval result.
 * @param config Current task config.
 * @param toolName Tool name being executed.
 * @param provider Provider id.
 * @param autoApproved Whether approval was automatic.
 * @param approved Whether execution was approved.
 * @param isNativeToolCall Whether the tool call was native.
 */
function captureToolTelemetry(
	config: TaskConfig,
	toolName: ClineDefaultTool,
	provider: string | undefined,
	autoApproved: boolean,
	approved: boolean,
	isNativeToolCall?: boolean,
): void {
	telemetryService.captureToolUsage(
		config.ulid ?? "",
		toolName,
		config.api.getModel().id,
		provider ?? "",
		autoApproved,
		approved,
		undefined,
		isNativeToolCall,
	)
}

/** Present an admitted subagent request and consume optional approval feedback. */
async function presentSubagentUse(
	config: TaskConfig,
	block: ToolUse,
	toolName: ClineDefaultTool,
	approvalBody: string,
): Promise<void> {
	const apiConfig = config.services.stateManager.getApiConfiguration()
	const currentMode = config.services.stateManager.getGlobalSettingsKey("mode")
	const provider = resolveProvider(apiConfig, currentMode)
	const outcome = block.dline_tid ? config.admissionOutcomes?.get(block.dline_tid) : undefined
	await config.callbacks.say("use_subagents", approvalBody, undefined, undefined, false, block.ts)
	captureToolTelemetry(config, toolName, provider, outcome === undefined, true, block.isNativeToolCall)
}

/**
 * Run one subagent against the task-scoped budget.
 *
 * The slot is taken before the run starts and returned only once the run has
 * actually stopped. That is deliberately not the same as the promise settling:
 * a runner interrupted while a tool is still executing resolves early, and
 * freeing the slot then would admit replacement work against resources the
 * abandoned tool still holds.
 *
 * @param budget Task-scoped subagent budget.
 * @param poolInstance Identifies the budget in telemetry. The task's ulid,
 *   because one gate is shared by every fan-out in the task including nested
 *   ones; keying by view would count the same state several times. It stays in
 *   memory and is never exported as a metric label.
 * @param runner Runner for this item.
 * @param options Prompt, timeout, progress and start notification.
 * @returns Terminal execution result, including a refusal reported as failure.
 */
async function runBudgetedSubagent(
	budget: SubagentFanoutBudget,
	poolInstance: string,
	runner: SubagentRunner,
	options: {
		prompt: string
		timeoutSeconds: number
		onProgress: (update: SubagentProgressUpdate) => void
		onStarted?: () => void
	},
): Promise<SubagentExecResult> {
	const admissionRequestedAt = Date.now()
	const admission = await budget.acquire()
	if (!admission.admitted) {
		return { status: "failed", error: admission.message, stats: emptyStats() }
	}
	const slot: SubagentSlot = admission.slot
	// Sampled with the permit in hand and labelled by pool, so a saturated
	// subagent fan-out is distinguishable from a saturated tool pool and from
	// a subagent that is simply slow.
	const budgetState = budget.state()
	telemetryService.capturePoolAdmission({
		pool: "subagent",
		instance: poolInstance,
		queueWaitMs: Date.now() - admissionRequestedAt,
		running: budgetState.running,
		queued: budgetState.queued,
		limit: budgetState.limit,
	})
	options.onStarted?.()
	try {
		return await runSubagent({
			runner,
			prompt: options.prompt,
			timeoutSeconds: options.timeoutSeconds,
			onProgress: options.onProgress,
		})
	} finally {
		// An interrupted run resolves while its abandoned tool is still
		// executing. Releasing here would admit replacement work against
		// resources that tool still holds, so the slot is returned only once
		// the runner reports the abandoned work has settled.
		//
		// The wait is bounded on purpose: a wedged tool must not hold the slot
		// forever, because every remaining item is queued behind it. Giving up
		// returns the slot but withholds one unit of allowance until the tool
		// really stops, so the batch keeps draining without the budget
		// pretending the resource is free.
		try {
			const settled = await runner.whenAbandonedWorkSettled()
			if (!settled) {
				// The claim is one-shot: a runner survives its retries, so a tool
				// wedged by an earlier attempt is still listed here. Charging it
				// again would shrink the allowance below the work that is really
				// outstanding and starve unrelated items.
				const outstanding = runner.claimOutstandingAbandonedWork()
				if (outstanding) {
					budget.withholdCapacity(outstanding)
					Logger.warn(
						"[SubagentToolHandler] a subagent tool outlived its run; subagent capacity is reduced until it exits",
					)
				}
			}
		} catch (error) {
			Logger.warn("[SubagentToolHandler] abandoned subagent tool did not settle cleanly", error)
		} finally {
			slot.release()
			const releasedState = budget.state()
			telemetryService.recordPoolOccupancy({
				pool: "subagent",
				instance: poolInstance,
				running: releasedState.running,
				queued: releasedState.queued,
				limit: releasedState.limit,
			})
		}
	}
}

/**
 * Describe items that never started, for the model.
 *
 * The same reasons are used whether the whole batch failed planning or only
 * some items did: a rejected item that is silently dropped from a mixed batch
 * reads to the model as work that was requested and then forgotten.
 *
 * @param rejected Items rejected during planning.
 * @param wholeBatch True when nothing at all could be started.
 * @returns Actionable multi-line summary.
 */
function formatRejectedItems(rejected: readonly RejectedSubagentItem[], wholeBatch: boolean): string {
	return [
		wholeBatch ? "No subagent could be started." : `${rejected.length} requested subagent(s) were not started:`,
		...rejected.map((item) => `[${item.index}] ${item.error}`),
	].join("\n")
}

/**
 * Emit aggregate usage for completed foreground entries.
 * @param config Current task config.
 * @param entries Final status entries.
 */
async function emitUsage(config: TaskConfig, entries: SubagentStatusItem[]): Promise<void> {
	const payload: ClineSubagentUsageInfo = {
		source: "subagents",
		tokensIn: entries.reduce((acc, entry) => acc + entry.inputTokens, 0),
		tokensOut: entries.reduce((acc, entry) => acc + entry.outputTokens, 0),
		// Aggregate the reported cache tokens rather than zero: the same card
		// already shows a cache hit rate, so a zeroed usage row contradicts it.
		cacheWrites: entries.reduce((acc, entry) => acc + (entry.cacheWriteTokens ?? 0), 0),
		cacheReads: entries.reduce((acc, entry) => acc + (entry.cacheReadTokens ?? 0), 0),
		cost: entries.reduce((acc, entry) => acc + entry.totalCost, 0),
	}
	await config.callbacks.say("subagent_usage", JSON.stringify(payload))
}

interface PreparedSingleSubagentExecution {
	request: ReturnType<typeof parseUseSubagentRequest>
	resolvedSubagent: Awaited<ReturnType<typeof resolveAgentConfig>>
	effectiveSubagentName: string
	approvalBody: string
}

interface PreparedBatchSubagentExecution {
	request: ReturnType<typeof parseUseSubagentsRequest>
	batchId: string
	planned: PlannedSubagentItem[]
	rejected: RejectedSubagentItem[]
	approvalBody: string
}

function preparedExecutionKey(block: ToolUse): string {
	return block.dline_tid ?? block.function_id ?? String(block.ts)
}

export class UseSubagentToolHandler implements IFullyManagedTool, IPreparableToolHandler {
	readonly name = ClineDefaultTool.USE_SUBAGENT
	private readonly preparedExecutions = new Map<string, PreparedSingleSubagentExecution>()

	/**
	 * Describe stable single subagent execution.
	 * @param _block Tool block.
	 * @returns UI description.
	 */
	getDescription(_block: ToolUse): string {
		return "[subagent]"
	}

	/**
	 * Stream partial single subagent approval UI.
	 * @param block Tool block.
	 * @param uiHelpers UI helper methods.
	 */
	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		const subagentName = readParam(block.params.agent_name) ?? DEFAULT_SUBAGENT_NAME
		const task = readParam(block.params.task)
		const context = readParam(block.params.context)
		if (!subagentName && !task && !context) return
		const payload: ClineAskUseSubagents = {
			kind: "single",
			prompts: task ? [task] : [],
			subagentName,
			task,
			context,
		}
		await uiHelpers.say("use_subagents", JSON.stringify(payload), undefined, undefined, true, block.ts)
	}

	async prepare(config: TaskConfig, block: ToolUse): Promise<ToolHandlerPreparationResult> {
		if (!(config.subagentsEnabled ?? config.services.stateManager.getGlobalSettingsKey("subagentsEnabled"))) {
			return { outcome: "rejected", message: getPrompt("toolHandlers", "subagentsDisabled") }
		}
		let request: ReturnType<typeof parseUseSubagentRequest>
		try {
			request = parseUseSubagentRequest(block.params)
		} catch (error) {
			config.taskState.consecutiveMistakeCount++
			return { outcome: "rejected", message: error instanceof Error ? error.message : String(error) }
		}
		const usesDefault = isDefaultSubagentName(request.agentName)
		const resolvedSubagent = await resolveAgentConfig(config.cwd, request.agentName, getResolveOptions(config))
		if (!usesDefault && !resolvedSubagent) {
			const available = await getAvailableSubagentNames(config)
			return {
				outcome: "rejected",
				message: `Unknown or disabled subagent '${request.agentName}'. Available subagents: ${available.join(", ")}.`,
			}
		}
		const effectiveSubagentName = resolvedSubagent?.config.name ?? DEFAULT_SUBAGENT_NAME
		const approvalBody = JSON.stringify({
			kind: "single",
			prompts: [request.task],
			subagentName: effectiveSubagentName,
			task: request.task,
			context: request.context,
			background: request.options.background,
			timeoutSeconds: request.options.timeoutSeconds,
		} satisfies ClineAskUseSubagents)
		this.preparedExecutions.set(preparedExecutionKey(block), {
			request,
			resolvedSubagent,
			effectiveSubagentName,
			approvalBody,
		})
		return { outcome: "prepared", presentation: { ask: "tool", body: approvalBody, notify: false } }
	}

	discardPrepared(block: ToolUse): void {
		this.preparedExecutions.delete(preparedExecutionKey(block))
	}

	/**
	 * Execute stable single subagent requests.
	 * @param config Current task config.
	 * @param block Tool block.
	 * @returns Tool response for the model.
	 */
	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		let prepared = this.preparedExecutions.get(preparedExecutionKey(block))
		if (!prepared) {
			const preparation = await this.prepare(config, block)
			if (preparation.outcome === "rejected") return formatResponse.toolError(preparation.message)
			prepared = this.preparedExecutions.get(preparedExecutionKey(block))
		}
		if (!prepared) return formatResponse.toolError("Prepared subagent execution is unavailable.")
		this.preparedExecutions.delete(preparedExecutionKey(block))
		const { request, resolvedSubagent, effectiveSubagentName, approvalBody } = prepared
		await presentSubagentUse(config, block, this.name, approvalBody)

		const entry: SubagentStatusItem = {
			index: 1,
			prompt: request.prompt,
			subagentName: effectiveSubagentName,
			task: request.task,
			context: request.context,
			background: request.options.background,
			backgroundHandoffAvailable: !request.options.background,
			timeoutSeconds: request.options.timeoutSeconds,
			injectionState: "pending",
			status: "running",
			...emptyStats(),
		}
		if (request.options.background) {
			const runner = new SubagentRunner(config, effectiveSubagentName, resolvedSubagent?.config)
			const job = getSubagentJobManager(config).startJob({
				subagentName: effectiveSubagentName,
				task: request.task,
				prompt: request.prompt,
				timeoutSeconds: request.options.timeoutSeconds,
				runner: () =>
					runBudgetedSubagent(getSubagentFanoutBudget(config), config.ulid, runner, {
						prompt: request.prompt,
						timeoutSeconds: request.options.timeoutSeconds,
						onProgress: (update) => applyProgress(config, entry, update),
					}),
				onCreated: (jobRecord) => {
					entry.jobId = jobRecord.jobId
					entry.startedAt = jobRecord.startedAt
					createSubagentActivity(
						config,
						entry,
						"background",
						() => runner.abort(),
						undefined,
						undefined,
						() => runner.requestFinish("user"),
					)
				},
				onStatusChange: async (jobRecord) => {
					entry.status = jobRecord.status
					entry.result = jobRecord.result
					entry.error = jobRecord.error
					if (jobRecord.stats) applyStats(entry, jobRecord.stats)
					entry.finishedAt = jobRecord.finishedAt
					updateActivityFromEntry(config, entry)
					config.activityStore?.setRetry?.(
						jobRecord.jobId,
						jobRecord.retryable
							? async () => {
									config.activityStore?.setCancel(jobRecord.jobId, () => runner.abort())
									config.activityStore?.setFinish(jobRecord.jobId, () => runner.requestFinish("user"))
									return getSubagentJobManager(config).retryJob(jobRecord.jobId)
								}
							: undefined,
					)
					await config.callbacks.say(
						"subagent",
						JSON.stringify(
							buildStatusPayload("single", jobRecord.status, [entry], {
								background: true,
								timeoutSeconds: request.options.timeoutSeconds,
								jobId: jobRecord.jobId,
							}),
						),
						undefined,
						undefined,
						false,
						block.ts,
					)
				},
			})
			await config.callbacks.say(
				"subagent",
				JSON.stringify(
					buildStatusPayload("single", "running", [entry], {
						background: true,
						timeoutSeconds: request.options.timeoutSeconds,
						jobId: job.jobId,
					}),
				),
				undefined,
				undefined,
				false,
				block.ts,
			)
			return formatResponse.toolResult(backgroundSubagentResult("started", "job", job.jobId))
		}

		config.taskState.consecutiveMistakeCount = 0
		config.taskState.isExecutingSubagent = true
		const foregroundRunner = new SubagentRunner(config, effectiveSubagentName, resolvedSubagent?.config)
		let isContinuedInBackground = false
		let resolveHandoff: (() => void) | undefined
		const handoffPromise = new Promise<void>((resolve) => {
			resolveHandoff = resolve
		})
		let resolveRunResult: ((result: SubagentExecResult) => void) | undefined
		const runResultPromise = new Promise<SubagentExecResult>((resolve) => {
			resolveRunResult = resolve
		})
		const subagentJobManager = getSubagentJobManager(config)
		const foregroundJob = subagentJobManager.startJob({
			subagentName: effectiveSubagentName,
			task: request.task,
			prompt: request.prompt,
			timeoutSeconds: request.options.timeoutSeconds,
			runner: async () => {
				try {
					const result = await runBudgetedSubagent(getSubagentFanoutBudget(config), config.ulid, foregroundRunner, {
						prompt: request.prompt,
						timeoutSeconds: request.options.timeoutSeconds,
						onProgress: (update) => applyProgress(config, entry, update),
					})
					resolveRunResult?.(result)
					return result
				} catch (error) {
					const result: SubagentExecResult = {
						status: "failed",
						error: error instanceof Error ? error.message : String(error),
						stats: emptyStats(),
					}
					resolveRunResult?.(result)
					return result
				}
			},
			onCreated: (jobRecord) => {
				entry.jobId = jobRecord.jobId
				entry.startedAt = jobRecord.startedAt
				createSubagentActivity(
					config,
					entry,
					"foreground",
					() => foregroundRunner.abort(),
					undefined,
					async () => {
						if (isContinuedInBackground || entry.status !== "running") return false
						isContinuedInBackground = true
						entry.background = true
						entry.backgroundHandoffAvailable = false
						try {
							await config.callbacks.say(
								"subagent",
								JSON.stringify(
									buildStatusPayload("single", "running", [entry], {
										background: true,
										timeoutSeconds: request.options.timeoutSeconds,
										jobId: foregroundJob.jobId,
									}),
								),
								undefined,
								undefined,
								false,
								block.ts,
							)
						} catch (error) {
							isContinuedInBackground = false
							entry.background = false
							entry.backgroundHandoffAvailable = true
							throw error
						}
						resolveHandoff?.()
						return true
					},
					() => foregroundRunner.requestFinish("user"),
				)
			},
			onStatusChange: async (jobRecord) => {
				entry.status = jobRecord.status
				entry.result = jobRecord.result
				entry.error = jobRecord.error
				entry.background = isContinuedInBackground
				entry.backgroundHandoffAvailable = false
				if (jobRecord.stats) applyStats(entry, jobRecord.stats)
				entry.finishedAt = jobRecord.finishedAt
				updateActivityFromEntry(config, entry)
				config.activityStore?.setRetry?.(
					jobRecord.jobId,
					jobRecord.retryable
						? async () => {
								isContinuedInBackground = true
								entry.background = true
								entry.backgroundHandoffAvailable = false
								config.activityStore?.setCancel(jobRecord.jobId, () => foregroundRunner.abort())
								config.activityStore?.setFinish(jobRecord.jobId, () => foregroundRunner.requestFinish("user"))
								return subagentJobManager.retryJob(jobRecord.jobId)
							}
						: undefined,
				)
				if (!isContinuedInBackground) return
				await config.callbacks.say(
					"subagent",
					JSON.stringify(
						buildStatusPayload("single", jobRecord.status, [entry], {
							background: true,
							timeoutSeconds: request.options.timeoutSeconds,
							jobId: jobRecord.jobId,
						}),
					),
					undefined,
					undefined,
					false,
					block.ts,
				)
			},
		})
		await config.callbacks.say(
			"subagent",
			JSON.stringify(
				buildStatusPayload("single", "running", [entry], {
					background: false,
					timeoutSeconds: request.options.timeoutSeconds,
					jobId: foregroundJob.jobId,
				}),
			),
			undefined,
			undefined,
			false,
			block.ts,
		)
		let result: SubagentExecResult
		try {
			const outcome = await Promise.race([
				runResultPromise.then((completedResult) => ({ kind: "completed" as const, result: completedResult })),
				handoffPromise.then(() => ({ kind: "background" as const })),
			])
			if (outcome.kind === "background") {
				return formatResponse.toolResult(backgroundSubagentResult("continued", "job", foregroundJob.jobId))
			}
			result = outcome.result
			if (!result.retryable) {
				subagentJobManager.markInjected([foregroundJob.jobId])
				subagentJobManager.markConsumed([foregroundJob.jobId])
			}
		} finally {
			config.taskState.isExecutingSubagent = false
		}
		entry.status = result.status
		entry.result = result.result
		entry.error = result.error
		entry.background = false
		entry.backgroundHandoffAvailable = false
		entry.finishedAt = Date.now()
		applyStats(entry, result.stats)
		updateActivityFromEntry(config, entry)
		await config.callbacks.say(
			"subagent",
			JSON.stringify(
				buildStatusPayload("single", result.status === "completed" ? "completed" : result.status, [entry], {
					background: false,
					timeoutSeconds: request.options.timeoutSeconds,
					jobId: foregroundJob.jobId,
				}),
			),
			undefined,
			undefined,
			false,
			block.ts,
		)
		await emitUsage(config, [entry])
		return formatResponse.toolResult(
			result.retryable
				? buildRetryablePausedResult(effectiveSubagentName, result, foregroundJob.jobId)
				: formatSummary([entry]),
		)
	}
}

export class UseSubagentsToolHandler implements IFullyManagedTool, IPreparableToolHandler {
	readonly name = ClineDefaultTool.USE_SUBAGENTS
	private readonly preparedExecutions = new Map<string, PreparedBatchSubagentExecution>()

	/**
	 * Describe stable batch subagent execution.
	 * @param _block Tool block.
	 * @returns UI description.
	 */
	getDescription(_block: ToolUse): string {
		return "[subagents]"
	}

	/**
	 * Stream partial batch subagent approval UI.
	 * @param block Tool block.
	 * @param uiHelpers UI helper methods.
	 */
	async handlePartialBlock(block: ToolUse, uiHelpers: StronglyTypedUIHelpers): Promise<void> {
		// A streaming batch is incomplete by definition, so the array is usually
		// unparseable text. Showing the raw fragment is still better than showing
		// nothing: the user sees the call taking shape and can stop it early.
		const streamed = uiHelpers.removeClosingTag(block, "subagents", readParam(block.params.subagents))?.trim()
		const prompts = streamed ? previewBatchPrompts(streamed) : []
		if (prompts.length === 0) return
		const partialMessage = JSON.stringify({ kind: "batch", prompts } satisfies ClineAskUseSubagents)
		await uiHelpers.say("use_subagents", partialMessage, undefined, undefined, true, block.ts)
	}

	async prepare(config: TaskConfig, block: ToolUse): Promise<ToolHandlerPreparationResult> {
		if (!(config.subagentsEnabled ?? config.services.stateManager.getGlobalSettingsKey("subagentsEnabled"))) {
			return { outcome: "rejected", message: getPrompt("toolHandlers", "subagentsDisabled") }
		}
		let request: ReturnType<typeof parseUseSubagentsRequest>
		try {
			request = parseUseSubagentsRequest(block.params)
		} catch (error) {
			config.taskState.consecutiveMistakeCount++
			return { outcome: "rejected", message: error instanceof Error ? error.message : String(error) }
		}
		const batchId = `subagent_batch_${block.function_id || block.ts}`
		const { planned, rejected } = await planSubagentBatch({
			items: request.items,
			batchTimeoutSeconds: request.options.timeoutSeconds,
			batchId,
			resolvers: getBatchResolvers(config),
		})
		telemetryService.captureSubagentFanout(
			request.items.length,
			request.items.filter((item) => item.profile !== undefined).length,
		)
		if (planned.length === 0) {
			config.taskState.consecutiveMistakeCount++
			return { outcome: "rejected", message: formatRejectedItems(rejected, true) }
		}
		const approvalBody = JSON.stringify({
			kind: "batch",
			prompts: planned.map((item) => item.prompt),
			items: planned.map((item) => ({
				index: item.index,
				task: item.task,
				context: item.context,
				subagentName: item.subagentName,
				profileName: item.profileName,
				jobId: item.jobId,
			})),
			rejected: rejected.map((item) => ({ index: item.index, error: item.error })),
			background: request.options.background,
			timeoutSeconds: request.options.timeoutSeconds,
		} satisfies ClineAskUseSubagents)
		this.preparedExecutions.set(preparedExecutionKey(block), { request, batchId, planned, rejected, approvalBody })
		return { outcome: "prepared", presentation: { ask: "tool", body: approvalBody, notify: false } }
	}

	discardPrepared(block: ToolUse): void {
		this.preparedExecutions.delete(preparedExecutionKey(block))
	}

	/**
	 * Execute stable batch subagent requests.
	 * @param config Current task config.
	 * @param block Tool block.
	 * @returns Tool response for the model.
	 */
	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		let prepared = this.preparedExecutions.get(preparedExecutionKey(block))
		if (!prepared) {
			const preparation = await this.prepare(config, block)
			if (preparation.outcome === "rejected") return formatResponse.toolError(preparation.message)
			prepared = this.preparedExecutions.get(preparedExecutionKey(block))
		}
		if (!prepared) return formatResponse.toolError("Prepared subagent batch execution is unavailable.")
		this.preparedExecutions.delete(preparedExecutionKey(block))
		const { request, batchId, planned, rejected, approvalBody } = prepared
		await presentSubagentUse(config, block, this.name, approvalBody)
		config.taskState.consecutiveMistakeCount = 0
		const entries: SubagentStatusItem[] = planned.map((item) => ({
			index: item.index,
			jobId: item.jobId,
			prompt: item.prompt,
			subagentName: item.subagentName,
			profileName: item.profileName,
			task: item.task,
			context: item.context,
			background: request.options.background,
			backgroundHandoffAvailable: !request.options.background,
			timeoutSeconds: item.timeoutSeconds,
			injectionState: "pending",
			// A wider batch than the budget allows starts queued rather than
			// running, so the row does not claim work that has not begun.
			status: "pending",
			...emptyStats(),
		}))
		// Runners are addressed by job id: rejected items make the executing set
		// sparse, so array position is not a usable identity.
		const runnersByJobId = new Map<string, SubagentRunner>(
			planned.map((item) => [item.jobId, new SubagentRunner(config, item.subagentName, item.agentConfig)]),
		)
		const entriesByJobId = new Map<string, SubagentStatusItem>(entries.map((entry) => [entry.jobId as string, entry]))
		const budget = getSubagentFanoutBudget(config)
		if (request.options.background) {
			// The manager assigns its own job ids for background work, so the
			// planned id is only the key used to reach this item's runner here.
			const runnerByBatchPosition = planned.map((item) => runnersByJobId.get(item.jobId) as SubagentRunner)
			const batch = getSubagentJobManager(config).startBatch({
				timeoutSeconds: request.options.timeoutSeconds,
				items: planned.map((item, position) => ({
					subagentName: item.subagentName,
					task: item.task,
					prompt: item.prompt,
					runner: () =>
						runBudgetedSubagent(budget, config.ulid, runnerByBatchPosition[position], {
							prompt: item.prompt,
							timeoutSeconds: item.timeoutSeconds,
							onProgress: (update) => applyProgress(config, entries[position], update),
						}),
				})),
				onCreated: (batchRecord) => {
					entries.forEach((entry, position) => {
						// Rebind identity to the manager's id and keep the runner
						// map addressable under it, so cancel, finish and retry
						// resolve by id rather than by array position.
						const runner = runnerByBatchPosition[position]
						const managedJobId = batchRecord.itemJobIds[position]
						entriesByJobId.delete(entry.jobId as string)
						runnersByJobId.delete(entry.jobId as string)
						entry.jobId = managedJobId
						entry.startedAt = batchRecord.startedAt
						entriesByJobId.set(managedJobId, entry)
						runnersByJobId.set(managedJobId, runner)
						createSubagentActivity(
							config,
							entry,
							"background",
							() => runner.abort(),
							batchRecord.batchJobId,
							undefined,
							() => runner.requestFinish("user"),
						)
					})
				},
				onStatusChange: async (jobRecord, batchRecord) => {
					const entry = entriesByJobId.get(jobRecord.jobId)
					if (entry) {
						entry.status = jobRecord.status
						entry.result = jobRecord.result
						entry.error = jobRecord.error
						if (jobRecord.stats) applyStats(entry, jobRecord.stats)
						entry.finishedAt = jobRecord.finishedAt
						updateActivityFromEntry(config, entry)
						const runner = runnersByJobId.get(jobRecord.jobId)
						config.activityStore?.setRetry?.(
							jobRecord.jobId,
							jobRecord.retryable && runner
								? async () => {
										config.activityStore?.setCancel(jobRecord.jobId, () => runner.abort())
										config.activityStore?.setFinish(jobRecord.jobId, () => runner.requestFinish("user"))
										return getSubagentJobManager(config).retryJob(jobRecord.jobId)
									}
								: undefined,
						)
					}
					await config.callbacks.say(
						"subagent",
						JSON.stringify(
							buildStatusPayload("batch", batchRecord?.status ?? jobRecord.status, entries, {
								background: true,
								timeoutSeconds: request.options.timeoutSeconds,
								batchJobId: batchRecord?.batchJobId,
							}),
						),
						undefined,
						undefined,
						false,
						block.ts,
					)
				},
			})
			await config.callbacks.say(
				"subagent",
				JSON.stringify(
					buildStatusPayload("batch", "running", entries, {
						background: true,
						timeoutSeconds: request.options.timeoutSeconds,
						batchJobId: batch.batchJobId,
					}),
				),
				undefined,
				undefined,
				false,
				block.ts,
			)
			// Background items report back later through the job manager, which
			// only knows about the ones that started. A rejected item would
			// otherwise never be mentioned again, so it is reported now.
			const startedNotice = backgroundSubagentResult("started", "batch job", batch.batchJobId)
			return formatResponse.toolResult(
				rejected.length === 0 ? startedNotice : `${startedNotice}\n\n${formatRejectedItems(rejected, false)}`,
			)
		}
		config.taskState.isExecutingSubagent = true
		let isContinuedInBackground = false
		let resolveHandoff: (() => void) | undefined
		const handoffPromise = new Promise<void>((resolve) => {
			resolveHandoff = resolve
		})
		const continueBatchInBackground = async (): Promise<BackgroundHandoffResult> => {
			if (isContinuedInBackground || !entries.some((entry) => entry.status === "pending" || entry.status === "running")) {
				return false
			}
			const rollback = async () => {
				isContinuedInBackground = false
				for (const entry of entries) {
					entry.background = false
					entry.backgroundHandoffAvailable = true
				}
			}
			isContinuedInBackground = true
			for (const entry of entries) {
				entry.background = true
				entry.backgroundHandoffAvailable = false
			}
			try {
				await config.callbacks.say(
					"subagent",
					JSON.stringify(
						buildStatusPayload("batch", "running", entries, {
							background: true,
							timeoutSeconds: request.options.timeoutSeconds,
							batchJobId: batchId,
						}),
					),
					undefined,
					undefined,
					false,
					block.ts,
				)
			} catch (error) {
				await rollback()
				throw error
			}
			return { accepted: true, rollback, commit: () => resolveHandoff?.() }
		}
		planned.forEach((item) => {
			const entry = entriesByJobId.get(item.jobId) as SubagentStatusItem
			const runner = runnersByJobId.get(item.jobId) as SubagentRunner
			createSubagentActivity(
				config,
				entry,
				"foreground",
				() => runner.abort(),
				batchId,
				continueBatchInBackground,
				() => runner.requestFinish("user"),
				undefined,
				entries.flatMap((candidate) => (candidate.jobId ? [candidate.jobId] : [])),
			)
		})
		await config.callbacks.say(
			"subagent",
			JSON.stringify(
				buildStatusPayload("batch", "running", entries, {
					background: false,
					timeoutSeconds: request.options.timeoutSeconds,
					batchJobId: batchId,
				}),
			),
			undefined,
			undefined,
			false,
			block.ts,
		)
		const runResultsPromise = budget.awaitChildren(() =>
			Promise.all(
				planned.map((item) => {
					const entry = entriesByJobId.get(item.jobId) as SubagentStatusItem
					return runBudgetedSubagent(budget, config.ulid, runnersByJobId.get(item.jobId) as SubagentRunner, {
						prompt: item.prompt,
						timeoutSeconds: item.timeoutSeconds,
						onProgress: (update: SubagentProgressUpdate) => applyProgress(config, entry, update),
						// Only a started item is running; until a slot is
						// free it stays queued rather than claiming work.
						onStarted: () => {
							entry.status = "running"
							entry.startedAt = Date.now()
							updateActivityFromEntry(config, entry)
						},
					})
				}),
			),
		)
		let results: SubagentExecResult[] = []
		let handedOff = false
		try {
			const outcome = await Promise.race([
				runResultsPromise.then((completedResults) => ({ kind: "completed" as const, results: completedResults })),
				handoffPromise.then(() => ({ kind: "background" as const })),
			])
			if (outcome.kind === "background") handedOff = true
			else results = outcome.results
		} finally {
			config.taskState.isExecutingSubagent = false
		}
		const finalizeBatchResults = async (completedResults: SubagentExecResult[], background: boolean): Promise<void> => {
			completedResults.forEach((result: SubagentExecResult, position) => {
				const item = planned[position]
				const entry = entriesByJobId.get(item.jobId) as SubagentStatusItem
				const foregroundRunner = runnersByJobId.get(item.jobId) as SubagentRunner
				entry.status = result.status
				entry.result = result.result
				entry.error = result.error
				entry.background = background
				entry.backgroundHandoffAvailable = false
				entry.finishedAt = Date.now()
				applyStats(entry, result.stats)
				updateActivityFromEntry(config, entry)
				if (!result.retryable || !entry.jobId) return
				const retainedManager = getSubagentJobManager(config)
				retainedManager.retainRetryableJob({
					jobId: entry.jobId,
					// The retained recipe keeps this item's own resolution, so a
					// retry after reopen replays against the agent and Profile that
					// were chosen, not against whatever the batch defaulted to.
					subagentName: item.subagentName,
					task: item.task,
					prompt: item.prompt,
					timeoutSeconds: item.timeoutSeconds,
					startedAt: entry.startedAt ?? Date.now(),
					result,
					runner: () =>
						runBudgetedSubagent(budget, config.ulid, foregroundRunner, {
							prompt: item.prompt,
							timeoutSeconds: item.timeoutSeconds,
							onProgress: (update: SubagentProgressUpdate) => applyProgress(config, entry, update),
						}),
					onStatusChange: async (jobRecord) => {
						entry.status = jobRecord.status
						entry.result = jobRecord.result
						entry.error = jobRecord.error
						entry.background = true
						if (jobRecord.stats) applyStats(entry, jobRecord.stats)
						entry.finishedAt = jobRecord.finishedAt
						updateActivityFromEntry(config, entry)
						config.activityStore?.setRetry?.(
							jobRecord.jobId,
							jobRecord.retryable
								? async () => {
										config.activityStore?.setCancel(jobRecord.jobId, () => foregroundRunner.abort())
										config.activityStore?.setFinish(jobRecord.jobId, () =>
											foregroundRunner.requestFinish("user"),
										)
										return retainedManager.retryJob(jobRecord.jobId)
									}
								: undefined,
						)
						await config.callbacks.say(
							"subagent",
							JSON.stringify(
								buildStatusPayload("batch", jobRecord.status, entries, {
									background: true,
									timeoutSeconds: request.options.timeoutSeconds,
									batchJobId: batchId,
								}),
							),
							undefined,
							undefined,
							false,
							block.ts,
						)
					},
				})
				config.activityStore?.setRetry?.(entry.jobId, async () => {
					entry.background = true
					config.activityStore?.update(entry.jobId as string, {
						executionMode: "background",
						cancellationOwner: "explicit",
					})
					config.activityStore?.setCancel(entry.jobId as string, () => foregroundRunner.abort())
					config.activityStore?.setFinish(entry.jobId as string, () => foregroundRunner.requestFinish("user"))
					return retainedManager.retryJob(entry.jobId as string)
				})
			})
			const finalStatus: ClineSaySubagentStatus["status"] = entries.some((entry) => entry.status === "timeout")
				? "timeout"
				: entries.some((entry) => entry.status === "failed")
					? "failed"
					: entries.some((entry) => entry.status === "cancelled")
						? "cancelled"
						: "completed"
			await config.callbacks.say(
				"subagent",
				JSON.stringify(
					buildStatusPayload("batch", finalStatus, entries, {
						background,
						timeoutSeconds: request.options.timeoutSeconds,
					}),
				),
				undefined,
				undefined,
				false,
				block.ts,
			)
			await emitUsage(config, entries)
		}
		if (handedOff) {
			void runResultsPromise
				.then((completedResults) => finalizeBatchResults(completedResults, true))
				.catch((error) => Logger.error("[SubagentToolHandler] background batch finalization failed", error))
			const continuedNotice = backgroundSubagentResult("continued", "batch job", batchId)
			return formatResponse.toolResult(
				rejected.length === 0 ? continuedNotice : `${continuedNotice}\n\n${formatRejectedItems(rejected, false)}`,
			)
		}
		await finalizeBatchResults(results, false)
		const modelSummaryEntries = entries.map((entry, index) => {
			const result = results[index]
			if (!result?.retryable) return entry
			return {
				...entry,
				error: `${describePausedReason(result)}. The activity is preserved; the user can restart it with the Retry control. Do not treat this failure as a completed result.`,
			}
		})
		const retryableCount = results.filter((result) => result?.retryable).length
		// Rejected items are reported with the results. Omitting them would let
		// the model read the summary as covering everything it asked for.
		const sections = [formatSummary(modelSummaryEntries)]
		if (rejected.length > 0) sections.push(formatRejectedItems(rejected, false))
		if (retryableCount > 0) {
			sections.push(
				getPrompt("toolHandlers", "subagentBatchRetryablePaused")
					.replace("@COUNT@", String(retryableCount))
					.replace("@TOTAL@", String(entries.length)),
			)
		}
		return formatResponse.toolResult(sections.join("\n\n"))
	}
}
