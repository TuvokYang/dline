import { describe, expect, it } from "vitest"
import { createInitialTaskState, type TaskState } from "../../kernel"
import { canonicalInputQueuePayloadRefs, projectCanonicalInputQueue } from "./materializeCanonicalInputQueue"

function stateWithQueue(): TaskState {
	const base = createInitialTaskState("task-1")
	return {
		...base,
		intake: {
			...base.intake,
			queued: [
				{
					entryId: "later",
					payloadRef: "payload:later",
					source: "user",
					mode: "queued",
					sequence: 2,
					state: "released",
					queue: { editing: true },
				},
				{
					entryId: "first",
					payloadRef: "payload:first",
					source: "user",
					mode: "steering",
					sequence: 1,
					state: "accepted",
					queue: { editing: false },
				},
				{
					entryId: "in-flight",
					payloadRef: "payload:in-flight",
					source: "user",
					mode: "queued",
					sequence: 0,
					state: "reserved",
					queue: { editing: false },
				},
				{
					entryId: "direct",
					payloadRef: "payload:direct",
					source: "user",
					mode: "queued",
					sequence: 3,
					state: "accepted",
				},
			],
		},
	}
}

describe("projectCanonicalInputQueue", () => {
	it("projects only visible retained input in kernel sequence order", () => {
		const state = stateWithQueue()
		const payloads = new Map([
			[
				"payload:first",
				{
					text: "first",
					images: ["image:first"],
					files: ["first.ts"],
					activeQuote: "quote",
					semanticInput: { id: "semantic:first" },
				},
			],
			["payload:later", { text: "later" }],
		])

		expect(canonicalInputQueuePayloadRefs(state)).toEqual(["payload:first", "payload:later"])
		expect(projectCanonicalInputQueue(state, payloads)).toEqual([
			{
				id: "first",
				text: "first",
				images: ["image:first"],
				files: ["first.ts"],
				activeQuote: "quote",
				semanticInput: { id: "semantic:first" },
				mode: "steering",
				editing: false,
				sequence: 1,
			},
			{
				id: "later",
				text: "later",
				images: [],
				files: [],
				mode: "queued",
				editing: true,
				sequence: 2,
			},
		])
	})
})
