import type { ClineMessage, ClineSayTool, CompactionConversationRange } from "@shared/ExtensionMessage"
import type { ClineStorageMessage, ClineUserToolResultContentBlock } from "@shared/messages/content"
import { hasTaggedUserFeedback } from "./logical-turns"

export type CanonicalMessageRange = readonly [startIndex: number, endIndex: number]

export interface CompletedCompactionCardProjection {
	readonly summary: string
	readonly range: CompactionConversationRange
}

export interface CompactionContextProjectionInput {
	readonly canonicalHistory: readonly ClineStorageMessage[]
	readonly completedCards?: readonly CompletedCompactionCardProjection[]
	readonly conversationHistoryDeletedRange?: CanonicalMessageRange
}

export interface CompactionContextProjection {
	readonly messages: ClineStorageMessage[]
	readonly canonicalMessageIndexes: Array<number | undefined>
	readonly sourceCanonicalRanges: Array<CanonicalMessageRange | undefined>
	readonly canonicalRanges: CanonicalMessageRange[]
}

/** Read new-format durable compaction cards from the already-loaded UI message cache. */
export function readCompletedCompactionCards(messages: readonly ClineMessage[]): CompletedCompactionCardProjection[] {
	return messages.flatMap((message) => {
		if (message.partial || message.say !== "tool" || !message.compactionConversationRange || !message.text) return []
		try {
			const payload = JSON.parse(message.text) as ClineSayTool
			if (
				payload.tool !== "summarizeTask" ||
				payload.compactionStatus !== "completed" ||
				typeof payload.content !== "string"
			) {
				return []
			}
			return [{ summary: payload.content, range: message.compactionConversationRange }]
		} catch {
			return []
		}
	})
}

/** Derive provider context from canonical history without changing durable conversation records. */
export function projectCompactionContext(input: CompactionContextProjectionInput): CompactionContextProjection {
	const cards = normalizeCards(input.completedCards ?? [], input.canonicalHistory.length)
	const deletedRanges = normalizeRanges(
		input.conversationHistoryDeletedRange ? [input.conversationHistoryDeletedRange] : [],
		input.canonicalHistory.length,
	)
	const messages: ClineStorageMessage[] = []
	const canonicalMessageIndexes: Array<number | undefined> = []
	const sourceCanonicalRanges: Array<CanonicalMessageRange | undefined> = []
	const canonicalRanges: CanonicalMessageRange[] = []
	// Tool use identity -> last canonical index the summarizing Pass could see.
	const summarizedToolUses = new Map<string, number>()
	let activeRangeStart: number | undefined
	let cardIndex = 0

	for (let index = 0; index < input.canonicalHistory.length; index++) {
		while (cards[cardIndex]?.range.apiConversationRange[0] === index) {
			const card = cards[cardIndex]
			if (card.summary.trim()) {
				messages.push(summaryMessage(card.summary))
				canonicalMessageIndexes.push(undefined)
				sourceCanonicalRanges.push(card.range.apiConversationRange)
			}
			cardIndex += 1
		}

		const coveringCard = findCoveringCard(index, cards)
		if (coveringCard) collectToolUses(input.canonicalHistory[index], coveringCard, summarizedToolUses)
		const message =
			isExcluded(index, deletedRanges) || coveringCard
				? undefined
				: withoutSummarizedToolResults(input.canonicalHistory[index], index, summarizedToolUses)
		if (!message) {
			if (activeRangeStart !== undefined) {
				canonicalRanges.push([activeRangeStart, index - 1])
				activeRangeStart = undefined
			}
			continue
		}
		activeRangeStart ??= index
		messages.push(message)
		canonicalMessageIndexes.push(index)
		sourceCanonicalRanges.push([index, index])
	}
	if (activeRangeStart !== undefined) canonicalRanges.push([activeRangeStart, input.canonicalHistory.length - 1])
	return { messages, canonicalMessageIndexes, sourceCanonicalRanges, canonicalRanges }
}

