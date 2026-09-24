import type { ToolUse } from "@core/assistant-message"
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
		const config = this.options.config.create({ ...input, coordinator: this.options.runtime.coordinator })
		const result = normalizeToolExecutionResult(await this.options.runtime.execute(config, block))
		return {
			content: serializeDurableToolResult(
				{
					type: "tool_result",
					function_id: block.function_id,
					dline_tid: block.dline_tid,
					content: result.response,
				},
				toolResultReplayOf(input.invocation),
			),
			...(result.postCommit === undefined ? {} : { postCommit: result.postCommit }),
		}
	}

	restoreSubagentRetry(config: TaskConfig, activityId: string): Promise<boolean> {
		return this.options.runtime.restoreSubagentRetry(config, activityId)
	}
}
