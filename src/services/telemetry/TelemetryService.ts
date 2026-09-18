import { HostProvider } from "@hosts/host-provider"
import type { BrowserSettings } from "@shared/BrowserSettings"
import { ApiFormat } from "@shared/proto/dline/models/metadata"
import type { TaskFeedbackType } from "@shared/WebviewMessage"
import * as os from "os"
import { ClineAccountUserInfo } from "@/services/auth/AuthService"
import { Setting } from "@/shared/proto/dline/host"
import { Logger } from "@/shared/services/Logger"
import { Mode } from "@/shared/storage/types"
import { version as extensionVersion } from "../../../package.json"
import { TelemetryContext, type TelemetryMetadata } from "./context/telemetry-context"
import { telemetryDevelopmentModeMetadata } from "./development-mode"
import { TELEMETRY_EVENTS, TELEMETRY_METRICS, type TelemetryCategory } from "./events/catalog"
import { HookEventRecorder, type HookExecutionMetadata, type HookExecutionStatus } from "./events/hook-recorder"
import { TaskAggregates } from "./events/task-aggregates"
import { TaskEventRecorder, type TokenUsage } from "./events/task-recorder"
import {
	type AiOutputArgs,
	type ExecutionPool,
	type StandaloneOutputMethod,
	TerminalHangStage,
	TerminalOutputFailureReason,
	type TerminalOutputMethod,
	type TerminalType,
	TerminalUserInterventionAction,
	ToolEventRecorder,
	type VscodeOutputMethod,
} from "./events/tool-recorder"
import { UiEventRecorder } from "./events/ui-recorder"
import { UserEventRecorder } from "./events/user-recorder"
import { WorkspaceEventRecorder } from "./events/workspace-recorder"
import type {
	TelemetryChannel,
	TelemetryProviderInput,
	TelemetrySeverity,
	TelemetrySpanHandle,
	TelemetrySpanStartOptions,
} from "./providers/capabilities"
import type { ITelemetryProvider, TelemetryProperties } from "./providers/ITelemetryProvider"
import { TelemetryCategoryPolicy } from "./service/category-policy"
import { TelemetryChannelPolicy } from "./service/channel-policy"
import { TelemetryProviderRegistry } from "./service/provider-registry"
import { TelemetrySignalDispatcher } from "./service/signal-dispatcher"
import { TelemetryProviderFactory } from "./TelemetryProviderFactory"

export type { TelemetryMetadata } from "./context/telemetry-context"
export type { TelemetryCategory } from "./events/catalog"
export type { TokenUsage } from "./events/task-recorder"
export {
	type ExecutionPool,
	type StandaloneOutputMethod,
	TerminalHangStage,
	TerminalOutputFailureReason,
	type TerminalOutputMethod,
	type TerminalType,
	TerminalUserInterventionAction,
	type VscodeOutputMethod,
} from "./events/tool-recorder"

/**
 * The product's single telemetry entry point.
 *
 * This class is deliberately thin. It owns the public call contract — the
 * `capture*` names the rest of the extension depends on — and nothing else:
 * event shapes live in domain recorders, identity in the context, fan-out in
 * the provider registry. Keeping it a delegating surface is what stops it
 * regrowing into the 2,400-line class it replaced, where every new feature
 * added another method and another private field to the same object.
 *
 * Construction is synchronous. The host version arrives from an async bridge
 * call, and making the constructor wait for it meant the first events of a
 * session — the activation path, precisely where failures cluster — either
 * blocked startup or were lost. Instead the service is usable immediately with
 * placeholder host fields, and `attachHostMetadata` fills them in when the
 * bridge answers.
 */
export class TelemetryService {
	/** Metric names, kept as a static so existing call sites and tests resolve. */
	public static readonly METRICS = TELEMETRY_METRICS

	private readonly context: TelemetryContext
	private readonly registry: TelemetryProviderRegistry
	private readonly categories: TelemetryCategoryPolicy
	private readonly dispatcher: TelemetrySignalDispatcher

