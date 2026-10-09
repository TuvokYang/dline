/**
 * Utility functions for message filtering, grouping, and manipulation
 */

import { combineApiRequests } from "@shared/combineApiRequests"
import { combineCommandSequences } from "@shared/combineCommandSequences"
import type { TaskViewState, UiMessage, UiSayBrowserAction, UiSayTool } from "@shared/ExtensionMessage"
import { parseImageGenerationToolText } from "@shared/image-generation"
import { FileIcon, FolderOpenDotIcon, FolderOpenIcon, SearchIcon, ShapesIcon, WrenchIcon } from "lucide-react"
import React from "react"

/**
 * Low-stakes tool types that should be grouped together
 */
const LOW_STAKES_TOOLS = new Set([
	"readFile",
	"listFilesTopLevel",
	"listFilesRecursive",
	"listCodeDefinitionNames",
	"searchFiles",
	"findReferences",
])

/**
 * Check if a tool message is a low-stakes tool
 */
export function isLowStakesTool(message: UiMessage): boolean {
	if (message.say !== "tool" && message.ask !== "tool") {
		return false
	}
	try {
		const tool = JSON.parse(message.text || "{}") as UiSayTool
		return LOW_STAKES_TOOLS.has(tool.tool)
	} catch {
		return false
	}
}

export function isImageGenerationMessage(message: UiMessage | undefined): boolean {
	return Boolean(message && (message.imageGeneration ?? parseImageGenerationToolText(message.text)))
}

export function resolveMessageRowExpanded(
	message: UiMessage | undefined,
	expandedRows: Readonly<Record<number, boolean>>,
): boolean {
	if (!message) return false
	return expandedRows[message.ts] ?? isImageGenerationMessage(message)
}

export function toggleMessageRowExpansion(
	message: UiMessage | undefined,
	expandedRows: Readonly<Record<number, boolean>>,
): Record<number, boolean> {
	if (!message) return { ...expandedRows }
	return { ...expandedRows, [message.ts]: !resolveMessageRowExpanded(message, expandedRows) }
}

/** Locate a message and its virtual row even when it is nested inside a browser-session group. */
export function findGroupedMessageByTs(
	groupedMessages: ReadonlyArray<UiMessage | UiMessage[]>,
	ts: number,
): { groupIndex: number; message: UiMessage } | undefined {
	for (let groupIndex = 0; groupIndex < groupedMessages.length; groupIndex++) {
		const row = groupedMessages[groupIndex]
		const message = Array.isArray(row) ? row.find((candidate) => candidate.ts === ts) : row?.ts === ts ? row : undefined
		if (message) return { groupIndex, message }
	}
	return undefined
}

/**
 * Check if a message group is a tool group (array with _isToolGroup marker)
 */
export function isToolGroup(item: UiMessage | UiMessage[]): item is UiMessage[] & { _isToolGroup: true } {
	return Array.isArray(item) && (item as any)._isToolGroup === true
}

/**
 * Combine API requests and command sequences in messages
 */
export function processMessages(messages: UiMessage[]): UiMessage[] {
	return combineApiRequests(combineCommandSequences(messages))
}

interface ApiErrorMessageInput {
	isLast: boolean
	lastModifiedMessage?: UiMessage
	streamingFailedMessage?: string
	taskViewState?: TaskViewState
}

/**
 * Resolve the API error text for request rows.
 */
export function resolveApiErrorMessage(input: ApiErrorMessageInput): string | undefined {
	if (!input.isLast) {
		return undefined
	}

	const activeInteraction = input.taskViewState?.activeInteraction
	if (
		activeInteraction?.taskAsk === "api_req_failed" &&
		input.lastModifiedMessage?.ask === "api_req_failed" &&
		activeInteraction.askMessageTs === input.lastModifiedMessage.ts
	) {
		return input.lastModifiedMessage.text
	}

	if (input.taskViewState) {
		return input.lastModifiedMessage?.ask === "api_req_failed" ? undefined : input.streamingFailedMessage
	}

	return input.lastModifiedMessage?.ask === "api_req_failed" ? input.lastModifiedMessage.text : input.streamingFailedMessage
}

export interface ParsedMcpServerResponse {
	requestTs?: number
	responses: string[]
}

