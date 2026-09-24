import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import type { MessageStateHandler } from "../../message-state"
import { ProviderTextPresenter } from "../ProviderTextPresenter"

/** A message store reduced to the row operations the presenter performs. */
function createMessages() {
	const rows = new Map<number, ClineMessage>()
	const committed: ClineMessage[] = []
	const removed: number[] = []
	const handler = {
		upsertTransientClineMessage: (message: ClineMessage) => {
			rows.set(message.ts, message)
			return message
		},
		commitTransientClineMessage: async (message: ClineMessage) => {
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
	let next = 100
	return { ...messages, presenter: new ProviderTextPresenter(messages.handler, () => ++next) }
}

/**
 * A reply that calls no tool has no block to render it, so its prose is the only
 * thing the chat can show. Before this the turn ran and ended with nothing
 * visible at all.
 */
describe("ProviderTextPresenter", () => {
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
