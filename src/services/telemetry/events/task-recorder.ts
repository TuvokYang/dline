import { ApiFormat, apiFormatToJSON } from "@shared/proto/dline/models/metadata"
import type { TaskFeedbackType } from "@shared/WebviewMessage"
import { calculateApiUsageStatistics } from "@/shared/api-usage"
import { Logger } from "@/shared/services/Logger"
import type { Mode } from "@/shared/storage/types"
import type { TelemetrySignalSink } from "../service/signal-sink"
import { MAX_ERROR_MESSAGE_LENGTH, TELEMETRY_EVENTS, TELEMETRY_METRICS } from "./catalog"
import { DomainRecorder } from "./domain-recorder"
import type { TaskAggregates } from "./task-aggregates"

/** Content-free summary of a committed compaction operation. */
export interface CompactionCommitTelemetry {
	trigger: string
	acceptedPassCount: number
}

/** Content-free diagnostics of one compaction Provider attempt. */
export interface CompactionAttemptTelemetry {
	trigger: string
	modelId: string
	provider: string
	attemptIndex: number
	outcome: "accepted" | "failed"
	nextAction: "accept" | "retry" | "fail"
	failureKind?: string
	reminderKind?: string
	stopReason?: string
	textChars: number
	reasoningChars: number
	toolCallChunks: number
	trailingChars?: number
	outputTokens?: number
	thoughtsTokens?: number
	providerTtfbMs?: number
	streamMs?: number
}

/**
 * Token usage data shared across telemetry capture methods.
 * Used by both `captureTokenUsage` and `captureConversationTurnEvent`.
 */
export interface TokenUsage {
	tokensIn?: number
	tokensOut?: number
	cacheWriteTokens?: number
	cacheReadTokens?: number
	thoughtsTokens?: number
	apiFormat?: ApiFormat
	totalCost?: number
	cacheUsageReported?: boolean
	requestsPerMinute?: number
	tokensPerMinute?: number
	features?: Readonly<Record<string, boolean>>
}

/**
 * Task lifecycle, conversation, and cost telemetry.
 *
 * Both events and metrics are emitted from the same methods because they
 * describe one observation from two angles: the event keeps the individual
 * occurrence with its full identity, while the metric keeps an aggregate a
 * dashboard can chart. Splitting them into separate call sites would let the
 * two drift out of agreement.
 */
export class TaskEventRecorder extends DomainRecorder {
	constructor(
		sink: TelemetrySignalSink,
		private readonly aggregates: TaskAggregates,
	) {
		super(sink)
	}