export function parseMcpServerResponse(text: string | undefined): ParsedMcpServerResponse {
	const fallback = { responses: [text || ""] }
	if (!text) return fallback
	try {
		const parsed = JSON.parse(text) as Partial<ParsedMcpServerResponse> & { type?: string }
		if (
			parsed.type === "mcp_server_response" &&
			typeof parsed.requestTs === "number" &&
			Array.isArray(parsed.responses) &&
			parsed.responses.every((response) => typeof response === "string")
		) {
			return { requestTs: parsed.requestTs, responses: parsed.responses }
		}
	} catch {
		// Legacy rows persist the response as plain text.
	}
	return fallback
}

function isMcpRequest(message: UiMessage): boolean {
	return message.ask === "use_mcp_server" || message.say === "use_mcp_server"
}

function isAttachedMcpResponse(messages: UiMessage[], responseIndex: number): boolean {
	const response = parseMcpServerResponse(messages[responseIndex]?.text)
	if (response.requestTs !== undefined) {
		return messages.some((message) => message.ts === response.requestTs && isMcpRequest(message))
	}
	for (let index = responseIndex - 1; index >= 0; index--) {
		const candidate = messages[index]
		if (isMcpRequest(candidate)) return true
		if (
			candidate.say === "mcp_server_request_started" ||
			candidate.say === "mcp_notification" ||
			candidate.say === "checkpoint_created" ||
			candidate.say === "mcp_server_response"
		) {
			continue
		}
		return false
	}
	return false
}

export function collectMcpResponseTexts(messages: UiMessage[], requestTs: number): string[] {
	const structured = messages.flatMap((message) => {
		if (message.say !== "mcp_server_response") return []
		const response = parseMcpServerResponse(message.text)
		return response.requestTs === requestTs ? response.responses : []
	})
	if (structured.length > 0) return structured

	const requestIndex = messages.findIndex((message) => message.ts === requestTs && isMcpRequest(message))
	if (requestIndex === -1) return []
	const responses: string[] = []
	for (let index = requestIndex + 1; index < messages.length; index++) {
		const candidate = messages[index]
		if (isMcpRequest(candidate)) break
		if (candidate.say === "mcp_server_response") {
			responses.push(...parseMcpServerResponse(candidate.text).responses)
			continue
		}
		if (
			candidate.say === "mcp_server_request_started" ||
			candidate.say === "mcp_notification" ||
			candidate.say === "checkpoint_created"
		) {
			continue
		}
		break
	}
	return responses
}

/**
 * Filter messages that should be visible in the chat
 */
