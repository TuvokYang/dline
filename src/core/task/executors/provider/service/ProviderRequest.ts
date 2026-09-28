import type { ApiHandler } from "@core/api"
import type { WebSearchRoutingPlan } from "@core/api/server-tools"
import type { ToolUse } from "@core/assistant-message"
import type { PromptProfile } from "@core/prompts/profiles/types"
import type { ClineStorageMessage } from "@shared/messages/content"
import type { ClineMessageModelInfo } from "@shared/messages/metrics"
import type { Mode } from "@shared/storage/types"
import type { ExplicitTurnAuthority } from "../../../explicit-instructions/TurnAuthority"
import type { ProviderTurnApproval } from "../../../kernel"
import type { ProviderDraftEnvelope } from "../../../stores/payload/TaskPayloadEnvelopes"
import type { HostedImageGenerationContext } from "../../../tools/HostedImageGenerationLifecycle"

export interface PlannedProviderTool {
	readonly attempt: string
	readonly lanes: readonly string[]
	readonly turnEnding: boolean
	readonly approval: ProviderTurnApproval
}

/**
 * Everything a provider request carries before its conversation.
 *
 * The handler, system prompt and tools form the prefix a provider caches. A
 * request that shares the conversation but not this frame - a compaction built
 * with its own prompt and no tools - starts a new cache entry and pays for the
 * whole conversation again, which is the opposite of what compaction is for.
 */
export interface ProviderServerToolRequestContext {
	readonly webSearchRoutingPlan: WebSearchRoutingPlan
	readonly imageGeneration: HostedImageGenerationContext
	readonly providerId: string
}

export interface ProviderRequestFrame {
	readonly api: ApiHandler
	readonly systemPrompt: string
	readonly tools?: Parameters<ApiHandler["createMessage"]>[2]
	readonly options?: Parameters<ApiHandler["createMessage"]>[3]
	readonly nativeTools: boolean
	/** Frozen routes and provider identity used to admit and present hosted calls from this request. */
	readonly serverToolContext: ProviderServerToolRequestContext
	readonly mode: "serial" | "parallel"
	/** Profile the system prompt was rendered for; follow-up instructions must match it. */
	readonly profile: PromptProfile
}

/**
 * The handler and Mode a request is sent under when it is not the task's own.
 *
 * A context transition compacts for the Profile or Mode it is about to adopt,
 * so its summary must come from that target before the task switches to it.
 */
export interface ProviderRequestScope {
	readonly api: ApiHandler
	readonly mode: Mode
}

/** Resolves the frame the task's ordinary requests currently use, without advancing its prompt lifecycle. */
export interface ProviderRequestFramePort {
	/** A scope replaces the task's current handler and Mode for this frame only. */
	frame(signal: AbortSignal, scope?: ProviderRequestScope): Promise<ProviderRequestFrame>
}

export interface PreparedProviderRequest extends ProviderRequestFrame {
	readonly messages: ClineStorageMessage[]
	readonly turnId: string
	/**
	 * One-shot authority the admitted input of this turn granted, if any.
	 *
	 * The request owns it because the turn it authorizes is the turn being sent;
	 * abandoning the request must withdraw it rather than leave it pending.
	 */
	readonly authority?: ExplicitTurnAuthority
	/**
	 * The model this request is sent to, recorded with its reply.
	 *
	 * A later request to another model reads it to project this turn as foreign
	 * history. Absent leaves the reply unattributed, as older replies are.
	 */
	readonly modelInfo?: ClineMessageModelInfo
	/**
	 * False once the task replaced the handler this request was prepared for.
	 *
	 * The frozen prompt and tools are a projection for one provider: a Profile or
	 * Mode switch while the request waits to be sent again makes them wrong for
	 * the handler that will send it. Absent means the request never goes stale.
	 */
	isCurrent?(): boolean
	planTool(tool: ToolUse): PlannedProviderTool
}

/** Freezes all provider-visible request facts before the stream starts. */
export interface ProviderRequestFactory {
	prepare(draft: ProviderDraftEnvelope, signal: AbortSignal): Promise<PreparedProviderRequest>
}
