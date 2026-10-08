import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import type { UiSayTool } from "@shared/ExtensionMessage"
import type { ClineToolResponseContent, ClineUserAttachedDocumentBlock } from "@shared/messages/content"
import { WebToolsMode } from "@shared/proto/dline/provider/common"
import { ClineDefaultTool } from "@shared/tools"
import { serializeDurableToolResult, toolResultReplayOf } from "../../../DurableToolResult"
import { LOOP_DETECTION_SOFT_THRESHOLD, recordToolCall, toolCallSignature } from "../../../loop-detection"
import type { ToolInvocationEnvelope } from "../../../stores/payload/TaskPayloadEnvelopes"
import { approvalInteractionId } from "../../../tools/approval-interaction"
import { normalizeToolExecutionResult, type ToolPostCommitDirective } from "../../../tools/ToolExecutionResult"
import type { ToolExecutorCoordinator } from "../../../tools/ToolExecutorCoordinator"
import type { TaskConfig } from "../../../tools/types/TaskConfig"
import { ToolDisplayUtils } from "../../../tools/utils/ToolDisplayUtils"
import { ToolResultUtils } from "../../../tools/utils/ToolResultUtils"
import type { ProductionToolExecutionService } from "../ProductionToolAdapter"
import type { ToolDomainSurface } from "../ToolDomainSurface"
import type { ToolRunCommand } from "../ToolExecutionDomain"
import type { ProductionToolHandlerRuntime } from "./ProductionToolHandlerRuntime"

export interface ProductionToolConfigFactoryInput {
	readonly command: ToolRunCommand
	readonly invocation: ToolInvocationEnvelope
	readonly surface: ToolDomainSurface
	readonly coordinator: ToolExecutorCoordinator
}

export interface ProductionToolConfigFactory {
	create(input: ProductionToolConfigFactoryInput): TaskConfig
}

export interface DefaultProductionToolExecutionServiceOptions {
	readonly config: ProductionToolConfigFactory
	readonly runtime: ProductionToolHandlerRuntime
}

export interface ProductionToolExecutionResult {
	readonly content: string
	readonly failed?: boolean
	/** PDFs the user attached to the call's answer; they follow the result in the next request. */
	readonly documents?: readonly ClineUserAttachedDocumentBlock[]
	readonly postCommit?: ToolPostCommitDirective
}

function canFallbackUnadvertisedWebSearch(config: TaskConfig): boolean {
	const plan = config.webSearchRoutingPlan
	return (
		config.webToolsEnabled === true &&
		plan?.mode === WebToolsMode.WEB_TOOLS_MODE_AUTO &&
		plan.route === "hosted" &&
		plan.localFallbackAvailable &&
		config.coordinator.has(ClineDefaultTool.WEB_SEARCH)
	)
}

function createLocalWebSearchFallbackConfig(config: TaskConfig): TaskConfig {
	const plan = config.webSearchRoutingPlan
	if (!plan) return config
	return {
		...config,
		webSearchRoutingPlan: Object.freeze({
			...plan,
			route: "local" as const,
			localToolEnabled: true,
			serverTools: Object.freeze([]),
		}),
	}
}

async function presentUnadvertisedHostedWebSearch(
	config: TaskConfig,
	block: ToolUse,
	fallback: boolean,
	mode: WebToolsMode,
): Promise<string> {
	const providerId = config.api.getProviderId?.() ?? "provider"
	const providerLabel = providerId === "openai" ? "OpenAI" : providerId === "deepseek" ? "DeepSeek" : providerId
	const query = typeof block.params?.query === "string" && block.params.query.trim() ? block.params.query.trim() : "Web search"
	const message = fallback
		? `${providerLabel} hosted Web Search returned a local web_search function call instead of a hosted search event; falling back to Dline local Web Search.`
		: mode === WebToolsMode.WEB_TOOLS_MODE_FORCE_REMOTE
			? `${providerLabel} hosted Web Search returned a local web_search function call, but the request is configured for Force Remote. The local call was rejected.`
			: `${providerLabel} hosted Web Search returned a local web_search function call, but Auto mode has no Dline local Web Search fallback for the current prompt profile. The local call was rejected.`
	const presentation: UiSayTool = {
		tool: "webSearch",
		path: query,
		content: `Web search routing failed: ${message}`,
		operationIsLocatedInWorkspace: false,
		webSearch: {
			schemaVersion: 1,
			status: "failed",
			source: {
				id: `${providerId}-hosted`,
				label: `${providerLabel} Web Search`,
				execution: "hosted",
				provider: providerId,
			},
			query,
			error: message,
		},
	}
	await config.callbacks.say("tool", JSON.stringify(presentation), undefined, undefined, false)
	return message
}

/**
 * Serialize what the call returned as the result the next request carries.
 *
 * A string result opens with the call's description, as main sends it: the
 * description names what the call acted on, so results with the same text -
 * two copies of one file - stay distinct to the model and to the prefix cache.
 */
