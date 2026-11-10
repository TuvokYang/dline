import { describe, expect, it, vi } from "vitest"
import { serializeDurableToolResult } from "../../DurableToolResult"
import { RetainedInputJournalBatch } from "../../executors/compose/RetainedInputJournalBatch"
import { RoundMaterialComposer } from "../../executors/compose/RoundMaterialComposer"
import { JournalConversationView } from "../../executors/provider/service/JournalConversationView"
import { ProviderJournalMessageMaterializer } from "../../executors/provider/service/ProviderJournalMessageMaterializer"
import type { RoundMaterialPlan } from "../../kernel"
import type { JournalSource } from "../contracts"
import { InMemoryConversationJournal, InMemoryTaskPayloadStore } from "../InMemoryRuntimeStores"
import { JournalConversationRewind } from "../JournalConversationRewind"
import { encodeTaskPayload } from "../payload/TaskPayloadCodec"

const BODY = "INPUT_THE_RESTORED_ROW_SHOWS"
const BEFORE = "ANSWER_BEFORE_THE_RESTORED_ROW"

async function fixture(options: { retained?: boolean; notice?: boolean; beforeInput?: "environment" | "provider" } = {}) {
    const journal = new InMemoryConversationJournal()
    const payloads = new InMemoryTaskPayloadStore()
    const view = new JournalConversationView(journal, new ProviderJournalMessageMaterializer(payloads))
    const append = async (id: string, source: JournalSource, payload: unknown) =>
        journal.append({ operationId: id, source, payloadRef: await payloads.put(encodeTaskPayload(payload)) })
    await append("before", "provider", { kind: "provider_final", text: BEFORE })
    const base = journal.watermark()
    if (options.beforeInput) {
        await append("intervening", options.beforeInput === "provider" ? "provider" : "system", {
            kind: options.beforeInput === "provider" ? "provider_final" : "environment_details",
            text: "UNRELATED_ENTRY",
        })
    }
    const inputRef = await payloads.put(encodeTaskPayload({ kind: "user_input", text: BODY }))
    const plan: RoundMaterialPlan = {
        id: "restore-material-plan",
        frozenRevision: 3,
        notices: options.notice ? [{ id: "exit", kind: "away_exited", revision: 1, reason: "stopped" }] : [],
        inputs: [{ id: "input", entryId: "accepted-input", payloadRef: inputRef, revision: 2, source: "intake" }],
    }
    const signal = new AbortController().signal
    const batches = options.retained
        ? [
              await new RetainedInputJournalBatch(payloads, journal).stage({
                  deliveryId: "retained-before-restore",
                  generation: 0,
                  entries: [{ entryId: "accepted-input", payloadRef: inputRef }],
                  roundMaterialOwned: true,
                  signal,
              }),
          ]
        : []
    await new RoundMaterialComposer(payloads, journal).appendBody(plan, signal, batches)
    await append("environment", "system", { kind: "environment_details", text: "ENVIRONMENT_AFTER_INPUT" })
    await append("answer", "provider", { kind: "provider_final", text: "ANSWER_AFTER_INPUT" })
    const rewind = new JournalConversationRewind(journal, view)
    const text = async () => JSON.stringify(await view.messages())
    const restore = async (kind: "ordinary" | "canonical", keepInput: boolean) => {
        const row = { keep: 1, seq: base.seq, keepInput }
        if (kind === "ordinary") await rewind.rewindToRow({ operationId: "restore-row", row })
        else {
            const boundary = await rewind.resolveRowBoundary(row, base)
            await rewind.restoreTo({ operationId: "restore-checkpoint", target: boundary })
        }
    }
    const compact = async (id = "hide-input") =>
        journal.supersedeRange({
            operationId: `summary:${id}`,
            from: { seq: 1 },
            to: journal.watermark(),
            replacementRef: await payloads.put(
                encodeTaskPayload({ kind: "compaction_summary", compactionId: id, text: "SUMMARY_AFTER_INPUT" }),
            ),
        })
    return { journal, base, text, restore, compact, append }
}

