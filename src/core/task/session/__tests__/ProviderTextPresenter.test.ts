import type { UiMessage } from "@shared/ExtensionMessage"
import { afterEach, describe, expect, it, vi } from "vitest"
import type { MessageStateHandler } from "../../message-state"
import { type ProviderPresentationPacing, ProviderTextPresenter } from "../ProviderTextPresenter"

/** No waiting between refreshes, so a test only has to let queued refreshes run. */
const UNPACED: ProviderPresentationPacing = { delayMs: () => 0 }

/** The production shape: first appearance at once, later changes on a 40ms cadence. */
const CADENCED: ProviderPresentationPacing = { delayMs: (priority) => (priority === "immediate" ? 0 : 40) }

const tick = () => new Promise((resolve) => setTimeout(resolve, 0))

/**
 * Let every refresh already requested reach the chat. A refresh queued behind
 * the one drawing is scheduled only once that one settles, a turn later.
 */
const drawn = async () => {
    await tick()
    await tick()
}

function deferred() {
    let resolve: () => void = () => undefined
    const promise = new Promise<void>((settle) => {
        resolve = settle
    })
    return { promise, resolve }
}

function toolProjection(dlineTid: string, content: string) {
    return {
        kind: "provider.tool_partial",
        dlineTid,
        block: { type: "tool_use", name: "write_to_file", params: { path: "a.ts", content }, partial: true },
    }
}

/** A message store reduced to the row operations the presenter performs. */
function createMessages() {
    const rows = new Map<number, UiMessage>()
    const committed: UiMessage[] = []
    const removed: number[] = []
    const withdrawn: number[] = []
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
        removeMessagesByTs: async (list: number[]) => {
            withdrawn.push(...list)
        },
    } as unknown as MessageStateHandler
    return { handler, rows, committed, removed, withdrawn }
}

/** The card the provider draws for a call written as markup, before the call settles. */
function provisionalCard(row: number, content: string) {
    return {
        kind: "provider.tool_partial",
        dlineTid: `xml:${row}`,
        provisional: true,
        block: { type: "tool_use", name: "write_to_file", params: { path: "a.ts", content }, partial: true, ts: row },
    }
}

