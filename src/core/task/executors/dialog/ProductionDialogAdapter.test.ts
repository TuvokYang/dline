import { describe, expect, it } from "vitest"
import { createInitialTaskState, type DialogCommand } from "../../kernel"
import { InMemoryConversationJournal, InMemoryTaskViewPort } from "../../stores"
import { ProductionDialogAdapter } from "./ProductionDialogAdapter"

const base = {
	commandId: "dialog-1",
	originRevision: 1,
	generation: 0,
	interactionId: "interaction-1",
	turnId: "turn-1",
	kind: "followup",
	presentationRef: "payload:question-1",
	actionRules: [{ actionId: "reply", payloadPolicy: "draft" as const }],
	prepareKey: "dialog.prepare:interaction-1",
}

function prepare(
	signal = new AbortController().signal,
): Extract<DialogCommand, { type: "dialog.prepare" }> & { signal: AbortSignal } {
	return { ...base, type: "dialog.prepare", signal }
}

function reveal(
	signal = new AbortController().signal,
): Extract<DialogCommand, { type: "dialog.reveal" }> & { signal: AbortSignal } {
	return {
		...base,
		commandId: "dialog-2",
		originRevision: 2,
		type: "dialog.reveal",
		journalRef: "journal:0:1",
		receiverGeneration: 0,
		revealKey: "dialog.reveal:interaction-1:0",
		signal,
	}
}

describe("ProductionDialogAdapter", () => {
	it("persists prepare idempotently and reveals through the task view", async () => {
		const journal = new InMemoryConversationJournal()
		const taskView = new InMemoryTaskViewPort()
		const state = createInitialTaskState("task-1")
		const adapter = new ProductionDialogAdapter({ taskId: "task-1", journal, taskView, readState: () => state })

		await expect(adapter.prepare(prepare())).resolves.toMatchObject({
			journalRef: "journal:0:1",
			journalWatermark: { epoch: 0, seq: 1 },
			receiverGeneration: 0,
			disposition: "created",
		})
		await expect(adapter.prepare(prepare())).resolves.toMatchObject({ disposition: "existing" })
		await expect(adapter.reveal(reveal())).resolves.toEqual({ disposition: "revealed" })
		await expect(adapter.reveal(reveal())).resolves.toEqual({ disposition: "already_revealed" })
		expect(taskView.transient).toEqual([
			expect.objectContaining({
				taskId: "task-1",
				projection: expect.objectContaining({ kind: "dialog_reveal", interactionId: "interaction-1" }),
			}),
		])
	})
})
