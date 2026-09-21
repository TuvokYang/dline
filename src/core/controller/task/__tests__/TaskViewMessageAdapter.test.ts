import { createInitialTaskState } from "@core/task/kernel"
import { projectCanonicalTaskView } from "@core/task/view/canonical/projectCanonicalTaskView"
import { describe, expect, it } from "vitest"
import { adaptCanonicalTaskView } from "../TaskViewMessageAdapter"

describe("adaptCanonicalTaskView", () => {
	it("decorates an awaiting canonical dialog with its exact message anchor", () => {
		const initial = createInitialTaskState("task-1")
		const projection = projectCanonicalTaskView({
			...initial,
			revision: 4,
			flow: { phase: "paused" },
			dialog: {
				approvalsByBlock: {},
				primary: {
					interactionId: "interaction-1",
					turnId: "turn-1",
					kind: "followup",
					status: "awaiting",
					createdRevision: 3,
					presentationRef: "presentation-1",
					receiverGeneration: 0,
					actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
				},
			},
		})
		const view = adaptCanonicalTaskView(projection, [
			{ type: "ask", ask: "followup", ts: 100, text: "question", interactionId: "interaction-1" },
		])

		expect(view.activeInteraction).toMatchObject({
			interactionId: "interaction-1",
			taskAsk: "followup",
			askMessageTs: 100,
			anchorVerified: true,
		})
		expect(view.input).toMatchObject({ enabled: true, enterAction: "reply" })
	})

	it("projects canonical halt and compaction without legacy runtime options", () => {
		const initial = createInitialTaskState("task-1")
		const projection = projectCanonicalTaskView({
			...initial,
			flow: {
				phase: "running",
				compaction: { compactionId: "compact-1", attempt: "attempt-1", contextRef: "context-1", status: "running" },
			},
			halt: {
				status: "stopping",
				generation: 1,
				haltId: "halt-1",
				target: "paused",
				pending: ["provider"],
				halted: [],
				failed: [],
				timedOut: [],
			},
		})
		const view = adaptCanonicalTaskView(projection)

		expect(view.phase).toBe("cancelling")
		expect(view.contextCompaction).toEqual({ active: true, operationId: "compact-1" })
		expect(view.footer.actions).toEqual([
			{
				type: "cancel",
				label: "Cancel",
				appearance: "danger",
				enabled: false,
				payloadPolicy: "none",
				dispatchTarget: "task",
			},
		])
	})
})
