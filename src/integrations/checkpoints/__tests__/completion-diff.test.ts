import type { ClineMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { resolveCompletionDiffBaseHash } from "../completion-diff"

function checkpoint(ts: number, hash: string): ClineMessage {
	return { ts, type: "say", say: "checkpoint_created", lastCheckpointHash: [hash] }
}

describe("resolveCompletionDiffBaseHash", () => {
	it("uses the task-start checkpoint for the first completion", () => {
		const messages: ClineMessage[] = [
			checkpoint(1, "task-start"),
			{ ts: 2, type: "say", say: "completion_result", lastCheckpointHash: ["current"] },
		]

		expect(resolveCompletionDiffBaseHash(messages, 1)).toBe("task-start")
	})

	it("uses the closest earlier completion after its row was rewritten as an ask", () => {
		const messages: ClineMessage[] = [
			checkpoint(1, "task-start"),
			{ ts: 2, type: "ask", ask: "completion_result", lastCheckpointHash: ["previous"] },
			{ ts: 3, type: "say", say: "completion_result", lastCheckpointHash: ["current"] },
		]

		expect(resolveCompletionDiffBaseHash(messages, 2)).toBe("previous")
	})

	it("skips completion rows without a file checkpoint hash", () => {
		const messages: ClineMessage[] = [
			checkpoint(1, "task-start"),
			{ ts: 2, type: "ask", ask: "completion_result" },
			{ ts: 3, type: "say", say: "completion_result", lastCheckpointHash: ["current"] },
		]

		expect(resolveCompletionDiffBaseHash(messages, 2)).toBe("task-start")
	})
})