export function filterVisibleMessages(messages: UiMessage[]): UiMessage[] {
	return messages.filter((message, index, arr) => {
		const hasNoVisibleContent = !message.text?.trim() && !message.images?.length && !message.files?.length
		// Older runtimes persisted empty intake and turn-ending presentation rows.
		// Keep them as recovery evidence, but never allocate a virtualized item for
		// a content-only row that cannot render any user-visible content.
		if (hasNoVisibleContent && message.type === "say") {
			switch (message.say) {
				case "user_feedback":
				case "text":
				case "qna_respond":
				case "completion_result":
					return false
			}
		}
		switch (message.ask) {
			case "completion_result":
				// don't show a chat row for a completion_result ask without text. This specific type of message only occurs if cline wants to execute a command as part of its completion result, in which case we interject the completion_result tool with the execute_command tool.
				if (hasNoVisibleContent) {
					return false
				}
				break
			case "generate_report":
			case "status_acknowledgment":
				if (hasNoVisibleContent) return false
				break
			case "api_req_failed": // this message is used to update the latest api_req_started that the request failed
			case "resume_task":
			case "resume_completed_task":
				return false
			case "use_subagents":
			case "spawn_task":
				if (arr.slice(index + 1).some((candidate) => candidate.type === "say" && candidate.say === "subagent")) {
					return false
				}
				break
		}
		// Generic partial dedup based on ts: hide stale partials when a completed
		// version or a newer partial with the same ts is present.
		if (message.partial === true) {
			const hasCompleteWithSameTs = arr.some((m, i) => i !== index && m.ts === message.ts && m.partial !== true)
			const hasNewerDuplicatePartial = arr.slice(index + 1).some((m) => m.ts === message.ts && m.partial === true)
			if (hasCompleteWithSameTs || hasNewerDuplicatePartial) return false
		}

		switch (message.say) {
			case "api_req_finished": // combineApiRequests removes this from modifiedMessages anyways
			case "api_req_retried": // this message is used to update the latest api_req_started that the request was retried
			case "deleted_api_reqs": // aggregated api_req metrics from deleted messages
			case "subagent_usage": // aggregated subagent usage metrics for task-level accounting
			case "task_progress": // task progress messages are displayed in TaskHeader, not in main chat
			case "partial_tool_result": // invisible tool-result snapshot for resume replay — not rendered
			case "state_snapshot": // phase lifecycle snapshot — backend-internal, not user-visible
				return false
			// NOTE: reasoning passes through to be included in tool groups
			case "api_req_started": {
				// api_req_started rows only render visible content for failures.
				// Reasoning has its own standalone ChatRows, and a cancelled request
				// has nothing of its own to show: keeping it only re-rendered that
				// reasoning a second time under the request. Filter out unless the
				// request failed.
				try {
					const info = JSON.parse(message.text || "{}")
					if (info.streamingFailedMessage) {
						break // keep - has error content
					}
				} catch {
					break // keep on parse error to be safe
				}
				// Keep this row if a subsequent api_req_failed needs it as an error carrier.
				// api_req_failed messages are filtered out and are only used to update the
				// latest api_req_started row. If we drop the carrier row, the error is invisible.
				if (arr.slice(index + 1).some((m) => m.ask === "api_req_failed")) {
					break
				}
				return false
			}
			case "text":
				// Sometimes cline returns an empty text message, we don't want to render these. (We also use a say text for user messages, so in case they just sent images we still render that)
				if (hasNoVisibleContent) {
					return false
				}
				break
			case "mcp_server_request_started":
				return false
			case "mcp_server_response":
				if (isAttachedMcpResponse(arr, index)) return false
				break
			case "use_subagents":
				if (arr.slice(index + 1).some((candidate) => candidate.type === "say" && candidate.say === "subagent")) {
					return false
				}
				break
		}
		return true
	})
}

/**
 * Check if a message is part of a browser session
 */
export function isBrowserSessionMessage(message: UiMessage): boolean {
	if (message.type === "ask") {
		return ["browser_action_launch"].includes(message.ask!)
	}
	if (message.type === "say") {
		return [
			"browser_action_launch",
			"api_req_started",
			"text",
			"browser_action",
			"browser_action_result",
			"checkpoint_created",
			"reasoning",
			"error_retry",
		].includes(message.say!)
	}
	return false
}

/**
 * Group messages, combining browser session messages into arrays
 */
export function groupMessages(visibleMessages: UiMessage[]): (UiMessage | UiMessage[])[] {
	const result: (UiMessage | UiMessage[])[] = []
	let currentGroup: UiMessage[] = []
	let isInBrowserSession = false

	const endBrowserSession = () => {
		if (currentGroup.length > 0) {
			result.push([...currentGroup])
			currentGroup = []
			isInBrowserSession = false
		}
	}

	for (const message of visibleMessages) {
		if (message.ask === "browser_action_launch" || message.say === "browser_action_launch") {
			// complete existing browser session if any
			endBrowserSession()
			// start new
			isInBrowserSession = true
			currentGroup.push(message)
		} else if (isInBrowserSession) {
			// end session if api_req_started is cancelled
			if (message.say === "api_req_started") {
				// get last api_req_started in currentGroup to check if it's cancelled
				const lastApiReqStarted = [...currentGroup].reverse().find((m) => m.say === "api_req_started")
				if (lastApiReqStarted?.text != null) {
					const info = JSON.parse(lastApiReqStarted.text)
					const isCancelled = info.cancelReason != null
					if (isCancelled) {
						endBrowserSession()
						result.push(message)
						continue
					}
				}
			}

			if (isBrowserSessionMessage(message)) {
				currentGroup.push(message)

				// Check if this is a close action
				if (message.say === "browser_action") {
					const browserAction = JSON.parse(message.text || "{}") as UiSayBrowserAction
					if (browserAction.action === "close") {
						endBrowserSession()
					}
				}
			} else {
				// complete existing browser session if any
				endBrowserSession()
				result.push(message)
			}
		} else {
			result.push(message)
		}
	}

	// Handle case where browser session is the last group
	if (currentGroup.length > 0) {
		result.push([...currentGroup])
	}

	return result
}

/**
 * Get the task message from the messages array
 */
