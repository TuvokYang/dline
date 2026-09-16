import { resolveProvider } from "@core/api"
import type { ToolUse } from "@core/assistant-message"
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
import { ClineDefaultTool } from "@/shared/tools"
import type { ToolResponse } from "../../index"
import { showNotificationForApproval } from "../../utils"
import { listEnabledAgentConfigs, type ResolveAgentConfigOptions, resolveAgentConfig } from "../subagent/AgentConfigLoader"
import { DEFAULT_SUBAGENT_NAME, isDefaultSubagentName } from "../subagent/DefaultSubagentConfig"
import {
	runSubagent,
	type SubagentExecResult,
	type SubagentProgressUpdate,
	type SubagentRunStats,
} from "../subagent/SubagentExecutor"
import { SubagentJobManager } from "../subagent/SubagentJobManager"
import { parseUseSubagentRequest, parseUseSubagentsRequest } from "../subagent/SubagentRequestParser"
import { SubagentRunner } from "../subagent/SubagentRunner"
import type { IFullyManagedTool } from "../ToolExecutorCoordinator"
import type { TaskConfig } from "../types/TaskConfig"
import type { StronglyTypedUIHelpers } from "../types/UIHelpers"
import { ToolResultUtils } from "../utils/ToolResultUtils"

const PROMPT_KEYS = ["prompt_1", "prompt_2", "prompt_3", "prompt_4", "prompt_5"] as const
const LATER_REQUEST_RESULT_NOTICE = "Its final result will be available only in a later model request."

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
	const runner = new SubagentRunner(config, effectiveSubagentName, resolvedSubagent?.config, {
		inheritTaskAbort: false,
	})
	const entry: SubagentStatusItem = {
		index: 1,
		jobId: activityId,
		subagentName: effectiveSubagentName,
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
		runner: () =>
			runSubagent({
				runner,
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
	continueInBackground?: () => Promise<boolean>,
	finish?: () => Promise<boolean>,
	retry?: () => Promise<boolean>,
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
			task: entry.task || entry.prompt,
			prompt: entry.prompt,
			timeoutSeconds: entry.timeoutSeconds || 0,
			retryable: Boolean(retry),
		},
		cancel,
		continueInBackground,
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

/**
 * Ask for approval unless auto-approval is enabled.
 * @param config Current task config.
 * @param block Tool use block.
 * @param toolName Tool name being approved.
 * @param askType Ask message type.
 * @param approvalBody Approval payload.
 * @param label Notification label.
 * @returns True when execution is approved.
 */
async function approveSubagentUse(
	config: TaskConfig,
	block: ToolUse,
	toolName: ClineDefaultTool,
	askType: "use_subagents",
	approvalBody: string,
	label: string,
): Promise<boolean> {
	const apiConfig = config.services.stateManager.getApiConfiguration()
	const currentMode = config.services.stateManager.getGlobalSettingsKey("mode")
	const provider = resolveProvider(apiConfig, currentMode)
	const autoApproveResult = config.autoApprover?.shouldAutoApproveTool(toolName)
	const [autoApproveSafe] = Array.isArray(autoApproveResult) ? autoApproveResult : [autoApproveResult, false]
	if (autoApproveSafe) {
		captureToolTelemetry(config, toolName, provider, true, true, block.isNativeToolCall)
		return true
	}
	showNotificationForApproval(label, config.autoApprovalSettings.enableNotifications)
	const didApprove = await ToolResultUtils.askApprovalAndPushFeedback(askType, approvalBody, config, block.ts)
	captureToolTelemetry(config, toolName, provider, false, didApprove, block.isNativeToolCall)
	return didApprove
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

export class UseSubagentToolHandler implements IFullyManagedTool {
	readonly name = ClineDefaultTool.USE_SUBAGENT

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
		const autoApproveResult = uiHelpers.shouldAutoApproveTool(this.name)
		const [shouldAutoApprove] = Array.isArray(autoApproveResult) ? autoApproveResult : [autoApproveResult, false]
		if (shouldAutoApprove) {
			await uiHelpers.say("use_subagents", JSON.stringify(payload), undefined, undefined, true, block.ts)
			return
		}
		uiHelpers.ask("use_subagents", JSON.stringify(payload), true, { existingTs: block.ts }).catch(() => undefined)
	}

	/**
	 * Execute stable single subagent requests.
	 * @param config Current task config.
	 * @param block Tool block.
	 * @returns Tool response for the model.
	 */
	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		if (!(config.subagentsEnabled ?? config.services.stateManager.getGlobalSettingsKey("subagentsEnabled"))) {
			return formatResponse.toolError(getPrompt("toolHandlers", "subagentsDisabled"))
		}
		let request: ReturnType<typeof parseUseSubagentRequest>
		try {
			request = parseUseSubagentRequest(block.params)
		} catch (error) {
			config.taskState.consecutiveMistakeCount++
			return formatResponse.toolError(error instanceof Error ? error.message : String(error))
		}
		const usesDefault = isDefaultSubagentName(request.agentName)
		const resolvedSubagent = await resolveAgentConfig(config.cwd, request.agentName, getResolveOptions(config))
		if (!usesDefault && !resolvedSubagent) {
			const available = await getAvailableSubagentNames(config)
			return formatResponse.toolError(
				`Unknown or disabled subagent '${request.agentName}'. Available subagents: ${available.join(", ")}.`,
			)
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
		const approved = await approveSubagentUse(
			config,
			block,
			this.name,
			"use_subagents",
			approvalBody,
			`Dline wants to use the '${effectiveSubagentName}' subagent`,
		)
		if (!approved) return formatResponse.toolDenied()

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
					runSubagent({
						runner,
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
					const result = await runSubagent({
						runner: foregroundRunner,
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

export class UseSubagentsToolHandler implements IFullyManagedTool {
	readonly name = ClineDefaultTool.USE_SUBAGENTS

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
		const prompts = PROMPT_KEYS.map((key) => uiHelpers.removeClosingTag(block, key, readParam(block.params[key])))
			.map((prompt) => prompt?.trim())
			.filter((prompt): prompt is string => !!prompt)
		if (prompts.length === 0) return
		const partialMessage = JSON.stringify({ kind: "batch", prompts } satisfies ClineAskUseSubagents)
		const autoApproveResult = uiHelpers.shouldAutoApproveTool(this.name)
		const [shouldAutoApprove] = Array.isArray(autoApproveResult) ? autoApproveResult : [autoApproveResult, false]
		if (shouldAutoApprove) {
			await uiHelpers.say("use_subagents", partialMessage, undefined, undefined, true, block.ts)
			return
		}
		uiHelpers.ask("use_subagents", partialMessage, true, { existingTs: block.ts }).catch(() => undefined)
	}

	/**
	 * Execute stable batch subagent requests.
	 * @param config Current task config.
	 * @param block Tool block.
	 * @returns Tool response for the model.
	 */
	async execute(config: TaskConfig, block: ToolUse): Promise<ToolResponse> {
		if (!(config.subagentsEnabled ?? config.services.stateManager.getGlobalSettingsKey("subagentsEnabled"))) {
			await config.callbacks.say(
				"use_subagents",
				JSON.stringify({
					prompts: [],
					error: "subagentsDisabled",
					message: getPrompt("toolHandlers", "subagentsDisabled"),
				}),
				undefined,
				undefined,
				false,
				block.ts,
			)
			return formatResponse.toolError(getPrompt("toolHandlers", "subagentsDisabled"))
		}
		let request: ReturnType<typeof parseUseSubagentsRequest>
		try {
			request = parseUseSubagentsRequest(block.params)
		} catch (error) {
			config.taskState.consecutiveMistakeCount++
			return formatResponse.toolError(error instanceof Error ? error.message : String(error))
		}
		const resolvedDefaultSubagent = await resolveAgentConfig(config.cwd, DEFAULT_SUBAGENT_NAME, getResolveOptions(config))
		const effectiveSubagentName = resolvedDefaultSubagent?.config.name ?? DEFAULT_SUBAGENT_NAME
		const prompts = request.items.map((item) => item.prompt)
		const approvalBody = JSON.stringify({
			kind: "batch",
			prompts,
			items: request.items.map((item) => ({
				task: item.task,
				context: item.context,
				subagentName: effectiveSubagentName,
			})),
			background: request.options.background,
			timeoutSeconds: request.options.timeoutSeconds,
		} satisfies ClineAskUseSubagents)
		const approved = await approveSubagentUse(
			config,
			block,
			this.name,
			"use_subagents",
			approvalBody,
			request.items.length === 1 ? "Dline wants to use a subagent" : `Dline wants to use ${request.items.length} subagents`,
		)
		if (!approved) return formatResponse.toolDenied()
		config.taskState.consecutiveMistakeCount = 0
		const entries: SubagentStatusItem[] = request.items.map((item) => ({
			index: item.index,
			prompt: item.prompt,
			subagentName: effectiveSubagentName,
			task: item.task,
			context: item.context,
			background: request.options.background,
			backgroundHandoffAvailable: false,
			timeoutSeconds: request.options.timeoutSeconds,
			injectionState: "pending",
			status: "running",
			...emptyStats(),
		}))
		if (request.options.background) {
			const runners = request.items.map(
				() => new SubagentRunner(config, effectiveSubagentName, resolvedDefaultSubagent?.config),
			)
			const batch = getSubagentJobManager(config).startBatch({
				timeoutSeconds: request.options.timeoutSeconds,
				items: request.items.map((item, index) => ({
					subagentName: effectiveSubagentName,
					task: item.task,
					prompt: item.prompt,
					runner: () =>
						runSubagent({
							runner: runners[index],
							prompt: item.prompt,
							timeoutSeconds: request.options.timeoutSeconds,
							onProgress: (update) => applyProgress(config, entries[index], update),
						}),
				})),
				onCreated: (batchRecord) => {
					entries.forEach((entry, index) => {
						entry.jobId = batchRecord.itemJobIds[index]
						entry.startedAt = batchRecord.startedAt
						createSubagentActivity(
							config,
							entry,
							"background",
							() => runners[index].abort(),
							batchRecord.batchJobId,
							undefined,
							() => runners[index].requestFinish("user"),
						)
					})
				},
				onStatusChange: async (jobRecord, batchRecord) => {
					const entry = entries.find((candidate) => candidate.jobId === jobRecord.jobId)
					if (entry) {
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
										config.activityStore?.setCancel(jobRecord.jobId, () => runners[entry.index - 1].abort())
										config.activityStore?.setFinish(jobRecord.jobId, () =>
											runners[entry.index - 1].requestFinish("user"),
										)
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
			return formatResponse.toolResult(backgroundSubagentResult("started", "batch job", batch.batchJobId))
		}
		config.taskState.isExecutingSubagent = true
		const foregroundRunners = request.items.map(
			() => new SubagentRunner(config, effectiveSubagentName, resolvedDefaultSubagent?.config),
		)
		const foregroundBatchId = `subagent_batch_fg_${block.function_id || block.ts}`
		entries.forEach((entry, index) => {
			entry.jobId = `${foregroundBatchId}_${index + 1}`
			entry.startedAt = Date.now()
			createSubagentActivity(
				config,
				entry,
				"foreground",
				() => foregroundRunners[index].abort(),
				foregroundBatchId,
				undefined,
				() => foregroundRunners[index].requestFinish("user"),
			)
		})
		await config.callbacks.say(
			"subagent",
			JSON.stringify(
				buildStatusPayload("batch", "running", entries, {
					background: false,
					timeoutSeconds: request.options.timeoutSeconds,
				}),
			),
			undefined,
			undefined,
			false,
			block.ts,
		)
		let results: SubagentExecResult[]
		try {
			results = await Promise.all(
				request.items.map((item, index) =>
					runSubagent({
						runner: foregroundRunners[index],
						prompt: item.prompt,
						timeoutSeconds: request.options.timeoutSeconds,
						onProgress: (update: SubagentProgressUpdate) => applyProgress(config, entries[index], update),
					}),
				),
			)
		} finally {
			config.taskState.isExecutingSubagent = false
		}
		results.forEach((result: SubagentExecResult, index) => {
			const entry = entries[index]
			entry.status = result.status
			entry.result = result.result
			entry.error = result.error
			entry.finishedAt = Date.now()
			applyStats(entry, result.stats)
			updateActivityFromEntry(config, entry)
			if (!result.retryable || !entry.jobId) return
			const retainedManager = getSubagentJobManager(config)
			retainedManager.retainRetryableJob({
				jobId: entry.jobId,
				subagentName: effectiveSubagentName,
				task: request.items[index].task,
				prompt: request.items[index].prompt,
				timeoutSeconds: request.options.timeoutSeconds,
				startedAt: entry.startedAt ?? Date.now(),
				result,
				runner: () =>
					runSubagent({
						runner: foregroundRunners[index],
						prompt: request.items[index].prompt,
						timeoutSeconds: request.options.timeoutSeconds,
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
									config.activityStore?.setCancel(jobRecord.jobId, () => foregroundRunners[index].abort())
									config.activityStore?.setFinish(jobRecord.jobId, () =>
										foregroundRunners[index].requestFinish("user"),
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
								batchJobId: foregroundBatchId,
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
				config.activityStore?.setCancel(entry.jobId as string, () => foregroundRunners[index].abort())
				config.activityStore?.setFinish(entry.jobId as string, () => foregroundRunners[index].requestFinish("user"))
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
					background: false,
					timeoutSeconds: request.options.timeoutSeconds,
				}),
			),
			undefined,
			undefined,
			false,
			block.ts,
		)
		await emitUsage(config, entries)
		const modelSummaryEntries = entries.map((entry, index) => {
			const result = results[index]
			if (!result?.retryable) return entry
			return {
				...entry,
				error: `${describePausedReason(result)}. The activity is preserved; the user can restart it with the Retry control. Do not treat this failure as a completed result.`,
			}
		})
		const retryableCount = results.filter((result) => result?.retryable).length
		const summary = formatSummary(modelSummaryEntries)
		if (retryableCount === 0) return formatResponse.toolResult(summary)
		const retryNotice = getPrompt("toolHandlers", "subagentBatchRetryablePaused")
			.replace("@COUNT@", String(retryableCount))
			.replace("@TOTAL@", String(entries.length))
		return formatResponse.toolResult(`${summary}\n\n${retryNotice}`)
	}
}
