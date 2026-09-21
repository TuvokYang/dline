import type { ApiHandler } from "@core/api"
import type { ToolUse } from "@core/assistant-message"
import type { ClineStorageMessage } from "@shared/messages/content"
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
	planTool(tool: ToolUse): PlannedProviderTool
}

/** Freezes all provider-visible request facts before the stream starts. */
export interface ProviderRequestFactory {
	prepare(draft: ProviderDraftEnvelope, signal: AbortSignal): Promise<PreparedProviderRequest>
}