export function getTaskMessage(messages: UiMessage[]): UiMessage | undefined {
	return messages.at(0)
}

/**
 * Check if we should show the scroll to bottom button
 */
export function shouldShowScrollButton(disableAutoScroll: boolean, isAtBottom: boolean): boolean {
	return disableAutoScroll && !isAtBottom
}

/**
 * Find reasoning content associated with an api_req_started message.
 * Also returns whether response content (non-reasoning) has started.
 */
export function findReasoningForApiReq(
	apiReqTs: number,
	allMessages: UiMessage[],
): { reasoning: string | undefined; responseStarted: boolean } {
	const apiReqIndex = allMessages.findIndex((m) => m.ts === apiReqTs && m.say === "api_req_started")
	if (apiReqIndex === -1) {
		return { reasoning: undefined, responseStarted: false }
	}

	// Collect reasoning and check if response content has started
	const reasoningParts: string[] = []
	let responseStarted = false

	for (let i = apiReqIndex + 1; i < allMessages.length; i++) {
		const msg = allMessages[i]
		// Stop at next api_req_started
		if (msg.say === "api_req_started") {
			break
		}
		// Collect reasoning content
		if (msg.say === "reasoning" && msg.text) {
			reasoningParts.push(msg.text)
		}
		// Check if non-reasoning response content has started (text, tool calls, etc.)
		if (msg.say === "text" || msg.say === "tool" || msg.ask === "tool" || msg.ask === "command" || msg.say === "command") {
			responseStarted = true
		}
	}

	return {
		reasoning: reasoningParts.length > 0 ? reasoningParts.join("\n\n") : undefined,
		responseStarted,
	}
}

/**
 * Find the API request info for a checkpoint message.
 * Looks backwards from the checkpoint to find the preceding api_req_started.
 * Returns cost and request content.
 */
export function findApiReqInfoForCheckpoint(
	checkpointTs: number,
	allMessages: UiMessage[],
): { cost: number | undefined; request: string | undefined } {
	const checkpointIndex = allMessages.findIndex((m) => m.ts === checkpointTs && m.say === "checkpoint_created")
	if (checkpointIndex === -1) {
		return { cost: undefined, request: undefined }
	}

	// Look backwards for the most recent api_req_started
	for (let i = checkpointIndex - 1; i >= 0; i--) {
		const msg = allMessages[i]
		if (msg.say === "api_req_started" && msg.text) {
			try {
				const info = JSON.parse(msg.text)
				return {
					cost: info.cost,
					request: info.request,
				}
			} catch {
				return { cost: undefined, request: undefined }
			}
		}
	}
	return { cost: undefined, request: undefined }
}

/**
 * Check if a checkpoint at the given index would be displayed (not absorbed into a tool group).
 * A checkpoint is absorbed if it's PRECEDED by low-stakes tools (meaning we're in a tool group).
 * A checkpoint is displayed if it's preceded by non-tool content (meaning no active tool group).
 */
function isDisplayedCheckpoint(checkpointIndex: number, allMessages: UiMessage[]): boolean {
	// Look BACKWARDS to see if we're in a tool group
	// A checkpoint is absorbed if the previous meaningful content was a low-stakes tool
	for (let i = checkpointIndex - 1; i >= 0; i--) {
		const msg = allMessages[i]

		// Skip api_req messages - they don't affect tool group status
		if (msg.say === "api_req_started" || msg.say === "api_req_finished") {
			continue
		}

		// Skip reasoning messages
		if (msg.say === "reasoning") {
			continue
		}

		// Skip other checkpoints - they don't end tool groups
		if (msg.say === "checkpoint_created") {
			continue
		}

		// If preceded by a low-stakes tool, this checkpoint is in the tool group (absorbed)
		if (msg.say === "tool" || msg.ask === "tool") {
			try {
				const tool = JSON.parse(msg.text || "{}") as UiSayTool
				if (LOW_STAKES_TOOLS.has(tool.tool)) {
					return false // absorbed into tool group
				}
			} catch {
				// Can't parse, treat as displayed
			}
		}

		// Any other content before this checkpoint ends the tool group, so this is displayed
		return true
	}

	// Start of messages - checkpoint is displayed (no preceding tool group)
	return true
}

