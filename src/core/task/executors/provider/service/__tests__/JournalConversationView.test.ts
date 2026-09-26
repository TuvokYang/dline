import type { ClineStorageMessage } from "@shared/messages/content"
import { describe, expect, it } from "vitest"
import type { JournalSource, TaskPayloadStore } from "../../../../stores"
import { InMemoryConversationJournal } from "../../../../stores/InMemoryRuntimeStores"
import { encodeTaskPayload } from "../../../../stores/payload/TaskPayloadCodec"
import { JournalConversationView } from "../JournalConversationView"
import { ProviderJournalMessageMaterializer } from "../ProviderJournalMessageMaterializer"

/** Payload store that counts reads, which is what a per-round render would repeat. */
class CountingPayloads implements TaskPayloadStore {
	readonly reads = new Map<string, number>()
	failNextRead = false
	private sequence = 0
	private readonly values = new Map<string, Uint8Array>()

	async put(value: Uint8Array): Promise<string> {
		const ref = `payload:${++this.sequence}`
		this.values.set(ref, value)
		return ref
	}

	async read(ref: string): Promise<Uint8Array> {
		this.reads.set(ref, (this.reads.get(ref) ?? 0) + 1)
		if (this.failNextRead) {
			this.failNextRead = false
			throw new Error("TransientReadFailure")
		}
		const value = this.values.get(ref)
		if (!value) throw new Error(`UnknownPayload:${ref}`)
		return value
	}

	totalReads(): number {
		return [...this.reads.values()].reduce((sum, count) => sum + count, 0)
	}
}

async function write(
	journal: InMemoryConversationJournal,
	payloads: CountingPayloads,
	operationId: string,
	payload: { readonly kind: string; readonly [key: string]: unknown },
	source: JournalSource = "intake",
) {
	const payloadRef = await payloads.put(encodeTaskPayload(payload))
	await journal.append({ operationId, payloadRef, source })
	return payloadRef
}

function textsOf(messages: readonly ClineStorageMessage[]): string[] {
	return messages.map((message) => {
		const blocks = Array.isArray(message.content) ? (message.content as { text?: string }[]) : []
		return (blocks[0]?.text ?? "").replace(/<\/?user_message>/g, "").trim()
	})
}

function open() {
	const journal = new InMemoryConversationJournal()
	const payloads = new CountingPayloads()
	const view = new JournalConversationView(journal, new ProviderJournalMessageMaterializer(payloads))
	return { journal, payloads, view }
}

describe("JournalConversationView", () => {
	it("renders each journal payload once however many rounds read it", async () => {
		const { journal, payloads, view } = open()
		await write(journal, payloads, "intake:1", { kind: "user_input", text: "first" })
		await write(journal, payloads, "provider:1", { kind: "provider_final", text: "answer" }, "provider")

		await view.messages()
		const afterFirstRound = payloads.totalReads()
		await write(journal, payloads, "intake:2", { kind: "user_input", text: "second" })
		const messages = await view.messages()

		expect(textsOf(messages)).toEqual(["first", "answer", "second"])
		// Only the new entry was read; the history came from memory.
		expect(payloads.totalReads()).toBe(afterFirstRound + 1)
	})

	it("counts entries journaled since the last read", async () => {
		const { journal, payloads, view } = open()
		await write(journal, payloads, "intake:1", { kind: "user_input", text: "first" })
		await view.messages()
		await write(journal, payloads, "provider:1", { kind: "provider_final", text: "answer" }, "provider")

		// The synchronous size still reports the last read; the count sees the new reply.
		expect(view.size()).toBe(1)
		await expect(view.count()).resolves.toBe(2)
		expect(view.size()).toBe(2)
	})

	it("finds the earliest position that held a given number of messages", async () => {
		const { journal, payloads, view } = open()
		await write(journal, payloads, "intake:1", { kind: "user_input", text: "first" })
		await write(journal, payloads, "provider:1", { kind: "provider_final", text: "answer" }, "provider")
		const answered = journal.watermark()
		await write(journal, payloads, "intake:2", { kind: "user_input", text: "second" })

		await expect(view.positionKeeping(2)).resolves.toEqual(answered)
		await expect(view.positionKeeping(9)).resolves.toBeUndefined()
	})

	it("returns the same message objects each round so the provider prefix stays stable", async () => {
		const { journal, payloads, view } = open()
		await write(journal, payloads, "intake:1", { kind: "user_input", text: "first" })

		const [first] = await view.messages()
		await write(journal, payloads, "intake:2", { kind: "user_input", text: "second" })
		const [again] = await view.messages()

		expect(again).toBe(first)
	})

	it("fixes the conversation at a recorded position", async () => {
		const { journal, payloads, view } = open()
		await write(journal, payloads, "intake:1", { kind: "user_input", text: "first" })
		await write(journal, payloads, "provider:1", { kind: "provider_final", text: "answer" }, "provider")
		const position = journal.watermark()
		await write(journal, payloads, "intake:2", { kind: "user_input", text: "arrived later" })
		await journal.supersedeRange({
			operationId: "compaction.supersede:1",
			from: { seq: 1 },
			to: { seq: 2 },
			replacementRef: await payloads.put(
				encodeTaskPayload({ kind: "compaction_summary", compactionId: "c1", text: "summary" }),
			),
		})

		expect(textsOf(await view.messages(position))).toEqual(["first", "answer"])
		expect(textsOf(await view.messages())).toEqual(["summary", "arrived later"])
		// The position still replays after the summary landed.
		expect(textsOf(await view.messages(position))).toEqual(["first", "answer"])
	})

	it("does not remember a render that failed", async () => {
		const { journal, payloads, view } = open()
		await write(journal, payloads, "intake:1", { kind: "user_input", text: "first" })
		payloads.failNextRead = true

		await expect(view.messages()).rejects.toThrow("TransientReadFailure")
		expect(textsOf(await view.messages())).toEqual(["first"])
	})

	it("replays a draft that named its payloads before drafts recorded a position", async () => {
		const { journal, payloads, view } = open()
		const first = await write(journal, payloads, "intake:1", { kind: "user_input", text: "first" })
		await write(journal, payloads, "intake:2", { kind: "user_input", text: "not in the draft" })

		expect(textsOf(await view.messagesOf([first]))).toEqual(["first"])
	})

	it("carries a summary's unanswered reply with the entry that holds it", async () => {
		const { journal, payloads, view } = open()
		await write(journal, payloads, "intake:1", { kind: "user_input", text: "task" })
		await write(journal, payloads, "summary:1", {
			kind: "compaction_summary",
			compactionId: "c1",
			text: "summary",
			continuation: { text: "open reply" },
		})

		const entries = await view.entries()
		const summary = entries.at(-1)

		expect(summary?.kind).toBe("compaction_summary")
		expect(textsOf(summary?.messages ?? [])).toEqual(["summary", "open reply"])
		expect(summary?.continuation).toEqual({ text: "open reply" })
	})
})
