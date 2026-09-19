import { describe, expect, it, vi } from "vitest"
import type { DialogCommand, TaskEvent } from "../../kernel"
import { DialogCommandExecutor } from "./DialogCommandExecutor"

const input = {
	commandId: "dialog-1",
	originRevision: 1,
	generation: 0,
	interactionId: "i-1",
	turnId: "turn-1",
	kind: "followup",
	presentationRef: "question:1",
	actionRules: [{ actionId: "reply", payloadPolicy: "draft" as const }],
}

function prepare(): Extract<DialogCommand, { type: "dialog.prepare" }> {
	return { ...input, type: "dialog.prepare" }
}

function reveal(): Extract<DialogCommand, { type: "dialog.reveal" }> {
	return {
		...input,
		commandId: "dialog-2",
		originRevision: 2,
		type: "dialog.reveal",
		journalRef: "journal:0:1",
		receiverGeneration: 4,
	}
}

describe("DialogCommandExecutor", () => {
	it("registers preparation before feedback and reveals only after the durable command arrives", async () => {
		const events: TaskEvent[] = []
		const port = {
			prepare: vi.fn(async () => ({ journalRef: "journal:0:1", receiverGeneration: 4 })),
			reveal: vi.fn(async () => undefined),
		}
		const executor = new DialogCommandExecutor(port, {
			submit: async (event) => (events.push(event), { kind: "accepted" as const }),
		})

		await executor.execute(prepare())
		await executor.execute(reveal())

		expect(port.prepare).toHaveBeenCalledWith(expect.objectContaining({ presentationRef: "question:1" }))
		expect(events).toEqual([
			expect.objectContaining({ type: "dialog.prepared", commandId: "dialog-1", journalRef: "journal:0:1" }),
			expect.objectContaining({ type: "dialog.presented", commandId: "dialog-2", interactionId: "i-1" }),
		])
	})

	it("dismisses a reveal whose presented feedback loses the causal race", async () => {
		const dismiss = vi.fn(async () => undefined)
		const executor = new DialogCommandExecutor(
			{
				prepare: async () => ({ journalRef: "journal:0:1", receiverGeneration: 4 }),
				reveal: async () => undefined,
				dismiss,
			},
			{ submit: async () => ({ kind: "rejected" as const }) },
		)
		await executor.execute(reveal())
		expect(dismiss).toHaveBeenCalledWith(
			expect.objectContaining({ interactionId: "i-1", reason: "presentation_feedback_rejected" }),
		)
	})

	it("sanitizes port failures and does not present after cancellation", async () => {
		const events: TaskEvent[] = []
		const executor = new DialogCommandExecutor(
			{
				prepare: async () => {
					const error = new Error("secret payload")
					error.name = "DialogBackendError"
					throw error
				},
				reveal: async ({ signal }) =>
					new Promise<void>((_, reject) =>
						signal.addEventListener("abort", () => reject(new Error("aborted")), { once: true }),
					),
			},
			{ submit: async (event) => (events.push(event), { kind: "accepted" as const }) },
		)
		await executor.execute(prepare())
		expect(events[0]).toMatchObject({ type: "dialog.failed", message: "dialog execution failed (DialogBackendError)" })

		const revealing = executor.execute(reveal())
		const order = { haltId: "halt-1", generation: 0, reason: "cancel" as const }
		executor.fence(order)
		executor.stop(order)
		await executor.drain(order)
		await revealing
		expect(events.some((event) => event.type === "dialog.presented")).toBe(false)
	})
})