	private readonly aggregates: TaskAggregates
	private readonly user: UserEventRecorder
	private readonly task: TaskEventRecorder
	private readonly tool: ToolEventRecorder
	private readonly workspace: WorkspaceEventRecorder
	private readonly hooks: HookEventRecorder
	private readonly ui: UiEventRecorder

	/**
	 * Build a service with the host's real metadata and configured providers.
	 *
	 * Retained for callers that can await; the constructor stays synchronous so
	 * that early instrumentation does not have to.
	 */
	public static async create(): Promise<TelemetryService> {
		const service = new TelemetryService([], TelemetryService.initialMetadata(), { deferProviders: true })
		await service.attachProviders()
		return service
	}

	/**
	 * Metadata available before the host bridge has answered.
	 *
	 * The version and OS are known from the process itself; only the host
	 * identity has to be asked for, so those are the only unknown fields.
	 */
	public static initialMetadata(): TelemetryMetadata {
		return {
			extension_version: extensionVersion,
			platform: "unknown",
			platform_version: "unknown",
			dline_type: "unknown",
			os_type: os.platform(),
			os_version: os.version(),
			is_remote_workspace: false,
			is_dev: telemetryDevelopmentModeMetadata(),
		}
	}

	/**
	 * @param providers Array of telemetry providers for dual/multi tracking
	 * @param telemetryMetadata Host identity attached to every signal
	 * @param options `deferProviders` holds signals until `attachProviders`
	 *   resolves, so that events recorded during activation are delivered once
	 *   providers exist rather than being dropped into an empty registry.
	 */
	constructor(
		providers: TelemetryProviderInput[],
		telemetryMetadata: TelemetryMetadata,
		options: { readonly deferProviders?: boolean; readonly channelPolicy?: TelemetryChannelPolicy } = {},
	) {
		this.context = new TelemetryContext(telemetryMetadata)
		const channelPolicy =
			options.channelPolicy ??
			(options.deferProviders ? TelemetryChannelPolicy.fromStateManager() : TelemetryChannelPolicy.allowAll())
		this.registry = new TelemetryProviderRegistry(providers, {
			ready: !options.deferProviders,
			policy: channelPolicy,
		})
		this.categories = new TelemetryCategoryPolicy()
		this.dispatcher = new TelemetrySignalDispatcher(this.context, this.registry, this.categories)

		this.aggregates = new TaskAggregates()
		this.user = new UserEventRecorder(this.dispatcher)
		this.task = new TaskEventRecorder(this.dispatcher, this.aggregates)
		this.tool = new ToolEventRecorder(this.dispatcher, this.aggregates)
		this.workspace = new WorkspaceEventRecorder(this.dispatcher)
		this.hooks = new HookEventRecorder(this.dispatcher)
		this.ui = new UiEventRecorder(this.dispatcher)

		this.user.captureTelemetryEnabled()
		Logger.info(`[TelemetryService] Initialized with ${providers.length} telemetry provider(s)`)
	}

	/**
	 * Build the configured providers and resolve host identity.
	 *
	 * Both need `await` while the service must be usable from the first
	 * synchronous line of activation, so they happen here rather than in the
	 * constructor. Host metadata is resolved *before* providers are marked
	 * ready: the held signals are replayed at that moment, and replaying them
	 * with placeholder host fields would record activation as coming from an
	 * unknown platform.
	 *
	 * Calling this more than once is harmless; the registry ignores a second
	 * ready transition.
	 */
	public async attachProviders(): Promise<void> {
		const [providers] = await Promise.all([TelemetryProviderFactory.createProviders(), this.attachHostMetadata()])
		for (const provider of providers) {
			this.registry.add(provider)
		}
		this.registry.markReady()
	}