/**
 * Find the total cost for the segment starting at a checkpoint.
 * Looks FORWARD from the checkpoint to the next DISPLAYED checkpoint (skipping absorbed ones).
 * Sums all api_req_started costs in between.
 * Returns undefined if the segment is incomplete (no next displayed checkpoint yet).
 */
export function findNextSegmentCost(checkpointTs: number, allMessages: UiMessage[]): number | undefined {
	const checkpointIndex = allMessages.findIndex((m) => m.ts === checkpointTs && m.say === "checkpoint_created")
	if (checkpointIndex === -1) {
		return undefined
	}
	// Find the next DISPLAYED checkpoint (skip absorbed ones)
	let nextDisplayedCheckpointIndex = -1
	for (let i = checkpointIndex + 1; i < allMessages.length; i++) {
		if (allMessages[i].say === "checkpoint_created") {
			if (isDisplayedCheckpoint(i, allMessages)) {
				nextDisplayedCheckpointIndex = i
				break
			}
			// Otherwise continue looking for next displayed checkpoint
		}
	}

	// If no next displayed checkpoint, sum to end of messages (in-progress segment)
	const endIndex = nextDisplayedCheckpointIndex === -1 ? allMessages.length : nextDisplayedCheckpointIndex

	// Sum all api_req_started costs between this checkpoint and the end
	let totalCost = 0
	for (let i = checkpointIndex + 1; i < endIndex; i++) {
		const msg = allMessages[i]
		if (msg.say === "api_req_started" && msg.text) {
			try {
				const info = JSON.parse(msg.text)
				if (typeof info.cost === "number") {
					totalCost += info.cost
				}
			} catch {
				// ignore parse errors
			}
		}
	}

	return totalCost > 0 ? totalCost : undefined
}

/**
 * Check if a text message's associated API request is still in progress.
 * Returns true if there's no cost yet on the parent api_req_started.
 */
export function isTextMessagePendingToolCall(textTs: number, allMessages: UiMessage[]): boolean {
	// Find the api_req_started that precedes this text message
	const textIndex = allMessages.findIndex((m) => m.ts === textTs)
	if (textIndex === -1) {
		return false
	}

	// Look backwards for the most recent api_req_started
	for (let i = textIndex - 1; i >= 0; i--) {
		const msg = allMessages[i]
		if (msg.say === "api_req_started" && msg.text) {
			try {
				const info = JSON.parse(msg.text)
				// If no cost, the request is still in progress
				return info.cost == null
			} catch {
				return false
			}
		}
	}
	return false
}

/**
 * Check if a tool group should be hidden because its tools are currently being
 * displayed in the loading state animation.
 *
 * Returns true when:
 * 1. (Case A) The MOST RECENT api_req_started overall has no cost (loading state is active) AND
 *    this tool group falls in the "current activities" range (between the previous completed api_req and the current one)
 * 2. (Case B) The MOST RECENT api_req_started overall has cost (is complete) AND
 *    this tool group appears after it (just arrived, waiting to be shown as "in flight")
 *
 * This mirrors the ChatRow currentActivities logic - we only hide tools that are
 * actively being shown in the loading state, not older tool groups.
 */
export function isToolGroupInFlight(toolGroupMessages: UiMessage[], allMessages: UiMessage[]): boolean {
	if (toolGroupMessages.length === 0) {
		return false
	}

	// Step 1: Find the MOST RECENT api_req_started overall (search backwards)
	let mostRecentApiReq: UiMessage | null = null
	let mostRecentApiReqIndex = -1
	for (let i = allMessages.length - 1; i >= 0; i--) {
		if (allMessages[i].say === "api_req_started") {
			mostRecentApiReq = allMessages[i]
			mostRecentApiReqIndex = i
			break
		}
	}

	if (!mostRecentApiReq?.text) {
		return false
	}

	// Step 2: Determine if most recent api_req is complete (has cost) or incomplete (no cost)
	let mostRecentHasCost = false
	try {
		const info = JSON.parse(mostRecentApiReq.text)
		mostRecentHasCost = info.cost != null
	} catch {
		return false
	}

	// Find the last tool in this group
	const lastTool = [...toolGroupMessages].reverse().find((m) => isLowStakesTool(m))
	if (!lastTool) {
		return false
	}

	const toolIndex = allMessages.findIndex((m) => m.ts === lastTool.ts)
	if (toolIndex === -1) {
		return false
	}

	// Step 3: Determine if tool group is in-flight
	if (!mostRecentHasCost) {
		// CASE A: Most recent api_req is INCOMPLETE (loading state active)
		// Tool group is in-flight if it's between prev completed and current incomplete

		// Find the previous COMPLETED api_req
		let prevCompletedApiReqIndex = -1
		for (let i = mostRecentApiReqIndex - 1; i >= 0; i--) {
			const msg = allMessages[i]
			if (msg.say === "api_req_started" && msg.text) {
				try {
					const prevInfo = JSON.parse(msg.text)
					if (prevInfo.cost != null) {
						prevCompletedApiReqIndex = i
						break
					}
				} catch {
					/* continue searching */
				}
			}
		}

		// If no previous completed api_req, there's no "current activities" range
		if (prevCompletedApiReqIndex === -1) {
			return false
		}

		// Tool group is in-flight if AFTER prevCompleted AND BEFORE current
		return toolIndex > prevCompletedApiReqIndex && toolIndex < mostRecentApiReqIndex
	}
	// CASE B: Most recent api_req is COMPLETE (has cost)
	// Tool group is in-flight if it appears AFTER this completed api_req (just arrived)
	return toolIndex > mostRecentApiReqIndex
}

