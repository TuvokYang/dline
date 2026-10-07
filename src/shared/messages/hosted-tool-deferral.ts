import {
	type ClineAssistantContent,
	type ClineAssistantHostedToolBlock,
	type ClineStorageMessage,
	type HostedToolReplayProtocol,
	hostedSegmentCallId,
	hostedToolName,
	isHostedToolBlock,
} from "./content"

/**
 * Where a deferred hosted call stands in a conversation.
 *
 * - `pending`: the history ends with the client tool results that let the provider run it; the next request
 *   resumes it.
 * - `resumed`: the following assistant turn opened with its result.
 * - `dropped`: the provider can no longer run it, so requests must not carry it.
 */
export type DeferredHostedCallState = "pending" | "resumed" | "dropped"

export interface DeferredHostedCall {
	/** Provider-native call id that pairs the call segment with its result segment. */
	callId: string
	toolName: string
	/** Index of the assistant message holding the call segment. */
	messageIndex: number
	state: DeferredHostedCallState
}

export interface DeferredHostedCallOptions {
	/** Hosted protocol of the target request; segments of any other protocol are dropped. */
	protocol: HostedToolReplayProtocol
	/** Hosted tool names the target request declares; absent when it declares none. */
	replayHostedTools?: ReadonlySet<string>
}

/**
 * Decide, from stored history alone, which deferred hosted calls a request can still carry.
 *
 * A deferred call is honoured only in the shape the provider accepts: the user message right after its turn
 * answers that turn's client tools, and the next assistant turn, if any, opens with the call's result. Every
 * consumer derives its view from this one function, so the request projection and the task's hosted-call
 * rows always agree, and the same history always projects to the same request.
 */
export function resolveDeferredHostedCalls(
	messages: readonly ClineStorageMessage[],
	options: DeferredHostedCallOptions,
): DeferredHostedCall[] {
	const calls: DeferredHostedCall[] = []
	messages.forEach((message, messageIndex) => {
		if (message.role !== "assistant" || !Array.isArray(message.content)) return
		for (const block of message.content) {
			if (!isHostedToolBlock(block) || block.segment !== "call") continue
			const callId = hostedSegmentCallId(block)
			const toolName = hostedToolName(block)
			if (callId === undefined || toolName === undefined) continue
			calls.push({
				callId,
				toolName,
				messageIndex,
				state: deferredCallState(messages, messageIndex, block, callId, toolName, options),
			})
		}
	})
	return calls
}

function deferredCallState(
	messages: readonly ClineStorageMessage[],
	messageIndex: number,
	block: ClineAssistantHostedToolBlock,
	callId: string,
	toolName: string,
	options: DeferredHostedCallOptions,
): DeferredHostedCallState {
	if (block.protocol !== options.protocol || !options.replayHostedTools?.has(toolName)) return "dropped"
	if (!answersClientTools(messages[messageIndex + 1])) return "dropped"
	const next = messages[messageIndex + 2]
	if (next === undefined) return "pending"
	return opensWithResultFor(next, callId) ? "resumed" : "dropped"
}

/**
 * Split the hosted blocks of one response into the results of calls an earlier response deferred, and the rest.
 *
 * The provider opens its response with those results, and the next request is only accepted when the stored
 * turn keeps them first, so the caller must place `resumed` at the very start of the assistant turn.
 */
export function splitResumedHostedResults(blocks: readonly ClineAssistantContent[]): {
	resumed: ClineAssistantContent[]
	others: ClineAssistantContent[]
} {
	const resumed: ClineAssistantContent[] = []
	const others: ClineAssistantContent[] = []
	for (const block of blocks) {
		if (isHostedToolBlock(block) && block.segment === "result") resumed.push(block)
		else others.push(block)
	}
	return { resumed, others }
}

/** The follow-up the provider resumes from: a user message carrying at least one client tool result. */
function answersClientTools(message: ClineStorageMessage | undefined): boolean {
	return (
		message?.role === "user" &&
		Array.isArray(message.content) &&
		message.content.some((block) => block.type === "tool_result")
	)
}

/** Whether an assistant turn opens with the result segments of deferred calls, one of them for `callId`. */
function opensWithResultFor(message: ClineStorageMessage, callId: string): boolean {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return false
	for (const block of message.content) {
		if (!isHostedToolBlock(block) || block.segment !== "result") return false
		if (hostedSegmentCallId(block) === callId) return true
	}
	return false
}