	/**
	 * Replace placeholder host fields once the host bridge answers.
	 *
	 * Failure is swallowed: telemetry that cannot name its host is still worth
	 * more than an extension that fails to activate because a metadata call
	 * timed out.
	 */
	public async attachHostMetadata(): Promise<void> {
		try {
			const hostVersion = await HostProvider.env.getHostVersion({})
			this.context.setMetadata({
				extension_version: extensionVersion,
				platform: hostVersion.platform || "unknown",
				platform_version: hostVersion.version || "unknown",
				dline_type: hostVersion.clineType || "unknown",
				os_type: os.platform(),
				os_version: os.version(),
				// `remoteName` is normalized by the host bridge to `undefined` for local workspaces.
				is_remote_workspace: !!hostVersion.remoteName,
				is_dev: telemetryDevelopmentModeMetadata(),
			})
		} catch (error) {
			Logger.error("[TelemetryService] Failed to resolve host metadata:", error)
		}
	}

	/**
	 * Release signals held for providers that will never arrive.
	 *
	 * Called when attachment fails: without it the held signals would sit
	 * against a buffer bound that nothing is going to relieve, and every
	 * subsequent signal would be counted as dropped.
	 */
	public releasePendingSignals(): void {
		this.registry.markReady()
	}

	public addProvider(provider: TelemetryProviderInput): void {
		this.registry.add(provider)
	}

	public removeProvider(name: string): Promise<void> {
		return this.registry.remove(name)
	}

	public startSpan(options: TelemetrySpanStartOptions, channel: TelemetryChannel = "runtime"): TelemetrySpanHandle {
		return this.registry.startSpan(options, channel)
	}

	public recordHistogram(
		name: string,
		value: number,
		attributes?: TelemetryProperties,
		description?: string,
		channel: TelemetryChannel = "runtime",
	): void {
		this.registry.recordHistogram(name, value, () => attributes ?? {}, description, false, channel, "info")
	}

	public recordGauge(
		name: string,
		value: number | null,
		attributes?: TelemetryProperties,
		description?: string,
		channel: TelemetryChannel = "runtime",
	): void {
		this.registry.recordGauge(name, value, () => attributes ?? {}, description, false, channel, "info")
	}

	/**
	 * Reports whether the host permits telemetry at all.
	 *
	 * The host's own telemetry level overrides the user's Cline setting, so an
	 * opted-in user on a host with telemetry disabled needs to be told why
	 * nothing is being reported. The prompt itself belongs to the Controller —
	 * this service must not reach into host UI — so the answer is returned
	 * rather than acted on.
	 *
	 * @returns `true` when the host has telemetry switched off.
	 */
	public async isHostTelemetryDisabled(): Promise<boolean> {
		const hostSetting = await HostProvider.env.getTelemetrySettings({})
		return hostSetting.isEnabled === Setting.DISABLED
	}

	/**
	 * Captures a telemetry event if telemetry is enabled
	 * @param event The event to capture with its properties
	 */
	public capture(event: { event: string; properties?: TelemetryProperties }): void {
		this.dispatcher.captureEvent(event.event, event.properties)
	}

	/** Route one content-safe runtime event through the error-consent channel. */
	public captureRuntimeEvent(event: string, properties: TelemetryProperties, severity: TelemetrySeverity): void {
		this.registry.logEvent(event, () => this.context.eventProperties(properties), false, "runtime", severity)
	}

	/**
	 * Captures a required telemetry event that bypasses user opt-out settings
	 * @param event The event name to capture
	 * @param properties Optional properties to attach to the event
	 */
	public captureRequired(event: string, properties?: TelemetryProperties): void {
		this.dispatcher.captureRequiredEvent(event, properties)
	}

	// User and account events

	public captureUserOptOut(): void {
		this.user.captureUserOptOut()
	}

	public captureUserOptIn(): void {
		this.user.captureUserOptIn()
	}

	public captureExtensionActivated() {
		this.user.captureExtensionActivated()
	}

	public captureExtensionStorageError(errorMessage: string, eventName: string) {
		this.user.captureExtensionStorageError(errorMessage, eventName)
	}

	public captureAuthStarted(provider?: string) {
		this.user.captureAuthStarted(provider)
	}

	public captureAuthSucceeded(provider?: string) {
		this.user.captureAuthSucceeded(provider)
	}

	public captureAuthFailed(provider?: string) {
		this.user.captureAuthFailed(provider)
	}

