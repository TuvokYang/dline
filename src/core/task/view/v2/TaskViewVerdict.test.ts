import { describe, expect, it } from "vitest"
import { createInitialTaskState } from "../../kernel/types"
import { projectTaskViewVerdict } from "./TaskViewVerdict"

describe("task view verdict", () => {
	it("projects completion and its active interaction from one state", () => {
		const state = {
			...createInitialTaskState("task-1"),
			revision: 3,
			flow: { phase: "completed" as const, completionId: "completion:1" },
			dialog: {
				primary: {
					interactionId: "completion:1",
					turnId: "turn-1",
					kind: "completion",
					status: "awaiting" as const,
					createdRevision: 3,
					presentationRef: "completion:1",
					actionRules: [{ actionId: "reply", payloadPolicy: "draft" as const }],
				},
				approvalsByBlock: {},
			},
		}
		expect(projectTaskViewVerdict(state)).toMatchObject({
			terminal: "completed",
			input: "interaction",
			canComplete: true,
			activeInteraction: { interactionId: "completion:1", status: "awaiting" },
		})
	})

	it("disables input for consumed tasks", () => {
		const state = {
			...createInitialTaskState("task-1"),
			flow: { phase: "terminated" as const, terminalReason: "consumed" as const, consumedRef: "handoff:1" },
		}
		expect(projectTaskViewVerdict(state)).toMatchObject({ terminal: "consumed", input: "disabled", canResume: false })
	})
})
