import { ApiHandler } from "@core/api"
import { getPrompt } from "@core/prompts/i18n"
import { formatResponse } from "@core/prompts/responses"
import { appendJsonl, writeJsonl } from "@core/storage/backend/jsonl/jsonl-utils"
import { GlobalFileNames } from "@core/storage/disk"
import { ClineApiReqInfo, ClineMessage } from "@shared/ExtensionMessage"
import { USER_CONTENT_TAGS } from "@shared/messages/constants"
import type {
	ClineAssistantToolUseBlock,
	ClineContent,
	ClineStorageMessage,
	ClineUserToolResultContentBlock,
} from "@shared/messages/content"
import cloneDeep from "clone-deep"
import fs from "fs/promises"
import * as path from "path"
import { Logger } from "@/shared/services/Logger"
import { isTurnEndingToolName } from "../../task/assistant-message-order"
import { createMissingToolResultMessage } from "../../task/resume/ResumeProvenance"
import { extractUserPromptFromContent } from "../../task/utils/extractUserPromptFromContent"
import type { CanonicalMessageRange } from "./compaction-context-projection"
import { collectContextWindowRequestPressures, getContextTokens, readContextTokens } from "./context-pressure"
import { resolveContextWindowProjection } from "./context-window-projection"
import {
	type CompactTriggerOptions,
	computeCompactTrigger,
	computeSummarizeBudget,
	getContextWindowInfo,
	shouldCompactProjectedUsage,
} from "./context-window-utils"

enum EditType {
	UNDEFINED = 0,
	NO_FILE_READ = 1,
	READ_FILE_TOOL = 2,
	ALTER_FILE_TOOL = 3,
	FILE_MENTION = 4,
}

// array of string values allows us to cover all changes for message types currently supported
type MessageContent = string[]
type MessageMetadata = string[][]

// Type for a single context update
type ContextUpdate = [number, string, MessageContent, MessageMetadata] // [timestamp, updateType, update, metadata]

// Type for the serialized format of our nested maps
type SerializedContextHistory = Array<
	[
		number, // messageIndex
		[
			number, // EditType (message type)
			Array<
				[
					number, // blockIndex
					ContextUpdate[], // updates array (now with 4 elements including metadata)
				]
			>,
		],
	]
>

type ContextHistoryRecord = { kind: "snapshot"; updates: SerializedContextHistory } | { kind: "truncate"; timestamp: number }

/** Keep the original task while dropping injected metadata from the first request. */
function extractInitialTaskBlock(text: string): string | undefined {
	const normalized = text.toLowerCase()
	const start = normalized.indexOf("<task>")
	if (start < 0) return undefined
	const closingTag = "</task>"
	const end = normalized.indexOf(closingTag, start + "<task>".length)
	if (end < 0) return undefined
	return text.slice(start, end + closingTag.length).trim()
}

const DLINE_FUNCTION_PREFIX = "dline_function_"

/** Identify a tool result created by Dline's non-native XML tool pipeline. */
function isDlineOwnedFunctionId(functionId: string): boolean {
	return functionId.startsWith(DLINE_FUNCTION_PREFIX)
}

/** Serialize a Dline-owned tool result before demoting it to ordinary user text. */
function serializeToolResultContent(block: ClineUserToolResultContentBlock): string {
	return typeof block.content === "string" ? block.content : JSON.stringify(block.content)
}

/** Recover only explicitly tagged user input before discarding an orphaned result. */
function extractTaggedUserPrompt(block: ClineUserToolResultContentBlock): string | undefined {
	const resultContent =
		typeof block.content === "string" ? ([{ type: "text", text: block.content }] satisfies ClineContent[]) : block.content
	const taggedText = resultContent.filter(
		(candidate) =>
			candidate.type === "text" &&
			USER_CONTENT_TAGS.some((tag) => candidate.text.toLowerCase().includes(tag.toLowerCase())),
	) as ClineContent[]
	const prompt = extractUserPromptFromContent(taggedText)
	return prompt || undefined
}

export class ContextManager {
	// mapping from the apiMessages outer index to the inner message index to a list of actual changes, ordered by timestamp
	// timestamp is required in order to support full checkpointing, where the changes we apply need to be able to be undone when
	// moving to an earlier conversation history checkpoint - this ordering intuitively allows for binary search on truncation
	// there is also a number stored for each (EditType) which defines which message type it is, for custom handling

	// format:  { outerIndex => [EditType, { innerIndex => [[timestamp, updateType, update], ...] }] }
	// example: { 1 => { [0, 0 => [[<timestamp>, "text", "[NOTE] Some previous conversation history with the user has been removed ..."], ...] }] }
	// the above example would be how we update the first assistant message to indicate we truncated text
	private contextHistoryUpdates: Map<number, [number, Map<number, ContextUpdate[]>]>

	constructor() {
		this.contextHistoryUpdates = new Map()
	}

	/**
	 * Extracts text from a content block, handling both regular text blocks and tool_result wrappers.
	 * For tool_result blocks, extracts text from content[0] (native tool calling format).
	 * @returns The text content, or null if no text could be extracted
	 */
	private getTextFromBlock(block: ClineContent): string | null {
		if (block.type === "text") {
			return block.text
		}
		if (block.type === "tool_result" && Array.isArray(block.content)) {
			const inner = block.content[0]
			if (inner && "type" in inner && inner.type === "text") {
				return inner.text
			}
		}
		return null
	}

	/**
	 * Sets text in a content block, handling both regular text blocks and tool_result wrappers.
	 * For tool_result blocks, sets text in content[0] (native tool calling format).
	 * @returns true if text was set successfully, false otherwise
	 */
	private setTextInBlock(block: ClineContent, text: string): boolean {
		if (block.type === "text") {
			block.text = text
			return true
		}
		if (block.type === "tool_result" && Array.isArray(block.content)) {
			const inner = block.content[0]
			if (inner && "type" in inner && inner.type === "text") {
				inner.text = text
				return true
			}
		}
		return false
	}

	/**
	 * public function for loading contextHistoryUpdates from disk, if it exists
	 */
	async initializeContextHistory(taskDirectory: string) {
		this.contextHistoryUpdates = await this.getSavedContextHistory(taskDirectory)
	}

	/**
	 * get the stored context history updates from disk (JSONL format)
	 */
	private async getSavedContextHistory(taskDirectory: string): Promise<Map<number, [number, Map<number, ContextUpdate[]>]>> {
		try {
			const filePath = path.join(taskDirectory, GlobalFileNames.contextHistory)
			const entries = await readContextHistoryRecords(filePath)
			let restored = new Map<number, [number, Map<number, ContextUpdate[]>]>()
			for (const entry of entries) {
				if (entry.kind === "snapshot") {
					restored = deserializeContextHistory(entry.updates)
					continue
				}
				if (Number.isFinite(entry.timestamp)) this.truncateContextHistoryAtTimestamp(restored, entry.timestamp)
			}
			return restored
		} catch (error) {
			Logger.error("Failed to load context history:", error instanceof Error ? error.message : String(error))
			// Self-heal: delete corrupt file
			try {
				await fs.unlink(path.join(taskDirectory, GlobalFileNames.contextHistory))
			} catch {
				// File may not exist — ignore
			}
		}
		return new Map()
	}