	public captureAuthLoggedOut(provider?: string, reason?: string) {
		this.user.captureAuthLoggedOut(provider, reason)
	}

	public identifyAccount(userInfo: ClineAccountUserInfo) {
		this.user.identifyAccount(userInfo)
	}

	public captureOnboardingProgress(args: { step: number; action?: string; model?: string; completed?: boolean }) {
		this.user.captureOnboardingProgress(args)
	}

	public captureHostEvent(name: string, content: string) {
		this.user.captureHostEvent(name, content)
	}

	// Task events

	public captureTaskCreated(ulid: string, apiProvider?: string, openAiCompatibleDomain?: string) {
		this.task.captureTaskCreated(ulid, apiProvider, openAiCompatibleDomain)
	}

	public captureTaskRestarted(ulid: string, apiProvider?: string, openAiCompatibleDomain?: string) {
		this.task.captureTaskRestarted(ulid, apiProvider, openAiCompatibleDomain)
	}

	public captureTaskCompleted(
		ulid: string,
		args?: {
			provider?: string
			modelId?: string
			apiFormat?: ApiFormat
			timeToFirstTokenMs?: number
			durationMs?: number
			mode: Mode
		},
	) {
		this.task.captureTaskCompleted(ulid, args)
	}

	public captureConversationTurnEvent(
		ulid: string,
		provider = "unknown",
		model = "unknown",
		source: "user" | "assistant",
		mode: Mode,
		tokenUsage: TokenUsage = {},
		isNativeToolCall?: boolean,
	) {
		this.task.captureConversationTurnEvent(ulid, provider, model, source, mode, tokenUsage, isNativeToolCall)
	}

	public captureTokenUsage(
		ulid: string,
		tokensIn: number,
		tokensOut: number,
		provider: string,
		model: string,
		options?: TokenUsage,
	) {
		this.task.captureTokenUsage(ulid, tokensIn, tokensOut, provider, model, options)
	}

	public captureModeSwitch(ulid: string, mode: Mode) {
		this.task.captureModeSwitch(ulid, mode)
	}

	public captureSummarizeTask(
		ulid: string,
		modelId: string,
		provider: string,
		currentTokens: number,
		maxContextWindow: number,
	) {
		this.task.captureSummarizeTask(ulid, modelId, provider, currentTokens, maxContextWindow)
	}

	public captureTaskFeedback(ulid: string, feedbackType: TaskFeedbackType) {
		this.task.captureTaskFeedback(ulid, feedbackType)
	}

	public captureTaskInitialization(ulid: string, taskId: string, durationMs: number, hasCheckpoints: boolean) {
		this.task.captureTaskInitialization(ulid, taskId, durationMs, hasCheckpoints)
	}

	public captureOptionSelected(ulid: string, qty: number, mode: Mode) {
		this.task.captureOptionSelected(ulid, qty, mode)
	}

	public captureOptionsIgnored(ulid: string, qty: number, mode: Mode) {
		this.task.captureOptionsIgnored(ulid, qty, mode)
	}

	public captureGeminiApiPerformance(
		ulid: string,
		modelId: string,
		data: {
			ttftSec?: number
			totalDurationSec?: number
			promptTokens: number
			outputTokens: number
			cacheReadTokens: number
			cacheHit: boolean
			cacheHitPercentage?: number
			apiSuccess: boolean
			apiError?: string
			throughputTokensPerSec?: number
		},
	) {
		this.task.captureGeminiApiPerformance(ulid, modelId, data)
	}

	public captureProviderApiError(args: {
		ulid: string
		model: string
		errorMessage: string
		provider?: string
		errorStatus?: number | undefined
		requestId?: string | undefined
		isNativeToolCall?: boolean
	}) {
		this.task.captureProviderApiError(args)
	}

	public captureDiffEditFailure(ulid: string, modelId: string, provider: string, errorType?: string, isNativeToolCall = false) {
		this.task.captureDiffEditFailure(ulid, modelId, provider, errorType, isNativeToolCall)
	}

