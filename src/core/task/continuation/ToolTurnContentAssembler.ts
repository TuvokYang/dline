import type { UiMessage } from "@shared/ExtensionMessage"
import type { ClineContent, ClineStorageMessage, ClineUserToolResultContentBlock } from "@shared/messages"
import { type DurableToolResultRecord, readDurableToolResult, replayContentOf } from "../DurableToolResult"
import { type BlockLifecycle, BlockPhase } from "./LegacyBlockLifecycle"

export interface AssembleToolTurnContentInput {
	blocks: readonly BlockLifecycle[]
	assistantApiIndex: number
	apiHistory: readonly ClineStorageMessage[]
	uiHistory: readonly UiMessage[]
	pendingContent: readonly ClineContent[]
	synthesizeMissing: "all" | "terminal_only"
	deferMissingDlineTids?: readonly string[]
}

function resultKey(dlineTid: string, functionId: string): string {
	return `${dlineTid}\u0000${functionId}`
}

function isToolResult(content: ClineContent): content is ClineUserToolResultContentBlock {
	return content.type === "tool_result"
}

function persistedApiResults(history: readonly ClineStorageMessage[], assistantApiIndex: number): Set<string> {
	const results = new Set<string>()
	for (const message of history.slice(Math.max(0, assistantApiIndex + 1))) {
		if (message.role !== "user" || !Array.isArray(message.content)) continue
		for (const content of message.content) {
			if (content.type === "tool_result") results.add(resultKey(content.dline_tid, content.function_id))
		}
	}
	return results
}

function pendingResults(content: readonly ClineContent[]): Map<string, ClineUserToolResultContentBlock> {
	const results = new Map<string, ClineUserToolResultContentBlock>()
	for (const item of content) {
		if (isToolResult(item)) results.set(resultKey(item.dline_tid, item.function_id), item)
	}
	return results
}

function durableResults(messages: readonly UiMessage[]): Map<string, DurableToolResultRecord> {
	const results = new Map<string, DurableToolResultRecord>()
	for (const message of messages) {
		if (message.type !== "say" || message.say !== "partial_tool_result" || !message.text) continue
		const record = readDurableToolResult(message.text)
		if (record) results.set(resultKey(record.block.dline_tid, record.block.function_id), record)
	}
	return results
}

function isTerminal(phase: BlockPhase): boolean {
	return (
		phase === BlockPhase.COMPLETED ||
		phase === BlockPhase.REJECTED ||
		phase === BlockPhase.SKIPPED ||
		phase === BlockPhase.CANCELLED
	)
}

function interruptedResult(block: BlockLifecycle): ClineUserToolResultContentBlock {
	return {
		type: "tool_result",
		function_id: block.functionId,
		dline_tid: block.dlineTid,
		content: [
			{
				type: "text",
				text: `Tool '${block.toolName}' was interrupted before a durable result was recorded. The side effect was not replayed.`,
			},
		],
		is_error: true,
	}
}

/** Assemble provider-facing content for one tool turn from canonical durable sources. */
export function assembleToolTurnContent(input: AssembleToolTurnContentInput): ClineContent[] {
	const persisted = persistedApiResults(input.apiHistory, input.assistantApiIndex)
	const pending = pendingResults(input.pendingContent)
	const durable = durableResults(input.uiHistory)
	const deferred = new Set(input.deferMissingDlineTids ?? [])
	const results: ClineUserToolResultContentBlock[] = []
	// A result whose call was never recorded as a tool call has nothing to pair
	// with, so it returns as prose; paired results stay first, as providers require.
	const prose: ClineContent[] = []

	for (const block of input.blocks) {
		const key = resultKey(block.dlineTid, block.functionId)
		if (persisted.has(key)) continue
		const pendingResult = pending.get(key)
		if (pendingResult) {
			results.push(pendingResult)
			continue
		}
		const durableResult = durable.get(key)
		if (durableResult) {
			if (durableResult.replay) prose.push(...replayContentOf(durableResult))
			else results.push(durableResult.block)
			continue
		}
		if (deferred.has(block.dlineTid)) continue
		if (input.synthesizeMissing === "all" || isTerminal(block.phase)) results.push(interruptedResult(block))
	}

	return [...results, ...prose, ...input.pendingContent.filter((content) => !isToolResult(content))]
}
