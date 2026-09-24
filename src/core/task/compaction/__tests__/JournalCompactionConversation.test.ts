import type { ClineStorageMessage, ClineUserToolResultContentBlock } from "@shared/messages/content"
import { describe, expect, it } from "vitest"
import { serializeDurableToolResult } from "../../DurableToolResult"
import { ProviderJournalMessageMaterializer } from "../../executors/provider/service/ProviderJournalMessageMaterializer"
import type { JournalSource, TaskPayloadStore } from "../../stores"
import { InMemoryConversationJournal } from "../../stores/InMemoryRuntimeStores"
import { encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import type {
	EnvironmentDetailsEnvelope,
	ProviderFinalEnvelope,
	ToolResultEnvelope,
	UserInputEnvelope,
} from "../../stores/payload/TaskPayloadEnvelopes"
import { JournalCompactionConversation } from "../JournalCompactionConversation"

class MemoryPayloads implements TaskPayloadStore {
	private sequence = 0
	private readonly values = new Map<string, Uint8Array>()

	async put(value: Uint8Array): Promise<string> {
		const ref = `payload:${++this.sequence}`
		this.values.set(ref, value)
		return ref
	}

	async read(ref: string): Promise<Uint8Array> {
		const value = this.values.get(ref)
		if (!value) throw new Error(`UnknownPayload:${ref}`)
		return value
	}
}

/** Land a summary for the span the conversation holds now, as a request built here would. */
async function landCurrent(conversation: JournalCompactionConversation, compactionId: string, summary: string) {
	const { span } = await conversation.read()
	await conversation.land({ compactionId, attempt: `${compactionId}:1`, summary, ...(span === undefined ? {} : { span }) })
}

async function write(
	journal: InMemoryConversationJournal,
	payloads: MemoryPayloads,
	operationId: string,
	payload: UserInputEnvelope | ProviderFinalEnvelope | ToolResultEnvelope | EnvironmentDetailsEnvelope,
	source: JournalSource = "intake",
) {
	const payloadRef = await payloads.put(encodeTaskPayload(payload))
	await journal.append({ operationId, payloadRef, source })
}

/**
 * Two answered rounds, journaled with the sources production writes.
 *
 * Provider finals are recorded as `provider` entries because that source is
 * what separates what the model already answered from input it has not seen.
 */
async function seed(journal: InMemoryConversationJournal, payloads: MemoryPayloads) {
	await write(journal, payloads, "intake:1", { kind: "user_input", text: "original task" })
	await write(
		journal,
		payloads,
		"provider:1",
		{ kind: "provider_final", text: "first answer", turnPlan: { mode: "serial", blocks: [] } },
		"provider",
	)
	await write(journal, payloads, "intake:2", { kind: "user_input", text: "follow up" })
	await write(
		journal,
		payloads,
		"provider:2",
		{ kind: "provider_final", text: "second answer", turnPlan: { mode: "serial", blocks: [] } },
		"provider",
	)
}

const PENDING_REPLY = "PENDING_REPLY_TO_QUESTION"

/**
 * The model asked the user something and the user has just answered.
 *
 * The answer arrives as the result of the conversational tool, so it is already
 * journaled when the next round's compaction barrier runs - but no request has
 * carried it to the model yet.
 */
async function seedAnsweredQuestion(journal: InMemoryConversationJournal, payloads: MemoryPayloads) {
	await seed(journal, payloads)
	await write(
		journal,
		payloads,
		"provider:3",
		{
			kind: "provider_final",
			content: [
				{
					type: "tool_use",
					function_id: "call-qna",
					dline_tid: "tid-qna",
					name: "qna_respond",
					input: { response: "ready" },
				},
			],
			turnPlan: { mode: "serial", blocks: [] },
		},
		"provider",
	)
	await write(
		journal,
		payloads,
		"tool.result:qna",
		{
			kind: "tool_result",
			blockId: "tid-qna",
			content: serializeDurableToolResult({
				type: "tool_result",
				function_id: "call-qna",
				dline_tid: "tid-qna",
				content: [{ type: "text", text: `<feedback>\n${PENDING_REPLY}\n</feedback>` }],
			}),
		},
		"tool",
	)
}

function call(functionId: string, name = "qna_respond"): ProviderFinalEnvelope {
	return {
		kind: "provider_final",
		content: [{ type: "tool_use", function_id: functionId, dline_tid: `tid-${functionId}`, name, input: {} }],
		turnPlan: { mode: "serial", blocks: [] },
	}
}

function result(functionId: string, content: ClineUserToolResultContentBlock["content"]): ToolResultEnvelope {
	return {
		kind: "tool_result",
		blockId: `tid-${functionId}`,
		content: serializeDurableToolResult({
			type: "tool_result",
			function_id: functionId,
			dline_tid: `tid-${functionId}`,
			content,
		}),
	}
}

const LATEST_REPLY = "LATEST_REPLY_TO_HISTORY"
const feedback = (text: string) => ({ type: "text" as const, text: `<feedback>\n${text}\n</feedback>` })

/**
 * The user answered one question and the model has already asked the next.
 *
 * The answer is the result of the first call, so it is paired and journaled,
 * yet it opens the turn the model is still in - the turn WS-010 keeps out of
 * what a compaction summarizes. An environment snapshot follows it, as
 * composing the next round journals one.
 */
async function seedReplyAwaitingNext(
	journal: InMemoryConversationJournal,
	payloads: MemoryPayloads,
	reply: ClineUserToolResultContentBlock["content"] = [feedback(LATEST_REPLY)],
) {
	await write(journal, payloads, "intake:1", { kind: "user_input", text: "original task" })
	await write(journal, payloads, "provider:1", call("call-history"), "provider")
	await write(journal, payloads, "tool.result:history", result("call-history", reply), "tool")
	await write(journal, payloads, "environment:1", { kind: "environment_details", text: "ENVIRONMENT_SNAPSHOT" }, "system")
	await write(journal, payloads, "provider:2", call("call-ready"), "provider")
}

async function visible(journal: InMemoryConversationJournal, payloads: MemoryPayloads): Promise<ClineStorageMessage[]> {
	const projection = await journal.project()
	return new ProviderJournalMessageMaterializer(payloads).materialize(
		projection.visibleMessages.flatMap((entry) => (entry.payloadRef ? [entry.payloadRef] : [])),
	)
}

function mentions(message: ClineStorageMessage | undefined, text: string): boolean {
	return JSON.stringify(message?.content ?? "").includes(text)
}

/**
 * The materialized body without the envelope wrapper a user message carries.
 *
 * These assertions are about which turns survived a compaction, not about how
 * a submission is framed for the provider.
 */
function texts(messages: readonly { readonly content: unknown }[]): string[] {
	return messages.map((message) => {
		const blocks = Array.isArray(message.content) ? (message.content as { text?: string }[]) : []
		return (blocks[0]?.text ?? "").replace(/<\/?user_message>/g, "").trim()
	})
}

function open() {
	const journal = new InMemoryConversationJournal()
	const payloads = new MemoryPayloads()
	const conversation = new JournalCompactionConversation(journal, payloads, new ProviderJournalMessageMaterializer(payloads))
	return { journal, payloads, conversation }
}

describe("JournalCompactionConversation", () => {
	it("reads the same conversation a provider request is materialized from", async () => {
		const { journal, payloads, conversation } = open()
		await seed(journal, payloads)

		expect(texts((await conversation.read()).messages)).toEqual([
			"original task",
			"first answer",
			"follow up",
			"second answer",
		])
	})

	it("leaves a reply the model has not seen yet out of what it summarizes", async () => {
		const { journal, payloads, conversation } = open()
		await seedAnsweredQuestion(journal, payloads)

		const source = await conversation.read()

		expect(source.messages.some((message) => mentions(message, PENDING_REPLY))).toBe(false)
		expect(texts(source.messages)).toEqual(["original task", "first answer", "follow up", "second answer"])
	})

	it("keeps the unanswered reply, and the call it answers, after the summary", async () => {
		const { journal, payloads, conversation } = open()
		await seedAnsweredQuestion(journal, payloads)

		await landCurrent(conversation, "compaction:1", "condensed so far")

		const after = (await conversation.read()).messages.length
		const projection = await journal.project()
		const messages = await new ProviderJournalMessageMaterializer(payloads).materialize(
			projection.visibleMessages.flatMap((entry) => (entry.payloadRef ? [entry.payloadRef] : [])),
		)
		// Order matters: the next request must read the summary first, then the
		// question it has not answered, then the user's reply to it.
		expect(texts(messages.slice(0, 2))).toEqual(["original task", "condensed so far"])
		expect(mentions(messages[2], "call-qna")).toBe(true)
		expect(mentions(messages[3], PENDING_REPLY)).toBe(true)
		expect(messages).toHaveLength(4)
		expect(after).toBeLessThanOrEqual(messages.length)
	})

	it("lands the span fixed when the source was read, not the journal as it is later", async () => {
		const { journal, payloads, conversation } = open()
		await seedAnsweredQuestion(journal, payloads)
		const { span } = await conversation.read()
		await write(journal, payloads, "intake:late", { kind: "user_input", text: "arrived during compaction" })

		await conversation.land({ compactionId: "compaction:1", attempt: "compaction:1:1", summary: "condensed so far", span })

		const projection = await journal.project()
		const messages = await new ProviderJournalMessageMaterializer(payloads).materialize(
			projection.visibleMessages.flatMap((entry) => (entry.payloadRef ? [entry.payloadRef] : [])),
		)
		expect(texts(messages.slice(0, 2))).toEqual(["original task", "condensed so far"])
		expect(mentions(messages[3], PENDING_REPLY)).toBe(true)
		expect(texts(messages.slice(4))).toEqual(["arrived during compaction"])
	})

	it("replaces the condensed span with the summary while keeping the opening request", async () => {
		const { journal, payloads, conversation } = open()
		await seed(journal, payloads)

		await landCurrent(conversation, "compaction:1", "condensed so far")

		expect(texts((await conversation.read()).messages)).toEqual(["original task", "condensed so far"])
	})

	it("keeps the summary out of the next compaction's condensed span", async () => {
		const { journal, payloads, conversation } = open()
		await seed(journal, payloads)
		await landCurrent(conversation, "compaction:1", "first summary")

		const payloadRef = await payloads.put(
			encodeTaskPayload<UserInputEnvelope>({ kind: "user_input", text: "later question" }),
		)
		await journal.append({ operationId: "intake:3", payloadRef, source: "intake" })
		await landCurrent(conversation, "compaction:2", "second summary")

		// The first summary is inside the second condensed span, so it is replaced
		// rather than accumulated: compaction must not grow what it shrinks.
		// "later question" has not been answered by any request yet, so it is the
		// round in progress and stays after the summary. The earlier expectation
		// had it condensed away, which is the same loss of unprocessed user input
		// this contract exists to prevent.
		const projection = await journal.project()
		const messages = await new ProviderJournalMessageMaterializer(payloads).materialize(
			projection.visibleMessages.flatMap((entry) => (entry.payloadRef ? [entry.payloadRef] : [])),
		)
		expect(texts(messages)).toEqual(["original task", "second summary", "later question"])
	})

	it("offers no span when only the opening request exists, and refuses to land without one", async () => {
		const { journal, payloads, conversation } = open()
		const payloadRef = await payloads.put(encodeTaskPayload<UserInputEnvelope>({ kind: "user_input", text: "only task" }))
		await journal.append({ operationId: "intake:1", payloadRef, source: "intake" })

		expect((await conversation.read()).span).toBeUndefined()
		// Deriving the span at landing would condense input the summary never saw.
		await expect(
			conversation.land({ compactionId: "compaction:1", attempt: "compaction:1:1", summary: "nothing to condense" }),
		).rejects.toThrow("CompactionSpanMissing")

		const projection = await journal.project()
		expect(projection.visibleMessages.map((entry) => entry.operationId)).toEqual(["intake:1"])
	})

	it("lands with exactly one journal record, so no crash point hides the span without its summary", async () => {
		const { journal, payloads, conversation } = open()
		await seedAnsweredQuestion(journal, payloads)
		const before = (await journal.read()).length

		await landCurrent(conversation, "compaction:1", "condensed so far")

		const written = (await journal.read()).slice(before)
		expect(written.map((entry) => entry.kind)).toEqual(["supersede_range"])
	})

	it("keeps the reply that opened the unfinished turn out of the summary, and replays it verbatim after it", async () => {
		const { journal, payloads, conversation } = open()
		const image = {
			type: "image" as const,
			source: { type: "base64" as const, media_type: "image/png" as const, data: "AAAA" },
		}
		await seedReplyAwaitingNext(journal, payloads, [feedback(LATEST_REPLY), image])

		const source = await conversation.read()

		// The call the reply answers is still summarized, so nothing is left unpaired;
		// only the reply itself - and what follows it - stays out.
		expect(source.span).toBeDefined()
		expect(source.messages.some((message) => mentions(message, "call-history"))).toBe(true)
		expect(source.messages.some((message) => mentions(message, LATEST_REPLY))).toBe(false)
		expect(source.messages.some((message) => mentions(message, "ENVIRONMENT_SNAPSHOT"))).toBe(false)
		expect(source.messages.some((message) => mentions(message, "call-ready"))).toBe(false)
		expect(source.continuation).toEqual({ text: LATEST_REPLY, images: ["data:image/png;base64,AAAA"] })

		await conversation.land({
			compactionId: "compaction:1",
			attempt: "compaction:1:1",
			summary: "condensed so far",
			span: source.span,
			continuation: source.continuation,
		})

		const messages = await visible(journal, payloads)
		expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user", "user", "assistant"])
		expect(texts(messages.slice(0, 3))).toEqual(["original task", "condensed so far", LATEST_REPLY])
		expect(messages[2]?.content).toEqual(expect.arrayContaining([expect.objectContaining({ type: "image" })]))
		expect(mentions(messages[3], "ENVIRONMENT_SNAPSHOT")).toBe(true)
		expect(mentions(messages[4], "call-ready")).toBe(true)
		// No result survives for a call the summary took away.
		expect(messages.some((message) => mentions(message, "call-history"))).toBe(false)
	})

	it("summarizes the finished turns before that reply, and replays only the reply", async () => {
		const { journal, payloads, conversation } = open()
		await seed(journal, payloads)
		await write(journal, payloads, "provider:3", call("call-question"), "provider")
		await write(journal, payloads, "tool.result:question", result("call-question", [feedback(LATEST_REPLY)]), "tool")
		await write(journal, payloads, "provider:4", call("call-next"), "provider")

		const source = await conversation.read()

		expect(texts(source.messages.slice(0, 4))).toEqual(["original task", "first answer", "follow up", "second answer"])
		expect(source.messages.some((message) => mentions(message, LATEST_REPLY))).toBe(false)
		expect(source.continuation).toEqual({ text: LATEST_REPLY })

		await conversation.land({
			compactionId: "compaction:1",
			attempt: "compaction:1:1",
			summary: "condensed so far",
			span: source.span,
			continuation: source.continuation,
		})

		const messages = await visible(journal, payloads)
		expect(texts(messages.slice(0, 3))).toEqual(["original task", "condensed so far", LATEST_REPLY])
		expect(mentions(messages[3], "call-next")).toBe(true)
		expect(messages).toHaveLength(4)
	})

	it("condenses a finished tool round before the call that is still waiting on the user", async () => {
		const { journal, payloads, conversation } = open()
		await write(journal, payloads, "intake:1", { kind: "user_input", text: "original task" })
		await write(journal, payloads, "provider:1", call("call-read", "read_file"), "provider")
		await write(journal, payloads, "tool.result:read", result("call-read", [{ type: "text", text: "FILE_CONTENTS" }]), "tool")
		await write(journal, payloads, "provider:2", call("call-ask"), "provider")

		const source = await conversation.read()

		// A plain tool result belongs to its call's turn; it is not the user's input.
		expect(source.continuation).toBeUndefined()
		expect(source.messages.some((message) => mentions(message, "FILE_CONTENTS"))).toBe(true)
		expect(source.messages.some((message) => mentions(message, "call-ask"))).toBe(false)

		await landCurrent(conversation, "compaction:1", "condensed so far")

		const messages = await visible(journal, payloads)
		expect(texts(messages.slice(0, 2))).toEqual(["original task", "condensed so far"])
		expect(mentions(messages[2], "call-ask")).toBe(true)
		expect(messages).toHaveLength(3)
	})

	it("hands the reply a summary replays on to the summary that replaces it", async () => {
		const { journal, payloads, conversation } = open()
		await seedReplyAwaitingNext(journal, payloads)
		const first = await conversation.read()
		await conversation.land({
			compactionId: "compaction:1",
			attempt: "compaction:1:1",
			summary: "first summary",
			span: first.span,
			continuation: first.continuation,
		})

		const second = await conversation.read()

		// The model is still in the turn the reply opened, so the next summary
		// replaces the first one without taking the reply with it.
		expect(texts(second.messages)).toEqual(["original task", "first summary"])
		expect(second.continuation).toEqual({ text: LATEST_REPLY })

		await conversation.land({
			compactionId: "compaction:2",
			attempt: "compaction:2:1",
			summary: "second summary",
			span: second.span,
			continuation: second.continuation,
		})

		const messages = await visible(journal, payloads)
		expect(texts(messages.slice(0, 3))).toEqual(["original task", "second summary", LATEST_REPLY])
		expect(mentions(messages[4], "call-ready")).toBe(true)
		expect(messages).toHaveLength(5)
	})

	it("tells a person's input from system context by what was journaled, not by the source it was filed under", async () => {
		const { journal, payloads, conversation } = open()
		await write(journal, payloads, "intake:1", { kind: "user_input", text: "original task" })
		await write(journal, payloads, "provider:1", call("call-history"), "provider")
		await write(journal, payloads, "tool.result:history", result("call-history", [feedback(LATEST_REPLY)]), "tool")
		// Filed under a user source, as an entry written before sources were recorded could be.
		await write(journal, payloads, "environment:1", { kind: "environment_details", text: "ENVIRONMENT_SNAPSHOT" }, "intake")
		await write(journal, payloads, "provider:2", call("call-ready"), "provider")

		const source = await conversation.read()

		expect(source.messages.some((message) => mentions(message, LATEST_REPLY))).toBe(false)
		expect(source.continuation).toEqual({ text: LATEST_REPLY })
	})

	it("stops before a tool result no call issued", async () => {
		const { journal, payloads, conversation } = open()
		await write(journal, payloads, "intake:1", { kind: "user_input", text: "original task" })
		await write(journal, payloads, "provider:1", call("call-read", "read_file"), "provider")
		await write(journal, payloads, "tool.result:read", result("call-read", [{ type: "text", text: "FILE_CONTENTS" }]), "tool")
		await write(journal, payloads, "tool.result:orphan", result("call-unknown", [{ type: "text", text: "ORPHAN" }]), "tool")
		await write(journal, payloads, "provider:2", call("call-ask"), "provider")

		const source = await conversation.read()

		expect(source.messages.some((message) => mentions(message, "FILE_CONTENTS"))).toBe(true)
		expect(source.messages.some((message) => mentions(message, "ORPHAN"))).toBe(false)
	})

	it("keeps attached files whole and the reply's own whitespace when replaying it", async () => {
		const { journal, payloads, conversation } = open()
		const file = '<file_content path="notes.txt">\nbefore <task>sample</task> after\n</file_content>'
		await seedReplyAwaitingNext(journal, payloads, [
			{ type: "text", text: "<feedback>\n  indented reply\n</feedback>" },
			{ type: "text", text: file },
		])

		const { continuation } = await conversation.read()

		expect(continuation).toEqual({ text: `  indented reply\n\n${file}` })
	})

	it("replays a reply that contains its own wrapper's closing tag in full", async () => {
		const { journal, payloads, conversation } = open()
		await seedReplyAwaitingNext(journal, payloads, [
			{ type: "text", text: "<feedback>\nprint </feedback> literally\n</feedback>" },
		])

		const { continuation } = await conversation.read()

		expect(continuation).toEqual({ text: "print </feedback> literally" })
	})

	it("treats a file-only answer as the user's reply and drops the handler's framing", async () => {
		const { journal, payloads, conversation } = open()
		const file = '<file_content path="spec.md">\nFILE_ONLY_BODY\n</file_content>'
		await seedReplyAwaitingNext(journal, payloads, [
			{ type: "text", text: "User continued the conversation." },
			{ type: "text", text: file },
		])

		const source = await conversation.read()

		expect(source.messages.some((message) => mentions(message, "FILE_ONLY_BODY"))).toBe(false)
		expect(source.continuation).toEqual({ text: file })
	})

	it("treats an image-only answer to a question as the user's reply", async () => {
		const { journal, payloads, conversation } = open()
		const image = {
			type: "image" as const,
			source: { type: "base64" as const, media_type: "image/png" as const, data: "BBBB" },
		}
		await seedReplyAwaitingNext(journal, payloads, [image])

		const source = await conversation.read()

		expect(source.messages.some((message) => mentions(message, "BBBB"))).toBe(false)
		expect(source.continuation).toEqual({ text: "", images: ["data:image/png;base64,BBBB"] })
	})

	it("replays a retried landing of the same attempt instead of conflicting with it", async () => {
		const { journal, payloads, conversation } = open()
		await seedAnsweredQuestion(journal, payloads)
		const { span } = await conversation.read()
		if (!span) throw new Error("seed produced no span")
		const landing = { compactionId: "compaction:1", attempt: "compaction:1:1", summary: "condensed so far", span }
		await conversation.land(landing)
		const settled = (await journal.read()).length

		// The payload store here issues a new ref per put, as a store that is not
		// content-addressed would; the retry must still land nothing new.
		await conversation.land(landing)

		expect((await journal.read()).length).toBe(settled)
	})
})