	/**
	 * save the context history updates to disk (JSONL format)
	 */
	private async saveContextHistory(taskDirectory: string) {
		try {
			const serializedUpdates: SerializedContextHistory = Array.from(this.contextHistoryUpdates.entries()).map(
				([messageIndex, [numberValue, innerMap]]) => [messageIndex, [numberValue, Array.from(innerMap.entries())]],
			)

			await writeJsonl<ContextHistoryRecord>(path.join(taskDirectory, GlobalFileNames.contextHistory), [
				{ kind: "snapshot", updates: serializedUpdates },
			])
		} catch (error) {
			Logger.error("Failed to save context history:", error)
		}
	}

	/**
	 * Determine whether we should compact context window, based on token counts.
	 *
	 * Only request pressure recorded after the latest completed compaction counts: the summary
	 * replaced everything before that boundary, so pre-compaction Provider occupancy no longer
	 * measures the live context. Reading it would re-compact a summary-only history, for example
	 * when the first post-compaction request fails before reporting fresh usage and is retried.
	 */
	shouldCompactContextWindow(
		clineMessages: ClineMessage[],
		api: ApiHandler,
		previousApiReqIndex: number,
		triggerOptions: CompactTriggerOptions = {},
	): boolean {
		if (previousApiReqIndex < 0) return false

		const requestInfos = collectContextWindowRequestPressures(clineMessages.slice(0, previousApiReqIndex + 1))
		if (requestInfos.length === 0) return false

		const { contextWindow } = getContextWindowInfo(api)
		const triggerTokens = computeCompactTrigger(contextWindow, computeSummarizeBudget(), triggerOptions)
		return resolveContextWindowProjection({
			requestInfos,
			candidateEstimatedTokens: 0,
			candidateDeltaTokens: 0,
			contextWindow,
			triggerTokens,
		}).shouldCompact
	}

	/**
	 * Get telemetry data for context management decisions
	 * Returns the token counts and context window info that drove summarization
	 */
	getContextTelemetryData(
		clineMessages: ClineMessage[],
		api: ApiHandler,
		triggerIndex?: number,
	): {
		tokensUsed: number
		maxContextWindow: number
	} | null {
		// Use provided triggerIndex or fallback to automatic detection
		let targetIndex: number
		if (triggerIndex !== undefined) {
			targetIndex = triggerIndex
		} else {
			// Find all API request indices
			const apiReqIndices = clineMessages
				.map((msg, index) => (msg.say === "api_req_started" ? index : -1))
				.filter((index) => index !== -1)

			// We want the second-to-last API request (the one that caused summarization)
			targetIndex = apiReqIndices.length >= 2 ? apiReqIndices[apiReqIndices.length - 2] : -1
		}

		if (targetIndex >= 0) {
			const targetRequestText = clineMessages[targetIndex]?.text
			if (targetRequestText) {
				try {
					const tokensUsed = readContextTokens(targetRequestText)

					const { contextWindow } = getContextWindowInfo(api)

					return {
						tokensUsed,
						maxContextWindow: contextWindow,
					}
				} catch (error) {
					Logger.error("Error parsing API request info for context telemetry:", error)
				}
			}
		}
		return null
	}

	/**
	 * primary entry point for getting up to date context
	 */
	async getNewContextMessagesAndMetadata(
		apiConversationHistory: ClineStorageMessage[],
		clineMessages: ClineMessage[],
		api: ApiHandler,
		conversationHistoryDeletedRange: [number, number] | undefined,
		previousApiReqIndex: number,
		taskDirectory: string,
		useAutoCondense: boolean, // option to use new auto-condense or old programmatic context management
		triggerOptions: CompactTriggerOptions = {},
	) {
		let updatedConversationHistoryDeletedRange = false

		if (!useAutoCondense) {
			// If the previous API request's total token usage is close to the context window, truncate the conversation history to free up space for the new request
			if (previousApiReqIndex >= 0) {
				const previousRequestText = clineMessages[previousApiReqIndex]?.text
				if (previousRequestText) {
					const timestamp = clineMessages[previousApiReqIndex].ts
					const requestInfo: ClineApiReqInfo = JSON.parse(previousRequestText)
					const totalTokens = getContextTokens(requestInfo)
					const { contextWindow } = getContextWindowInfo(api)
					const triggerTokens = computeCompactTrigger(contextWindow, computeSummarizeBudget(), triggerOptions)

					// Use the same input-context trigger as auto-condense to avoid early standard truncation.
					if (shouldCompactProjectedUsage(totalTokens, triggerTokens)) {
						// Since the user may switch between models with different context windows, truncating half may not be enough (ie if switching from claude 200k to deepseek 64k, half truncation will only remove 100k tokens, but we need to remove much more)
						// So if totalTokens/2 is greater than triggerTokens, we truncate 3/4 instead of 1/2
						const keep = totalTokens / 2 > triggerTokens ? "quarter" : "half"

						// Attempt file read optimization and check if we need to truncate
						let { anyContextUpdates, needToTruncate } = this.attemptFileReadOptimizationCore(
							apiConversationHistory,
							conversationHistoryDeletedRange,
							timestamp,
						)

						if (needToTruncate) {
							// go ahead with truncation
							anyContextUpdates = this.applyStandardContextTruncationNoticeChange(timestamp) || anyContextUpdates

							// NOTE: it's okay that we overwriteConversationHistory in resume task since we're only ever removing the last user message and not anything in the middle which would affect this range
							conversationHistoryDeletedRange = this.getNextTruncationRange(
								apiConversationHistory,
								conversationHistoryDeletedRange,
								keep,
							)

							updatedConversationHistoryDeletedRange = true
						}

						// if we alter the context history, save the updated version to disk
						if (anyContextUpdates) {
							await this.saveContextHistory(taskDirectory)
						}
					}
				}
			}
		}

		const truncatedConversationHistory = this.getAndAlterTruncatedMessages(
			apiConversationHistory,
			conversationHistoryDeletedRange,
		)

		return {
			conversationHistoryDeletedRange: conversationHistoryDeletedRange,
			updatedConversationHistoryDeletedRange: updatedConversationHistoryDeletedRange,
			truncatedConversationHistory: truncatedConversationHistory,
		}
	}

	/**
	 * get truncation range
	 */
	public getNextTruncationRange(
		apiMessages: ClineStorageMessage[],
		currentDeletedRange: [number, number] | undefined,
		keep: "none" | "lastTwo" | "half" | "quarter",
	): [number, number] {
		// We always keep the first user-assistant pairing, and truncate an even number of messages from there
		const rangeStartIndex = 2 // index 0 and 1 are kept
		const startOfRest = currentDeletedRange ? currentDeletedRange[1] + 1 : 2 // inclusive starting index

		let messagesToRemove: number
		if (keep === "none") {
			// Removes all messages beyond the first core user/assistant message pair
			messagesToRemove = Math.max(apiMessages.length - startOfRest, 0)
		} else if (keep === "lastTwo") {
			// Keep the last user-assistant pair in addition to the first core user/assistant message pair
			messagesToRemove = Math.max(apiMessages.length - startOfRest - 2, 0)
		} else if (keep === "half") {
			// Remove half of remaining user-assistant pairs
			// We first calculate half of the messages then divide by 2 to get the number of pairs.
			// After flooring, we multiply by 2 to get the number of messages.
			// Note that this will also always be an even number.
			messagesToRemove = Math.floor((apiMessages.length - startOfRest) / 4) * 2 // Keep even number
		} else {
			// Remove 3/4 of remaining user-assistant pairs
			// We calculate 3/4ths of the messages then divide by 2 to get the number of pairs.
			// After flooring, we multiply by 2 to get the number of messages.
			// Note that this will also always be an even number.
			messagesToRemove = Math.floor(((apiMessages.length - startOfRest) * 3) / 4 / 2) * 2
		}

		let rangeEndIndex = startOfRest + messagesToRemove - 1 // inclusive ending index

		// Make sure that the last message being removed is a assistant message, so the next message after the initial user-assistant pair is an assistant message. This preserves the user-assistant-user-assistant structure.
		// NOTE: anthropic format messages are always user-assistant-user-assistant, while openai format messages can have multiple user messages in a row (we use anthropic format throughout cline)
		if (apiMessages[rangeEndIndex] && apiMessages[rangeEndIndex].role !== "assistant") {
			rangeEndIndex -= 1
		}

		// this is an inclusive range that will be removed from the conversation history
		return [rangeStartIndex, rangeEndIndex]
	}