	public captureSlashCommandUsed(
		ulid: string,
		commandName: string,
		commandType: "builtin" | "workflow" | "mcp_prompt" | "skill",
	) {
		this.task.captureSlashCommandUsed(ulid, commandName, commandType)
	}

	public captureFeatureToggle(ulid: string, featureName: string, enabled: boolean, modelId: string) {
		this.task.captureFeatureToggle(ulid, featureName, enabled, modelId)
	}

	public captureClineRuleToggled(ulid: string, ruleFileName: string, enabled: boolean, isGlobal: boolean) {
		this.task.captureClineRuleToggled(ulid, ruleFileName, enabled, isGlobal)
	}

	public captureAutoCondenseToggle(ulid: string, enabled: boolean, modelId: string) {
		this.task.captureAutoCondenseToggle(ulid, enabled, modelId)
	}

	public captureYoloModeToggle(ulid: string, enabled: boolean) {
		this.task.captureYoloModeToggle(ulid, enabled)
	}

	public captureClineWebToolsToggle(ulid: string, enabled: boolean) {
		this.task.captureClineWebToolsToggle(ulid, enabled)
	}

	// Tool, terminal, browser and mention events

	public captureToolUsage(
		ulid: string,
		tool: string,
		modelId: string,
		provider: string,
		autoApproved: boolean,
		success: boolean,
		workspaceContext?: {
			isMultiRootEnabled: boolean
			usedWorkspaceHint: boolean
			resolvedToNonPrimary: boolean
			resolutionMethod: "hint" | "primary_fallback" | "path_detection"
		},
		isNativeToolCall = false,
	) {
		this.tool.captureToolUsage(ulid, tool, modelId, provider, autoApproved, success, workspaceContext, isNativeToolCall)
	}

	public captureSkillUsed(args: {
		ulid: string
		skillName: string
		skillSource: "global" | "project"
		skillsAvailableGlobal: number
		skillsAvailableProject: number
		provider?: string
		modelId?: string
	}): void {
		this.tool.captureSkillUsed(args)
	}

	public captureMcpToolCall(
		ulid: string,
		serverName: string,
		toolName: string,
		status: "started" | "success" | "error",
		errorMessage?: string,
		argumentKeys?: string[],
		isNativeToolCall = false,
	) {
		this.tool.captureMcpToolCall(ulid, serverName, toolName, status, errorMessage, argumentKeys, isNativeToolCall)
	}

	public captureCheckpointUsage(
		ulid: string,
		action: "shadow_git_initialized" | "commit_created" | "restored" | "diff_generated",
		durationMs?: number,
	) {
		this.tool.captureCheckpointUsage(ulid, action, durationMs)
	}

	public captureBrowserToolStart(ulid: string, browserSettings: BrowserSettings) {
		this.tool.captureBrowserToolStart(ulid, browserSettings)
	}

	public captureBrowserToolEnd(
		ulid: string,
		stats: {
			actionCount: number
			duration: number
			actions?: string[]
		},
	) {
		this.tool.captureBrowserToolEnd(ulid, stats)
	}

	public captureBrowserError(
		ulid: string,
		errorType: string,
		errorMessage: string,
		context?: {
			action?: string
			url?: string
			isRemote?: boolean
			remoteBrowserHost?: string
			endpoint?: string
		},
	) {
		this.tool.captureBrowserError(ulid, errorType, errorMessage, context)
	}

	public captureTerminalExecution(success: boolean, terminalType: "vscode", method: VscodeOutputMethod): void
	public captureTerminalExecution(
		success: boolean,
		terminalType: "standalone",
		method: StandaloneOutputMethod,
		exitCode?: number | null,
	): void
	public captureTerminalExecution(
		success: boolean,
		terminalType: TerminalType,
		method: TerminalOutputMethod,
		exitCode?: number | null,
	): void {
		// The overloads above are the contract callers see; the recorder takes
		// the widened form once the caller's variant has been type-checked.
		this.tool.captureTerminalExecution(success, terminalType as "standalone", method as StandaloneOutputMethod, exitCode)
	}

