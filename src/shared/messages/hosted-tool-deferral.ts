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
	/**
	 * Indices of the consecutive user messages that follow the call's turn. The provider reads them as one user
	 * turn, so a request that carries the call must send them as one message holding only tool results.
	 */
	followUpIndices: readonly number[]
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
 * A deferred call is honoured only in the shape the provider accepts: the user turn right after its turn - one
 * or more consecutive user messages, which the provider reads as one turn - opens with the answers to that
 * turn's client tools, and the next assistant turn, if any, opens with the call's result. Every
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
			const followUpIndices = followUpRun(messages, messageIndex)
			calls.push({
				callId,
				toolName,
				messageIndex,
				followUpIndices,
				state: deferredCallState(messages, followUpIndices, block, callId, toolName, options),
			})
		}
	})
	return calls
}

/**
 * The user messages between an assistant turn and the next assistant turn.
 *
 * The task journal stores a round's tool results and its environment details as separate user messages; the
 * provider merges adjacent user messages into one turn, so the deferral rules apply to the whole run.
 */
function followUpRun(messages: readonly ClineStorageMessage[], messageIndex: number): number[] {
	const indices: number[] = []
	for (let index = messageIndex + 1; index < messages.length && messages[index].role === "user"; index++) {
		indices.push(index)
	}
	return indices
}

function deferredCallState(
	messages: readonly ClineStorageMessage[],
	followUpIndices: readonly number[],
	block: ClineAssistantHostedToolBlock,
	callId: string,
	toolName: string,
	options: DeferredHostedCallOptions,
): DeferredHostedCallState {
	if (block.protocol !== options.protocol || !options.replayHostedTools?.has(toolName)) return "dropped"
	const firstFollowUp = followUpIndices[0]
	if (firstFollowUp === undefined || !answersClientTools(messages[firstFollowUp])) return "dropped"
	const next = messages[firstFollowUp + followUpIndices.length]
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