	/**
	 * external interface to support old calls
	 */
	public getTruncatedMessages(
		messages: ClineStorageMessage[],
		deletedRange: [number, number] | undefined,
	): ClineStorageMessage[] {
		return this.getAndAlterTruncatedMessages(messages, deletedRange)
	}

	/** Apply index-preserving context-history edits before a canonical range projection. */
	public applyContextHistoryUpdatesToCanonical(messages: ClineStorageMessage[]): ClineStorageMessage[] {
		return this.applyContextHistoryUpdates(messages, 2)
	}

	/** Apply the provider pairing repairs to an already projected in-memory history. */
	public repairProviderMessages(messages: ClineStorageMessage[]): ClineStorageMessage[] {
		this.removeOrphanedToolResults(messages)
		this.ensureToolResultsFollowToolUse(messages)
		return messages
	}

	/** Repair provider messages while preserving an aligned canonical range mapping. */
	public repairProviderMessagesWithRanges(
		messages: ClineStorageMessage[],
		canonicalRanges: Array<CanonicalMessageRange | undefined>,
	): { messages: ClineStorageMessage[]; canonicalRanges: Array<CanonicalMessageRange | undefined> } {
		if (messages.length !== canonicalRanges.length) {
			throw new Error("Provider message canonical range mapping must align before repair")
		}
		this.removeOrphanedToolResults(messages)
		this.ensureToolResultsFollowToolUse(messages, canonicalRanges)
		return { messages, canonicalRanges }
	}

	/**
	 * apply all required truncation methods to the messages in context
	 */
	private getAndAlterTruncatedMessages(
		messages: ClineStorageMessage[],
		deletedRange: [number, number] | undefined,
	): ClineStorageMessage[] {
		if (messages.length <= 1) {
			return messages
		}

		const updatedMessages = this.applyContextHistoryUpdates(messages, deletedRange ? deletedRange[1] + 1 : 2)

		// Remove results whose declaring tool use is no longer in the provider-ready history.
		this.removeOrphanedToolResults(updatedMessages)
		// Validate and fix tool_use/tool_result pairing.
		this.ensureToolResultsFollowToolUse(updatedMessages)

		// OLD NOTE: if you try to Logger log these, don't forget that logging a reference to an array may not provide the same result as logging a slice() snapshot of that array at that exact moment. The following DOES in fact include the latest assistant message.
		return updatedMessages
	}

	/**
	 * Resolve the provider-neutral pairing identity for a stored tool use.
	 *
	 * @param block Stored assistant tool-use block.
	 * @returns Canonical function identity, with the legacy Anthropic id as fallback.
	 */
	private getToolFunctionId(block: ClineAssistantToolUseBlock): string {
		return block.function_id
	}

	/**
	 * Resolve the provider-neutral pairing identity for a stored tool result.
	 *
	 * @param block Stored user tool-result block.
	 * @returns Canonical function identity.
	 */
	private getResultFunctionId(block: ClineUserToolResultContentBlock): string {
		return block.function_id
	}

	/** Build a provider-projectable result for a tool call whose real result was lost. */
	private createSyntheticToolResult(
		functionId: string,
		toolBlock: ClineAssistantToolUseBlock | undefined,
		text: string,
	): ClineUserToolResultContentBlock {
		return {
			type: "tool_result",
			function_id: functionId,
			dline_tid: toolBlock?.dline_tid ?? `recovered:${functionId}`,
			content: [{ type: "text", text }],
		}
	}

	/** Remove tool results that do not belong to the immediately preceding assistant message. */
	private removeOrphanedToolResults(messages: ClineStorageMessage[]): void {
		for (let index = 0; index < messages.length; index++) {
			const message = messages[index]
			if (message.role !== "user" || !Array.isArray(message.content)) {
				continue
			}

			const previousMessage = messages[index - 1]
			const validToolUseIds = new Set<string>()
			if (previousMessage?.role === "assistant" && Array.isArray(previousMessage.content)) {
				for (const block of previousMessage.content) {
					if (block.type === "tool_use") {
						validToolUseIds.add(this.getToolFunctionId(block))
					}
				}
			}

			const retainedContent: ClineContent[] = []
			const preservedUserPrompts: string[] = []
			let removedOrphan = false
			for (const block of message.content) {
				if (block.type !== "tool_result" || validToolUseIds.has(this.getResultFunctionId(block))) {
					retainedContent.push(block)
					continue
				}

				removedOrphan = true
				if (isDlineOwnedFunctionId(this.getResultFunctionId(block))) {
					const demotedOutput = serializeToolResultContent(block)
					if (demotedOutput) {
						retainedContent.push({ type: "text", text: demotedOutput })
					}
					continue
				}

				const preservedPrompt = extractTaggedUserPrompt(block)
				if (preservedPrompt) {
					preservedUserPrompts.push(preservedPrompt)
				}
			}

			if (!removedOrphan) {
				continue
			}
			if (preservedUserPrompts.length > 0) {
				retainedContent.unshift({ type: "text", text: preservedUserPrompts.join("\n\n") })
			}

			const clonedMessage = cloneDeep(message)
			clonedMessage.content = retainedContent
			messages[index] = clonedMessage
		}
	}