function normalizeCards(
	cards: readonly CompletedCompactionCardProjection[],
	canonicalLength: number,
): CompletedCompactionCardProjection[] {
	const survivingCards: CompletedCompactionCardProjection[] = []
	for (const card of cards) {
		if (!card.summary.trim() || !isValidConversationRange(card.range, canonicalLength)) continue
		for (let index = survivingCards.length - 1; index >= 0; index--) {
			if (rangesOverlap(survivingCards[index].range.apiConversationRange, card.range.apiConversationRange)) {
				survivingCards.splice(index, 1)
			}
		}
		survivingCards.push(card)
	}
	return survivingCards.sort((left, right) => left.range.apiConversationRange[0] - right.range.apiConversationRange[0])
}

function rangesOverlap(left: CanonicalMessageRange, right: CanonicalMessageRange): boolean {
	return left[0] <= right[1] && right[0] <= left[1]
}

function isValidConversationRange(range: CompactionConversationRange, canonicalLength: number): boolean {
	const [start, end] = range.apiConversationRange
	const [turnStart, turnEnd] = range.logicalTurnRange
	return (
		Number.isInteger(start) &&
		Number.isInteger(end) &&
		start >= 0 &&
		start <= end &&
		end < canonicalLength &&
		Number.isInteger(turnStart) &&
		Number.isInteger(turnEnd) &&
		turnStart >= 0 &&
		turnStart <= turnEnd &&
		Number.isInteger(range.preCompactionApiEndIndex) &&
		range.preCompactionApiEndIndex >= end &&
		range.preCompactionApiEndIndex < canonicalLength
	)
}

function normalizeRanges(ranges: readonly CanonicalMessageRange[], length: number): CanonicalMessageRange[] {
	const normalized = ranges
		.map(([start, end]) => [Math.max(0, start), Math.min(length - 1, end)] as const)
		.filter(([start, end]) => Number.isInteger(start) && Number.isInteger(end) && start <= end)
		.sort(([left], [right]) => left - right)
	const merged: CanonicalMessageRange[] = []
	for (const range of normalized) {
		const previous = merged.at(-1)
		if (!previous || range[0] > previous[1] + 1) merged.push(range)
		else merged[merged.length - 1] = [previous[0], Math.max(previous[1], range[1])]
	}
	return merged
}

function isExcluded(index: number, ranges: readonly CanonicalMessageRange[]): boolean {
	return ranges.some(([start, end]) => index >= start && index <= end)
}

function findCoveringCard(
	index: number,
	cards: readonly CompletedCompactionCardProjection[],
): CompletedCompactionCardProjection | undefined {
	return cards.find(({ range }) => index >= range.apiConversationRange[0] && index <= range.apiConversationRange[1])
}

function collectToolUses(
	message: ClineStorageMessage,
	card: CompletedCompactionCardProjection,
	summarizedToolUses: Map<string, number>,
): void {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return
	for (const block of message.content) {
		if (block.type === "tool_use" && block.function_id) {
			summarizedToolUses.set(block.function_id, card.range.preCompactionApiEndIndex)
		}
	}
}

/**
 * A Pass consumes plain results that were still pending when it ran; its summary already carries their payload.
 * Results that were durable before the Pass, or that carry tagged user feedback, were never summarized and stay.
 */
function isConsumedBySummary(
	block: ClineUserToolResultContentBlock,
	messageIndex: number,
	summarizedToolUses: ReadonlyMap<string, number>,
): boolean {
	const preCompactionApiEndIndex = summarizedToolUses.get(block.function_id)
	return preCompactionApiEndIndex !== undefined && messageIndex > preCompactionApiEndIndex && !hasTaggedUserFeedback(block)
}

/** Returns the message itself when nothing is omitted, and undefined when nothing provider-visible remains. */
function withoutSummarizedToolResults(
	message: ClineStorageMessage,
	messageIndex: number,
	summarizedToolUses: ReadonlyMap<string, number>,
): ClineStorageMessage | undefined {
	if (summarizedToolUses.size === 0 || message.role !== "user" || !Array.isArray(message.content)) return message
	const content = message.content.filter(
		(block) => block.type !== "tool_result" || !isConsumedBySummary(block, messageIndex, summarizedToolUses),
	)
	if (content.length === message.content.length) return message
	return content.length > 0 ? ({ ...message, content } as ClineStorageMessage) : undefined
}

function summaryMessage(summary: string): ClineStorageMessage {
	return { role: "user", content: [{ type: "text", text: summary }] }
}
