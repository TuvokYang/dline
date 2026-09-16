import { UIMessage } from "@core/storage/UIMessage"
import { MessageStateHandler } from "@core/task/message-state"
import { TaskState } from "@core/task/TaskState"
import type { ClineMessage } from "@shared/ExtensionMessage"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"

/**
 * History updates run on the message write path, so their aggregates are cached.
 * The cache is keyed on a mutation revision rather than the message shape: an
 * edit to an earlier api_req_started changes the totals while leaving the count
 * and the tail untouched, which a shape-based key would fail to notice.
 */
describe("history aggregate cache", () => {
	let dlineDocsDir: string

	beforeEach(async () => {
		dlineDocsDir = await fs.mkdtemp(path.join(os.tmpdir(), "dline-history-aggregate-"))
		vi.stubEnv("DLINE_DOCS_DIR", dlineDocsDir)
	})

	afterEach(async () => {
		vi.unstubAllEnvs()
		await fs.rm(dlineDocsDir, { recursive: true, force: true })
	})

	async function createMessageState(taskId: string) {
		const writer = await UIMessage.open(taskId)
		const history: Array<{ tokensIn: number; totalCost: number }> = []
		const messageState = new MessageStateHandler({
			taskId,
			ulid: "test-ulid",
			taskState: new TaskState(),
			updateTaskHistory: async (item) => {
				history.push({ tokensIn: item.tokensIn, totalCost: item.totalCost })
				return []
			},
			uiMessage: writer,
		})
		return { messageState, history }
	}

	/** An api_req_started row carrying the usage the aggregate reads. */
	function requestRow(ts: number, tokensIn: number, cost: number): ClineMessage {
		return {
			ts,
			type: "say",
			say: "api_req_started",
			text: JSON.stringify({ tokensIn, tokensOut: 0, cost }),
		}
	}

	it("advances the mutation revision on every message change", async () => {
		const { messageState } = await createMessageState("aggregate-revision")
		const initial = messageState.messageMutationRevision

		await messageState.addToClineMessages({ ts: 100, type: "say", say: "task", text: "task" })
		const afterAdd = messageState.messageMutationRevision
		expect(afterAdd).toBeGreaterThan(initial)

		await messageState.updateClineMessage(0, { text: "task edited" })
		expect(messageState.messageMutationRevision).toBeGreaterThan(afterAdd)
	})

	it("invalidates on a non-tail edit that leaves count and tail unchanged", async () => {
		const { messageState } = await createMessageState("aggregate-non-tail")
		await messageState.addToClineMessages({ ts: 100, type: "say", say: "task", text: "task" })
		await messageState.addToClineMessages(requestRow(200, 10, 1))
		await messageState.addToClineMessages(requestRow(300, 20, 2))

		const countBefore = messageState.clineMessages.length
		const tailBefore = messageState.clineMessages.at(-1)
		const revisionBefore = messageState.messageMutationRevision

		// Edit the earlier request. A shape-based key (count + tail) would miss
		// this entirely, which is why the cache is keyed on the mutation revision.
		const index = messageState.clineMessages.findIndex((message) => message.ts === 200)
		await messageState.updateClineMessage(index, { text: JSON.stringify({ tokensIn: 70, tokensOut: 0, cost: 7 }) })

		expect(messageState.clineMessages.length).toBe(countBefore)
		expect(messageState.clineMessages.at(-1)).toEqual(tailBefore)
		expect(messageState.messageMutationRevision).toBeGreaterThan(revisionBefore)
	})

	it("holds the revision steady when no mutation occurs", async () => {
		const { messageState } = await createMessageState("aggregate-stable")
		await messageState.addToClineMessages({ ts: 100, type: "say", say: "task", text: "task" })
		await messageState.addToClineMessages(requestRow(200, 5, 1))

		const revisionBefore = messageState.messageMutationRevision
		// Reading the projection must not be mistaken for a mutation.
		void messageState.clineMessages
		void messageState.durableClineMessages

		expect(messageState.messageMutationRevision).toBe(revisionBefore)
	})
})
