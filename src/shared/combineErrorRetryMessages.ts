import { ClineMessage } from "./ExtensionMessage"

const recoveredStreamSayTypes = new Set([
	"reasoning",
	"text",
	"tool",
	"use_mcp_server",
	"use_subagents",
	"browser_action_launch",
	"browser_action",
])

function isTerminalRetryFailure(message: ClineMessage): boolean {
	try {
		const retryInfo = JSON.parse(message.text || "{}") as { failed?: unknown }
		return retryInfo.failed === true
	} catch {
		return false
	}
}

function isRecoveredStreamMessage(message: ClineMessage, conversationHistoryIndex: number): boolean {
	if ((message.conversationHistoryIndex ?? 0) !== conversationHistoryIndex) {
		return false
	}

	if (message.type === "ask") {
		if ((message.ask === "followup" || message.ask === "completion_result") && message.partial !== true) {
			return Boolean(message.text)
		}
		return message.partial === true && message.ask !== undefined
	}

	if (message.say === "completion_result" && message.partial !== true) {
		return Boolean(message.text)
	}

	return (
		message.partial === true &&
		message.say !== undefined &&
		recoveredStreamSayTypes.has(message.say) &&
		Boolean(message.text || message.reasoning)
	)
}

function projectCanonicalApiError(messages: ClineMessage[]): ClineMessage[] {
	const canonicalError = messages.at(-1)
	if (canonicalError?.type !== "ask" || canonicalError.ask !== "api_req_failed" || !canonicalError.text) {
		return messages
	}

	let requestIndex = -1
	for (let index = messages.length - 2; index >= 0; index--) {
		if (messages[index].type === "say" && messages[index].say === "api_req_started") {
			requestIndex = index
			break
		}
	}
	if (requestIndex === -1) {
		return messages
	}

	const request = messages[requestIndex]
	try {
		const requestInfo = JSON.parse(request.text || "{}")
		if (requestInfo.streamingFailedMessage === canonicalError.text) {
			return messages
		}
		const projected = [...messages]
		projected[requestIndex] = {
			...request,
			text: JSON.stringify({ ...requestInfo, streamingFailedMessage: canonicalError.text }),
		}
		return projected
	} catch {
		return messages
	}
}

/**
 * Consolidates error_retry messages in a retry sequence, keeping only the latest one,
 * and removes successful retry messages entirely.
 *
 * When an API request fails and auto-retry is enabled, multiple error_retry messages are created
 * (e.g., "Attempt 1 of 3", "Attempt 2 of 3", "Attempt 3 of 3"), interleaved with api_req_retried
 * messages. This function:
 * 1. Filters out earlier retry messages, showing only the most recent one
 * 2. Removes error_retry messages entirely when a later durable conversation entry
 *    proves that the retried request produced a model response
 * 3. Preserves the legacy api_req_started boundary for non-final retries
 *
 * @param messages - An array of ClineMessage objects to process.
 * @returns A new array of ClineMessage objects with error_retry sequences consolidated.
 *
 * @example
 * // During retry sequence - shows only latest attempt:
 * const messages: ClineMessage[] = [
 *   { type: 'say', say: 'error_retry', text: '{"attempt":1,"maxAttempts":3}', ts: 1000 },
 *   { type: 'say', say: 'api_req_retried', ts: 1001 },
 *   { type: 'say', say: 'error_retry', text: '{"attempt":2,"maxAttempts":3}', ts: 1002 },
 *   { type: 'say', say: 'api_req_retried', ts: 1003 },
 *   { type: 'say', say: 'error_retry', text: '{"attempt":3,"maxAttempts":3}', ts: 1004 },
 * ];
 * const result = combineErrorRetryMessages(messages);
 * // Result: [{ type: 'say', say: 'error_retry', text: '{"attempt":3,"maxAttempts":3}', ts: 1004 }]
 *
 * @example
 * // After successful retry - removes error_retry entirely:
 * const messages: ClineMessage[] = [
 *   { type: 'say', say: 'error_retry', text: '{"attempt":1,"maxAttempts":3}', ts: 1000 },
 *   { type: 'say', say: 'api_req_retried', ts: 1001 },
 *   { type: 'say', say: 'api_req_started', text: '{}', ts: 1002 },
 * ];
 * const result = combineErrorRetryMessages(messages);
 * // Result: [{ type: 'say', say: 'api_req_started', text: '{}', ts: 1002 }]
 */
export function combineErrorRetryMessages(messages: ClineMessage[]): ClineMessage[] {
	const projectedMessages = projectCanonicalApiError(messages)
	const result: ClineMessage[] = []

	for (let i = 0; i < projectedMessages.length; i++) {
		const message = projectedMessages[i]

		if (message.say === "error_retry") {
			// Look ahead to find if there's another error_retry before the next api_req_started
			const isTerminalFailure = isTerminalRetryFailure(message)
			let hasLaterErrorRetry = false
			let hasApiReqStartedBefore = false
			let hasRecoveredConversation = false
			let hasCanonicalRecoveryAsk = false
			let hasRetryStarted = false
			const conversationHistoryIndex = message.conversationHistoryIndex ?? 0

			for (let j = i + 1; j < projectedMessages.length; j++) {
				const laterMessage = projectedMessages[j]
				if (laterMessage.say === "error_retry") {
					hasLaterErrorRetry = true
					break
				}
				if (laterMessage.type === "ask" && laterMessage.ask === "api_req_failed") {
					hasCanonicalRecoveryAsk = true
					break
				}
				if (laterMessage.say === "api_req_retried") {
					hasRetryStarted = true
					continue
				}
				if (laterMessage.say === "api_req_started") {
					hasApiReqStartedBefore = true
					hasRetryStarted = true
					continue
				}
				if (
					hasRetryStarted &&
					((laterMessage.conversationHistoryIndex ?? 0) > conversationHistoryIndex ||
						isRecoveredStreamMessage(laterMessage, conversationHistoryIndex))
				) {
					hasRecoveredConversation = true
					break
				}
			}

			// Case 1: Another error_retry follows before api_req_started - skip this one
			if (hasLaterErrorRetry) {
				continue
			}

			// A canonical recovery ask replaces transient retry status, but the
			// exhausted card remains the visible explanation beside its actions.
			// Any later durable model response retires both states entirely.
			if (hasRecoveredConversation || (hasCanonicalRecoveryAsk && !isTerminalFailure)) {
				continue
			}

			// Case 2: api_req_started follows (no later error_retry) - retry succeeded.
			// Keep only a terminal failure until a durable response proves recovery.
			if (hasApiReqStartedBefore && !isTerminalFailure) {
				continue
			}
		}

		result.push(message)
	}

	return result
}