	public captureTerminalOutputFailure(reason: TerminalOutputFailureReason, terminalType: TerminalType = "vscode") {
		this.tool.captureTerminalOutputFailure(reason, terminalType)
	}

	public captureTerminalUserIntervention(action: TerminalUserInterventionAction, terminalType: TerminalType = "vscode") {
		this.tool.captureTerminalUserIntervention(action, terminalType)
	}

	public captureTerminalHang(stage: TerminalHangStage, terminalType: TerminalType = "vscode") {
		this.tool.captureTerminalHang(stage, terminalType)
	}

	public captureMentionUsed(
		mentionType: "file" | "folder" | "url" | "problems" | "terminal" | "git-changes" | "commit",
		contentLength?: number,
	) {
		this.tool.captureMentionUsed(mentionType, contentLength)
	}

	public captureMentionFailed(
		mentionType: "file" | "folder" | "url" | "problems" | "terminal" | "git-changes" | "commit",
		errorType:
			| "not_found"
			| "permission_denied"
			| "network_error"
			| "parse_error"
			| "ripgrep_spawn_failed"
			| "workspace_unavailable"
			| "unknown",
		errorMessage?: string,
		fsContext?: { fsClass?: "local" | "network" | "unknown"; fsType?: string },
	) {
		this.tool.captureMentionFailed(mentionType, errorType, errorMessage, fsContext)
	}

	public captureMentionSearchResults(
		query: string,
		resultCount: number,
		searchType: "file" | "folder" | "all",
		isEmpty: boolean,
		fsContext?: { fsClass?: "local" | "network" | "unknown"; fsType?: string },
		searchSource?: "host_index" | "ripgrep",
	) {
		this.tool.captureMentionSearchResults(query, resultCount, searchType, isEmpty, fsContext, searchSource)
	}

	/**
	 * Report one admission into an execution pool.
	 *
	 * The wait and the occupancy that caused it are reported together: a slow
	 * tool and a saturated pool are indistinguishable from duration alone.
	 */
	public capturePoolAdmission(args: {
		pool: ExecutionPool
		instance: string
		queueWaitMs: number
		running: number
		queued: number
		limit: number
	}) {
		this.tool.capturePoolAdmission(args)
	}

	/**
	 * Sample one pool instance's occupancy, queue depth and effective ceiling.
	 *
	 * `instance` separates concurrent pools of the same kind in memory; the
	 * exported series describe the process, not the instance.
	 */
	public recordPoolOccupancy(args: { pool: ExecutionPool; instance: string; running: number; queued: number; limit: number }) {
		this.tool.recordPoolOccupancy(args)
	}

	/** Drop a pool instance that has gone away, so its last sample stops counting. */
	public forgetPoolInstance(pool: ExecutionPool, instance: string) {
		this.tool.forgetPoolInstance(pool, instance)
	}

	/**
	 * Report the shape of one subagent batch.
	 *
	 * The explicit-profile count is separate from the width because a batch
	 * that binds Profiles per item loads the pool differently from one that
	 * inherits a single Profile. Both describe what was requested, not what
	 * survived admission.
	 */
	public captureSubagentFanout(items: number, explicitProfileItems: number) {
		this.tool.captureSubagentFanout(items, explicitProfileItems)
	}

	public captureSubagentToggle(enabled: boolean) {
		this.tool.captureSubagentToggle(enabled)
	}

	public captureSubagentExecution(ulid: string, durationMs: number, outputLines: number, success: boolean) {
		this.tool.captureSubagentExecution(ulid, durationMs, outputLines, success)
	}

	public captureAiOutputAccepted(args: AiOutputArgs): void {
		this.tool.captureAiOutputAccepted(args)
	}

	public captureAiOutputRejected(args: AiOutputArgs): void {
		this.tool.captureAiOutputRejected(args)
	}

	// Workspace and worktree events

