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

	it("attempts every release after termination, preserving all cleanup failures", async () => {
		const order: string[] = []
		const failures = [new Error("last owner failed"), new Error("first owner failed")]
		const terminate = vi.fn(async () => void order.push("terminate"))
		const payloads = { put: vi.fn(), read: vi.fn() } as unknown as TaskPayloadStore
		const session = new ActiveTaskSession({
			task: { taskId: "task-1", terminate } as unknown as Task,
			readState: () => createInitialTaskState("task-1"),
			assembly: {} as TaskExecutorAssembly,
			payloads,
			inputs: new TaskInputMaterializer(payloads, { nextEntryId: () => "entry-1", nextSequence: () => 0 }),
			owners: createOwners(),
			approvalFeedback: new InMemoryToolApprovalFeedbackLedger(),
			conversation: createConversation(),
			releases: [
				{
					release: async () => {
						order.push("first")
						throw failures[1]
					},
				},
				{ release: async () => void order.push("middle") },
				{
					release: async () => {
						order.push("last")
						throw failures[0]
					},
				},
			],
		})

		const result = await session.dispose("halt-1").catch((error: unknown) => error)
		expect(result).toBeInstanceOf(AggregateError)
		expect((result as AggregateError).errors).toEqual(failures)
		expect(order).toEqual(["terminate", "last", "middle", "first"])
		await expect(session.dispose("halt-2")).rejects.toBe(result)
		expect(terminate).toHaveBeenCalledOnce()
		expect(order).toHaveLength(4)
	})

	it("keeps resources owned when task termination fails before quiescence", async () => {
		const failure = new Error("task did not quiesce")
		const release = vi.fn(async () => undefined)
		const terminate = vi.fn(async () => {
			throw failure
		})
		const payloads = { put: vi.fn(), read: vi.fn() } as unknown as TaskPayloadStore
		const session = new ActiveTaskSession({
			task: { taskId: "task-1", terminate } as unknown as Task,
			readState: () => createInitialTaskState("task-1"),
			assembly: {} as TaskExecutorAssembly,
			payloads,
			inputs: new TaskInputMaterializer(payloads, { nextEntryId: () => "entry-1", nextSequence: () => 0 }),
			owners: createOwners(),
			approvalFeedback: new InMemoryToolApprovalFeedbackLedger(),
			conversation: createConversation(),
			releases: [{ release }],
		})

		await expect(session.dispose("halt-1")).rejects.toBe(failure)
		expect(release).not.toHaveBeenCalled()
	})
})
