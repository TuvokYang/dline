import type { ToolUse } from "@core/assistant-message"
import { formatResponse } from "@core/prompts/responses"
import type { UiSayTool } from "@shared/ExtensionMessage"
import type { ClineToolResponseContent } from "@shared/messages/content"
import { WebToolsMode } from "@shared/proto/dline/provider/common"
import { ClineDefaultTool } from "@shared/tools"
import { serializeDurableToolResult, toolResultReplayOf } from "../../../DurableToolResult"
import type { ToolInvocationEnvelope } from "../../../stores/payload/TaskPayloadEnvelopes"
import { normalizeToolExecutionResult, type ToolPostCommitDirective } from "../../../tools/ToolExecutionResult"
import type { ToolExecutorCoordinator } from "../../../tools/ToolExecutorCoordinator"
import type { TaskConfig } from "../../../tools/types/TaskConfig"
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

function serializeResult(
	invocation: ToolInvocationEnvelope,
	response: ClineToolResponseContent,
	failed = false,
): ProductionToolExecutionResult {
	return {
		content: serializeDurableToolResult(
			{
				type: "tool_result",
				function_id: invocation.functionId,
				dline_tid: invocation.dlineTid,
				content: response,
				...(failed ? { is_error: true } : {}),
			},
			toolResultReplayOf(invocation),
		),
		...(failed ? { failed: true } : {}),
	}
}

function params(input: Readonly<Record<string, unknown>>): ToolUse["params"] {
	return Object.fromEntries(
		Object.entries(input).map(([key, value]) => [key, typeof value === "string" ? value : JSON.stringify(value)]),
	) as ToolUse["params"]
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
		const block: ToolUse = {
			type: "tool_use",
			name: input.invocation.toolName as ToolUse["name"],
			params: params(input.invocation.input),
			partial: false,
			ts: input.invocation.presentationId,
			isNativeToolCall: input.invocation.isNativeToolCall,
			function_id: input.invocation.functionId,
			dline_tid: input.invocation.dlineTid,
			...(input.invocation.signature === undefined ? {} : { signature: input.invocation.signature }),
		}
		let config = this.options.config.create({ ...input, coordinator: this.options.runtime.coordinator })
		if (
			input.invocation.isNativeToolCall &&
			input.invocation.toolName === ClineDefaultTool.WEB_SEARCH &&
			config.webSearchRoutingPlan?.route === "hosted"
		) {
			const fallback = canFallbackUnadvertisedWebSearch(config)
			const message = await presentUnadvertisedHostedWebSearch(config, block, fallback, config.webSearchRoutingPlan.mode)
			if (!fallback) return serializeResult(input.invocation, formatResponse.toolError(message), true)
			config = createLocalWebSearchFallbackConfig(config)
		}
		const result = normalizeToolExecutionResult(await this.options.runtime.execute(config, block))
		return {
			...serializeResult(input.invocation, result.response),
			...(result.postCommit === undefined ? {} : { postCommit: result.postCommit }),
		}
	}

	restoreSubagentRetry(config: TaskConfig, activityId: string): Promise<boolean> {
		return this.options.runtime.restoreSubagentRetry(config, activityId)
	}
}