	/**
	 * Ensures that every tool_use block in assistant messages has a corresponding tool_result in the next user message,
	 * and that tool_result blocks immediately follow their corresponding tool_use blocks.
	 */
	private ensureToolResultsFollowToolUse(
		messages: ClineStorageMessage[],
		canonicalRanges?: Array<CanonicalMessageRange | undefined>,
	): void {
		for (let i = 0; i < messages.length - 1; i++) {
			const message = messages[i]

			// Only process assistant messages with content
			if (message.role !== "assistant" || !Array.isArray(message.content)) {
				continue
			}

			// Extract provider-neutral function identities in order.
			const toolUseIds: string[] = []
			for (const block of message.content) {
				if (block.type === "tool_use") {
					toolUseIds.push(this.getToolFunctionId(block))
				}
			}

			// Skip if no tool_use blocks found
			if (toolUseIds.length === 0) {
				continue
			}

			const nextMessage = messages[i + 1]

			// If next message is not a user message (e.g., consecutive assistants due to race condition),
			// insert synthetic tool_results for unpaired tool_uses and continue processing.
			if (nextMessage.role !== "user") {
				// Collect unpaired tool_use IDs for this assistant
				const unpairedIds: string[] = []
				for (const block of message.content) {
					if (block.type === "tool_use") {
						unpairedIds.push(this.getToolFunctionId(block))
					}
				}
				if (unpairedIds.length === 0) {
					continue
				}

				// Build synthetic tool_results for all unpaired tool_uses
				const syntheticResults: ClineUserToolResultContentBlock[] = []
				for (const toolUseId of unpairedIds) {
					const toolBlock = message.content.find(
						(block): block is ClineAssistantToolUseBlock =>
							block.type === "tool_use" && this.getToolFunctionId(block) === toolUseId,
					)
					const toolName = toolBlock?.name || "unknown"
					const isTurnEnding = isTurnEndingToolName(toolName)
					const resultContent = isTurnEnding
						? `Tool ${toolName} executed successfully.`
						: getPrompt("contextManagement", "raceConditionToolError")
					syntheticResults.push(this.createSyntheticToolResult(toolUseId, toolBlock, resultContent))
				}

				// Insert a synthetic user message with tool_results between the two assistants
				const syntheticUserMsg: ClineStorageMessage = {
					role: "user",
					content: syntheticResults,
				}
				messages.splice(i + 1, 0, syntheticUserMsg)
				canonicalRanges?.splice(i + 1, 0, undefined)
				// Retry this iteration with the newly inserted user message
				i--
				continue
			}

			// Ensure content is an array
			if (!Array.isArray(nextMessage.content)) {
				nextMessage.content = []
			}

			// Separate tool_results from other blocks.
			// Use Map to deduplicate by canonical function identity — duplicates can
			// appear when the same tool executes twice (e.g. partial + reRender lifecycle bug).
			// Only the last occurrence is kept; dedup is always performed even when
			// no other repair is needed, to prevent "tool messages following
			// tool_calls" mismatches that DeepSeek/OpenAI-compatible APIs reject.
			const toolResultMap = new Map<string, ClineUserToolResultContentBlock>()
			let hasDuplicates = false
			let normalizedIdentity = false
			// Providers require the answering tool_results to lead the user message.
			// Persisted histories can violate this when a tool pushed its own block
			// (e.g. read_file pushing an image) before its result was recorded.
			let hasMisorderedResult = false
			let sawNonResultBlock = false

			for (const block of nextMessage.content) {
				if (block.type !== "tool_result") {
					sawNonResultBlock = true
				} else if (sawNonResultBlock) {
					hasMisorderedResult = true
				}
				if (block.type === "tool_result") {
					const functionId = this.getResultFunctionId(block)
					const storedResult = block as ClineUserToolResultContentBlock
					const pairedUse = message.content.find(
						(candidate): candidate is ClineAssistantToolUseBlock =>
							candidate.type === "tool_use" && this.getToolFunctionId(candidate) === functionId,
					)
					const pairedDlineTid = pairedUse?.dline_tid
					const normalizedResult: ClineUserToolResultContentBlock = {
						...storedResult,
						function_id: functionId,
						...(storedResult.dline_tid || !pairedDlineTid ? {} : { dline_tid: pairedDlineTid }),
					}
					if (
						storedResult.function_id !== normalizedResult.function_id ||
						storedResult.dline_tid !== normalizedResult.dline_tid
					) {
						normalizedIdentity = true
					}
					if (toolResultMap.has(functionId)) {
						hasDuplicates = true
						const toolBlock = message.content.find(
							(candidate): candidate is ClineAssistantToolUseBlock =>
								candidate.type === "tool_use" && this.getToolFunctionId(candidate) === functionId,
						)
						Logger.warn(
							`ContextManager: duplicate tool_result for function_id=${functionId} ` +
								`tool=${toolBlock?.name ?? "unknown"}`,
						)
					}
					toolResultMap.set(functionId, normalizedResult)
				}
			}

			// Add missing tool_results.
			// Turn-ending tools (attempt_completion, ask_followup_question, make_plan)
			// do not produce results, so provide a success message. Non-turn-ending
			// synthetic results are reserved for genuinely missing history entries.
			let needsUpdate = normalizedIdentity
			for (const toolUseId of toolUseIds) {
				if (!toolResultMap.has(toolUseId)) {
					const toolBlock = message.content.find(
						(block): block is ClineAssistantToolUseBlock =>
							block.type === "tool_use" && this.getToolFunctionId(block) === toolUseId,
					)
					const toolName = toolBlock?.name || "unknown"
					const isTurnEnding = isTurnEndingToolName(toolName)

					if (isTurnEnding) {
						// Turn-ending tools never produce a result — inject success message
						toolResultMap.set(
							toolUseId,
							this.createSyntheticToolResult(toolUseId, toolBlock, `Tool ${toolName} executed successfully.`),
						)
						needsUpdate = true
					} else {
						// Missing results after truncation still require a synthetic pair
						// so providers do not reject the repaired history. Canonical runtime
						// results are already keyed by function_id and are never guessed here.
						if (!toolResultMap.has(toolUseId)) {
							toolResultMap.set(
								toolUseId,
								this.createSyntheticToolResult(toolUseId, toolBlock, createMissingToolResultMessage(toolName)),
							)
							needsUpdate = true
						}
					}
				}
			}

			// Force reorder when duplicates exist, even if no repair was needed.
			// Without this, duplicate tool_results for the same function_id are
			// passed through to the API and produce "Messages with role 'tool'
			// must be a response to a preceding message with 'tool_calls'".
			if (!needsUpdate && !hasDuplicates && !hasMisorderedResult) {
				continue
			}

			// Reorder: tool_results first (in toolUseIds order), then other blocks.
			// This is only done when we actually modified content, so it does not
			// break context caching on normal (no-op) requests.
			const newContent: ClineContent[] = []
			for (const toolUseId of toolUseIds) {
				const toolResult = toolResultMap.get(toolUseId)
				if (toolResult) {
					newContent.push(toolResult)
				}
			}
			for (const block of nextMessage.content) {
				if (block.type === "tool_result") {
					// Already added above in provider-neutral function identity order.
				} else {
					newContent.push(block)
				}
			}

			const clonedMessage = cloneDeep(nextMessage)
			clonedMessage.content = newContent
			messages[i + 1] = clonedMessage
		}
	}

	/**
	 * applies deletedRange truncation and other alterations based on changes in this.contextHistoryUpdates
	 */
	private applyContextHistoryUpdates(messages: ClineStorageMessage[], startFromIndex: number): ClineStorageMessage[] {
		// runtime is linear in length of user messages, if expecting a limited number of alterations, could be more optimal to loop over alterations

		const firstChunk = messages.slice(0, 2) // get first user-assistant pair
		const secondChunk = messages.slice(startFromIndex) // get remaining messages within context
		const messagesToUpdate = [...firstChunk, ...secondChunk]

		// we need the mapping from the local indices in messagesToUpdate to the global array of updates in this.contextHistoryUpdates
		const originalIndices = [
			...Array(2).keys(),
			...Array(secondChunk.length)
				.fill(0)
				.map((_, i) => i + startFromIndex),
		]

		for (let arrayIndex = 0; arrayIndex < messagesToUpdate.length; arrayIndex++) {
			const messageIndex = originalIndices[arrayIndex]

			const innerTuple = this.contextHistoryUpdates.get(messageIndex)
			if (!innerTuple) {
				continue
			}

			// because we are altering this, we need a deep copy
			messagesToUpdate[arrayIndex] = cloneDeep(messagesToUpdate[arrayIndex])

			// Extract the map from the tuple
			const innerMap = innerTuple[1]
			for (const [blockIndex, changes] of innerMap) {
				// apply the latest change among n changes - [timestamp, updateType, update]
				const latestChange = changes[changes.length - 1]

				if (latestChange[1] === "text") {
					// only altering text for now
					const message = messagesToUpdate[arrayIndex]

					if (Array.isArray(message.content)) {
						const block = message.content[blockIndex]
						if (block) {
							const text = latestChange[2][0]
							const didSetText = this.setTextInBlock(block, text)
							if (!didSetText && messageIndex === 1 && blockIndex === 0 && message.role === "assistant") {
								message.content.unshift({ type: "text", text })
							}
						}
					}
				}
			}
		}

		return messagesToUpdate
	}