describe("JournalConversationRewind typed material boundary", () => {
    it.each(["ordinary", "canonical"] as const)("keeps the real material input once on %s non-edit restore", async (kind) => {
        const h = await fixture()
        expect((await h.text()).split(BODY)).toHaveLength(2)

        await h.restore(kind, true)

        const actual = await h.text()
        expect(actual).toContain(BEFORE)
        expect(actual.split(BODY)).toHaveLength(2)
        expect(actual).not.toContain("ENVIRONMENT_AFTER_INPUT")
        expect(actual).not.toContain("ANSWER_AFTER_INPUT")
    })

    it.each([
        "ordinary",
        "canonical",
    ] as const)("keeps an input hidden by compaction when %s restore undoes its summary", async (kind) => {
        const h = await fixture()
        await h.compact()
        expect(await h.text()).not.toContain(BODY)

        await h.restore(kind, true)

        const actual = await h.text()
        expect(actual).toContain(BEFORE)
        expect(actual.split(BODY)).toHaveLength(2)
        expect(actual).not.toContain("SUMMARY_AFTER_INPUT")
        expect(actual).not.toContain("ENVIRONMENT_AFTER_INPUT")
        expect(actual).not.toContain("ANSWER_AFTER_INPUT")
    })

    it.each([
        "ordinary",
        "canonical",
    ] as const)("keeps a retained input and its notice through nested summaries on %s restore", async (kind) => {
        const h = await fixture({ retained: true, notice: true })
        await h.compact()
        await h.compact("nested")

        await h.restore(kind, true)

        const actual = await h.text()
        expect(actual).toContain(BEFORE)
        expect(actual.split(BODY)).toHaveLength(2)
        expect(actual).toContain("sent by the user while work was in progress")
        expect(actual).not.toContain("SUMMARY_AFTER_INPUT")
        expect(actual).not.toContain("ENVIRONMENT_AFTER_INPUT")
        expect(actual).not.toContain("ANSWER_AFTER_INPUT")
    })

    it.each(["ordinary", "canonical"] as const)("does not retain hidden input when %s restore edits the row", async (kind) => {
        const h = await fixture()
        await h.compact()

        await h.restore(kind, false)

        expect(await h.text()).toContain(BEFORE)
        expect(await h.text()).not.toContain(BODY)
        expect(await h.text()).not.toContain("SUMMARY_AFTER_INPUT")
    })

    it.each([
        "ordinary",
        "canonical",
    ] as const)("refuses an undone base instead of retaining another branch's input on %s restore", async (kind) => {
        const h = await fixture()
        await h.journal.rewind({ operationId: "discard-old-branch", target: { seq: 0 } })
        await h.append("new-branch", "intake", { kind: "user_input", text: "NEW_BRANCH_INPUT" })
        const before = await h.journal.read()
        const visible = await h.text()

        await expect(h.restore(kind, true)).rejects.toThrow("ConversationRewindTargetMissing")

        expect(await h.journal.read()).toEqual(before)
        expect(await h.text()).toBe(visible)
    })

    it.each(["ordinary", "canonical"] as const)("drops the real material input when %s restore replaces it", async (kind) => {
        const h = await fixture()

        await h.restore(kind, false)

        expect(await h.text()).toContain(BEFORE)
        expect(await h.text()).not.toContain(BODY)
    })

    it("does not mistake a suppressed retained intake for its rendered input", async () => {
        const h = await fixture({ retained: true })
        expect((await h.text()).split(BODY)).toHaveLength(2)

        await h.restore("canonical", true)

        expect((await h.text()).split(BODY)).toHaveLength(2)
        expect(await h.text()).not.toContain("ANSWER_AFTER_INPUT")
    })

    it("keeps the frozen notice before the input without extending into its environment", async () => {
        const h = await fixture({ notice: true })

        await h.restore("ordinary", true)

        expect((await h.text()).split(BODY)).toHaveLength(2)
        expect(await h.text()).not.toContain("ENVIRONMENT_AFTER_INPUT")
    })

    it("keeps the opening material hidden by a summary when its row recorded genesis", async () => {
        const journal = new InMemoryConversationJournal()
        const payloads = new InMemoryTaskPayloadStore()
        const inputRef = await payloads.put(encodeTaskPayload({ kind: "user_input", text: BODY }))
        await new RoundMaterialComposer(payloads, journal).appendBody(
            {
                id: "opening",
                frozenRevision: 1,
                notices: [],
                inputs: [{ id: "task", source: "intake", revision: 1, payloadRef: inputRef }],
            },
            new AbortController().signal,
        )
        await journal.supersedeRange({
            operationId: "hide-opening",
            from: { seq: 1 },
            to: { seq: 1 },
            replacementRef: await payloads.put(encodeTaskPayload({ kind: "compaction_summary", text: "SUMMARY" })),
        })
        const view = new JournalConversationView(journal, new ProviderJournalMessageMaterializer(payloads))
        const rewind = new JournalConversationRewind(journal, view)

        const boundary = await rewind.resolveRowBoundary({ keep: 0, seq: 0, keepInput: true }, { seq: 0 })
        expect(boundary).toEqual({ seq: 1 })
        await rewind.restoreTo({ operationId: "restore-opening", target: boundary })

        const messages = await view.messages()
        expect(messages).toHaveLength(1)
        expect(JSON.stringify(messages).split(BODY)).toHaveLength(2)
        expect(JSON.stringify(messages)).not.toContain("SUMMARY")
    })

    it("retains a hidden result with the call before the restored row, without crossing later environment", async () => {
        const journal = new InMemoryConversationJournal()
        const payloads = new InMemoryTaskPayloadStore()
        const append = async (operationId: string, source: JournalSource, payload: unknown) =>
            journal.append({ operationId, source, payloadRef: await payloads.put(encodeTaskPayload(payload)) })
        await append("task", "intake", { kind: "user_input", text: "TASK" })
        await append("call", "provider", {
            kind: "provider_final",
            content: [{ type: "tool_use", function_id: "read", dline_tid: "read", name: "read_file", input: {} }],
            turnPlan: { mode: "serial", blocks: [] },
        })
        const base = journal.watermark()
        await append("result", "tool", {
            kind: "tool_result",
            blockId: "read",
            content: serializeDurableToolResult({
                type: "tool_result",
                function_id: "read",
                dline_tid: "read",
                content: "READ_BODY",
            }),
        })
        await append("environment", "system", { kind: "environment_details", text: "LATER_ENVIRONMENT" })
        await append("later", "intake", { kind: "user_input", text: "LATER_INPUT" })
        await journal.supersedeRange({
            operationId: "hide-call-and-result",
            from: { seq: 1 },
            to: journal.watermark(),
            replacementRef: await payloads.put(encodeTaskPayload({ kind: "compaction_summary", text: "SUMMARY" })),
        })
        const view = new JournalConversationView(journal, new ProviderJournalMessageMaterializer(payloads))
        const rewind = new JournalConversationRewind(journal, view)

        const boundary = await rewind.resolveRowBoundary({ keep: 2, seq: base.seq, keepInput: false }, base)
        expect(boundary).toEqual({ seq: 3 })
        await rewind.restoreTo({ operationId: "restore-call", target: boundary })

        const messages = await view.messages()
        expect(messages.map((message) => message.role)).toEqual(["user", "assistant", "user"])
        const blocks = messages.flatMap((message) => (typeof message.content === "string" ? [] : message.content))
        expect(blocks.filter((block) => block.type === "tool_use")).toMatchObject([{ function_id: "read" }])
        expect(blocks.filter((block) => block.type === "tool_result")).toMatchObject([
            { function_id: "read", content: "READ_BODY" },
        ])
        expect(JSON.stringify(messages)).not.toContain("LATER_")
        expect(JSON.stringify(messages)).not.toContain("SUMMARY")
    })

    it("resolves only the captured projection when a new input lands during the lookup", async () => {
        const journal = new InMemoryConversationJournal()
        const payloads = new InMemoryTaskPayloadStore()
        await journal.append({
            operationId: "before",
            source: "provider",
            payloadRef: await payloads.put(encodeTaskPayload({ kind: "provider_final", text: BEFORE })),
        })
        const base = journal.watermark()
        const view = new JournalConversationView(journal, new ProviderJournalMessageMaterializer(payloads))
        const project = journal.project.bind(journal)
        vi.spyOn(journal, "project").mockImplementationOnce(async (through) => {
            const captured = await project(through)
            const inputRef = await payloads.put(encodeTaskPayload({ kind: "user_input", text: "LATER_ACCEPTED_INPUT" }))
            await new RoundMaterialComposer(payloads, journal).appendBody(
                {
                    id: "later-plan",
                    frozenRevision: 1,
                    notices: [],
                    inputs: [{ id: "later", source: "intake", revision: 1, payloadRef: inputRef }],
                },
                new AbortController().signal,
            )
            return captured
        })

        const rewind = new JournalConversationRewind(journal, view)
        await expect(rewind.resolveRowBoundary({ keep: 1, seq: base.seq, keepInput: true }, base)).resolves.toEqual(base)
        expect(JSON.stringify(await view.messages())).toContain("LATER_ACCEPTED_INPUT")
        expect((await journal.read()).filter((entry) => entry.kind === "rewind")).toEqual([])
    })

    it.each([
        "environment",
        "provider",
    ] as const)("does not cross an unrelated %s entry to retain a later input", async (beforeInput) => {
        const h = await fixture({ beforeInput })

        await h.restore("canonical", true)

        expect(await h.text()).toContain(BEFORE)
        expect(await h.text()).not.toContain(BODY)
        expect(await h.text()).not.toContain("UNRELATED_ENTRY")
    })
})
