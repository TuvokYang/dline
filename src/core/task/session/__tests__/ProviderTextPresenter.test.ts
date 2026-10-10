import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it, vi } from "vitest"
import type { MessageStateHandler } from "../../message-state"
import { ProviderTextPresenter } from "../ProviderTextPresenter"

/** A message store reduced to the row operations the presenter performs. */
function createMessages() {
    const rows = new Map<number, UiMessage>()
    const committed: UiMessage[] = []
    const removed: number[] = []
    const handler = {
        upsertTransientClineMessage: (message: UiMessage) => {
            rows.set(message.ts, message)
            return message
        },
        commitTransientClineMessage: async (message: UiMessage) => {
            rows.set(message.ts, message)
            committed.push(message)
            return message
        },
        removeTransientClineMessage: (ts: number) => {
            removed.push(ts)
            return rows.delete(ts)
        },
    } as unknown as MessageStateHandler
    return { handler, rows, committed, removed }
}

function createPresenter() {
    const messages = createMessages()
    const published: UiMessage[] = []
    let next = 100
    return {
        ...messages,
        published,
        presenter: new ProviderTextPresenter(messages.handler, () => ++next, {
            publish: (row) => published.push(row),
        }),
    }
}

/**
 * A reply that calls no tool has no block to render it, so its prose is the only
 * thing the chat can show. Before this the turn ran and ended with nothing
 * visible at all.
 */