	public captureWorkspaceInitialized(
		rootCount: number,
		vcsTypes: string[],
		initDurationMs?: number,
		featureFlagEnabled?: boolean,
	) {
		this.workspace.captureWorkspaceInitialized(rootCount, vcsTypes, initDurationMs, featureFlagEnabled)
	}

	public captureWorkspaceInitError(error: Error, fallbackMode: boolean, workspaceCount?: number) {
		this.workspace.captureWorkspaceInitError(error, fallbackMode, workspaceCount)
	}

	public captureMultiRootCheckpoint(
		ulid: string,
		action: "initialized" | "committed" | "restored",
		rootCount: number,
		successCount: number,
		failureCount: number,
		durationMs?: number,
	) {
		this.workspace.captureMultiRootCheckpoint(ulid, action, rootCount, successCount, failureCount, durationMs)
	}

	public captureWorkspacePathResolved(
		ulid: string,
		context: string,
		resolutionType: "hint_provided" | "fallback_to_primary" | "cross_workspace_search",
		hintType?: "workspace_name" | "workspace_path" | "invalid",
		resolutionSuccess?: boolean,
		targetWorkspaceIndex?: number,
		isMultiRootEnabled?: boolean,
	) {
		this.workspace.captureWorkspacePathResolved(
			ulid,
			context,
			resolutionType,
			hintType,
			resolutionSuccess,
			targetWorkspaceIndex,
			isMultiRootEnabled,
		)
	}

	public captureWorkspaceSearchPattern(
		ulid: string,
		searchType: "targeted" | "cross_workspace" | "primary_only",
		workspaceCount: number,
		hintProvided: boolean,
		resultsFound: boolean,
		searchDurationMs?: number,
	) {
		this.workspace.captureWorkspaceSearchPattern(
			ulid,
			searchType,
			workspaceCount,
			hintProvided,
			resultsFound,
			searchDurationMs,
		)
	}

	public captureWorktreeViewOpened(source: "home_page" | "menu_bar") {
		this.workspace.captureWorktreeViewOpened(source)
	}

	public captureWorktreeCreated(success: boolean, worktreeCount?: number) {
		this.workspace.captureWorktreeCreated(success, worktreeCount)
	}

	public captureWorktreeMergeAttempted(success: boolean, hasConflicts: boolean, deleteAfterMerge: boolean) {
		this.workspace.captureWorktreeMergeAttempted(success, hasConflicts, deleteAfterMerge)
	}

	// Hook events

	public captureHookCacheAccess(hookName: string, cacheHit: boolean) {
		this.hooks.captureHookCacheAccess(hookName, cacheHit)
	}

	public captureHookExecution(ulid: string, hookName: string, status: HookExecutionStatus, metadata?: HookExecutionMetadata) {
		this.hooks.captureHookExecution(ulid, hookName, status, metadata)
	}

	public captureHookDiscovery(hookName: string, globalCount: number, workspaceCount: number) {
		this.hooks.captureHookDiscovery(hookName, globalCount, workspaceCount)
	}

	// UI and transport events

	public captureModelSelected(model: string, provider: string, ulid?: string) {
		this.ui.captureModelSelected(model, provider, ulid)
	}

	public captureModelFavoritesUsage(model: string, isFavorited: boolean) {
		this.ui.captureModelFavoritesUsage(model, isFavorited)
	}

	public captureButtonClick(button: string, ulid?: string) {
		this.ui.captureButtonClick(button, ulid)
	}

	public captureRulesMenuOpened() {
		this.ui.captureRulesMenuOpened()
	}

	public captureFocusChainToggle(enabled: boolean) {
		this.ui.captureFocusChainToggle(enabled)
	}

	public captureFocusChainProgressFirst(ulid: string, totalItems: number) {
		this.ui.captureFocusChainProgressFirst(ulid, totalItems)
	}

	public captureFocusChainProgressUpdate(ulid: string, totalItems: number, completedItems: number) {
		this.ui.captureFocusChainProgressUpdate(ulid, totalItems, completedItems)
	}

