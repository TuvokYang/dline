import type { ApiStreamToolCallsChunk } from "@core/api/transform/stream"
import type { ToolUse } from "@core/assistant-message"
import { JSONParser } from "@streamparser/json"
import { McpHub } from "@/services/mcp/McpHub"
import { CLINE_MCP_TOOL_IDENTIFIER } from "@/shared/mcp"
import {
	ClineAssistantRedactedThinkingBlock,
	ClineAssistantThinkingBlock,
	ClineAssistantToolUseBlock,
	ClineProviderMetadata,
	ClineReasoningDetailParam,
} from "@/shared/messages/content"
import { Logger } from "@/shared/services/Logger"
import { Session } from "@/shared/services/Session"
import { ClineDefaultTool } from "@/shared/tools"
import { EncryptedReasoningAccumulator, type EncryptedReasoningPhase } from "./reasoning-retention"

export interface PendingToolUse {
	function_id: string
	dline_tid: string
	provider_metadata?: ClineProviderMetadata
	name: string
	input: string
	parsedInput?: unknown
	signature?: string
	jsonParser?: JSONParser
	/** Stable UI message ts assigned at tool call creation time. */
	ts: number
}

interface ToolUseDeltaBlock {
	type?: string
	name?: string
	input?: string
	signature?: string
}

export interface ReasoningDelta {
	provider_metadata?: ClineProviderMetadata
	reasoning?: string
	signature?: string
	details?: any[]
	redacted_data?: any
	/**
	 * Whether `redacted_data` is an in-progress snapshot or the provider's authoritative payload.
	 * Snapshots refresh the matching item in place; only a final payload is durable.
	 */
	redacted_phase?: EncryptedReasoningPhase
}

export interface PendingReasoning {
	provider_metadata?: ClineProviderMetadata
	content: string
	signature: string
	redactedThinking: EncryptedReasoningAccumulator
	summary: unknown[] | ClineReasoningDetailParam[]
}

const ESCAPE_MAP: Record<string, string> = {
	"\\n": "\n",
	"\\t": "\t",
	"\\r": "\r",
	'\\"': '"',
	"\\\\": "\\",
}

