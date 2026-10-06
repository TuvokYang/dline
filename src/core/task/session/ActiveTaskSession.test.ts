import { describe, expect, it, vi } from "vitest"
import { InMemoryToolApprovalFeedbackLedger } from "../executors/tool/ToolApprovalFeedbackLedger"
import { createInitialTaskState } from "../kernel"
import type { MessageStateHandler } from "../message-state"
import type { Task } from "../shell/Task"
import type { TaskExecutorAssembly } from "../shell/TaskExecutorAssembly"
import type { TaskPayloadStore } from "../stores"
import { ActiveTaskSession } from "./ActiveTaskSession"
import type { InputQueueApplicationPort } from "./InputQueueApplicationPort"
import type { TaskInputAdmissionPort } from "./TaskInputAdmission"
import { TaskInputMaterializer } from "./TaskInputMaterializer"
import type { TaskSessionOwners } from "./TaskSessionOwners"

function createOwners(): TaskSessionOwners {
	return {
		identity: { taskId: "task-1", taskIncarnationId: "incarnation-1" },
		messages: {} as MessageStateHandler,
		interactions: { anchorStagedCompletion: vi.fn(async () => undefined) },
	} as unknown as TaskSessionOwners
}

function createConversation() {
	// The port returns the source with the span it fixes; an empty conversation has no span.
	return { read: async () => ({ messages: [] }) }
}

function createInputQueue(): InputQueueApplicationPort {
	return { mutate: vi.fn(), project: vi.fn(async () => []), onTurnEndAwaiting: vi.fn() }
}

const admittingPlainText: TaskInputAdmissionPort = {
	admit: async (input) => ({
		ok: true,
		admitted: {
			document: {
				schemaVersion: 1,
				parserVersion: "test",
				catalogRevision: "test",
				documentId: "test-input",
				rawText: input.text ?? "",
				nodes: [{ kind: "text", text: input.text ?? "" }],
				resources: [],
			},
			admittedText: input.text ?? "",
			authorizedTools: [],
			explicitInstructions: [],
		},
	}),
}

function createInputs(payloads: TaskPayloadStore): TaskInputMaterializer {
	return new TaskInputMaterializer(payloads, { nextEntryId: () => "entry-1", nextSequence: () => 0 }, admittingPlainText)
}

describe("ActiveTaskSession", () => {
	it("keeps state/query ownership outside the six-use-case Task facade", () => {
		const task = { taskId: "task-1", terminate: vi.fn() } as unknown as Task
		const payloads = { put: vi.fn(), read: vi.fn() } as unknown as TaskPayloadStore
		const inputs = createInputs(payloads)
		const state = createInitialTaskState("task-1")
		const session = new ActiveTaskSession({
			task,
			checkpointRestore: {} as never,
			readState: () => state,
			assembly: {} as TaskExecutorAssembly,
			payloads,
			inputs,
			inputQueue: createInputQueue(),
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
			checkpointRestore: {} as never,
			readState: () => createInitialTaskState("task-1"),
			assembly: {} as TaskExecutorAssembly,
			payloads,
			inputs: createInputs(payloads),
			inputQueue: createInputQueue(),
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
			checkpointRestore: {} as never,
			readState: () => createInitialTaskState("task-1"),
			assembly: {} as TaskExecutorAssembly,
			payloads,
			inputs: createInputs(payloads),
			inputQueue: createInputQueue(),
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

	it("releases a checkpoint-fenced session without terminating over the restored vault", async () => {
		const order: string[] = []
		const state = createInitialTaskState("task-1")
		const stopAndFence = vi.fn(async () => ({
			kind: "accepted" as const,
			state,
			commands: [],
			receipt: { revision: state.revision, durable: Promise.resolve() },
		}))
		const terminate = vi.fn(async () => void order.push("terminate"))
		const payloads = { put: vi.fn(), read: vi.fn() } as unknown as TaskPayloadStore
		const session = new ActiveTaskSession({
			task: { taskId: "task-1", terminate } as unknown as Task,
			checkpointRestore: { stopAndFence },
			readState: () => state,
			assembly: {} as TaskExecutorAssembly,
			payloads,
			inputs: createInputs(payloads),
			inputQueue: createInputQueue(),
			owners: createOwners(),
			approvalFeedback: new InMemoryToolApprovalFeedbackLedger(),
			conversation: createConversation(),
			releases: [{ release: async () => void order.push("first") }, { release: async () => void order.push("second") }],
		})

		const fence = await session.stopForCheckpointRestore("restore-1")
		await Promise.all([session.disposeAfterCheckpointRestore(fence), session.disposeAfterCheckpointRestore(fence)])

		expect(stopAndFence).toHaveBeenCalledExactlyOnceWith("restore-1")
		expect(terminate).not.toHaveBeenCalled()
		expect(order).toEqual(["second", "first"])
		await expect(session.dispose("ordinary-halt")).rejects.toThrow("TaskSessionCheckpointRestoreDisposal")
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
			checkpointRestore: {} as never,
			readState: () => createInitialTaskState("task-1"),
			assembly: {} as TaskExecutorAssembly,
			payloads,
			inputs: createInputs(payloads),
			inputQueue: createInputQueue(),
			owners: createOwners(),
			approvalFeedback: new InMemoryToolApprovalFeedbackLedger(),
			conversation: createConversation(),
			releases: [{ release }],
		})

		await expect(session.dispose("halt-1")).rejects.toBe(failure)
		expect(release).not.toHaveBeenCalled()
	})
})