	/**
	 * removes all context history updates that occurred after the specified timestamp and saves to disk
	 */
	async truncateContextHistory(timestamp: number, taskDirectory: string): Promise<void> {
		this.truncateContextHistoryAtTimestamp(this.contextHistoryUpdates, timestamp)
		try {
			await appendJsonl<ContextHistoryRecord>(path.join(taskDirectory, GlobalFileNames.contextHistory), {
				kind: "truncate",
				timestamp,
			})
		} catch (error) {
			Logger.error("Failed to append context history truncation:", error)
		}
	}

	/**
	 * alters the context history to remove all alterations after a given timestamp
	 * removes the index if there are no alterations there anymore, both outer and inner indices
	 */
	private truncateContextHistoryAtTimestamp(
		contextHistory: Map<number, [number, Map<number, ContextUpdate[]>]>,
		timestamp: number,
	): void {
		for (const [messageIndex, [_, innerMap]] of contextHistory) {
			// track which blockIndices to delete
			const blockIndicesToDelete: number[] = []

			// loop over the innerIndices of the messages in this block
			for (const [blockIndex, updates] of innerMap) {
				// updates ordered by timestamp, so find cutoff point by iterating from right to left
				let cutoffIndex = updates.length - 1
				while (cutoffIndex >= 0 && updates[cutoffIndex][0] > timestamp) {
					cutoffIndex--
				}

				// If we found updates to remove
				if (cutoffIndex < updates.length - 1) {
					// Modify the array in place to keep only updates up to cutoffIndex
					updates.length = cutoffIndex + 1

					// If no updates left after truncation, mark this block for deletion
					if (updates.length === 0) {
						blockIndicesToDelete.push(blockIndex)
					}
				}
			}

			// Remove empty blocks from inner map
			for (const blockIndex of blockIndicesToDelete) {
				innerMap.delete(blockIndex)
			}

			// If inner map is now empty, remove the message index from outer map
			if (innerMap.size === 0) {
				contextHistory.delete(messageIndex)
			}
		}
	}

	/**
	 * applies the context optimization steps and returns whether any changes were made
	 */
	public applyContextOptimizations(
		apiMessages: ClineStorageMessage[],
		startFromIndex: number,
		timestamp: number,
	): [boolean, Set<number>] {
		const [fileReadUpdatesBool, uniqueFileReadIndices] = this.findAndPotentiallySaveFileReadContextHistoryUpdates(
			apiMessages,
			startFromIndex,
			timestamp,
		)

		// true if any context optimization steps alter state
		const contextHistoryUpdated = fileReadUpdatesBool

		return [contextHistoryUpdated, uniqueFileReadIndices]
	}

	/**
	 * Private helper that attempts file read optimization and checks threshold.
	 */
	private attemptFileReadOptimizationCore(
		apiConversationHistory: ClineStorageMessage[],
		conversationHistoryDeletedRange: [number, number] | undefined,
		timestamp: number,
	): {
		anyContextUpdates: boolean
		needToTruncate: boolean
	} {
		const startIndex = conversationHistoryDeletedRange ? conversationHistoryDeletedRange[1] + 1 : 2

		const [anyContextUpdates, uniqueFileReadIndices] = this.applyContextOptimizations(
			apiConversationHistory,
			startIndex,
			timestamp,
		)

		if (!anyContextUpdates) {
			return { anyContextUpdates: false, needToTruncate: true }
		}

		const percentSaved = this.calculateContextOptimizationMetrics(
			apiConversationHistory,
			conversationHistoryDeletedRange,
			uniqueFileReadIndices,
		)

		return {
			anyContextUpdates: true,
			needToTruncate: percentSaved < 0.3,
		}
	}

	/**
	 * Public helper that attempts file read optimization and saves to disk.
	 */
	async attemptFileReadOptimization(
		apiConversationHistory: ClineStorageMessage[],
		conversationHistoryDeletedRange: [number, number] | undefined,
		clineMessages: ClineMessage[],
		previousApiReqIndex: number,
		taskDirectory: string,
	): Promise<boolean> {
		// Extract timestamp using same logic as getNewContextMessagesAndMetadata
		if (previousApiReqIndex < 0) {
			return true
		}

		const previousRequest = clineMessages[previousApiReqIndex]
		if (!previousRequest?.text) {
			return true
		}

		const timestamp = previousRequest.ts
		const originalContextHistoryUpdates = cloneDeep(this.contextHistoryUpdates)

		const { anyContextUpdates, needToTruncate } = this.attemptFileReadOptimizationCore(
			apiConversationHistory,
			conversationHistoryDeletedRange,
			timestamp,
		)

		if (needToTruncate) {
			this.contextHistoryUpdates = originalContextHistoryUpdates
			return true
		}

		if (anyContextUpdates) {
			await this.saveContextHistory(taskDirectory)
		}

		return false
	}

	/**
	 * Public helper that attempts file read optimization in memory without persisting context history.
	 */
	public attemptFileReadOptimizationInMemory(
		apiConversationHistory: ClineStorageMessage[],
		conversationHistoryDeletedRange: [number, number] | undefined,
		timestamp: number,
	): {
		anyContextUpdates: boolean
		needToTruncate: boolean
		optimizedConversationHistory: ClineStorageMessage[]
	} {
		const { anyContextUpdates, needToTruncate } = this.attemptFileReadOptimizationCore(
			apiConversationHistory,
			conversationHistoryDeletedRange,
			timestamp,
		)

		if (!anyContextUpdates) {
			return {
				anyContextUpdates: false,
				needToTruncate: true,
				optimizedConversationHistory: apiConversationHistory,
			}
		}

		return {
			anyContextUpdates: true,
			needToTruncate,
			optimizedConversationHistory: this.getTruncatedMessages(apiConversationHistory, conversationHistoryDeletedRange),
		}
	}

	/**
	 * Public function for triggering potentially setting the truncation message
	 * If the truncation message already exists, does nothing, otherwise adds the message
	 */
	async triggerApplyStandardContextTruncationNoticeChange(
		timestamp: number,
		taskDirectory: string,
		apiConversationHistory: ClineStorageMessage[],
	) {
		const assistantUpdated = this.applyStandardContextTruncationNoticeChange(timestamp)
		const userUpdated = this.applyFirstUserMessageReplacement(timestamp, apiConversationHistory)
		if (assistantUpdated || userUpdated) {
			await this.saveContextHistory(taskDirectory)
		}
	}

	/**
	 * if there is any truncation and there is no other alteration already set, alter the assistant message to indicate this occurred
	 */
	private applyStandardContextTruncationNoticeChange(timestamp: number): boolean {
		if (!this.contextHistoryUpdates.has(1)) {
			// first assistant message always at index 1
			const innerMap = new Map<number, ContextUpdate[]>()
			innerMap.set(0, [[timestamp, "text", [formatResponse.contextTruncationNotice()], []]])
			this.contextHistoryUpdates.set(1, [0, innerMap]) // EditType is undefined for first assistant message
			return true
		}
		return false
	}