/**
 * Filter a tool group to exclude tools that are in the "current activities" range.
 * Returns the filtered array of messages (may be empty).
 *
 * This is used so ToolGroupRenderer shows PAST tools (what's already in context),
 * while the loading state shows ACTIVE tools (what's being "read" now).
 *
 * "Current activities" includes:
 * - (Case A) Tools between a previous completed api_req and the current incomplete api_req
 * - (Case B) Tools after the most recent api_req overall (either because it's complete, or no loading state is active yet)
 */
export function getToolsNotInCurrentActivities(toolGroupMessages: UiMessage[], allMessages: UiMessage[]): UiMessage[] {
	// Build a Map of timestamp -> index for O(1) lookups instead of O(n) findIndex calls
	const tsToIndex = new Map<number, number>()
	for (let i = 0; i < allMessages.length; i++) {
		tsToIndex.set(allMessages[i].ts, i)
	}

	// Step 1: Find the MOST RECENT api_req_started overall (search backwards)
	let mostRecentApiReqIndex = -1
	let mostRecentApiReq: UiMessage | null = null
	for (let i = allMessages.length - 1; i >= 0; i--) {
		if (allMessages[i].say === "api_req_started") {
			mostRecentApiReqIndex = i
			mostRecentApiReq = allMessages[i]
			break
		}
	}

	if (mostRecentApiReqIndex === -1) {
		// No api_req at all - show all tools
		return toolGroupMessages
	}

	if (!mostRecentApiReq?.text) {
		return toolGroupMessages
	}

	// Step 2: Determine if most recent api_req is complete (has cost) or incomplete (no cost)
	let mostRecentHasCost = false
	try {
		const info = JSON.parse(mostRecentApiReq.text)
		mostRecentHasCost = info.cost != null
	} catch {
		return toolGroupMessages
	}

	// Step 3: Determine which tools are "in current activities"
	if (!mostRecentHasCost) {
		// CASE A: Most recent api_req is INCOMPLETE (loading state active)
		// Tools are in-flight if they're between prev completed api_req and current incomplete one

		// Find the previous COMPLETED api_req
		let prevCompletedApiReqIndex = -1
		for (let i = mostRecentApiReqIndex - 1; i >= 0; i--) {
			const msg = allMessages[i]
			if (msg.say === "api_req_started" && msg.text) {
				try {
					const prevInfo = JSON.parse(msg.text)
					if (prevInfo.cost != null) {
						prevCompletedApiReqIndex = i
						break
					}
				} catch {
					/* continue searching */
				}
			}
		}

		if (prevCompletedApiReqIndex === -1) {
			// No previous completed api_req, so no tools are in the "current activities" range
			return toolGroupMessages
		}

		// Filter out tools in the range (prevCompleted, current)
		return toolGroupMessages.filter((msg) => {
			// Keep non-low-stakes tools
			if (!isLowStakesTool(msg)) {
				return true
			}

			// Filter out only tools awaiting approval (ask === 'tool')
			// Completed tools (say === 'tool') should still be shown
			if (msg.ask === "tool") {
				const toolIndex = tsToIndex.get(msg.ts)
				if (toolIndex === undefined) {
					return true
				}
				// Tool is in "current activities" range if AFTER prevCompleted AND BEFORE current
				const isInCurrentActivitiesRange = toolIndex > prevCompletedApiReqIndex && toolIndex < mostRecentApiReqIndex
				// Filter out if in current activities range
				return !isInCurrentActivitiesRange
			}

			// Keep completed tools (say === 'tool')
			return true
		})
	}
	// A completed request has no current-activity projection. Keep later asks in
	// the timeline so rejected or otherwise settled tools retain their card.
	return toolGroupMessages
}

