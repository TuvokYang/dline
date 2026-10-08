import { randomUUID } from "node:crypto"
import { USER_CONTENT_TAGS } from "@shared/messages/constants"
import {
	type ClineImageContentBlock,
	type ClineStorageMessage,
	type ClineTextContentBlock,
	type ClineUserToolResultContentBlock,
	imageSourceToUrl,
} from "@shared/messages/content"
import { Logger } from "@shared/services/Logger"
import { type ClineDefaultTool, CONVERSATIONAL_TOOL_NAMES } from "@shared/tools"
import type { JournalConversationView } from "../executors/provider/service/JournalConversationView"
import type { ConversationJournal, JournalEntry, JournalWatermark, TaskPayloadStore } from "../stores"
import { encodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type {
	CompactionContinuation,
	CompactionReplyBoundary,
	CompactionSummaryEnvelope,
} from "../stores/payload/TaskPayloadEnvelopes"
import type { CompactionLandingInput, CompactionLandingPort, CompactionSpan } from "./CompactionSummaryLanding"

/** What a compaction summarizes, and the journal span the summary will stand for. */
export interface CompactionSource {
	readonly messages: ClineStorageMessage[]
	/**
	 * Journal position of each message in `messages`, as `[seq, seq]`.
	 *
	 * A summary may stand for only the oldest turns of the span when the rest
	 * already fits, so landing needs to know where each summarized message
	 * lives to shrink the span to what was actually covered.
	 */
	readonly sourceRanges?: ReadonlyArray<readonly [number, number]>
	/** Visible messages after the span, which the next request carries after the summary. */
	readonly tail?: ClineStorageMessage[]
	/** Absent when nothing past the opening request has been answered yet. */
	readonly span?: CompactionSpan
	/**
	 * The user's reply the span has to end on, replayed after the summary.
	 *
	 * Present when that reply opens the turn still waiting on the user: the
	 * reply belongs to the protected continuation (WS-010 §2), but its tool
	 * result must stay paired with the call it answers, so the result is
	 * condensed and the reply itself survives the summary verbatim.
	 */
	readonly continuation?: CompactionContinuation
	/** Replies inside the span, so a summary of only its oldest turns still lands each call with its result. */
	readonly replies?: readonly CompactionReplyBoundary[]
}

/**
 * Reads the conversation a compaction has to summarize.
 *
 * A summary is only useful if it describes what the next request would have
 * carried, so the source must be the same conversation the provider domain
 * sends. Declaring it as a port keeps the compaction domain independent of
 * where that conversation is stored.
 */
export interface CompactionConversationPort {
	read(): Promise<CompactionSource>
}

/** Removes the oldest settled history so a request the provider refused as too long fits again. */
export interface ContextTruncationPort {
	/** Resolves the truncation record's position, or undefined when nothing settled can be removed. */
	truncate(input: { readonly notice: string; readonly signal?: AbortSignal }): Promise<JournalWatermark | undefined>
}

interface ConversationItem {
	readonly entry: JournalEntry
	/** Payload kind of the entry, which is what says who wrote a user-role message. */
	readonly kind: string
	readonly message: ClineStorageMessage
	/** Set on the reply a landed summary replays after itself; that reply is still the user's open input. */
	readonly continuation?: CompactionContinuation
}

/** Tool id to tool name, so a result can be told apart by the call it answers. */
type ToolNames = ReadonlyMap<string, string>

/**
 * Payloads a person wrote.
 *
 * Environment snapshots, background results and turn continuations are
 * journaled as user-role text too, and their journal source is not reliable
 * for entries written before sources were recorded, so authorship is read
 * from the payload itself. An imported user message that answers no call is
 * the task or feedback an earlier version recorded, so it counts as written too.
 */
const USER_AUTHORED_KINDS: ReadonlySet<string> = new Set([
	"user_input",
	"dialog_draft",
	"dialog_selection",
	"task_handoff",
	"api_history_message",
])

/**
 * What the summarizer reads in place of a reply the summary will not describe.
 *
 * The result has to stay so its call is not left unpaired, but the reply
 * itself is replayed after the summary; describing it twice would hand the
 * model a paraphrase of input it is about to read verbatim.
 */
const REPLY_KEPT_AFTER_SUMMARY =
	"The user replied to this call. The reply follows the summary verbatim, so it is not part of what is summarized."

function toolUseIds(message: ClineStorageMessage): string[] {
	if (message.role !== "assistant" || !Array.isArray(message.content)) return []
	return message.content.flatMap((block) => (block.type === "tool_use" ? [block.function_id] : []))
}

function toolResults(message: ClineStorageMessage): ClineUserToolResultContentBlock[] {
	if (message.role !== "user" || !Array.isArray(message.content)) return []
	return message.content.filter((block): block is ClineUserToolResultContentBlock => block.type === "tool_result")
}

function toolResultIds(message: ClineStorageMessage): string[] {
	return toolResults(message).map((block) => block.function_id)
}

function toolNames(messages: readonly ClineStorageMessage[]): ToolNames {
	const names = new Map<string, string>()
	for (const message of messages) {
		if (message.role !== "assistant" || !Array.isArray(message.content)) continue
		for (const block of message.content) if (block.type === "tool_use") names.set(block.function_id, block.name)
	}
	return names
}

function resultParts(block: ClineUserToolResultContentBlock): Array<ClineTextContentBlock | ClineImageContentBlock> {
	return typeof block.content === "string" ? [{ type: "text", text: block.content }] : block.content
}

/** How a handler frames a file the user attached to a reply (`processFilesIntoText`). */
const FILE_ATTACHMENT_OPENING = "<file_content "

function isFileAttachment(text: string): boolean {
	return text.trimStart().startsWith(FILE_ATTACHMENT_OPENING)
}

/**
 * Results that carry the user's own reply to a conversational call, which WS-010 counts as user-authored input.
 *
 * A reply is recognised by the tag its handler wraps the text in, or by what
 * only a user puts into a conversational result: an image or an attached file.
 * Image-only and file-only replies have no tagged text to find.
 */
function userReplies(message: ClineStorageMessage, names: ToolNames): ClineUserToolResultContentBlock[] {
	return toolResults(message).filter((block) => {
		const name = names.get(block.function_id)
		if (!name || !CONVERSATIONAL_TOOL_NAMES.has(name as ClineDefaultTool)) return false
		return resultParts(block).some(
			(part) => part.type === "image" || hasUserContentTag(part.text) || isFileAttachment(part.text),
		)
	})
}

/**
 * Whether this message opens a logical turn (WS-010 §2): input a person wrote,
 * or their reply to a conversational call. Environment snapshots and other
 * system context are journaled as user messages too, but nobody wrote them.
 */
function opensTurn(item: ConversationItem, names: ToolNames): boolean {
	if (item.message.role !== "user") return false
	if (item.continuation) return true
	if (toolResults(item.message).length > 0) return userReplies(item.message, names).length > 0
	return USER_AUTHORED_KINDS.has(item.kind)
}

function lastAssistantIndex(messages: readonly ClineStorageMessage[]): number {
	for (let index = messages.length - 1; index >= 0; index--) {
		if (messages[index]?.role === "assistant") return index
	}
	return -1
}

/** Index of the first assistant message within `[0, end]` whose tool call has no result within it. */
function firstUnpairedCall(messages: readonly ClineStorageMessage[], end: number): number {
	const answered = new Set(messages.slice(0, end + 1).flatMap(toolResultIds))
	return messages.findIndex((message, index) => index <= end && toolUseIds(message).some((id) => !answered.has(id)))
}

/** Index of the first message within `[0, end]` with a tool result no earlier call issued. */
function firstOrphanResult(messages: readonly ClineStorageMessage[], end: number): number {
	const called = new Set<string>()
	for (let index = 0; index <= end; index++) {
		const message = messages[index]
		if (!message) continue
		for (const id of toolUseIds(message)) called.add(id)
		if (toolResultIds(message).some((id) => !called.has(id))) return index
	}
	return -1
}

/**
 * The latest index at or before `limit` whose prefix pairs every call with its
 * result and every result with its call; an unpaired result is protected
 * continuation (WS-010 §2), never summarized.
 */
function settledEnd(messages: readonly ClineStorageMessage[], limit: number): number {
	let end = limit
	while (end >= 0) {
		const cuts = [firstUnpairedCall(messages, end), firstOrphanResult(messages, end)].filter((index) => index >= 0)
		if (cuts.length === 0) return end
		end = Math.min(...cuts) - 1
	}
	return end
}

/**
 * Index of the last message a summary may stand for.
 *
 * Input a person wrote after the model last spoke opens the next turn, so no
 * request has carried it and it stays verbatim after the summary. Tool results
 * that answer the model's last calls are different: they close the turn the
 * model already opened, so that completed turn is summarized whole rather than
 * leaving its results behind without their calls (WS-010 AC-WS010-011-01). An
 * assistant call whose result is still unsettled is excluded with it, so the
 * settled span stays provider-projectable on its own.
 */
function lastSettledIndex(items: readonly ConversationItem[], names: ToolNames): number {
	const messages = items.map((item) => item.message)
	let end = lastAssistantIndex(messages)
	while (end >= 0) {
		const next = items[end + 1]
		if (!next || toolResults(next.message).length === 0 || opensTurn(next, names)) break
		end++
	}
	return settledEnd(messages, end)
}

/** Index of the first call the model is still waiting on, or -1 when the journal answers every call. */
function firstOpenCall(messages: readonly ClineStorageMessage[]): number {
	return firstUnpairedCall(messages, messages.length - 1)
}

/**
 * Where the logical turn still waiting on an open call begins, or -1 when no call is open.
 *
 * Mirrors the logical-turn index: the turn opens at the nearest user-authored
 * message before the call, unless a completed tool round lies in between, in
 * which case the next call the model made after that round opened the turn.
 */
function openTurnStart(items: readonly ConversationItem[], names: ToolNames): number {
	const messages = items.map((item) => item.message)
	const open = firstOpenCall(messages)
	if (open < 0) return -1
	for (let index = open - 1; index >= 0; index--) {
		const item = items[index]
		if (!item) continue
		if (opensTurn(item, names)) return index
		if (toolResults(item.message).length > 0) {
			return messages.findIndex((message, next) => next > index && toolUseIds(message).length > 0)
		}
	}
	return 0
}

/**
 * Index of the user's reply to the model's last call when that call closes the
 * only round so far, or -1.
 *
 * With an answered round before the call, that round is what gets summarized
 * and the call stays verbatim with its reply. Without one, stopping before the
 * call leaves nothing a summary could stand for, though the round the reply
 * completes is finished. That round is summarized instead, ending on the reply
 * so its call keeps a result, and the reply itself is carried past the summary
 * as the input of the round being composed.
 */
function onlyRoundReply(items: readonly ConversationItem[], names: ToolNames, end: number): number {
	const messages = items.map((item) => item.message)
	if (messages.slice(0, end + 1).some((message) => message.role === "assistant")) return -1
	const reply = lastAssistantIndex(messages) + 1
	const answer = items[reply]
	if (reply === 0 || !answer || userReplies(answer.message, names).length === 0) return -1
	return settledEnd(messages, reply) === reply ? reply : -1
}

/**
 * The last message a summary may stand for, and whether it is the user's reply
 * opening the turn that is still waiting on them.
 *
 * That turn is protected continuation, so the span stops before it. A reply is
 * the one exception: it is the result of the call before it, and leaving it
 * behind would strand that call without its result, so the span ends on it
 * and the reply itself is carried past the summary.
 */
function settledBoundary(
	items: readonly ConversationItem[],
	names: ToolNames,
): { readonly end: number; readonly reply: boolean } {
	const messages = items.map((item) => item.message)
	const end = lastSettledIndex(items, names)
	const start = openTurnStart(items, names)
	if (start < 0) {
		const reply = onlyRoundReply(items, names, end)
		return reply < 0 ? { end, reply: false } : { end: reply, reply: true }
	}
	const opening = messages[start]
	if (start > end || !opening) return { end, reply: false }
	if (userReplies(opening, names).length === 0) return { end: settledEnd(messages, start - 1), reply: false }
	const replyEnd = settledEnd(messages, start)
	return { end: replyEnd, reply: replyEnd === start }
}

/**
 * What the user wrote, without the handler's framing.
 *
 * The handler wraps the reply as `<tag>\n...\n</tag>` and may put its own prose
 * around it. The body runs to the last closing tag of the same name, so a
 * reply that itself contains that closing tag as text is kept whole. Only the
 * newlines the wrapper added are removed, so the reply's own leading and
 * trailing whitespace survives.
 */
function unwrapReply(text: string): string | undefined {
	const lower = text.toLowerCase()
	const opened = USER_CONTENT_TAGS.map((tag) => ({ tag, at: lower.indexOf(tag) }))
		.filter(({ at }) => at >= 0)
		.sort((left, right) => left.at - right.at)[0]
	if (!opened) return undefined
	const bodyStart = opened.at + opened.tag.length
	const bodyEnd = lower.lastIndexOf(`</${opened.tag.slice(1)}`)
	if (bodyEnd < bodyStart) return undefined
	return text.slice(bodyStart, bodyEnd).replace(/^\n/, "").replace(/\n$/, "")
}

function hasUserContentTag(text: string): boolean {
	return USER_CONTENT_TAGS.some((tag) => text.toLowerCase().includes(tag))
}

/**
 * The call a reply answers through the reply itself, verbatim.
 *
 * Replayed after the summary, the reply stays the result of the call it
 * answers rather than becoming input that answers nothing. Everything between
 * the call and the reply goes with them so every call in the exchange keeps
 * its result.
 */
function replyExchange(
	items: readonly ConversationItem[],
	replyIndex: number,
	names: ToolNames,
): ClineStorageMessage[] | undefined {
	const reply = items[replyIndex]
	if (!reply) return undefined
	const answered = new Set(userReplies(reply.message, names).map((block) => block.function_id))
	for (let index = replyIndex - 1; index >= 0; index--) {
		const item = items[index]
		if (!item || !toolUseIds(item.message).some((id) => answered.has(id))) continue
		return items.slice(index, replyIndex + 1).map(({ message }) => message)
	}
	return undefined
}

/** Whether the model answered anything after `index`; a reply nothing answered yet is still pending. */
function answeredAfter(items: readonly ConversationItem[], index: number): boolean {
	return items.slice(index + 1).some((item) => item.message.role === "assistant")
}

/** The continuation without the call it answers, for a reply the model already went on from. */
function withoutExchange(continuation: CompactionContinuation): CompactionContinuation {
	const { exchange: _exchange, ...reply } = continuation
	return reply
}

/**
 * The reply at `replyIndex`, to be replayed after the summary.
 *
 * The user-authored part is kept: the body of the first wrapped reply and the
 * files they attached, kept verbatim even if a file happens to contain a tag,
 * without the handler's own framing ("Result: Done", "User continued the
 * conversation."). Only a reply the model has not answered yet keeps the call
 * it answers, as dev keeps the call a pending result answers; a reply the
 * model already went on from returns as ordinary input, as dev demotes a
 * result whose call the summary replaced, so the summarized call never comes
 * back with it.
 */
function replyContinuation(items: readonly ConversationItem[], replyIndex: number, names: ToolNames): CompactionContinuation {
	const message = items[replyIndex]?.message
	if (!message) return { text: "" }
	const texts: string[] = []
	const images: string[] = []
	for (const block of userReplies(message, names)) {
		let unwrapped = false
		for (const part of resultParts(block)) {
			if (part.type === "image") {
				if (part.source.type === "base64") images.push(imageSourceToUrl(part.source))
				else Logger.warn("[Compaction] A reply image without inline data cannot be replayed after the summary")
				continue
			}
			if (isFileAttachment(part.text)) {
				texts.push(part.text)
				continue
			}
			const body = unwrapped ? undefined : unwrapReply(part.text)
			if (body === undefined) continue
			unwrapped = true
			texts.push(body)
		}
	}
	const text = texts.filter((value) => value.trim().length > 0).join("\n\n")
	const exchange = answeredAfter(items, replyIndex) ? undefined : replyExchange(items, replyIndex, names)
	return { text, ...(images.length > 0 ? { images } : {}), ...(exchange ? { exchange } : {}) }
}

/** The same message with the reply replaced by a note, so the summary keeps the pairing but not the reply. */
function withoutReplies(message: ClineStorageMessage, names: ToolNames): ClineStorageMessage {
	if (!Array.isArray(message.content)) return message
	const replied = new Set(userReplies(message, names).map((block) => block.function_id))
	return {
		...message,
		content: message.content.map((block) =>
			block.type === "tool_result" && replied.has(block.function_id)
				? { ...block, content: REPLY_KEPT_AFTER_SUMMARY }
				: block,
		),
	}
}

/** Each reply the span ending at `end` holds, located by the call it answers. */
function replyBoundaries(items: readonly ConversationItem[], end: number, names: ToolNames): CompactionReplyBoundary[] {
	const covered = items.slice(0, end + 1)
	return covered.flatMap((item, index) => {
		const answered = new Set(userReplies(item.message, names).map((block) => block.function_id))
		if (answered.size === 0) return []
		const call = covered.find((candidate) => toolUseIds(candidate.message).some((id) => answered.has(id)))
		if (!call) return []
		return [
			{
				callSeq: call.entry.watermark.seq,
				replySeq: item.entry.watermark.seq,
				continuation: replyContinuation(items, index, names),
			},
		]
	})
}

/**
 * Index of the first message context-window truncation may remove, or -1.
 *
 * What the task is stays: the opening input, or the summary that took its
 * place. A landed summary and the exchange it replays are one journal record
 * and a range cannot split a record, so the head extends past all of it.
 */
function truncationStart(items: readonly ConversationItem[], names: ToolNames): number {
	const opening = items.findIndex((item) => opensTurn(item, names) || item.kind === "compaction_summary")
	if (opening < 0) return -1
	let start = opening + 1
	while (start < items.length && items[start]?.entry === items[opening]?.entry) start++
	return start < items.length ? start : -1
}

/** Whether each prefix pairs every call with its result and every result with its call. */
function closedPrefixes(messages: readonly ClineStorageMessage[]): boolean[] {
	const open = new Set<string>()
	let orphaned = false
	return messages.map((message) => {
		for (const id of toolUseIds(message)) open.add(id)
		for (const id of toolResultIds(message)) {
			if (!open.delete(id)) orphaned = true
		}
		return !orphaned && open.size === 0
	})
}

/**
 * Where truncation ends: nearest `target`, within `[first, last]`, on an index
 * that closes both its tool pairing and its journal entry; -1 when none does.
 *
 * Every call up to the cut has its result before it, so what follows answers
 * only calls that follow it too, and the remaining conversation needs no
 * pairing repair. A cut is looked for at or before the target first, so no
 * more is removed than three quarters; past it only when that finds none, so
 * a refusal is never answered by removing nothing.
 */
function truncationCut(items: readonly ConversationItem[], first: number, target: number, last: number): number {
	const closed = closedPrefixes(items.map((item) => item.message))
	const cuts = (index: number) => closed[index] === true && items[index + 1]?.entry !== items[index]?.entry
	for (let index = Math.min(target, last); index >= first; index--) if (cuts(index)) return index
	for (let index = target + 1; index <= last; index++) if (cuts(index)) return index
	return -1
}

/**
 * A reply a landed summary already carries, which a span ending on that summary has to carry on.
 *
 * Once the model has answered it, the reply goes on without the call it
 * answered, as a reply that was never pending would.
 */
function carriedContinuation(items: readonly ConversationItem[], end: number): CompactionContinuation | undefined {
	const next = items[end + 1]
	if (next?.continuation === undefined || next.entry !== items[end]?.entry) return undefined
	let last = end + 1
	while (items[last + 1]?.entry === next.entry) last++
	return answeredAfter(items, last) ? withoutExchange(next.continuation) : next.continuation
}

/**
 * Condenses the journal the provider requests are actually built from.
 *
 * Provider input is materialized from the journal projection frozen into each
 * round's draft, so a summary applied anywhere else leaves the request exactly
 * as large as it was: the model never sees the summary, and the context it is
 * supposed to relieve keeps growing.
 *
 * Landing is one supersede marker that carries the summary rather than a
 * rewrite, because the journal is append-only. The superseded span stays on
 * disk, so a replay can still explain what the summary stands for.
 */
export class JournalCompactionConversation implements CompactionConversationPort, CompactionLandingPort, ContextTruncationPort {
	constructor(
		private readonly journal: ConversationJournal,
		private readonly payloads: TaskPayloadStore,
		private readonly conversation: JournalConversationView,
	) {}

	/**
	 * The settled conversation, fixed as a span when it was read.
	 *
	 * The span starts at logical turn 0, opening request included: the summary
	 * carries the task forward, so the next request reads the summary in place
	 * of the request rather than both. A conversation the model has not answered
	 * yet has nothing settled and offers no span.
	 */
	async read(): Promise<CompactionSource> {
		const items = await this.items()
		const all = items.map((item) => item.message)
		const names = toolNames(all)
		const { end, reply } = settledBoundary(items, names)
		const first = items[0]
		const last = items[end]
		// Nothing condensable: the source is only read to be refused, so it stays what was settled.
		if (end < 0 || !first || !last) return { messages: all.slice(0, lastSettledIndex(items, names) + 1) }
		const covered = items.slice(0, end + 1)
		const messages = covered.map((item, index) =>
			reply && index === end ? withoutReplies(item.message, names) : item.message,
		)
		const sourceRanges = covered.map(({ entry }) => [entry.watermark.seq, entry.watermark.seq] as const)
		const tail = items.slice(end + 1).map((item) => item.message)
		const span = { from: first.entry.watermark, to: last.entry.watermark }
		const continuation = reply ? replyContinuation(items, end, names) : carriedContinuation(items, end)
		const replies = replyBoundaries(items, end, names)
		return {
			messages,
			sourceRanges,
			tail,
			span,
			...(continuation ? { continuation } : {}),
			...(replies.length > 0 ? { replies } : {}),
		}
	}

	/**
	 * Replace the span with the summary, keeping everything after it.
	 *
	 * The span is the one the request was built from. Recomputing it here would
	 * condense whatever reached the journal while the summary was produced,
	 * which the summary never saw. Input after the span is not touched: the
	 * summary takes the span's place, so the next request reads it first and
	 * the unanswered input after it.
	 *
	 * Hiding the span and placing the summary is one journal record. Two
	 * records would let a crash between them leave the span hidden with no
	 * summary, which loses the conversation instead of shrinking it.
	 */
	async land(input: CompactionLandingInput): Promise<void> {
		// Deriving the span now would take in whatever arrived while the summary
		// was produced, so a landing without the request's span is refused.
		const span = input.span
		if (!span) throw new Error("CompactionSpanMissing")
		const operationId = `compaction.supersede:${input.attempt}`
		// A retried landing replays its own record; a fresh payload ref would
		// otherwise conflict with it under a store that is not content-addressed.
		if (await this.journal.findByOperation(operationId)) return
		const replacementRef = await this.payloads.put(
			encodeTaskPayload<CompactionSummaryEnvelope>({
				kind: "compaction_summary",
				compactionId: input.compactionId,
				text: input.summary,
				...(input.continuation ? { continuation: input.continuation } : {}),
			}),
		)
		// The supersede record is the commit point: a run stopped before it
		// leaves the conversation whole, one stopped after it has already landed.
		if (input.signal?.aborted) throw input.signal.reason
		await this.journal.supersedeRange({
			operationId,
			from: span.from,
			to: span.to,
			replacementRef,
		})
	}

	/**
	 * Remove the oldest settled history after a provider refused the request as
	 * longer than its context window, the recovery used when auto-compaction is off.
	 *
	 * The opening input stays verbatim. Three quarters of the settled history
	 * after it is replaced by `notice`, so the model knows history is missing
	 * rather than reading a conversation with an unexplained gap. Input the
	 * user is still waiting on is never removed, and the cut moves back until
	 * every call before it has its result.
	 *
	 * @returns The truncation record's position, which the resent request has
	 * to be projected through; undefined when nothing settled can be removed.
	 */
	async truncate(input: { readonly notice: string; readonly signal?: AbortSignal }): Promise<JournalWatermark | undefined> {
		const items = await this.items()
		const names = toolNames(items.map((item) => item.message))
		const start = truncationStart(items, names)
		const boundary = settledBoundary(items, names)
		// A reply the boundary ends on opens the turn still waiting on the user.
		const settled = boundary.reply ? boundary.end - 1 : boundary.end
		// The range has to take some of what the model said; a range of only
		// earlier notices would answer the refusal by removing nothing.
		const said = items.findIndex((item, index) => index >= start && item.message.role === "assistant")
		if (start < 0 || said < 0 || settled < said) return undefined
		const quarters = Math.floor(((settled - start + 1) * 3) / 4)
		const cut = truncationCut(items, said, Math.max(start + quarters - 1, said), settled)
		const first = items[start]
		const last = items[cut]
		if (cut < said || !first || !last) return undefined
		const operationId = `context.truncate:${randomUUID()}`
		const replacementRef = await this.payloads.put(
			encodeTaskPayload<CompactionSummaryEnvelope>({
				kind: "compaction_summary",
				compactionId: operationId,
				text: input.notice,
			}),
		)
		if (input.signal?.aborted) return undefined
		const { watermark } = await this.journal.supersedeRange({
			operationId,
			from: first.entry.watermark,
			to: last.entry.watermark,
			replacementRef,
		})
		Logger.warn(
			`[compaction] context window exceeded; truncated ${cut - start + 1} of ${items.length} messages (seq ${first.entry.watermark.seq}-${last.entry.watermark.seq})`,
		)
		return watermark
	}

	/**
	 * The visible conversation, one item per provider message.
	 *
	 * A landed summary that carries a reply materializes as several messages
	 * from one entry - the summary, then the replayed exchange - so all share
	 * that entry's watermark: a later span that takes the summary takes its
	 * reply with it, and hands the reply on.
	 */
	private async items(): Promise<ConversationItem[]> {
		const items: ConversationItem[] = []
		for (const { entry, kind, messages, continuation } of await this.conversation.entries()) {
			const [message, ...carried] = messages
			if (!message) continue
			items.push({ entry, kind, message })
			for (const reply of carried) items.push({ entry, kind, message: reply, ...(continuation ? { continuation } : {}) })
		}
		return items
	}
}