	/**
	 * Replace the first user message when context window is compacted
	 */
	private applyFirstUserMessageReplacement(timestamp: number, apiConversationHistory: ClineStorageMessage[]): boolean {
		if (!this.contextHistoryUpdates.has(0)) {
			try {
				// choosing to be extra careful here, but likely not required
				let firstUserMessage = ""

				const message = apiConversationHistory[0]
				if (Array.isArray(message.content)) {
					const block = message.content[0]
					if (block && block.type === "text") {
						firstUserMessage = block.text
					}
				}

				if (firstUserMessage) {
					const processedFirstUserMessage =
						extractInitialTaskBlock(firstUserMessage) ?? formatResponse.processFirstUserMessageForTruncation()

					const innerMap = new Map<number, ContextUpdate[]>()
					innerMap.set(0, [[timestamp, "text", [processedFirstUserMessage], []]])
					this.contextHistoryUpdates.set(0, [0, innerMap]) // same EditType as first assistant truncation notice

					return true
				}
			} catch (error) {
				Logger.error("applyFirstUserMessageReplacement:", error)
			}
		}
		return false
	}

	/**
	 * wraps the logic for determining file reads to overwrite, and altering state
	 * returns whether any updates were made (bool) and indices where updates were made
	 */
	private findAndPotentiallySaveFileReadContextHistoryUpdates(
		apiMessages: ClineStorageMessage[],
		startFromIndex: number,
		timestamp: number,
	): [boolean, Set<number>] {
		const [fileReadIndices, messageFilePaths] = this.getPossibleDuplicateFileReads(apiMessages, startFromIndex)
		return this.applyFileReadContextHistoryUpdates(fileReadIndices, messageFilePaths, apiMessages, timestamp)
	}

	/**
	 * generate a mapping from unique file reads from multiple tool calls to their outer index position(s)
	 * also return additional metadata to support multiple file reads in file mention text blocks
	 */
	private getPossibleDuplicateFileReads(
		apiMessages: ClineStorageMessage[],
		startFromIndex: number,
	): [Map<string, [number, number, string, string, number][]>, Map<number, string[]>] {
		// fileReadIndices: { fileName => [outerIndex, EditType, searchText, replaceText, innerIndex] }
		// messageFilePaths: { outerIndex => [fileRead1, fileRead2, ..] }
		// searchText in fileReadIndices is only required for file mention file-reads since there can be more than one file in the text
		// searchText will be the empty string "" in the case that it's not required, for non-file mentions
		// messageFilePaths is only used for file mentions as there can be multiple files read in the same text chunk

		// for all text blocks per file, has info for updating the block
		// originally our messages were formatted where the innerIndex was consistently at index=1, but that is no longer the case
		// which is why we now need to support both an outerIndex and innerIndex in this mapping
		const fileReadIndices = new Map<string, [number, number, string, string, number][]>()

		// for file mention text blocks, track all the unique files read
		const messageFilePaths = new Map<number, string[]>()

		for (let i = startFromIndex; i < apiMessages.length; i++) {
			let thisExistingFileReads: string[] = []

			if (this.contextHistoryUpdates.has(i)) {
				const innerTuple = this.contextHistoryUpdates.get(i)

				if (innerTuple) {
					// safety check
					const editType = innerTuple[0]

					if (editType === EditType.FILE_MENTION) {
						const innerMap = innerTuple[1]

						// Get the first entry from the innerMap since we only process one inner block index for FILE_MENTION
						const blockUpdates = innerMap.values().next().value

						// if we have updated this text previously, we want to check whether the lists of files in the metadata are the same
						if (blockUpdates && blockUpdates.length > 0) {
							// the first list indicates the files we have replaced in this text, second list indicates all unique files in this text
							// if they are equal then we have replaced all the files in this text already, and can ignore further processing
							if (
								blockUpdates[blockUpdates.length - 1][3][0].length ===
								blockUpdates[blockUpdates.length - 1][3][1].length
							) {
								continue
							}
							// otherwise there are still file reads here we can overwrite, so still need to process this text chunk
							// to do so we need to keep track of which files we've already replaced so we don't replace them again

							thisExistingFileReads = blockUpdates[blockUpdates.length - 1][3][0]
						}
					} else {
						// for all other cases we can assume that we dont need to check this again
						continue
					}
				}
			}

			const message = apiMessages[i]
			if (message.role === "user" && Array.isArray(message.content) && message.content.length > 0) {
				const firstBlock = message.content[0]
				// Extract text from either a direct text block or from inside a tool_result wrapper (native tool calling)
				const firstBlockText = this.getTextFromBlock(firstBlock)

				if (firstBlockText) {
					const result = this.parseToolCallWithFormat(firstBlockText)
					let foundNormalFileRead = false
					if (result) {
						const [toolName, filePath, contentBlockIndex, headerText] = result

						if (toolName === "read_file") {
							// For native tool calling format, we assume contentBlockIndex=0 which is what happens naturally
							this.handleReadFileToolCall(i, filePath, fileReadIndices, contentBlockIndex, headerText)
							foundNormalFileRead = true
						} else if (toolName === "replace_in_file" || toolName === "write_to_file") {
							// For native tool calling format, the content is assumed to always in the same block (index=0 inside tool_result)
							// For the XML format, the old format has the file contents in index=1 whereas the new format has it in index=0
							let blockText: string | undefined
							if (firstBlock.type === "tool_result") {
								blockText = firstBlockText
							} else if (contentBlockIndex === 0) {
								// remaining cases are for type="text"
								blockText = firstBlockText
							} else if (contentBlockIndex === 1 && message.content.length > 1) {
								const secondBlock = message.content[1]
								if (secondBlock.type === "text") {
									blockText = secondBlock.text
								}
							}

							if (blockText) {
								this.handlePotentialFileChangeToolCalls(
									i,
									filePath,
									blockText,
									fileReadIndices,
									contentBlockIndex,
								)
								foundNormalFileRead = true
							}
						}
					}

					// file mentions can happen in most other user message blocks
					if (!foundNormalFileRead) {
						// search over indices 0-2 inclusive for file mentions
						// this is a heuristic to catch most occurrences without looping over all inner indices
						for (const candidateIndex of [0, 1, 2]) {
							if (candidateIndex >= message.content.length) {
								break
							}

							const block = message.content[candidateIndex]
							// Extract text from either a direct text block or from inside a tool_result wrapper
							const blockText = this.getTextFromBlock(block)
							if (blockText) {
								const [hasFileRead, filePaths] = this.handlePotentialFileMentionCalls(
									i,
									blockText,
									fileReadIndices,
									thisExistingFileReads, // file reads we've already replaced in this text in the latest version of this updated text
									candidateIndex,
								)
								if (hasFileRead) {
									messageFilePaths.set(i, filePaths) // all file paths in this string
									break // at most one file mentions block per outer index
								}
							}
						}
					}
				}
			}
		}

		return [fileReadIndices, messageFilePaths]
	}