/**
 * Returns true if this api_req_started should be fully absorbed into a low-stakes tool group.
 *
 * This scans FORWARD from the api_req_started until the next api_req_started and checks:
 * - at least one low-stakes tool exists
 * - no high-stakes tool/command exists
 *
 * Note: this operates on a flat `UiMessage[]` (e.g. `modifiedMessages`) rather than
 * grouped messages. It is used at render time to avoid transient UI frames where
 * `api_req_started` briefly appears before grouping absorbs it.
 */
export function isApiReqAbsorbable(apiReqTs: number, allMessages: UiMessage[]): boolean {
	const apiReqIndex = allMessages.findIndex((m) => m.ts === apiReqTs && m.say === "api_req_started")
	if (apiReqIndex === -1) {
		return false
	}

	let hasLowStakesTool = false
	let hasReasoning = false
	for (let i = apiReqIndex + 1; i < allMessages.length; i++) {
		const msg = allMessages[i]
		if (msg.say === "api_req_started") {
			break
		}

		// Reasoning - mark it but don't absorb if present
		if (msg.say === "reasoning") {
			hasReasoning = true
			continue
		}

		// Checkpoints do not affect absorbability
		if (msg.say === "checkpoint_created") {
			continue
		}

		// Text is allowed (we still want to absorb api_req into the tool group)
		if (msg.say === "text") {
			continue
		}

		// Low-stakes tools mark absorbability
		if (isLowStakesTool(msg)) {
			hasLowStakesTool = true
			continue
		}

		// Any other tool/command is considered high-stakes; do not absorb
		if (msg.say === "tool" || msg.ask === "tool" || msg.say === "command" || msg.ask === "command") {
			return false
		}
	}

	// Don't absorb if there's reasoning - we want to show "Thoughts >"
	return hasLowStakesTool && !hasReasoning
}

/**
 * Check if an api_req_started at a given index produces low-stakes tools
 * (regardless of whether it also produces text).
 * If so, it should be absorbed into the tool group rather than rendered separately.
 * The key is: no HIGH-stakes tools (write, edit, command, etc.) AND no reasoning
 */
function isApiReqFollowedOnlyByLowStakesTools(index: number, messages: (UiMessage | UiMessage[])[]): boolean {
	let hasLowStakesTool = false
	let hasReasoning = false
	for (let i = index + 1; i < messages.length; i++) {
		const item = messages[i]
		if (Array.isArray(item)) {
			// Browser session - this ends the low-stakes run
			break
		}
		const msg = item
		// Another api_req_started - stop checking
		if (msg.say === "api_req_started") {
			break
		}
		// Reasoning - mark it but don't absorb if present
		if (msg.say === "reasoning") {
			hasReasoning = true
			continue
		}
		// Low-stakes tool - mark it
		if (isLowStakesTool(msg)) {
			hasLowStakesTool = true
			continue
		}
		// Checkpoint is OK
		if (msg.say === "checkpoint_created") {
			continue
		}
		// Text is OK - it will render separately, but we still absorb api_req
		if (msg.say === "text") {
			continue
		}
		// High-stakes tool (write, edit, command, etc.) - don't absorb
		if (msg.say === "tool" || msg.ask === "tool" || msg.ask === "command" || msg.say === "command") {
			return false
		}
	}
	// Don't absorb if there's reasoning - we want to show "Thoughts >"
	return hasLowStakesTool && !hasReasoning
}

/**
 * Group consecutive low-stakes tools (and their reasoning) into arrays.
 * Also filters out checkpoints that follow low-stakes tool groups.
 * Absorbs api_req_started messages that are followed only by low-stakes tools.
 * Only creates tool groups when there's at least one actual tool - reasoning-only groups are dropped.
 * Should be called after groupMessages.
 */