function createPresenter() {
    const messages = createMessages()
    const published: UiMessage[] = []
    let next = 100
    return {
        ...messages,
        published,
        presenter: new ProviderTextPresenter(
            messages.handler,
            () => ++next,
            {
                publish: (row) => published.push(row),
            },
            undefined,
            UNPACED,
        ),
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
        await drawn()

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

    it("keeps one row per stream while the prose grows", async () => {
        const { presenter, rows } = createPresenter()

        presenter.showPartial({ transientId: "provider:turn-1", text: "Hel" })
        presenter.showPartial({ transientId: "provider:turn-1", text: "Hello" })
        await drawn()

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

    it("replaces invalid prose with a durable error row while preserving its streamed row identity", async () => {
        const { presenter, committed, rows } = createPresenter()

        presenter.showPartial({ transientId: "provider:turn-1", text: "ordinary prose" })
        const streamedTs = [...rows.keys()][0]
        await presenter.commit({
            transientId: "provider:turn-1",
            text: "ordinary prose",
            proseDisposition: "plain_text_outside_tool",
        })

        expect(committed).toEqual([expect.objectContaining({ ts: streamedTs, type: "say", say: "error", partial: false })])
        expect(committed[0].text).not.toBe("ordinary prose")
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

/**
 * Every provider chunk carries the reply so far. Drawing each one sent work
 * quadratic in the reply's length to the host and the Webview, and partial rows
 * piled up until the final row overtook them: a long reply showed nothing until
 * it was complete.
 */
describe("ProviderTextPresenter pacing", () => {
    afterEach(() => {
        vi.useRealTimers()
    })

    it("draws a new row at once and coalesces the chunks after it into the latest frame", async () => {
        vi.useFakeTimers()
        const messages = createMessages()
        const published: UiMessage[] = []
        const presenter = new ProviderTextPresenter(
            messages.handler,
            () => 1,
            { publish: (row) => published.push(row) },
            undefined,
            CADENCED,
        )

        presenter.showPartial({ transientId: "provider:turn-1", text: "a" })
        presenter.showPartial({ transientId: "provider:turn-1", text: "ab" })
        presenter.showPartial({ transientId: "provider:turn-1", text: "abc" })
        expect(published.map((row) => row.text)).toEqual(["a"])

        await vi.advanceTimersByTimeAsync(40)

        expect(published.map((row) => row.text)).toEqual(["a", "abc"])
        await presenter.dispose()
    })

    it("does not redraw prose that a tool delta left unchanged", async () => {
        const messages = createMessages()
        const published: UiMessage[] = []
        const presentToolPartial = vi.fn(async () => undefined)
        const presenter = new ProviderTextPresenter(
            messages.handler,
            () => 1,
            { publish: (row) => published.push(row) },
            presentToolPartial,
            UNPACED,
        )

        presenter.showPartial({ transientId: "provider:turn-1", text: "Writing it now." })
        await drawn()
        presenter.showPartial({ transientId: "provider:turn-1", text: "Writing it now.", projection: toolProjection("t1", "a") })
        presenter.showPartial({ transientId: "provider:turn-1", text: "Writing it now.", projection: toolProjection("t1", "ab") })
        await drawn()
        await drawn()

        expect(published.filter((row) => row.say === "text")).toHaveLength(1)
        expect(presentToolPartial).toHaveBeenCalled()
    })

    it("refreshes one tool call at a time with only its latest arguments", async () => {
        const messages = createMessages()
        const first = deferred()
        let running = 0
        let overlapped = false
        const presentToolPartial = vi.fn(async (projection: Readonly<Record<string, unknown>>) => {
            running += 1
            overlapped ||= running > 1
            if (presentToolPartial.mock.calls.length === 1) await first.promise
            running -= 1
            return projection && undefined
        })
        const presenter = new ProviderTextPresenter(messages.handler, () => 1, undefined, presentToolPartial, UNPACED)

        presenter.showPartial({ transientId: "provider:turn-1", text: "", projection: toolProjection("t1", "a") })
        presenter.showPartial({ transientId: "provider:turn-1", text: "", projection: toolProjection("t1", "ab") })
        presenter.showPartial({ transientId: "provider:turn-1", text: "", projection: toolProjection("t1", "abc") })
        await drawn()
        expect(presentToolPartial).toHaveBeenCalledTimes(1)

        first.resolve()
        await drawn()
        await drawn()

        expect(
            presentToolPartial.mock.calls.map(
                ([projection]) => (projection.block as { params: { content: string } }).params.content,
            ),
        ).toEqual(["a", "abc"])
        expect(overlapped).toBe(false)
    })

    // The final tool row is written once the turn settles. A partial refresh that
    // was still queued would land after it and be refused, or worse, regress it.
    it("settles only after the refresh in flight and never draws a frame queued behind it", async () => {
        const messages = createMessages()
        const inFlight = deferred()
        const presentToolPartial = vi.fn(async () => {
            if (presentToolPartial.mock.calls.length === 1) await inFlight.promise
        })
        const presenter = new ProviderTextPresenter(messages.handler, () => 1, undefined, presentToolPartial, UNPACED)

        presenter.showPartial({ transientId: "provider:turn-1", text: "Done", projection: toolProjection("t1", "a") })
        presenter.showPartial({ transientId: "provider:turn-1", text: "Done", projection: toolProjection("t1", "ab") })
        let settled = false
        const commit = presenter.commit({ transientId: "provider:turn-1", text: "Done" }).then(() => {
            settled = true
        })
        await drawn()
        expect(settled).toBe(false)
        expect(messages.committed).toEqual([])

        inFlight.resolve()
        await commit
        await drawn()

        expect(presentToolPartial).toHaveBeenCalledTimes(1)
        expect(messages.committed).toEqual([expect.objectContaining({ say: "text", text: "Done", partial: false })])
    })

    // The provider draws a card's row id right after the chunk that introduced
    // it. A prose row reserved only when it is drawn sorted below that card
    // whenever a tool refresh was still in flight.
    it("reserves the prose row when its chunk arrives, ahead of the card that follows", async () => {
        const messages = createMessages()
        const inFlight = deferred()
        let next = 0
        const ids = () => ++next
        const presentToolPartial = vi.fn(async () => {
            if (presentToolPartial.mock.calls.length === 1) await inFlight.promise
        })
        const presenter = new ProviderTextPresenter(messages.handler, ids, undefined, presentToolPartial, UNPACED)

        presenter.showPartial({ transientId: "provider:turn-1", text: "", projection: toolProjection("t1", "a") })
        presenter.showPartial({ transientId: "provider:turn-1", text: "Reading it." })
        const cardRow = ids()
        inFlight.resolve()
        await drawn()
        await drawn()

        const prose = [...messages.rows.values()].find((row) => row.say === "text")
        expect(prose?.ts).toBeLessThan(cardRow)
    })

    it("reserves reply rows before a native card so late reasoning still sorts above it", async () => {
        const messages = createMessages()
        let next = 0
        const ids = () => ++next
        const presentToolPartial = vi.fn(async (): Promise<void> => undefined)
        const presenter = new ProviderTextPresenter(messages.handler, ids, undefined, presentToolPartial, UNPACED)

        const replyRows = { reasoning: ids(), text: ids() }
        const cardRow = ids()
        presenter.showPartial({
            transientId: "provider:turn-1",
            text: "",
            replyRows,
            projection: {
                ...toolProjection("native-1", "done"),
                provisional: true,
                block: {
                    type: "tool_use",
                    name: "attempt_completion",
                    params: { result: "done" },
                    partial: true,
                    ts: cardRow,
                },
            },
        })
        presenter.showPartial({ transientId: "provider:turn-1", text: "", reasoning: "LATE_THOUGHT" })
        await drawn()
        await presenter.commit({
            transientId: "provider:turn-1",
            text: "",
            reasoning: "LATE_THOUGHT",
            toolRows: [cardRow],
        })

        const reasoning = messages.committed.find((row) => row.say === "reasoning")
        expect(reasoning?.ts).toBeLessThan(cardRow)
        expect(messages.withdrawn).toEqual([])
    })
})

/**
 * A card drawn for a call written as markup stands for a call still being
 * written. A model that never closes its markup leaves a call that never runs,
 * and its card must not stay in the chat as if it were still streaming.
 */
describe("ProviderTextPresenter provisional tool cards", () => {
    function presenterWithCards() {
        const messages = createMessages()
        const presentToolPartial = vi.fn(async (): Promise<void> => undefined)
        const presenter = new ProviderTextPresenter(messages.handler, () => 1, undefined, presentToolPartial, UNPACED)
        return { ...messages, presenter, presentToolPartial }
    }

    it("keeps the cards the settled turn names and withdraws the rest", async () => {
        const { presenter, withdrawn } = presenterWithCards()

        presenter.showPartial({ transientId: "provider:turn-1", text: "", projection: provisionalCard(7, "a") })
        presenter.showPartial({ transientId: "provider:turn-1", text: "", projection: provisionalCard(8, "b") })
        await drawn()
        await drawn()
        await presenter.commit({ transientId: "provider:turn-1", text: "", toolRows: [7] })

        expect(withdrawn).toEqual([8])
    })

    it("withdraws every card of a stream that settled no call, and leaves native rows alone", async () => {
        const { presenter, withdrawn } = presenterWithCards()

        presenter.showPartial({ transientId: "provider:turn-1", text: "", projection: provisionalCard(7, "a") })
        presenter.showPartial({ transientId: "provider:turn-1", text: "", projection: toolProjection("native-1", "x") })
        await drawn()
        await drawn()
        await presenter.commit({ transientId: "provider:turn-1", text: "" })

        expect(withdrawn).toEqual([7])
    })

    it("withdraws nothing for a card that was never drawn", async () => {
        const { presenter, withdrawn, presentToolPartial } = presenterWithCards()
        const inFlight = deferred()
        presentToolPartial.mockImplementationOnce(() => inFlight.promise)

        presenter.showPartial({ transientId: "provider:turn-1", text: "", projection: provisionalCard(7, "a") })
        presenter.showPartial({ transientId: "provider:turn-1", text: "", projection: provisionalCard(9, "c") })
        const commit = presenter.commit({ transientId: "provider:turn-1", text: "", toolRows: [7] })
        inFlight.resolve()
        await commit

        expect(withdrawn).toEqual([])
    })
})
