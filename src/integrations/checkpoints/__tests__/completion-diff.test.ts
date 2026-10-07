import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { resolveCompletionDiffBaseReferences } from "../completion-diff"

function checkpoint(ts: number, hash: string): UiMessage {
	return { ts, type: "say", say: "checkpoint_created", lastCheckpointHash: [hash] }
}

function resolveCompletionDiffBaseHash(messages: readonly UiMessage[], messageIndex: number): string | undefined {
	return resolveCompletionDiffBaseReferences(messages, messageIndex)?.hashes[0]
}

describe("resolveCompletionDiffBaseReferences", () => {
	it("keeps every root of a multi-root baseline bound to its workspace", () => {
		const messages: UiMessage[] = [
			{
				ts: 1,
				type: "say",
				say: "checkpoint_created",
				lastCheckpointHash: ["root-a", "root-b"],
				checkpointWorkspaceRoots: ["/a", "/b"],
			},
			{ ts: 2, type: "say", say: "completion_result", lastCheckpointHash: ["current-a", "current-b"] },
		]

		expect(resolveCompletionDiffBaseReferences(messages, 1)).toEqual({
			hashes: ["root-a", "root-b"],
			workspaceRoots: ["/a", "/b"],
		})
	})

	it("uses the task-start checkpoint for the first completion", () => {
		const messages: UiMessage[] = [
			checkpoint(1, "task-start"),
			{ ts: 2, type: "say", say: "completion_result", lastCheckpointHash: ["current"] },
		]

		expect(resolveCompletionDiffBaseHash(messages, 1)).toBe("task-start")
	})

	it("uses the closest earlier completion after its row was rewritten as an ask", () => {
		const messages: UiMessage[] = [
			checkpoint(1, "task-start"),
			{ ts: 2, type: "ask", ask: "completion_result", lastCheckpointHash: ["previous"] },
			{ ts: 3, type: "say", say: "completion_result", lastCheckpointHash: ["current"] },
		]

		expect(resolveCompletionDiffBaseHash(messages, 2)).toBe("previous")
	})

	it("skips completion rows without a file checkpoint hash", () => {
		const messages: UiMessage[] = [
			checkpoint(1, "task-start"),
			{ ts: 2, type: "ask", ask: "completion_result" },
			{ ts: 3, type: "say", say: "completion_result", lastCheckpointHash: ["current"] },
		]

		expect(resolveCompletionDiffBaseHash(messages, 2)).toBe("task-start")
	})
})
