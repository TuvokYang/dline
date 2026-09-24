import { randomUUID } from "node:crypto"
import type { ToolUse } from "@core/assistant-message"
import { ToolPromptGenerator } from "@core/prompts/generators/ToolPromptGenerator"
import { resolveFrozenPromptRuntime } from "@core/prompts/system-prompt-cache/FrozenPromptRuntime"
import type { StateManager } from "@core/storage/StateManager"
import { ProviderJournalMessageMaterializer } from "../executors/provider/service/ProviderJournalMessageMaterializer"
import type {
	PreparedProviderRequest,
	ProviderRequestFactory,
	ProviderRequestFrame,
	ProviderRequestFramePort,
	ProviderRequestScope,
} from "../executors/provider/service/ProviderRequest"
import type { ProductionToolHandlerRuntime } from "../executors/tool/production/ProductionToolHandlerRuntime"
import type { ToolAdmissionSnapshot } from "../executors/tool/ToolAdmissionRegistry"
import type { TaskTurnAuthority } from "../explicit-instructions/TurnAuthority"
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
	readonly authority: TaskTurnAuthority
	readonly tools: ProductionToolHandlerRuntime
	readonly readAdmissionSnapshot: (block: ToolUse) => ToolAdmissionSnapshot
}

/** Freezes one provider request from task-scoped owners and durable journal content. */
export class TaskProviderRequestFactory implements ProviderRequestFactory, ProviderRequestFramePort {
	constructor(private readonly options: TaskProviderRequestFactoryOptions) {}

	async prepare(draft: ProviderDraftEnvelope, signal: AbortSignal): Promise<PreparedProviderRequest> {
		const frame = await this.buildFrame(signal, false)
		const messages = await this.options.messages.materialize(draft.journalPayloadRefs)
		const turnId = draft.turnId ?? randomUUID()
		// Authority is derived from the durable admitted input, so a recovered or
		// retried turn grants exactly what the user named and nothing more.
		const authority = this.options.authority.grant(
			turnId,
			await this.options.messages.collectAuthority(draft.inputPayloadRefs),
		)
		return {
			...frame,
			messages,
			turnId,
			...(authority === undefined ? {} : { authority }),
			planTool: (tool: ToolUse) => this.options.tools.plan(tool, this.options.readAdmissionSnapshot(tool)),
		}
	}

	/**
	 * The frame the last ordinary request was sent with.
	 *
	 * Resolved as a preview so a pending prompt refresh is left for the next
	 * ordinary round: a refresh consumed here would move the prefix between the
	 * compaction and the request it exists to serve. A scope resolves the frame
	 * the task will use once it adopts that handler and Mode instead.
	 */
	frame(signal: AbortSignal, scope?: ProviderRequestScope): Promise<ProviderRequestFrame> {
		return this.buildFrame(signal, true, scope)
	}

	private async buildFrame(signal: AbortSignal, preview: boolean, scope?: ProviderRequestScope): Promise<ProviderRequestFrame> {
		if (signal.aborted) throw signal.reason
		const api = scope?.api ?? this.options.api.current()
		const requestScope = createRequestApiScope(
			api,
			scope?.mode ?? this.options.settings.mode,
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
		const frozen = await this.options.prompt.resolvePrompt(context, preview)
		const runtime = resolveFrozenPromptRuntime(frozen, context)
		const selectedTools = new ToolPromptGenerator().generateToolsForRequest(
			context.promptProfile,
			context,
			this.options.prompt.getLastTools(),
		)
		const tools = selectedTools ? [...selectedTools] : undefined
		const serverTools = Object.freeze([
			...new Set([...runtime.webSearchRoutingPlan.serverTools, ...requestScope.hostedImageGenerationPlan.serverTools]),
		])
		return {
			api,
			systemPrompt: frozen.text,
			tools,
			options: { serverTools, taskNamespace: this.options.taskId, retryOwner: "task" },
			nativeTools: Boolean(tools?.length),
			// The frozen prompt already resolved the setting against provider
			// capability; scheduling must agree with what the model was told.
			mode: runtime.parallelToolsEnabled ? "parallel" : "serial",
			profile: context.promptProfile,
		}
	}
}