export function groupLowStakesTools(groupedMessages: (UiMessage | UiMessage[])[]): (UiMessage | UiMessage[])[] {
	const result: (UiMessage | UiMessage[])[] = []
	let toolGroup: UiMessage[] = []
	let pendingReasoning: UiMessage[] = []
	let pendingApiReq: UiMessage[] = []
	let hasTools = false
	const pendingTools: UiMessage[] = []

	const flushPending = () => {
		pendingApiReq.forEach((m) => result.push(m))
		pendingReasoning.forEach((m) => result.push(m))
		pendingApiReq = []
		pendingReasoning = []
	}

	const commitToolGroup = () => {
		if (toolGroup.length > 0 && hasTools) {
			const group = toolGroup as UiMessage[] & { _isToolGroup: boolean }
			group._isToolGroup = true
			result.push(group)
			pendingReasoning = []
			pendingApiReq = []
		}
		toolGroup = []
		hasTools = false
	}

	const absorbPending = () => {
		if (pendingApiReq.length > 0) {
			toolGroup.push(...pendingApiReq)
			pendingApiReq = []
		}
	}

	for (let i = 0; i < groupedMessages.length; i++) {
		const item = groupedMessages[i]

		// Browser session group - commit current work and pass through
		if (Array.isArray(item)) {
			commitToolGroup()
			flushPending()
			result.push(item)
			continue
		}

		const message = item
		const messageType = message.say
		const isLast = i === groupedMessages.length - 1

		// Low-stakes tool - absorb pending and add to group
		if (isLowStakesTool(message)) {
			// Keep reasoning visible as its own row when it happens before a tool group.
			// If we absorb it into the group, ToolGroupRenderer hides it entirely.
			if (!hasTools && pendingReasoning.length > 0) {
				flushPending()
			}
			absorbPending()
			hasTools = true
			toolGroup.push(message)
			// If the streaming has stopped and the last message is still an ask,
			// this means the tool requires user approval - show the old tool block UI.
			if (message.type === "ask" && !message.partial && isLast) {
				pendingTools.push(message)
			}
			continue
		}

		// Reasoning - add to group if active, otherwise queue
		if (messageType === "reasoning") {
			if (hasTools) {
				toolGroup.push(message)
			} else {
				pendingReasoning.push(message)
			}
			continue
		}

		// API request - absorb if followed by low-stakes tools, otherwise render
		if (messageType === "api_req_started") {
			if (isApiReqFollowedOnlyByLowStakesTools(i, groupedMessages)) {
				absorbPending()
				pendingApiReq.push(message)
			} else {
				commitToolGroup()
				flushPending()
				result.push(message)
			}
			continue
		}

		// Checkpoint - absorb into active tool group
		if (messageType === "checkpoint_created" && hasTools) {
			toolGroup.push(message)
			continue
		}

		// Text - once a tool group is active, ignore additional text so it
		// doesn't continue mutating the text row rendered above the group.
		if (messageType === "text") {
			if (hasTools) {
				continue
			}
			flushPending()
			result.push(message)
			continue
		}

		// Everything else - commit group, flush pending, and render
		commitToolGroup()
		flushPending()
		result.push(message)
	}

	// Finalize any remaining work
	commitToolGroup()
	flushPending()

	if (pendingTools.length > 0) {
		result.push(...pendingTools)
	}

	return result
}

export function getIconByToolName(toolName: string) {
	switch (toolName) {
		case "readFile":
			return FileIcon
		case "listFilesTopLevel":
			return FolderOpenIcon
		case "listFilesRecursive":
			return FolderOpenDotIcon
		case "searchFiles":
			return SearchIcon
		case "findReferences": {
			const CodiconRef = () =>
				React.createElement("span", { className: "codicon codicon-references", style: { fontSize: "12px" } })
			return CodiconRef
		}
		case "renameSymbol": {
			const CodiconReplace = () =>
				React.createElement("span", { className: "codicon codicon-replace", style: { fontSize: "12px" } })
			return CodiconReplace
		}
		case "replaceText": {
			const CodiconReplaceAll = () =>
				React.createElement("span", { className: "codicon codicon-replace-all", style: { fontSize: "12px" } })
			return CodiconReplaceAll
		}
		case "listCodeDefinitionNames":
			return ShapesIcon
		default:
			return WrenchIcon
	}
}