	/**
	 * Records when a new task/conversation is started
	 * @param ulid Unique identifier for the new task
	 * @param apiProvider Optional API provider
	 * @param openAiCompatibleDomain Optional domain for OpenAI Compatible providers (e.g., "api.example.com")
	 */
	captureTaskCreated(ulid: string, apiProvider?: string, openAiCompatibleDomain?: string): void {
		this.aggregates.reset(ulid)
		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.CREATED, { ulid, apiProvider, openAiCompatibleDomain })
	}

	/**
	 * Records when a task/conversation is restarted
	 * @param ulid Unique identifier for the new task
	 * @param apiProvider Optional API provider
	 * @param openAiCompatibleDomain Optional domain for OpenAI Compatible providers
	 */
	captureTaskRestarted(ulid: string, apiProvider?: string, openAiCompatibleDomain?: string): void {
		this.aggregates.reset(ulid)
		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.RESTARTED, { ulid, apiProvider, openAiCompatibleDomain })
	}

	/**
	 * Records when cline calls the task completion_result tool signifying that cline is done with the task
	 * @param ulid Unique identifier for the task
	 */
	captureTaskCompleted(
		ulid: string,
		args?: {
			provider?: string
			modelId?: string
			apiFormat?: ApiFormat
			timeToFirstTokenMs?: number
			durationMs?: number
			mode: Mode
		},
	): void {
		const apiFormatName = args?.apiFormat !== undefined ? apiFormatToJSON(args.apiFormat) : undefined
		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.COMPLETED, {
			ulid,
			provider: args?.provider,
			modelId: args?.modelId,
			apiFormat: args?.apiFormat,
			apiFormatName,
			timeToFirstTokenMs: args?.timeToFirstTokenMs,
			durationMs: args?.durationMs,
			mode: args?.mode,
		})

		if (Number.isFinite(args?.timeToFirstTokenMs)) {
			this.sink.recordHistogram(TELEMETRY_METRICS.API.TTFT_SECONDS, (args?.timeToFirstTokenMs ?? 0) / 1000, {
				ulid,
				provider: args?.provider,
				model: args?.modelId,
				apiFormat: apiFormatName,
				mode: args?.mode,
			})
		}

		if (Number.isFinite(args?.durationMs)) {
			this.sink.recordHistogram(TELEMETRY_METRICS.API.DURATION_SECONDS, (args?.durationMs ?? 0) / 1000, {
				ulid,
				provider: args?.provider,
				model: args?.modelId,
				apiFormat: apiFormatName,
				scope: "task",
				mode: args?.mode,
			})
		}

		this.aggregates.reset(ulid)
	}

	/**
	 * Captures that a message was sent, and includes the API provider and model used
	 * @param ulid Unique identifier for the task
	 * @param provider The API provider (e.g., OpenAI, Anthropic)
	 * @param model The specific model used (e.g., GPT-4, Claude)
	 * @param source The source of the message ("user" | "assistant")
	 * @param mode The mode in which the conversation turn occurred ("plan" or "act")
	 * @param tokenUsage Optional token usage data
	 */
	captureConversationTurnEvent(
		ulid: string,
		provider = "unknown",
		model = "unknown",
		source: "user" | "assistant",
		mode: Mode,
		tokenUsage: TokenUsage = {},
		isNativeToolCall?: boolean,
	): void {
		// Ensure required parameters are provided
		if (!ulid || !provider || !model || !source) {
			Logger.warn("TelemetryService: Missing required parameters for message capture")
			return
		}

		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.CONVERSATION_TURN, {
			ulid,
			provider,
			model,
			source,
			mode,
			timestamp: new Date().toISOString(), // Add timestamp for message sequencing
			...tokenUsage,
			isNativeToolCall,
		})

		const turnCount = this.aggregates.nextTurn(ulid)
		const turnAttributes = { ulid, provider, model, source, mode }
		this.sink.recordCounter(TELEMETRY_METRICS.TASK.TURNS_TOTAL, 1, turnAttributes)
		this.sink.recordHistogram(TELEMETRY_METRICS.TASK.TURNS_PER_TASK, turnCount, turnAttributes)

		const usageAttributes = { ulid, provider, model, mode }

		if (Number.isFinite(tokenUsage.cacheWriteTokens)) {
			const cacheWriteTokens = tokenUsage.cacheWriteTokens ?? 0
			this.sink.recordCounter(TELEMETRY_METRICS.CACHE.WRITE_TOTAL, cacheWriteTokens, usageAttributes)
			this.sink.recordHistogram(TELEMETRY_METRICS.CACHE.WRITE_PER_EVENT, cacheWriteTokens, usageAttributes)
		}

		if (Number.isFinite(tokenUsage.cacheReadTokens)) {
			const cacheReadTokens = tokenUsage.cacheReadTokens ?? 0
			this.sink.recordCounter(TELEMETRY_METRICS.CACHE.READ_TOTAL, cacheReadTokens, usageAttributes)
			this.sink.recordHistogram(TELEMETRY_METRICS.CACHE.READ_PER_EVENT, cacheReadTokens, usageAttributes)
		}

		if (Number.isFinite(tokenUsage.totalCost)) {
			const totalCost = tokenUsage.totalCost ?? 0
			const costAttributes = { ...usageAttributes, currency: "USD" }
			this.sink.recordCounter(TELEMETRY_METRICS.TASK.COST_TOTAL, totalCost, costAttributes)
			this.sink.recordHistogram(TELEMETRY_METRICS.TASK.COST_PER_EVENT, totalCost, costAttributes)
		}
	}

	/**
	 * Records token usage metrics for cost tracking and usage analysis
	 * @param ulid Unique identifier for the task
	 * @param tokensIn Number of input tokens consumed
	 * @param tokensOut Number of output tokens generated
	 * @param provider The API provider identifier (e.g. "anthropic", "openai", "cline")
	 * @param model The model used for token calculation
	 */
	captureTokenUsage(
		ulid: string,
		tokensIn: number,
		tokensOut: number,
		provider: string,
		model: string,
		options?: TokenUsage,
	): void {
		const statistics = calculateApiUsageStatistics({
			inputTokens: tokensIn,
			outputTokens: tokensOut,
			cacheWriteTokens: options?.cacheWriteTokens,
			cacheReadTokens: options?.cacheReadTokens,
			thoughtsTokens: options?.thoughtsTokens,
		})
		const cacheUsageReported =
			options?.cacheUsageReported ?? (options?.cacheWriteTokens !== undefined || options?.cacheReadTokens !== undefined)
		const apiFormatName = options?.apiFormat !== undefined ? apiFormatToJSON(options.apiFormat) : undefined

		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.TOKEN_USAGE, {
			ulid,
			tokensIn,
			tokensOut,
			provider,
			model,
			modelId: model,
			...options,
			apiFormatName,
			totalTokens: statistics.totalTokens,
			...(cacheUsageReported
				? {
						cacheHit: statistics.cacheHit,
						cacheHitRate: statistics.cacheHitRatePercent,
					}
				: {}),
		})

		const attributes = { ulid, provider, model, apiFormat: apiFormatName }
		this.sink.recordCounter(TELEMETRY_METRICS.API.REQUESTS_TOTAL, 1, attributes, "Completed provider requests")
		this.sink.recordCounter(
			TELEMETRY_METRICS.TASK.TOKENS_TOTAL,
			statistics.totalTokens,
			attributes,
			"Total provider tokens including input, output, cache, and reasoning",
		)

		if (Number.isFinite(tokensIn)) {
			this.sink.recordCounter(TELEMETRY_METRICS.TASK.TOKENS_INPUT_TOTAL, tokensIn, attributes)
			this.sink.recordHistogram(TELEMETRY_METRICS.TASK.TOKENS_INPUT_PER_RESPONSE, tokensIn, attributes)
		}

		if (Number.isFinite(tokensOut)) {
			this.sink.recordCounter(TELEMETRY_METRICS.TASK.TOKENS_OUTPUT_TOTAL, tokensOut, attributes)
			this.sink.recordHistogram(TELEMETRY_METRICS.TASK.TOKENS_OUTPUT_PER_RESPONSE, tokensOut, attributes)
		}

		if (cacheUsageReported) {
			this.sink.recordCounter(
				TELEMETRY_METRICS.CACHE.INPUT_TOTAL,
				statistics.totalInputTokens,
				attributes,
				"Input-side tokens eligible for prompt caching",
			)
			this.sink.recordHistogram(
				TELEMETRY_METRICS.CACHE.HIT_RATE_PERCENT,
				statistics.cacheHitRatePercent,
				attributes,
				"Token-weighted prompt cache hit percentage per provider request",
			)
		}

		if (cacheUsageReported && Number.isFinite(options?.cacheWriteTokens)) {
			const cacheWriteTokens = options?.cacheWriteTokens ?? 0
			this.sink.recordCounter(TELEMETRY_METRICS.CACHE.WRITE_TOTAL, cacheWriteTokens, attributes)
			this.sink.recordHistogram(TELEMETRY_METRICS.CACHE.WRITE_PER_EVENT, cacheWriteTokens, attributes)
		}

		if (cacheUsageReported && Number.isFinite(options?.cacheReadTokens)) {
			const cacheReadTokens = options?.cacheReadTokens ?? 0
			this.sink.recordCounter(TELEMETRY_METRICS.CACHE.READ_TOTAL, cacheReadTokens, attributes)
			this.sink.recordHistogram(TELEMETRY_METRICS.CACHE.READ_PER_EVENT, cacheReadTokens, attributes)
		}

		if (Number.isFinite(options?.totalCost)) {
			const totalCost = options?.totalCost ?? 0
			const costAttributes = { ...attributes, currency: "USD" }
			this.sink.recordCounter(TELEMETRY_METRICS.TASK.COST_TOTAL, totalCost, costAttributes)
			this.sink.recordHistogram(TELEMETRY_METRICS.TASK.COST_PER_EVENT, totalCost, costAttributes)
		}
	}

	/**
	 * Records when a task switches between plan and act modes
	 * @param ulid Unique identifier for the task
	 * @param mode The mode being switched to (plan or act)
	 */
	captureModeSwitch(ulid: string, mode: Mode): void {
		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.MODE_SWITCH, { ulid, mode })
	}

	/**
	 * Records one committed context compaction.
	 * @param ulid Unique identifier for the task
	 * @param modelId The model that produced the summary
	 * @param provider The API provider being used
	 * @param currentTokens Total tokens in context window when compaction started
	 * @param maxContextWindow Maximum context window size for the model
	 * @param details Trigger and accepted Pass count of the committed operation
	 */
	captureSummarizeTask(
		ulid: string,
		modelId: string,
		provider: string,
		currentTokens: number,
		maxContextWindow: number,
		details?: CompactionCommitTelemetry,
	): void {
		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.AUTO_COMPACT, {
			ulid,
			modelId,
			provider,
			currentTokens,
			maxContextWindow,
			...details,
		})
	}

	/**
	 * Records one compaction Provider attempt. Properties are counts and classifications only;
	 * no prompt, summary, or reply text is ever attached.
	 * @param ulid Unique identifier for the task
	 * @param attempt Content-free attempt diagnostics
	 */
	captureCompactionAttempt(ulid: string, attempt: CompactionAttemptTelemetry): void {
		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.COMPACTION_ATTEMPT, { ulid, ...attempt })
	}

	/**
	 * Records user feedback on completed tasks
	 * @param ulid Unique identifier for the task
	 * @param feedbackType The type of feedback ("thumbs_up" or "thumbs_down")
	 */
	captureTaskFeedback(ulid: string, feedbackType: TaskFeedbackType): void {
		Logger.info("TelemetryService: Capturing task feedback", { ulid, feedbackType })
		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.FEEDBACK, { ulid, feedbackType })
		this.aggregates.reset(ulid)
	}

	/**
	 * Records task initialization timing and metadata
	 * @param ulid Unique identifier for the task
	 * @param taskId Task ID (timestamp in milliseconds when task was created)
	 * @param durationMs Duration of initialization in milliseconds
	 * @param hasCheckpoints Whether checkpoints are enabled for this task
	 */
	captureTaskInitialization(ulid: string, taskId: string, durationMs: number, hasCheckpoints: boolean): void {
		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.INITIALIZATION, { ulid, taskId, durationMs, hasCheckpoints })
	}

	/**
	 * Records when a user selects an option from AI-generated followup questions
	 * @param ulid Unique identifier for the task
	 * @param qty The quantity of options that were presented
	 * @param mode The mode in which the option was selected ("plan" or "act")
	 */
	captureOptionSelected(ulid: string, qty: number, mode: Mode): void {
		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.OPTION_SELECTED, { ulid, qty, mode })
	}

	/**
	 * Records when a user types a custom response instead of selecting one of the AI-generated followup questions
	 * @param ulid Unique identifier for the task
	 * @param qty The quantity of options that were presented
	 * @param mode The mode in which the custom response was provided ("plan" or "act")
	 */
	captureOptionsIgnored(ulid: string, qty: number, mode: Mode): void {
		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.OPTIONS_IGNORED, { ulid, qty, mode })
	}

	/**
	 * Captures Gemini API performance metrics.
	 * @param ulid Unique identifier for the task
	 * @param modelId Specific Gemini model ID
	 * @param data Performance data including TTFT, durations, token counts, cache stats, and API success status
	 */
	captureGeminiApiPerformance(
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
	): void {
		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.GEMINI_API_PERFORMANCE, { ulid, modelId, ...data })

		const attributes = { ulid, model: modelId, provider: "gemini" }

		if (typeof data.ttftSec === "number") {
			this.sink.recordHistogram(TELEMETRY_METRICS.API.TTFT_SECONDS, data.ttftSec, attributes)
		}

		if (typeof data.totalDurationSec === "number") {
			this.sink.recordHistogram(TELEMETRY_METRICS.API.DURATION_SECONDS, data.totalDurationSec, attributes)
		}

		if (typeof data.throughputTokensPerSec === "number") {
			this.sink.recordHistogram(TELEMETRY_METRICS.API.THROUGHPUT_TOKENS_PER_SECOND, data.throughputTokensPerSec, attributes)
		}

		if (data.cacheHit) {
			this.sink.recordCounter(TELEMETRY_METRICS.CACHE.HITS_TOTAL, 1, attributes)
		}
	}

	/**
	 * Records telemetry when an API provider returns an error
	 * @param args Error identity, model, and the provider's message
	 */
	captureProviderApiError(args: {
		ulid: string
		model: string
		errorMessage: string
		provider?: string
		errorStatus?: number | undefined
		requestId?: string | undefined
		isNativeToolCall?: boolean
	}): void {
		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.PROVIDER_API_ERROR, {
			...args,
			errorMessage: args.errorMessage.substring(0, MAX_ERROR_MESSAGE_LENGTH), // Truncate long error messages
			timestamp: new Date().toISOString(),
		})

		const errorAttributes = {
			ulid: args.ulid,
			model: args.model,
			provider: args.provider,
			error_status: args.errorStatus,
		}
		this.sink.recordCounter(TELEMETRY_METRICS.ERRORS.TOTAL, 1, errorAttributes)
		const errorCount = this.aggregates.nextError(args.ulid)
		this.sink.recordHistogram(TELEMETRY_METRICS.ERRORS.PER_TASK, errorCount, errorAttributes)
	}

	/**
	 * Records when a diff edit (replace_in_file) operation fails
	 * @param ulid Unique identifier for the task
	 * @param modelId The model ID being used
	 * @param provider The API provider being used
	 * @param errorType Type of error that occurred (e.g., "search_not_found", "invalid_format")
	 * @param isNativeToolCall Whether the diff edit was invoked by a native tool call
	 */
	captureDiffEditFailure(ulid: string, modelId: string, provider: string, errorType?: string, isNativeToolCall = false): void {
		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.DIFF_EDIT_FAILED, {
			ulid,
			errorType,
			modelId,
			provider,
			isNativeToolCall,
		})
	}

	/**
	 * Records when slash commands or workflows are activated
	 * @param ulid Unique identifier for the task
	 * @param commandName The name of the command
	 * @param commandType Whether it's a built-in command, custom workflow, MCP prompt, or skill
	 */
	captureSlashCommandUsed(
		ulid: string,
		commandName: string,
		commandType: "builtin" | "workflow" | "mcp_prompt" | "skill",
	): void {
		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.SLASH_COMMAND_USED, { ulid, commandName, commandType })
	}

	/**
	 * Records when a feature is enabled/disabled by the user
	 * @param ulid Unique identifier for the task
	 * @param featureName The name of the feature being toggled
	 * @param enabled Whether the feature was enabled (true) or disabled (false)
	 * @param modelId The model ID being used when the toggle occurred
	 */
	captureFeatureToggle(ulid: string, featureName: string, enabled: boolean, modelId: string): void {
		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.FEATURE_TOGGLED, { ulid, featureName, enabled, modelId })
	}

	/**
	 * Records when individual Cline rules are toggled on/off
	 * @param ulid Unique identifier for the task
	 * @param ruleFileName The filename of the rule (sanitized to exclude full path)
	 * @param enabled Whether the rule is being enabled (true) or disabled (false)
	 * @param isGlobal Whether this is a global rule or workspace-specific rule
	 */
	captureClineRuleToggled(ulid: string, ruleFileName: string, enabled: boolean, isGlobal: boolean): void {
		// Sanitize filename to remove any path information for privacy
		const sanitizedFileName = ruleFileName.split("/").pop() || ruleFileName.split("\\").pop() || ruleFileName
		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.RULE_TOGGLED, {
			ulid,
			ruleFileName: sanitizedFileName,
			enabled,
			isGlobal,
		})
	}

	/**
	 * Records when auto condense is enabled/disabled by the user
	 * @param ulid Unique identifier for the task
	 * @param enabled Whether auto condense was enabled (true) or disabled (false)
	 * @param modelId The model ID being used when the toggle occurred
	 */
	captureAutoCondenseToggle(ulid: string, enabled: boolean, modelId: string): void {
		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.AUTO_CONDENSE_TOGGLED, { ulid, enabled, modelId })
	}

	/**
	 * Records when yolo mode is enabled/disabled by the user
	 * @param ulid Unique identifier for the task
	 * @param enabled Whether yolo mode was enabled (true) or disabled (false)
	 */
	captureYoloModeToggle(ulid: string, enabled: boolean): void {
		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.YOLO_MODE_TOGGLED, { ulid, enabled })
	}

	/**
	 * Records when Cline web tools are enabled/disabled by the user
	 * @param ulid Unique identifier for the task
	 * @param enabled Whether Cline web tools are enabled (true) or disabled (false)
	 */
	captureClineWebToolsToggle(ulid: string, enabled: boolean): void {
		this.sink.captureEvent(TELEMETRY_EVENTS.TASK.CLINE_WEB_TOOLS_TOGGLED, { ulid, enabled })
	}
}
