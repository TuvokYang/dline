import type { ResolvedPromptRuntime } from "@core/prompts/system-prompt-cache/FrozenPromptRuntime"
import type { ClineStorageMessage } from "@shared/messages"
import type { ServerTool } from "@shared/proto/dline/models/metadata"
import type { ClineTool } from "@shared/tools"

/** Frozen Provider request for one hidden compaction Pass; every attempt replays it unchanged. */
export interface CompactionProviderInput {
	systemPrompt: string
	messages: ClineStorageMessage[]
	tools?: ClineTool[]
	readonly serverTools: readonly ServerTool[]
	/** Frozen prompt/tool execution projection for this Provider input. */
	readonly runtime?: ResolvedPromptRuntime
	providerOutputCap?: number
}
