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
import type { ConversationJournal, JournalEntry, TaskPayloadStore } from "../stores"
import { encodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { CompactionContinuation, CompactionSummaryEnvelope } from "../stores/payload/TaskPayloadEnvelopes"
import type { CompactionLandingInput, CompactionLandingPort, CompactionSpan } from "./CompactionSummaryLanding"

/** What a compaction summarizes, and the journal span the summary will stand for. */
export interface CompactionSource {
	readonly messages: ClineStorageMessage[]
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
 * from the payload itself. A legacy user message that answers no call is the
 * task or feedback an older build recorded, so it counts as written too.
 */
const USER_AUTHORED_KINDS: ReadonlySet<string> = new Set([
	"user_input",
	"dialog_draft",
	"dialog_selection",
	"task_handoff",
	"legacy_message",
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

function resultTexts(block: ClineUserToolResultContentBlock): string[] {
	if (typeof block.content === "string") return [block.content]
	return block.content.flatMap((part) => (part.type === "text" ? [part.text] : []))
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
 * Index of the last message the model has already answered.
 *
 * Anything after the last assistant message reached the conversation after the
 * model last spoke - a reply the user just typed, the result of a tool the
 * model is waiting on - so no request has carried it yet. Summarizing it would
 * hand the model's next request a summary of input it never processed instead
 * of the input itself. An assistant call whose result is still unsettled is
 * excluded with it, so the settled span stays provider-projectable on its own.
 */
function lastSettledIndex(messages: readonly ClineStorageMessage[]): number {
	return settledEnd(messages, lastAssistantIndex(messages))
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
	const end = lastSettledIndex(messages)
	const start = openTurnStart(items, names)
	const opening = messages[start]
	if (start < 0 || start > end || !opening) return { end, reply: false }
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
 * The reply as the user wrote it, with its images and attached files, to be
 * replayed after the summary.
 *
 * Only what the user authored survives: the body of the first wrapped reply
 * and the files they attached, kept verbatim even if a file happens to contain
 * a tag. The handler's own framing ("Result: Done", "User continued the
 * conversation.") describes the call, which the summary already covers.
 */
function replyContinuation(message: ClineStorageMessage, names: ToolNames): CompactionContinuation {
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
	return images.length > 0 ? { text, images } : { text }
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

/** A reply a landed summary already carries, which a span ending on that summary has to carry on. */
function carriedContinuation(items: readonly ConversationItem[], end: number): CompactionContinuation | undefined {
	const next = items[end + 1]
	return next?.continuation !== undefined && next.entry === items[end]?.entry ? next.continuation : undefined
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
export class JournalCompactionConversation implements CompactionConversationPort, CompactionLandingPort {
	constructor(
		private readonly journal: ConversationJournal,
		private readonly payloads: TaskPayloadStore,
		private readonly conversation: JournalConversationView,
	) {}

	/**
	 * The settled conversation, fixed as a span when it was read.
	 *
	 * The opening request is part of the source but never of the span: the
	 * summary describes that task, so condensing it would leave the model
	 * summarizing work it cannot name.
	 */
	async read(): Promise<CompactionSource> {
		const items = await this.items()
		const all = items.map((item) => item.message)
		const names = toolNames(all)
		const { end, reply } = settledBoundary(items, names)
		const first = items[1]
		const last = items[end]
		// Nothing condensable: the source is only read to be refused, so it stays what was settled.
		if (end < 1 || !first || !last) return { messages: all.slice(0, lastSettledIndex(all) + 1) }
		const messages = items
			.slice(0, end + 1)
			.map((item, index) => (reply && index === end ? withoutReplies(item.message, names) : item.message))
		const span = { from: first.entry.watermark, to: last.entry.watermark }
		const continuation = reply ? replyContinuation(last.message, names) : carriedContinuation(items, end)
		return continuation ? { messages, span, continuation } : { messages, span }
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
	 * The visible conversation, one item per provider message.
	 *
	 * A landed summary that carries a reply materializes as two messages from
	 * one entry, so both share that entry's watermark: a later span that takes
	 * the summary takes its reply with it, and hands the reply on.
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