const ESCAPE_PATTERN = /\\[ntr"\\]/g

export class StreamResponseHandler {
	private toolUseHandler: ToolUseHandler
	private reasoningHandler = new ReasoningHandler()

	private _requestId: string | undefined

	constructor(tsFactory: () => number) {
		this.toolUseHandler = new ToolUseHandler(tsFactory)
	}

	public setRequestId(id?: string) {
		if (!this._requestId && id) {
			this._requestId = id
		}
	}

	public get requestId() {
		return this._requestId
	}

	public getHandlers() {
		return {
			toolUseHandler: this.toolUseHandler,
			reasonsHandler: this.reasoningHandler,
		}
	}

	public reset() {
		this._requestId = undefined
		this.toolUseHandler = new ToolUseHandler(this.toolUseHandler.getTsFactory())
		this.reasoningHandler = new ReasoningHandler()
	}
}

/**
 * Handles streaming native tool use blocks and converts them to ClineAssistantToolUseBlock format
 */
class ToolUseHandler {
	private pendingToolUses = new Map<string, PendingToolUse>()
	private loggedFinalizedFunctionIds = new Set<string>()
	private tsFactory: () => number

	constructor(tsFactory: () => number) {
		this.tsFactory = tsFactory
	}

	getTsFactory(): () => number {
		return this.tsFactory
	}

	processToolUseDelta(
		delta: ToolUseDeltaBlock,
		identity: Pick<ApiStreamToolCallsChunk, "function_id" | "dline_tid" | "provider_metadata">,
	): void {
		if (delta.type !== "tool_use") {
			return
		}

		let pending = this.pendingToolUses.get(identity.dline_tid)
		if (!pending) {
			pending = this.createPendingToolUse(delta.name || "", identity)
		}

		if (delta.name) {
			pending.name = delta.name
		}

		if (delta.signature) {
			pending.signature = delta.signature
		}

		if (delta.input) {
			pending.input += delta.input
			try {
				pending.jsonParser?.write(delta.input)
			} catch {
				// Expected during streaming - JSONParser may not have complete JSON yet
			}
		}
	}

	getFinalizedToolUse(id: string): ClineAssistantToolUseBlock | undefined {
		const pending = this.pendingToolUses.get(id)
		if (!pending?.name) {
			return undefined
		}

		let input: unknown = {}
		if (pending.parsedInput != null) {
			input = pending.parsedInput
		} else if (pending.input) {
			try {
				input = JSON.parse(pending.input)
			} catch {
				input = this.extractPartialJsonFields(pending.input)
			}
		}

		const block = {
			type: "tool_use" as const,
			name: pending.name,
			input,
			signature: pending.signature,
			function_id: pending.function_id,
			dline_tid: pending.dline_tid,
			provider_metadata: pending.provider_metadata,
		}
		if (!this.loggedFinalizedFunctionIds.has(pending.function_id)) {
			this.loggedFinalizedFunctionIds.add(pending.function_id)
			Logger.debug(
				`[ToolUseHandler] finalized ${pending.name} function_id=${pending.function_id} keys=${Object.keys(input as object).join(",")}`,
			)
		}
		return block
	}

	getAllFinalizedToolUses(summary?: ClineAssistantToolUseBlock["reasoning_details"]): ClineAssistantToolUseBlock[] {
		const results: ClineAssistantToolUseBlock[] = []
		for (const id of this.pendingToolUses.keys()) {
			const toolUse = this.getFinalizedToolUse(id)
			if (toolUse) {
				results.push({ ...toolUse, reasoning_details: summary })
			}
		}
		return results
	}

	hasToolUse(id: string): boolean {
		return this.pendingToolUses.has(id)
	}

	getPartialToolUsesAsContent(): ToolUse[] {
		const results: ToolUse[] = []
		const pendingToolUses = this.pendingToolUses.values()

		for (const pending of pendingToolUses) {
			if (!pending.name) {
				continue
			}

			// Try to get the most up-to-date parsed input
			// Priority: parsedInput (from JSONParser) > fallback to manual parsing
			let input: any = {}
			if (pending.parsedInput != null) {
				input = pending.parsedInput
			} else if (pending.input) {
				// Try full JSON parse first
				try {
					input = JSON.parse(pending.input)
				} catch {
					// Fall back to extracting partial fields from incomplete JSON
					input = this.extractPartialJsonFields(pending.input)
				}
			}

			if (pending.name.includes(CLINE_MCP_TOOL_IDENTIFIER)) {
				const [key, toolName] = pending.name.split(CLINE_MCP_TOOL_IDENTIFIER)
				results.push({
					type: "tool_use",
					name: ClineDefaultTool.MCP_USE,
					params: {
						server_name: McpHub.getMcpServerByKey(key),
						tool_name: toolName,
						arguments: JSON.stringify(input),
					},
					partial: true,
					ts: pending.ts,
					isNativeToolCall: true,
					signature: pending.signature,
					function_id: pending.function_id,
					dline_tid: pending.dline_tid,
				})
			} else {
				const params: Record<string, string> = {}
				if (typeof input === "object" && input !== null) {
					for (const [key, value] of Object.entries(input)) {
						params[key] = typeof value === "string" ? value : JSON.stringify(value)
					}
				}
				results.push({
					type: "tool_use",
					name: pending.name as ClineDefaultTool,
					params: params as any,
					partial: true,
					ts: pending.ts,
					signature: pending.signature,
					isNativeToolCall: true,
					function_id: pending.function_id,
					dline_tid: pending.dline_tid,
				})
			}
		}
		// Ensure all returned tool uses are marked as partial
		return results.map((t) => ({ ...t, partial: true }))
	}

	reset(): void {
		this.pendingToolUses.clear()
	}

	private createPendingToolUse(
		name: string,
		identity: Pick<ApiStreamToolCallsChunk, "function_id" | "dline_tid" | "provider_metadata">,
	): PendingToolUse {
		const jsonParser = new JSONParser()
		jsonParser.onValue = (info: any) => {
			if (info.stack.length === 0 && info.value && typeof info.value === "object") {
				pending.parsedInput = info.value
			}
		}

		jsonParser.onError = () => {}

		const pending: PendingToolUse = {
			function_id: identity.function_id,
			dline_tid: identity.dline_tid,
			provider_metadata: identity.provider_metadata,
			name,
			input: "",
			parsedInput: undefined,
			jsonParser,
			signature: undefined,
			ts: this.tsFactory(),
		}

		this.pendingToolUses.set(identity.dline_tid, pending)
		// Initialize tool call in session tracking
		Session.get().updateToolCall(pending.function_id, pending.name)

		return pending
	}

	private extractPartialJsonFields(partialJson: string): Record<string, any> {
		const result: Record<string, any> = {}
		// Phase 1: Require closing quote for all fields.
		// Without the closing quote guard, truncated path values (e.g. "path":"s)
		// leak into handlePartialBlock, which opens the diff editor at the wrong path
		// and the real path is never applied because isEditing stays true.
		const closedPattern = /"(\w+)":\s*"((?:[^"\\]|\\.)*)"/g

		for (const match of partialJson.matchAll(closedPattern)) {
			result[match[1]] = match[2].replace(ESCAPE_PATTERN, (m) => ESCAPE_MAP[m])
		}

		// Phase 2: For long streaming fields, extract incremental
		// content from an unclosed string value so that partial rendering can show
		// growing text instead of waiting for the closing quote.
		// Includes: generic text fields (content, diff), compaction context
		// (summarize_task/new_task), and turn-ending tool response fields
		// (response for make_plan/qna_respond/act_mode_respond, result for attempt_completion).
		const streamingFields = ["context", "content", "diff", "response", "result"]
		for (const field of streamingFields) {
			if (result[field] !== undefined) {
				continue // already extracted with closed quote in Phase 1
			}
			// Match from the opening quote of the field value to end of string.
			// `$` anchors to end-of-string because partialJson is a single-line
			// accumulated JSON fragment with all newlines escaped as \n.
			const openPattern = new RegExp(`"${field}":\\s*"((?:[^"\\\\]|\\\\.)*)`)
			const match = partialJson.match(openPattern)
			if (match) {
				result[field] = match[1].replace(ESCAPE_PATTERN, (m) => ESCAPE_MAP[m])
			}
		}

		return result
	}
}

