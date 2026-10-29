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

    it("refuses a target an earlier rewind undid, without writing", async () => {
        const { journal, history } = await journalWithSummary()
        const rewind = new JournalConversationRewind(journal)
        await rewind.rewindTo({ operationId: "checkpoint.restore:1", target: history })
        const tail = journal.watermark()

        await expect(rewind.rewindTo({ operationId: "checkpoint.restore:2", target: { seq: 5 } })).rejects.toThrow(
            "ConversationRewindTargetMissing",
        )
        expect(journal.watermark()).toEqual(tail)
        expect(await visibleRefs(journal)).toEqual(["task", "answer", "history"])
    })

    it("rewinds to the genesis position, which empties the conversation", async () => {
        const { journal } = await journalWithSummary()

        await new JournalConversationRewind(journal).rewindTo({ operationId: "checkpoint.restore:1", target: { seq: 0 } })

        expect(await visibleRefs(journal)).toEqual([])
    })
})

describe("JournalConversationRewind.rewindToRow", () => {
    async function journalWithToolRound() {
        const journal = new InMemoryConversationJournal()
        await journal.append({ operationId: "intake:1", payloadRef: "task", source: "intake" })
        await journal.append({ operationId: "provider:1", payloadRef: "call", source: "provider" })
        await journal.append({ operationId: "tool.result:1", payloadRef: "result", source: "tool" })
        await journal.append({ operationId: "intake:2", payloadRef: "later", source: "intake" })
        return journal
    }

    it("keeps the tool result that answers a call made before the row", async () => {
        const journal = await journalWithToolRound()

        await new JournalConversationRewind(journal).rewindToRow({ operationId: "restore:1", row: { keep: 2, seq: 2 } })

        expect(await visibleRefs(journal)).toEqual(["task", "call", "result"])
    })

    it("keeps the input a row shows unless the restore edits it", async () => {
        const kept = await journalWithToolRound()
        await new JournalConversationRewind(kept).rewindToRow({
            operationId: "restore:1",
            row: { keep: 0, seq: 0, keepInput: true },
        })
        expect(await visibleRefs(kept)).toEqual(["task"])

        const edited = await journalWithToolRound()
        await new JournalConversationRewind(edited).rewindToRow({ operationId: "restore:1", row: { keep: 0, seq: 0 } })
        expect(await visibleRefs(edited)).toEqual([])
    })

    it("writes nothing when the same restore is retried after it landed", async () => {
        const journal = await journalWithToolRound()
        const rewind = new JournalConversationRewind(journal)
        await rewind.rewindToRow({ operationId: "restore:1", row: { keep: 2, seq: 2 } })
        const tail = journal.watermark()

        await rewind.rewindToRow({ operationId: "restore:1", row: { keep: 2, seq: 2 } })

        expect(journal.watermark()).toEqual(tail)
    })

    it("finds the position of a row that recorded only a length", async () => {
        const journal = await journalWithToolRound()
        const lengths = { positionKeeping: async (keep: number) => ({ seq: keep }) }

        await new JournalConversationRewind(journal, lengths).rewindToRow({ operationId: "restore:1", row: { keep: 1 } })

        expect(await visibleRefs(journal)).toEqual(["task"])
    })

    it("reports a journal with no conversation so the legacy rows stay authoritative", async () => {
        expect(new JournalConversationRewind(new InMemoryConversationJournal()).holdsConversation()).toBe(false)
        expect(new JournalConversationRewind(await journalWithToolRound()).holdsConversation()).toBe(true)
    })
})
