import { randomUUID } from "node:crypto"
import type { ToolUse } from "@core/assistant-message"
import { ToolPromptGenerator } from "@core/prompts/generators/ToolPromptGenerator"
import { resolveFrozenPromptRuntime } from "@core/prompts/system-prompt-cache/FrozenPromptRuntime"
import type { StateManager } from "@core/storage/StateManager"
import { DEFAULT_API_PROVIDER } from "@shared/api"
import { ServerTool } from "@shared/proto/dline/models/metadata"
import type { JournalConversationView } from "../executors/provider/service/JournalConversationView"
import type { ProviderJournalMessageMaterializer } from "../executors/provider/service/ProviderJournalMessageMaterializer"
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
import { deriveNewTaskFeedbackContinuationFromConversation } from "../new-task/new-task-continuation"
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
	/** The task's conversation, held in memory and read through the draft's position. */
	readonly conversation: JournalConversationView
	/** Reads the one-shot authority the round's admitted inputs carry. */
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
		const messages = await this.conversationOf(draft)
		const turnId = draft.turnId ?? randomUUID()
		// Authority is derived from the durable admitted input, so a recovered or
		// retried turn grants exactly what the user named and nothing more. A
		// Regenerate Context reply is the user's word too: it re-authorizes the
		// new_task the user asked to see again.
		const continuation = deriveNewTaskFeedbackContinuationFromConversation(messages)
		const authority = this.options.authority.grant(turnId, [
			...(await this.options.messages.collectAuthority(draft.inputPayloadRefs)),
			...(continuation ? [continuation] : []),
		])
		return {
			...frame,
			messages,
			turnId,
			...(authority === undefined ? {} : { authority }),
			modelInfo: {
				modelId: frame.api.getModel().id,
				providerId: frame.api.getProviderId?.() ?? DEFAULT_API_PROVIDER,
				mode: this.options.settings.mode,
			},
			// Every Profile, Mode or configuration change ends in a handler rebuild,
			// so handler identity is what tells whether this projection still applies.
			isCurrent: () => this.options.api.current() === frame.api,
			planTool: (tool: ToolUse) => this.options.tools.plan(tool, this.options.readAdmissionSnapshot(tool)),
		}
	}

	/**
	 * The conversation the draft was composed with.
	 *
	 * A draft written before drafts recorded a position names its payloads
	 * instead; replaying it from those keeps a recovered request unchanged.
	 */
	private conversationOf(draft: ProviderDraftEnvelope) {
		if (draft.journalThrough) return this.options.conversation.messages(draft.journalThrough)
		if (draft.journalPayloadRefs) return this.options.conversation.messagesOf(draft.journalPayloadRefs)
		return this.options.conversation.messages()
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
			serverToolContext: {
				webSearchRoutingPlan: runtime.webSearchRoutingPlan,
				providerId: api.getProviderId?.() ?? DEFAULT_API_PROVIDER,
				imageGeneration: {
					enabled: serverTools.includes(ServerTool.IMAGE_GENERATION),
					providerId: api.getProviderId?.() ?? DEFAULT_API_PROVIDER,
					modelId: api.getModel().id,
				},
			},
			// The frozen prompt already resolved the setting against provider
			// capability; scheduling must agree with what the model was told.
			mode: runtime.parallelToolsEnabled ? "parallel" : "serial",
			profile: context.promptProfile,
		}
	}
}