/**
 * Handles streaming reasoning content and converts it to the appropriate message format
 */
class ReasoningHandler {
	private pendingReasoning: PendingReasoning | null = null
	private received = false
	/** Fallback key counter for providers that omit a reasoning item id. */
	private anonymousRedactedCount = 0
	private reportedRedactedBudgetExhaustion = false

	processReasoningDelta(delta: ReasoningDelta): void {
		this.received = true

		// Initialize pending reasoning if we have an ID but no pending reasoning yet
		if (!this.pendingReasoning) {
			this.pendingReasoning = {
				provider_metadata: delta.provider_metadata,
				content: "",
				signature: "",
				redactedThinking: new EncryptedReasoningAccumulator(),
				summary: [],
			}
		}

		if (!this.pendingReasoning) {
			return
		}

		// Update fields from delta
		if (delta.reasoning) {
			this.pendingReasoning.content += delta.reasoning
		}
		if (delta.signature) {
			this.pendingReasoning.signature = delta.signature
		}
		if (delta.details) {
			if (Array.isArray(delta.details)) {
				this.pendingReasoning.summary.push(...delta.details)
			} else {
				this.pendingReasoning.summary.push(delta.details)
			}
		}
		if (delta.redacted_data) {
			const provider_metadata = delta.provider_metadata ?? this.pendingReasoning.provider_metadata
			// Refresh by provider item id so repeated in-progress snapshots of one reasoning item
			// replace each other instead of accumulating as distinct blocks.
			const itemId = provider_metadata?.response_id
			const block: ClineAssistantRedactedThinkingBlock = {
				type: "redacted_thinking",
				data: delta.redacted_data,
				provider_metadata,
			}
			const retained = this.pendingReasoning.redactedThinking.record(
				itemId ?? `anonymous:${this.anonymousRedactedCount++}`,
				block,
				delta.redacted_phase ?? "partial",
			)
			if (!retained && !this.reportedRedactedBudgetExhaustion) {
				this.reportedRedactedBudgetExhaustion = true
				Logger.warn("[Reasoning] Encrypted reasoning budget exhausted; dropping additional items for this response")
			}
		}
	}

	hasReceivedReasoning(): boolean {
		return this.received
	}

	getCurrentReasoning(): ClineAssistantThinkingBlock | null {
		if (!this.pendingReasoning) {
			return null
		}

		if (!this.pendingReasoning.summary.length && !this.pendingReasoning.content) {
			return null
		}

		// Ensure signature is set if it's hidden in the summary / reasoning details
		// to ensure it's always accessible at the top level by each provider.
		if (!this.pendingReasoning.signature && this.pendingReasoning.summary.length) {
			const lastSummary = this.pendingReasoning.summary.at(-1)
			if (lastSummary && typeof lastSummary === "object" && "signature" in lastSummary) {
				if (typeof lastSummary.signature === "string") {
					this.pendingReasoning.signature = lastSummary.signature
				}
			}
		}

		return {
			type: "thinking",
			thinking: this.pendingReasoning.content,
			signature: this.pendingReasoning.signature,
			summary: this.pendingReasoning.summary,
			provider_metadata: this.pendingReasoning.provider_metadata,
		}
	}

	getRedactedThinking(): ClineAssistantRedactedThinkingBlock[] {
		return this.pendingReasoning?.redactedThinking.blocks() ?? []
	}

	reset(): void {
		this.pendingReasoning = null
		this.received = false
		this.anonymousRedactedCount = 0
		this.reportedRedactedBudgetExhaustion = false
	}
}