describe("ProviderTextPresenter", () => {
    // dev showed reasoning while it streamed; a long think is otherwise
    // indistinguishable from a stalled request.
    it("shows streamed reasoning in its own row above the prose and settles both", async () => {
        const { presenter, rows, committed, published } = createPresenter()

        presenter.showPartial({ transientId: "provider:turn-1", text: "", reasoning: "THINK" })
        presenter.showPartial({ transientId: "provider:turn-1", text: "Answer", reasoning: "THINKING" })

        const streamed = [...rows.values()]
        expect(streamed.map((row) => [row.say, row.text, row.partial])).toEqual([
            ["reasoning", "THINKING", true],
            ["text", "Answer", true],
        ])
        expect(streamed[0].ts).toBeLessThan(streamed[1].ts)
        expect(published.slice(-2)).toEqual([
            expect.objectContaining({ say: "reasoning", text: "THINKING", partial: true }),
            expect.objectContaining({ say: "text", text: "Answer", partial: true }),
        ])

        await presenter.commit({ transientId: "provider:turn-1", text: "Answer", reasoning: "THINKING" })

        expect(committed.map((row) => [row.say, row.text, row.partial, row.ts])).toEqual([
            ["reasoning", "THINKING", false, streamed[0].ts],
            ["text", "Answer", false, streamed[1].ts],
        ])
        expect(published.slice(-2)).toEqual([
            expect.objectContaining({ ts: streamed[0].ts, say: "reasoning", text: "THINKING", partial: false }),
            expect.objectContaining({ ts: streamed[1].ts, say: "text", text: "Answer", partial: false }),
        ])
    })

    // Encrypted-only reasoning has no text to show, yet the chat must still read
    // it as thinking; the contentless row is withdrawn once the turn settles.
    it("opens a contentless reasoning row for empty reasoning and withdraws it on commit", async () => {
        const { presenter, rows, committed, removed, published } = createPresenter()

        presenter.showPartial({ transientId: "provider:turn-1", text: "", reasoning: "" })

        const [thinking] = [...rows.values()]
        expect([thinking.say, thinking.text, thinking.partial]).toEqual(["reasoning", "", true])
        expect(published).toEqual([expect.objectContaining({ say: "reasoning", text: "", partial: true })])

        presenter.showPartial({ transientId: "provider:turn-1", text: "Answer" })
        await presenter.commit({ transientId: "provider:turn-1", text: "Answer" })

        expect(removed).toEqual([thinking.ts])
        expect(committed.map((row) => [row.say, row.text])).toEqual([["text", "Answer"]])
    })

    it("opens no reasoning row when the partial carries no reasoning", () => {
        const { presenter, rows } = createPresenter()

        presenter.showPartial({ transientId: "provider:turn-1", text: "Answer" })

        expect([...rows.values()].map((row) => row.say)).toEqual(["text"])
    })

    it("forwards one native tool projection without creating a prose row", async () => {
        const messages = createMessages()
        const presentToolPartial = vi.fn(async () => undefined)
        const presenter = new ProviderTextPresenter(messages.handler, () => 101, undefined, presentToolPartial)
        const projection = { kind: "provider.tool_partial", block: { type: "tool_use", name: "qna_respond", partial: true } }

        presenter.showPartial({ transientId: "provider:turn-1", text: "", projection })
        await vi.waitFor(() => expect(presentToolPartial).toHaveBeenCalledWith(projection))

        expect(messages.rows.size).toBe(0)
    })

    it("keeps the reasoning of a reply that said nothing else", async () => {
        const { presenter, committed, removed } = createPresenter()

        presenter.showPartial({ transientId: "provider:turn-1", text: "", reasoning: "ONLY_THOUGHT" })
        await presenter.commit({ transientId: "provider:turn-1", text: "", reasoning: "ONLY_THOUGHT" })

        expect(committed.map((row) => [row.say, row.text])).toEqual([["reasoning", "ONLY_THOUGHT"]])
        expect(removed).toEqual([])
    })

    it("keeps one row per stream while the prose grows", () => {
        const { presenter, rows } = createPresenter()

        presenter.showPartial({ transientId: "provider:turn-1", text: "Hel" })
        presenter.showPartial({ transientId: "provider:turn-1", text: "Hello" })

        expect([...rows.values()]).toEqual([expect.objectContaining({ type: "say", say: "text", text: "Hello", partial: true })])
    })

    it("settles the streamed row under the same identity", async () => {
        const { presenter, committed, rows } = createPresenter()

        presenter.showPartial({ transientId: "provider:turn-1", text: "Hello" })
        const streamedTs = [...rows.keys()][0]
        await presenter.commit({ transientId: "provider:turn-1", text: "Hello there" })

        expect(committed).toEqual([expect.objectContaining({ ts: streamedTs, text: "Hello there", partial: false })])
    })

    it("commits prose that only arrived with the final chunk", async () => {
        // A provider that emits its whole answer at once never streams a partial,
        // so the row has to be created at commit time or the reply is lost.
        const { presenter, committed } = createPresenter()

        await presenter.commit({ transientId: "provider:turn-1", text: "Complete answer" })

        expect(committed).toEqual([expect.objectContaining({ text: "Complete answer", partial: false })])
    })

    it("withdraws the row when the turn produced no prose", async () => {
        // A tool-only turn has nothing to say; the blocks render themselves, and an
        // empty row would leave a blank message above them forever.
        const { presenter, committed, removed, rows } = createPresenter()

        presenter.showPartial({ transientId: "provider:turn-1", text: "thinking aloud" })
        const streamedTs = [...rows.keys()][0]
        await presenter.commit({ transientId: "provider:turn-1", text: "   " })

        expect(removed).toEqual([streamedTs])
        expect(committed).toEqual([])
    })

    it("gives a later stream its own row", async () => {
        const { presenter, committed } = createPresenter()

        presenter.showPartial({ transientId: "provider:turn-1", text: "first" })
        await presenter.commit({ transientId: "provider:turn-1", text: "first" })
        presenter.showPartial({ transientId: "provider:turn-2", text: "second" })
        await presenter.commit({ transientId: "provider:turn-2", text: "second" })

        const [first, second] = committed
        expect(first.text).toBe("first")
        expect(second.text).toBe("second")
        expect(second.ts).toBeGreaterThan(first.ts)
    })
})
