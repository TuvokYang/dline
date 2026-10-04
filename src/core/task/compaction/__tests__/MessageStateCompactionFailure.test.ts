import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import type { MessageStateHandler } from "../../message-state"
import { MessageStateCompactionCards } from "../MessageStateCompactionCards"
import { COMPACTION_FAILURE_MESSAGE, MessageStateCompactionFailure } from "../MessageStateCompactionFailure"

function recordingMessages() {
	const rows: UiMessage[] = []
	const handler = {
		addToClineMessages: async (message: UiMessage) => {
			rows.push(message)
		},
	} as unknown as MessageStateHandler
	return { handler, rows }
}

describe("MessageStateCompactionFailure", () => {
	it("writes the standalone failure form of the compaction card without any partial summary", async () => {
		const { handler, rows } = recordingMessages()
		let next = 100
		const failure = new MessageStateCompactionFailure(new MessageStateCompactionCards(handler, () => next++))

		await failure.present({ compactionId: "compaction:1", attempt: "compaction:1:1" })

		expect(rows).toHaveLength(1)
		expect(rows[0]).toMatchObject({ ts: 100, type: "say", say: "tool", partial: false })
		expect(JSON.parse(rows[0].text ?? "{}")).toEqual({
			tool: "summarizeTask",
			content: "",
			compactionStatus: "failed",
			compactionOperationId: "compaction:1",
			compactionAttemptId: "compaction:1:1",
			compactionUnitKind: "failure",
			compactionDurable: true,
			error: COMPACTION_FAILURE_MESSAGE,
		})
	})
})