	public captureFocusChainIncompleteOnCompletion(
		ulid: string,
		totalItems: number,
		completedItems: number,
		incompleteItems: number,
		modelId: string,
		provider: string,
	) {
		this.ui.captureFocusChainIncompleteOnCompletion(ulid, totalItems, completedItems, incompleteItems, modelId, provider)
	}

	public captureFocusChainListOpened(ulid: string) {
		this.ui.captureFocusChainListOpened(ulid)
	}

	public captureFocusChainListWritten(ulid: string) {
		this.ui.captureFocusChainListWritten(ulid)
	}

	public captureGrpcResponseSize(sizeUtf8Bytes: number, service: string, method: string, requestId?: string): void {
		this.ui.captureGrpcResponseSize(sizeUtf8Bytes, service, method, requestId)
	}

	// Introspection and lifecycle

	/**
	 * Checks if a specific telemetry category is enabled
	 * @param category The telemetry category to check
	 */
	public isCategoryEnabled(category: TelemetryCategory): boolean {
		return this.categories.isEnabled(category)
	}

	/**
	 * Switch one event category on or off.
	 *
	 * Coarser than consent: this silences a noisy feature without asking the
	 * user to withdraw reporting altogether.
	 */
	public setCategoryEnabled(category: TelemetryCategory, enabled: boolean): void {
		this.categories.setEnabled(category, enabled)
	}

	/**
	 * Get the telemetry provider instances
	 * @returns The array of telemetry providers
	 */
	public getProviders(): ITelemetryProvider[] {
		return this.registry.list()
	}

	/**
	 * Check if telemetry is currently enabled
	 * @returns Boolean indicating whether any provider is enabled
	 */
	public isEnabled(): boolean {
		return this.registry.isEnabled()
	}

	/**
	 * Get current telemetry settings from the first provider
	 * @returns Current telemetry settings
	 */
	public getSettings() {
		return this.registry.getSettings()
	}

	/**
	 * Safely executes a telemetry call with error protection.
	 *
	 * Use for critical execution paths where telemetry errors could break functionality:
	 * - Hook execution (during tool execution)
	 * - Browser automation (during active sessions)
	 * - Auth flows, task initialization
	 * - MCP server operations
	 *
	 * Not needed for non-critical, fire-and-forget events:
	 * - UI events (clicks, navigation)
	 * - Post-completion events
	 * - Background operations
	 *
	 * This wrapper protects against both pre-provider errors (parameter construction,
	 * property access, calculations) and provider-level errors (network, API failures).
	 *
	 * An async callback is accepted and its rejection is caught too. Returning
	 * `void` regardless is deliberate: a caller on a hot path must not be given
	 * a Promise it is expected to await, and an unobserved rejection from a
	 * telemetry call would surface as an unhandled rejection in the host.
	 *
	 * @param telemetryFn The telemetry function to execute
	 * @param context Optional context string for debugging (e.g., "HookFactory.exec")
	 */
	public safeCapture(telemetryFn: () => void | Promise<void>, context?: string): void {
		try {
			const result = telemetryFn()
			if (isPromiseLike(result)) {
				void Promise.resolve(result).catch((error: unknown) => {
					TelemetryService.logCaptureFailure(error, context)
				})
			}
		} catch (error) {
			TelemetryService.logCaptureFailure(error, context)
		}
	}

	private static logCaptureFailure(error: unknown, context?: string): void {
		const contextStr = context ? ` [Context: ${context}]` : ""
		Logger.error(`[Telemetry] Failed to capture telemetry${contextStr}:`, error)
	}

	/**
	 * Clean up resources when the service is disposed
	 */
	public async dispose(): Promise<void> {
		this.aggregates.clear()
		await this.registry.dispose()
	}
}

/** Event names, exported so tests and tooling can assert the published contract. */
export const TELEMETRY_EVENT_NAMES = TELEMETRY_EVENTS

/**
 * Whether a value can be awaited.
 *
 * Duck-typed rather than `instanceof Promise` because a callback may return a
 * thenable from another realm or library, and that rejection still needs
 * catching.
 */
function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return typeof (value as PromiseLike<unknown> | undefined)?.then === "function"
}