	/**
	 * handles potential file content mentions in text blocks
	 * there will not be more than one of the same file read in a text block
	 */
	private handlePotentialFileMentionCalls(
		i: number,
		blockText: string,
		fileReadIndices: Map<string, [number, number, string, string, number][]>,
		thisExistingFileReads: string[],
		innerIndex: number,
	): [boolean, string[]] {
		const pattern = /<file_content path="([^"]*)">([\s\S]*?)<\/file_content>/g

		let foundMatch = false
		const filePaths: string[] = []

		for (const match of blockText.matchAll(pattern)) {
			foundMatch = true

			const filePath = match[1]
			filePaths.push(filePath) // we will record all unique paths from file mentions in this text

			// we can assume that thisExistingFileReads does not have many entries
			if (!thisExistingFileReads.includes(filePath)) {
				// meaning we haven't already replaced this file read

				const entireMatch = match[0] // The entire matched string

				// Create the replacement text - keep the tags but replace the content
				const replacementText = `<file_content path="${filePath}">${formatResponse.duplicateFileReadNotice()}</file_content>`

				const indices = fileReadIndices.get(filePath) || []
				// use the actual inner index where file mentions were found
				indices.push([i, EditType.FILE_MENTION, entireMatch, replacementText, innerIndex])
				fileReadIndices.set(filePath, indices)
			}
		}

		return [foundMatch, filePaths]
	}

	/**
	 * Parses tool call formats and returns null if no acceptable format is found
	 * Supports older version (content in separate block), and newer (content in same block)
	 * Returns [toolName, filePath, contentBlockIndex, headerText]
	 */
	private parseToolCallWithFormat(text: string): [string, string, number, string] | null {
		const match = text.match(/^\[([^\s]+) for '([^']+)'\] Result:/)

		if (!match) {
			return null
		}

		const headerLength = match[0].length
		let contentBlockIndex = 1
		if (text.length > headerLength) {
			// newer format: content follows header in this block (index 0)
			// in the older format the content is in the following block (index 1)
			contentBlockIndex = 0
		}

		return [match[1], match[2], contentBlockIndex, match[0]]
	}

	/**
	 * file_read tool call always pastes the file, so this is always a hit
	 */
	private handleReadFileToolCall(
		i: number,
		filePath: string,
		fileReadIndices: Map<string, [number, number, string, string, number][]>,
		contentBlockIndex: number,
		headerText: string,
	) {
		const indices = fileReadIndices.get(filePath) || []

		if (contentBlockIndex === 1) {
			// the original tool call format
			indices.push([i, EditType.READ_FILE_TOOL, "", formatResponse.duplicateFileReadNotice(), contentBlockIndex])
		} else {
			// the new tool call format (index=0)
			// in the new format the tool call output for read_file is appended to the tool call header with a newline separator
			// this means we need to extract just the header and append the duplicateFileReadNotice to it with the separator
			indices.push([
				i,
				EditType.READ_FILE_TOOL,
				"",
				`${headerText}\n${formatResponse.duplicateFileReadNotice()}`,
				contentBlockIndex,
			])
		}

		fileReadIndices.set(filePath, indices)
	}

	/**
	 * write_to_file and replace_in_file tool output are handled similarly
	 */
	private handlePotentialFileChangeToolCalls(
		i: number,
		filePath: string,
		blockText: string,
		fileReadIndices: Map<string, [number, number, string, string, number][]>,
		contentBlockIndex: number,
	) {
		const pattern = /(<final_file_content path="[^"]*">)[\s\S]*?(<\/final_file_content>)/

		// check if this exists in the text, it won't exist if the user rejects the file change for example
		if (pattern.test(blockText)) {
			const replacementText = blockText.replace(pattern, `$1 ${formatResponse.duplicateFileReadNotice()} $2`)
			const indices = fileReadIndices.get(filePath) || []
			indices.push([i, EditType.ALTER_FILE_TOOL, "", replacementText, contentBlockIndex])
			fileReadIndices.set(filePath, indices)
		}
	}

	/**
	 * alter all occurrences of file read operations and track which messages were updated
	 * returns the outer index of messages we alter, to count number of changes
	 */
	private applyFileReadContextHistoryUpdates(
		fileReadIndices: Map<string, [number, number, string, string, number][]>,
		messageFilePaths: Map<number, string[]>,
		apiMessages: ClineStorageMessage[],
		timestamp: number,
	): [boolean, Set<number>] {
		let didUpdate = false
		const updatedMessageIndices = new Set<number>() // track which messages we update on this round
		const fileMentionUpdates = new Map<number, [string, string[], number]>() // [baseText, prevFilesReplaced, innerIndex]

		for (const [filePath, indices] of fileReadIndices.entries()) {
			// Only process if there are multiple reads of the same file, else we will want to keep the latest read of the file
			if (indices.length > 1) {
				// Process all but the last index, as we will keep that instance of the file read
				for (let i = 0; i < indices.length - 1; i++) {
					const messageIndex = indices[i][0]
					const messageType = indices[i][1] // EditType value
					const searchText = indices[i][2] // search text (for file mentions, else empty string)
					const messageString = indices[i][3] // what we will replace the string with
					const innerIndex = indices[i][4] // inner block index where we are making the change

					didUpdate = true
					updatedMessageIndices.add(messageIndex)

					// for single-fileread text we can set the updates here
					// for potential multi-fileread text we need to determine all changes & iteratively update the text prior to saving the final change
					if (messageType === EditType.FILE_MENTION) {
						if (!fileMentionUpdates.has(messageIndex)) {
							// Get base text either from existing updates or from apiMessages
							let baseText = ""
							let prevFilesReplaced: string[] = []

							const innerTuple = this.contextHistoryUpdates.get(messageIndex)
							if (innerTuple) {
								const blockUpdates = innerTuple[1].get(innerIndex)
								if (blockUpdates && blockUpdates.length > 0) {
									baseText = blockUpdates[blockUpdates.length - 1][2][0] // index 0 of MessageContent
									prevFilesReplaced = blockUpdates[blockUpdates.length - 1][3][0] // previously overwritten file reads in this text
								}
							}

							// can assume that this content will exist, otherwise it would not have been in fileReadIndices
							const messageContent = apiMessages[messageIndex]?.content
							if (!baseText && Array.isArray(messageContent) && messageContent.length > innerIndex) {
								// contentBlock can either be the type="text" dict or type="tool_result" dict which has its own content array
								// but we currently assume the content we will overwrite is at index=0 in this content array
								const contentBlock = messageContent[innerIndex]
								const extractedText = this.getTextFromBlock(contentBlock)
								if (extractedText) {
									baseText = extractedText
								}
							}

							// prevFilesReplaced keeps track of the previous file reads we've replace in this string, empty array if none
							fileMentionUpdates.set(messageIndex, [baseText, prevFilesReplaced, innerIndex])
						}

						// Replace searchText with messageString for all file reads we need to replace in this text
						if (searchText) {
							const currentTuple = fileMentionUpdates.get(messageIndex) || ["", [], 0]
							if (currentTuple[0]) {
								// safety check
								// replace this text chunk
								const updatedText = currentTuple[0].replace(searchText, messageString)

								// add the newly added filePath read
								const updatedFileReads = currentTuple[1]
								updatedFileReads.push(filePath)

								fileMentionUpdates.set(messageIndex, [updatedText, updatedFileReads, currentTuple[2]])
							}
						}
					} else {
						const innerTuple = this.contextHistoryUpdates.get(messageIndex)
						let innerMap: Map<number, ContextUpdate[]>

						if (!innerTuple) {
							innerMap = new Map<number, ContextUpdate[]>()
							this.contextHistoryUpdates.set(messageIndex, [messageType, innerMap])
						} else {
							innerMap = innerTuple[1]
						}

						const blockIndex = innerIndex

						const updates = innerMap.get(blockIndex) || []

						// metadata array is empty for non-file mention occurrences
						updates.push([timestamp, "text", [messageString], []])

						innerMap.set(blockIndex, updates)
					}
				}
			}
		}

		// apply file mention updates to contextHistoryUpdates
		// in fileMentionUpdates, filePathsUpdated includes all the file paths which are updated in the latest version of this altered text
		for (const [messageIndex, [updatedText, filePathsUpdated, blockIndex]] of fileMentionUpdates.entries()) {
			const innerTuple = this.contextHistoryUpdates.get(messageIndex)
			let innerMap: Map<number, ContextUpdate[]>

			if (!innerTuple) {
				innerMap = new Map<number, ContextUpdate[]>()
				this.contextHistoryUpdates.set(messageIndex, [EditType.FILE_MENTION, innerMap])
			} else {
				innerMap = innerTuple[1]
			}

			const updates = innerMap.get(blockIndex) || []

			// filePathsUpdated includes changes done previously to this timestamp, and right now
			if (messageFilePaths.has(messageIndex)) {
				const allFileReads = messageFilePaths.get(messageIndex)
				if (allFileReads) {
					// we gather all the file reads possible in this text from messageFilePaths
					// filePathsUpdated from fileMentionUpdates stores all the files reads we have replaced now & previously
					updates.push([timestamp, "text", [updatedText], [filePathsUpdated, allFileReads]])
					innerMap.set(blockIndex, updates)
				}
			}
		}

		return [didUpdate, updatedMessageIndices]
	}

	/**
	 * count total characters in messages and total savings within this range
	 */
	private countCharactersAndSavingsInRange(
		apiMessages: ClineStorageMessage[],
		startIndex: number,
		endIndex: number,
		uniqueFileReadIndices: Set<number>,
	): { totalCharacters: number; charactersSaved: number } {
		let totalCharCount = 0
		let totalCharactersSaved = 0

		for (let i = startIndex; i < endIndex; i++) {
			// looping over the outer indices of messages
			const message = apiMessages[i]

			if (!message.content) {
				continue
			}

			// hasExistingAlterations checks whether the outer idnex has any changes
			// hasExistingAlterations will also include the alterations we just made
			const hasExistingAlterations = this.contextHistoryUpdates.has(i)
			const hasNewAlterations = uniqueFileReadIndices.has(i)

			if (Array.isArray(message.content)) {
				for (let blockIndex = 0; blockIndex < message.content.length; blockIndex++) {
					// looping over inner indices of messages
					const block = message.content[blockIndex]

					// Extract text from either a direct text block or from inside a tool_result wrapper (native tool calling)
					const blockText = this.getTextFromBlock(block)
					if (blockText) {
						// true if we just altered it, or it was altered before
						if (hasExistingAlterations) {
							const innerTuple = this.contextHistoryUpdates.get(i)
							const updates = innerTuple?.[1].get(blockIndex) // updated text for this inner index

							if (updates && updates.length > 0) {
								// exists if we have an update for the message at this index
								const latestUpdate = updates[updates.length - 1]

								// if block was just altered, then calculate savings
								if (hasNewAlterations) {
									let originalTextLength: number
									if (updates.length > 1) {
										originalTextLength = updates[updates.length - 2][2][0].length // handles case if we have multiple updates for same text block
									} else {
										originalTextLength = blockText.length
									}

									const newTextLength = latestUpdate[2][0].length // replacement text
									totalCharactersSaved += originalTextLength - newTextLength

									totalCharCount += originalTextLength
								} else {
									// meaning there was an update to this text previously, but we didn't just alter it
									totalCharCount += latestUpdate[2][0].length
								}
							} else {
								// reach here if there was one inner index with an update, but now we are at a different index, so updates is not defined
								totalCharCount += blockText.length
							}
						} else {
							// reach here if there's no alterations for this outer index, meaning each inner index won't have any changes either
							totalCharCount += blockText.length
						}
					} else if (block.type === "image" && block.source) {
						if (block.source.type === "base64" && block.source.data) {
							totalCharCount += block.source.data.length
						}
					}
				}
			}
		}

		return { totalCharacters: totalCharCount, charactersSaved: totalCharactersSaved }
	}

	/**
	 * count total percentage character savings across in-range conversation
	 */
	private calculateContextOptimizationMetrics(
		apiMessages: ClineStorageMessage[],
		conversationHistoryDeletedRange: [number, number] | undefined,
		uniqueFileReadIndices: Set<number>,
	): number {
		// count for first user-assistant message pair
		const firstChunkResult = this.countCharactersAndSavingsInRange(apiMessages, 0, 2, uniqueFileReadIndices)

		// count for the remaining in-range messages
		const secondChunkResult = this.countCharactersAndSavingsInRange(
			apiMessages,
			conversationHistoryDeletedRange ? conversationHistoryDeletedRange[1] + 1 : 2,
			apiMessages.length,
			uniqueFileReadIndices,
		)

		const totalCharacters = firstChunkResult.totalCharacters + secondChunkResult.totalCharacters
		const totalCharactersSaved = firstChunkResult.charactersSaved + secondChunkResult.charactersSaved

		const percentCharactersSaved = totalCharacters === 0 ? 0 : totalCharactersSaved / totalCharacters

		return percentCharactersSaved
	}
}

