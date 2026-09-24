import { describe, expect, it, vi } from "vitest"
import { InMemoryToolApprovalFeedbackLedger } from "../executors/tool/ToolApprovalFeedbackLedger"
import { createInitialTaskState } from "../kernel"
import type { MessageStateHandler } from "../message-state"
import type { Task } from "../shell/Task"
import type { TaskExecutorAssembly } from "../shell/TaskExecutorAssembly"
import type { TaskPayloadStore } from "../stores"
import { ActiveTaskSession } from "./ActiveTaskSession"
import { TaskInputMaterializer } from "./TaskInputMaterializer"
import type { TaskSessionOwners } from "./TaskSessionOwners"

function createOwners(): TaskSessionOwners {
	return { messages: {} as MessageStateHandler } as TaskSessionOwners
}

function createConversation() {
	// The port returns the source with the span it fixes; an empty conversation has no span.
	return { read: async () => ({ messages: [] }) }
}

describe("ActiveTaskSession", () => {
	it("keeps state/query ownership outside the six-use-case Task facade", () => {
		const task = { taskId: "task-1", terminate: vi.fn() } as unknown as Task
		const payloads = { put: vi.fn(), read: vi.fn() } as unknown as TaskPayloadStore
		const inputs = new TaskInputMaterializer(payloads, { nextEntryId: () => "entry-1", nextSequence: () => 0 })
		const state = createInitialTaskState("task-1")
		const session = new ActiveTaskSession({
			task,
			readState: () => state,
			assembly: {} as TaskExecutorAssembly,
			payloads,
			inputs,
			owners: createOwners(),
			approvalFeedback: new InMemoryToolApprovalFeedbackLedger(),
			conversation: createConversation(),
		})

		expect(session.state()).toBe(state)
		expect(session.projectView()).toMatchObject({ taskId: "task-1", terminal: "active" })
		expect(session.task).toBe(task)
	})

	it("terminates once and releases owned resources in reverse acquisition order", async () => {
		const order: string[] = []
		const terminate = vi.fn(async () => {
			order.push("terminate")
		})
		const task = { taskId: "task-1", terminate } as unknown as Task
		const payloads = { put: vi.fn(), read: vi.fn() } as unknown as TaskPayloadStore
		const session = new ActiveTaskSession({
			task,
			readState: () => createInitialTaskState("task-1"),
			assembly: {} as TaskExecutorAssembly,
			payloads,
			inputs: new TaskInputMaterializer(payloads, { nextEntryId: () => "entry-1", nextSequence: () => 0 }),
			owners: createOwners(),
			approvalFeedback: new InMemoryToolApprovalFeedbackLedger(),
			conversation: createConversation(),
			releases: [{ release: async () => void order.push("first") }, { release: async () => void order.push("second") }],
		})

		await Promise.all([session.dispose("halt-1"), session.dispose("halt-2")])

		expect(terminate).toHaveBeenCalledExactlyOnceWith("halt-1")
		expect(order).toEqual(["terminate", "second", "first"])
	})
})
