import { describe, expect, it } from "vitest"
import { InMemoryConversationJournal } from "../InMemoryRuntimeStores"
import { JournalConversationRewind } from "../JournalConversationRewind"

async function journalWithSummary() {
	const journal = new InMemoryConversationJournal()
	await journal.append({ operationId: "intake:1", payloadRef: "task", source: "intake" })
	await journal.append({ operationId: "provider:1", payloadRef: "answer", source: "provider" })
	const history = await journal.append({ operationId: "intake:2", payloadRef: "history", source: "intake" })
	await journal.supersedeRange({
		operationId: "compaction.supersede:1",
		from: { seq: 2 },
		to: history.watermark,
		replacementRef: "summary",
	})
	await journal.append({ operationId: "intake:3", payloadRef: "after", source: "intake" })
	return { journal, history: history.watermark }
}

const visibleRefs = async (journal: InMemoryConversationJournal) =>
	(await journal.project()).visibleMessages.map((entry) => entry.payloadRef)

describe("JournalConversationRewind", () => {
	it("undoes the summary and everything recorded after the restored point", async () => {
		const { journal, history } = await journalWithSummary()

		await new JournalConversationRewind(journal).rewindTo({ operationId: "checkpoint.restore:1", target: history })

		expect(await visibleRefs(journal)).toEqual(["task", "answer", "history"])
	})

	it("replays the same restore without stacking a second rewind", async () => {
		const { journal, history } = await journalWithSummary()
		const rewind = new JournalConversationRewind(journal)

		await rewind.rewindTo({ operationId: "checkpoint.restore:1", target: history })
		const tail = journal.watermark()
		await rewind.rewindTo({ operationId: "checkpoint.restore:1", target: history })

		expect(journal.watermark()).toEqual(tail)
	})

	it("refuses to report the same restore operation for a different target", async () => {
		const { journal, history } = await journalWithSummary()
		const rewind = new JournalConversationRewind(journal)
		await rewind.rewindTo({ operationId: "checkpoint.restore:1", target: history })
		const tail = journal.watermark()

		await expect(rewind.rewindTo({ operationId: "checkpoint.restore:1", target: { seq: history.seq - 1 } })).rejects.toThrow(
			"ConversationRewindOperationConflict",
		)
		expect(journal.watermark()).toEqual(tail)
	})

	it("refuses an operation id already owned by a non-rewind record", async () => {
		const { journal, history } = await journalWithSummary()
		const tail = journal.watermark()

		await expect(
			new JournalConversationRewind(journal).rewindTo({ operationId: "intake:3", target: history }),
		).rejects.toThrow("ConversationRewindOperationConflict")
		expect(journal.watermark()).toEqual(tail)
	})

	it("refuses a target past the journal tail without writing", async () => {
		const { journal } = await journalWithSummary()
		const tail = journal.watermark()

		await expect(
			new JournalConversationRewind(journal).rewindTo({
				operationId: "checkpoint.restore:1",
				target: { seq: tail.seq + 5 },
			}),
		).rejects.toThrow("ConversationRewindTargetAhead")
		expect(journal.watermark()).toEqual(tail)
	})

	it("refuses a target that names no entry without writing", async () => {
		const { journal } = await journalWithSummary()
		const tail = journal.watermark()

		await expect(
			new JournalConversationRewind(journal).rewindTo({
				operationId: "checkpoint.restore:1",
				target: { seq: 0 },
			}),
		).rejects.toThrow("ConversationRewindTargetMissing")
		expect(journal.watermark()).toEqual(tail)
	})
})