async function readContextHistoryRecords(filePath: string): Promise<ContextHistoryRecord[]> {
	let content: string
	try {
		content = await fs.readFile(filePath, "utf8")
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
		throw error
	}
	if (!content.trim()) return []

	const records: ContextHistoryRecord[] = []
	let parsedEveryLine = true
	for (const line of content.split("\n")) {
		if (!line.trim()) continue
		try {
			const parsed = JSON.parse(line) as unknown
			const record = normalizeContextHistoryRecord(parsed)
			if (record) records.push(record)
		} catch {
			parsedEveryLine = false
			break
		}
	}
	if (parsedEveryLine) return records

	const legacy = JSON.parse(content) as unknown
	const normalized = normalizeContextHistoryRecord(legacy)
	return normalized ? [normalized] : []
}

function normalizeContextHistoryRecord(value: unknown): ContextHistoryRecord | undefined {
	if (isSerializedContextHistory(value)) return { kind: "snapshot", updates: value }
	if (typeof value !== "object" || value === null) return undefined
	const record = value as Partial<ContextHistoryRecord> & { updates?: unknown; timestamp?: unknown }
	if (record.kind === "snapshot" && isSerializedContextHistory(record.updates)) {
		return { kind: "snapshot", updates: record.updates }
	}
	if (record.kind === "truncate" && typeof record.timestamp === "number" && Number.isFinite(record.timestamp)) {
		return { kind: "truncate", timestamp: record.timestamp }
	}
	return undefined
}

function isSerializedContextHistory(value: unknown): value is SerializedContextHistory {
	return (
		Array.isArray(value) &&
		value.every(
			(entry) =>
				Array.isArray(entry) &&
				entry.length === 2 &&
				Number.isInteger(entry[0]) &&
				Array.isArray(entry[1]) &&
				entry[1].length === 2 &&
				Number.isInteger(entry[1][0]) &&
				Array.isArray(entry[1][1]),
		)
	)
}

function deserializeContextHistory(updates: SerializedContextHistory): Map<number, [number, Map<number, ContextUpdate[]>]> {
	return new Map(
		updates.map(([messageIndex, [numberValue, innerMapArray]]) => [messageIndex, [numberValue, new Map(innerMapArray)]]),
	)
}
