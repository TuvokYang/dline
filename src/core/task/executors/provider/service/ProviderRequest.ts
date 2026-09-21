import type { ApiHandler } from "@core/api"
import type { ToolUse } from "@core/assistant-message"
import type { ClineStorageMessage } from "@shared/messages/content"
import type { ExplicitTurnAuthority } from "../../../explicit-instructions/TurnAuthority"
import type { ProviderTurnApproval } from "../../../kernel"
import type { ProviderDraftEnvelope } from "../../../stores/payload/TaskPayloadEnvelopes"

export interface PlannedProviderTool {
	readonly attempt: string
	readonly lanes: readonly string[]
	readonly turnEnding: boolean
	readonly approval: ProviderTurnApproval
}

export interface PreparedProviderRequest {
	readonly api: ApiHandler
	readonly systemPrompt: string
	readonly messages: ClineStorageMessage[]
	readonly tools?: Parameters<ApiHandler["createMessage"]>[2]
	readonly options?: Parameters<ApiHandler["createMessage"]>[3]
	readonly nativeTools: boolean
	readonly mode: "serial" | "parallel"
	readonly turnId: string
	/**
	 * One-shot authority the admitted input of this turn granted, if any.
	 *
	 * The request owns it because the turn it authorizes is the turn being sent;
	 * abandoning the request must withdraw it rather than leave it pending.
	 */
	readonly authority?: ExplicitTurnAuthority
	planTool(tool: ToolUse): PlannedProviderTool
}

/** Freezes all provider-visible request facts before the stream starts. */
export interface ProviderRequestFactory {
	prepare(draft: ProviderDraftEnvelope, signal: AbortSignal): Promise<PreparedProviderRequest>
}