function serializeResult(
	invocation: ToolInvocationEnvelope,
	response: ClineToolResponseContent,
	description: string,
	failed = false,
): ProductionToolExecutionResult {
	const described = typeof response === "string"
	return {
		content: serializeDurableToolResult(
			{
				type: "tool_result",
				function_id: invocation.functionId,
				dline_tid: invocation.dlineTid,
				content: ToolResultUtils.boundContent(
					described ? ToolResultUtils.describeTextResult(description, response) : response,
				),
				...(failed ? { is_error: true } : {}),
			},
			toolResultReplayOf(invocation, described),
		),
		...(failed ? { failed: true } : {}),
	}
}

/** Rehydrate the canonical runtime tool block stored behind an invocation reference. */
export function materializeToolInvocation(invocation: ToolInvocationEnvelope): ToolUse {
	const params = Object.fromEntries(
		Object.entries(invocation.input).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]),
	) as ToolUse["params"]
	return {
		type: "tool_use",
		name: invocation.toolName as ToolUse["name"],
		params,
		partial: false,
		ts: invocation.presentationId,
		isNativeToolCall: invocation.isNativeToolCall,
		function_id: invocation.functionId,
		dline_tid: invocation.dlineTid,
		...(invocation.signature === undefined ? {} : { signature: invocation.signature }),
	}
}

/**
 * Record a finished call with the repeated-call detector and apply its verdict.
 *
 * It runs after the handler because a successful handler resets the mistake
 * count; escalating afterwards keeps the limit latched for the next round, as in
 * dev. The soft warning rides on this call's own result because the runtime has
 * no separate user-content buffer to carry it. Detection is synchronous, so
 * concurrent calls cannot interleave between comparing and recording.
 */
export function applyRepeatedCallGuard(
	config: Pick<TaskConfig, "taskState" | "services">,
	block: Pick<ToolUse, "name" | "params">,
	response: ClineToolResponseContent,
): ClineToolResponseContent {
	const verdict = recordToolCall(config.taskState, block.name, toolCallSignature(block.params))
	if (verdict.hardEscalation) {
		config.taskState.consecutiveMistakeCount =
			config.services.stateManager.getGlobalSettingsKey("maxConsecutiveMistakes") ?? 3
	}
	if (!verdict.softWarning) return response
	const warning = formatResponse.repeatedToolCall(block.name, LOOP_DETECTION_SOFT_THRESHOLD)
	return Array.isArray(response) ? [...response, { type: "text", text: warning }] : `${response}\n\n${warning}`
}

/** Task-scoped handler runtime with no dependency on the legacy ToolExecutor. */
export class DefaultProductionToolExecutionService implements ProductionToolExecutionService {
	constructor(private readonly options: DefaultProductionToolExecutionServiceOptions) {}

	async execute(input: {
		readonly command: ToolRunCommand
		readonly invocation: ToolInvocationEnvelope
		readonly surface: ToolDomainSurface
	}): Promise<ProductionToolExecutionResult> {
		if (input.invocation.dlineTid !== input.command.dlineTid) {
			throw new Error(`ToolInvocationIdentityMismatch:${input.invocation.dlineTid}:${input.command.dlineTid}`)
		}
		let config = this.options.config.create({ ...input, coordinator: this.options.runtime.coordinator })
		const block = materializeToolInvocation(input.invocation)
		const approvalAnchor = config.messageState?.clineMessages.find(
			(message) => message.interactionId === approvalInteractionId(input.invocation.dlineTid),
		)
		if (approvalAnchor) block.ts = approvalAnchor.ts
		const description = ToolDisplayUtils.getToolDescription(block, this.options.runtime.coordinator)
		if (
			input.invocation.isNativeToolCall &&
			input.invocation.toolName === ClineDefaultTool.WEB_SEARCH &&
			config.webSearchRoutingPlan?.route === "hosted"
		) {
			const fallback = canFallbackUnadvertisedWebSearch(config)
			const message = await presentUnadvertisedHostedWebSearch(config, block, fallback, config.webSearchRoutingPlan.mode)
			if (!fallback) return serializeResult(input.invocation, formatResponse.toolError(message), description, true)
			config = createLocalWebSearchFallbackConfig(config)
		}
		const result = normalizeToolExecutionResult(await this.options.runtime.execute(config, block))
		const response = applyRepeatedCallGuard(config, block, result.response)
		return {
			...serializeResult(input.invocation, response, description),
			...(result.documents?.length ? { documents: result.documents } : {}),
			...(result.postCommit === undefined ? {} : { postCommit: result.postCommit }),
		}
	}

	restoreSubagentRetry(config: TaskConfig, activityId: string): Promise<boolean> {
		return this.options.runtime.restoreSubagentRetry(config, activityId)
	}
}
