import type { ClineStorageMessage } from "@shared/messages/content"
import { describe, expect, it } from "vitest"
import { JournalConversationView } from "../../executors/provider/service/JournalConversationView"
import { ProviderJournalMessageMaterializer } from "../../executors/provider/service/ProviderJournalMessageMaterializer"
import { InMemoryConversationJournal, InMemoryTaskPayloadStore } from "../../stores"
import { JournalConversationRewind } from "../../stores/JournalConversationRewind"
import { encodeTaskPayload } from "../../stores/payload/TaskPayloadCodec"
import { importLegacyConversation } from "../LegacyConversationImport"

const task: ClineStorageMessage = { role: "user", content: [{ type: "text", text: "<task>fix it</task>" }], ts: 1 }
const call: ClineStorageMessage = {
	role: "assistant",
	content: [{ type: "tool_use", function_id: "call-1", dline_tid: "tid-1", name: "read_file", input: { path: "a.ts" } }],
	ts: 2,
}
const result: ClineStorageMessage = {
	role: "user",
	content: [{ type: "tool_result", function_id: "call-1", dline_tid: "tid-1", content: "const a = 1" }],
	ts: 3,
}
const answer: ClineStorageMessage = { role: "assistant", content: [{ type: "text", text: "done" }], ts: 4 }
const feedback: ClineStorageMessage = { role: "user", content: [{ type: "text", text: "<feedback>again</feedback>" }], ts: 5 }
const legacy = [task, call, result, answer, feedback]

function openStores() {
	const journal = new InMemoryConversationJournal()
	const payloads = new InMemoryTaskPayloadStore()
	const view = new JournalConversationView(journal, new ProviderJournalMessageMaterializer(payloads))
	return { journal, payloads, view }
}

describe("importLegacyConversation", () => {
	it("replays a legacy conversation verbatim and in order", async () => {
		const { journal, payloads, view } = openStores()

		await expect(importLegacyConversation({ journal, payloads, legacy })).resolves.toBe(5)

		expect(await view.messages()).toEqual(legacy)
		expect((await journal.read()).map((entry) => entry.source)).toEqual(["intake", "provider", "tool", "provider", "intake"])
	})

	it("imports a conversation only once", async () => {
		const { journal, payloads, view } = openStores()
		await importLegacyConversation({ journal, payloads, legacy })

		await expect(importLegacyConversation({ journal, payloads, legacy })).resolves.toBe(0)

		expect(journal.watermark()).toEqual({ seq: 5 })
		expect(await view.messages()).toEqual(legacy)
	})

	it("completes an import that stopped part way", async () => {
		const { journal, payloads, view } = openStores()
		await importLegacyConversation({ journal, payloads, legacy: legacy.slice(0, 2) })

		await expect(importLegacyConversation({ journal, payloads, legacy })).resolves.toBe(3)

		expect(await view.messages()).toEqual(legacy)
	})

	it("leaves a journal the runtime already wrote alone", async () => {
		const { journal, payloads, view } = openStores()
		const payloadRef = await payloads.put(encodeTaskPayload({ kind: "user_input", text: "written by the runtime" }))
		await journal.append({ operationId: "intake:user:1", payloadRef, source: "intake" })

		await expect(importLegacyConversation({ journal, payloads, legacy })).resolves.toBe(0)

		expect(journal.watermark()).toEqual({ seq: 1 })
		expect(await view.messages()).toHaveLength(1)
	})

	it("writes nothing for a task without legacy messages", async () => {
		const { journal, payloads } = openStores()

		await expect(importLegacyConversation({ journal, payloads, legacy: [] })).resolves.toBe(0)

		expect(journal.watermark()).toEqual({ seq: 0 })
	})

	it("lets a legacy row's recorded length name the entry it followed", async () => {
		const { journal, payloads, view } = openStores()
		await importLegacyConversation({ journal, payloads, legacy })

		await expect(view.positionKeeping(3)).resolves.toEqual({ seq: 3 })
	})

	it("keeps the result answering a kept call when a legacy row is restored", async () => {
		const { journal, payloads, view } = openStores()
		await importLegacyConversation({ journal, payloads, legacy })
		const rewind = new JournalConversationRewind(journal, view)

		await rewind.rewindToRow({ operationId: "checkpoint.restore:1", row: { keep: 2 } })

		expect(await view.messages()).toEqual([task, call, result])
	})

	it("keeps the feedback a restored legacy row shows unless it is edited", async () => {
		const kept = openStores()
		await importLegacyConversation({ ...kept, legacy })
		await new JournalConversationRewind(kept.journal, kept.view).rewindToRow({
			operationId: "checkpoint.restore:1",
			row: { keep: 4, keepInput: true },
		})
		expect(await kept.view.messages()).toEqual(legacy)

		const edited = openStores()
		await importLegacyConversation({ ...edited, legacy })
		await new JournalConversationRewind(edited.journal, edited.view).rewindToRow({
			operationId: "checkpoint.restore:1",
			row: { keep: 4 },
		})
		expect(await edited.view.messages()).toEqual([task, call, result, answer])
	})
})
