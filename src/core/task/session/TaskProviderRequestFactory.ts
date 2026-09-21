import { randomUUID } from "node:crypto"
import type { ToolUse } from "@core/assistant-message"
import { ToolPromptGenerator } from "@core/prompts/generators/ToolPromptGenerator"
import { resolveFrozenPromptRuntime } from "@core/prompts/system-prompt-cache/FrozenPromptRuntime"
import type { StateManager } from "@core/storage/StateManager"
import { ProviderJournalMessageMaterializer } from "../executors/provider/service/ProviderJournalMessageMaterializer"
import type { PreparedProviderRequest, ProviderRequestFactory } from "../executors/provider/service/ProviderRequest"
import type { ProductionToolHandlerRuntime } from "../executors/tool/production/ProductionToolHandlerRuntime"
import type { ToolAdmissionSnapshot } from "../executors/tool/ToolAdmissionRegistry"
import type { TaskPromptContextOwner } from "../prompt/TaskPromptContextOwner"
import type { TaskPromptLifecycle } from "../prompt/TaskPromptLifecycle"
import { createRequestApiScope } from "../RequestApiScope"
import type { ProviderDraftEnvelope } from "../stores/payload/TaskPayloadEnvelopes"
import type { TaskStateManager } from "../TaskStateManager"
import type { TaskApiHandlerOwner } from "./TaskApiHandlerOwner"

export interface TaskProviderRequestFactoryOptions {
	readonly taskId: string
	readonly stateManager: StateManager
	readonly settings: TaskStateManager
	readonly api: TaskApiHandlerOwner
	readonly promptContext: TaskPromptContextOwner
	readonly prompt: TaskPromptLifecycle
	readonly messages: ProviderJournalMessageMaterializer
	readonly tools: ProductionToolHandlerRuntime
	readonly readAdmissionSnapshot: (block: ToolUse) => ToolAdmissionSnapshot
}

/** Freezes one provider request from task-scoped owners and durable journal content. */
export class TaskProviderRequestFactory implements ProviderRequestFactory {
	constructor(private readonly options: TaskProviderRequestFactoryOptions) {}

	async prepare(draft: ProviderDraftEnvelope, signal: AbortSignal): Promise<PreparedProviderRequest> {
		if (signal.aborted) throw signal.reason
		const api = this.options.api.current()
		const mode = this.options.settings.mode
		const requestScope = createRequestApiScope(
			api,
			mode,
			this.options.stateManager.getGlobalSettingsKey("customPrompt"),
			this.options.stateManager.getGlobalSettingsKey("clineWebToolsEnabled") === true,
			undefined,
			this.options.stateManager.getCanonicalSettingsKey("imageGenerationEnabled") === true,
		)
		const context = await this.options.promptContext.build(
			requestScope.providerInfo,
			requestScope.webToolsEnabled,
			requestScope.webSearchRoutingPlan,
		)
		const frozen = await this.options.prompt.resolvePrompt(context, false)
		const runtime = resolveFrozenPromptRuntime(frozen, context)
		const selectedTools = new ToolPromptGenerator().generateToolsForRequest(
			context.promptProfile,
			context,
			this.options.prompt.getLastTools(),
		)
		const tools = selectedTools ? [...selectedTools] : undefined
		const messages = await this.options.messages.materialize(draft.journalPayloadRefs)
		const serverTools = Object.freeze([
			...new Set([...runtime.webSearchRoutingPlan.serverTools, ...requestScope.hostedImageGenerationPlan.serverTools]),
		])
		return {
			api,
			systemPrompt: frozen.text,
			messages,
			tools,
			options: { serverTools, taskNamespace: this.options.taskId, retryOwner: "task" },
			nativeTools: Boolean(tools?.length),
			// The frozen prompt already resolved the setting against provider
			// capability; scheduling must agree with what the model was told.
			mode: runtime.parallelToolsEnabled ? "parallel" : "serial",
			turnId: draft.turnId ?? randomUUID(),
			planTool: (tool: ToolUse) => this.options.tools.plan(tool, this.options.readAdmissionSnapshot(tool)),
		}
	}
}
