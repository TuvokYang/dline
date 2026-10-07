import type { ClineStorageMessage } from "@shared/messages"
import { describe, expect, it, vi } from "vitest"
import { BlockPhase } from "../../BlockPhaseMachine"
import { createTaskRuntimeState } from "../../runtime/TaskRuntimeState"
import { TaskPhase } from "../../TaskPhase"
import { createSnapshot, hydrateSnapshot } from "../../TaskSnapshot"
import { projectTaskView } from "../../view/TaskViewProjector"
import { ResumeCoordinator, type ResumeCoordinatorPorts } from "../ResumeCoordinator"
import type { ResumeInput } from "../ResumeInput"

function input(taskId = "task-1"): ResumeInput {
	const apiHistory: ClineStorageMessage[] = [{ role: "user", content: "task" }]
	return {
		taskId,
		snapshot: createSnapshot(
			createTaskRuntimeState({
				taskId,
				phase: TaskPhase.STREAMING,
				revision: 2,
				anchor: { apiIndex: 0 },
			}),
			100,
		),
		apiHistory,
		uiHistory: [],
		apiTail: [],
		uiTail: [],
		apiTailStartIndex: 1,
		apiHistoryLength: 1,
	}
}

function resolvingCompletionInput(taskId = "task-1"): ResumeInput {
	const interactionId = "completion-1"
	const turnId = "turn:completion-1"
	const apiHistory: ClineStorageMessage[] = [
		{ role: "user", content: "task" },
		{
			role: "assistant",
			content: [
				{
					type: "tool_use",
					name: "attempt_completion",
					input: { result: "done" },
					function_id: "fn-completion-1",
					dline_tid: interactionId,
				},
			],
		},
	]
	const state = createTaskRuntimeState({
		taskId,
		phase: TaskPhase.COMPLETED,
		revision: 5,
		anchor: { apiIndex: 1, turnId, interactionId, uiMessageTs: 205 },
	})
	state.turn = {
		turnId,
		assistantApiIndex: 1,
		mode: "serial",
		blocks: [
			{
				dlineTid: interactionId,
				functionId: "fn-completion-1",
				toolName: "attempt_completion",
				phase: BlockPhase.COMPLETED,
				ts: 200,
				requiresApproval: true,
				conversationHistoryIndex: 1,
			},
		],
	}
	state.interaction = {
		taskId,
		turnId,
		interactionId,
		kind: "completion",
		status: "resolving",
		createdRevision: 4,
		anchor: { messageTs: 205, messageType: "ask" },
		acceptedResponse: {
			taskId,
			turnId,
			interactionId,
			actionId: "reply",
			stateRevision: 5,
			draft: { text: "one more change", images: [], files: [] },
		},
	}
	state.completion = { completionId: interactionId }

	return {
		taskId,
		snapshot: createSnapshot(state, 206),
		apiHistory,
		uiHistory: [
			{
				ts: 205,
				type: "ask",
				ask: "completion_result",
				text: "{}",
				interactionId,
				conversationHistoryIndex: 1,
			},
		],
		apiTail: [],
		uiTail: [],
		apiTailStartIndex: 2,
		apiHistoryLength: 2,
	}
}

function ports(
	order: string[],
	load: ResumeCoordinatorPorts["load"] = vi.fn(async (taskId: string) => input(taskId)),
): ResumeCoordinatorPorts {
	return {
		load: async (taskId) => {
			order.push(`load:${taskId}`)
			return load(taskId)
		},
		presentInteraction: async (result) => {
			order.push(`present:${result.entry.type}`)
		},
		persist: async (result) => {
			order.push(`persist:${result.snapshot.phase}`)
		},
		hydrate: async (result) => {
			order.push(`hydrate:${result.snapshot.phase}`)
		},
		publishView: async (result) => {
			order.push(`publish:${result.entry.type}`)
		},
	}
}

describe("ResumeCoordinator", () => {
	it("only reconciles, persists, hydrates and publishes a stopped task", async () => {
		const order: string[] = []
		const result = await new ResumeCoordinator(ports(order)).prepare("task-1")

		expect(result.snapshot.phase).toBe(TaskPhase.PAUSED)
		expect(result.entry).toMatchObject({ type: "show_resume_interaction" })
		expect(order).toEqual([
			"load:task-1",
			"present:show_resume_interaction",
			"persist:paused",
			"hydrate:paused",
			"publish:show_resume_interaction",
		])
	})

	it("contains recovery observer failures", async () => {
		const order: string[] = []
		const coordinatorPorts = ports(order)
		coordinatorPorts.reportRecovery = () => {
			throw new Error("observer failed")
		}

		await expect(new ResumeCoordinator(coordinatorPorts).prepare("task-1")).resolves.toMatchObject({
			snapshot: { phase: TaskPhase.PAUSED },
		})
	})

	it("publishes the stopped interaction while ask persistence is still in flight", async () => {
		const order: string[] = []
		let releasePresentation!: () => void
		const presentationGate = new Promise<void>((resolve) => {
			releasePresentation = resolve
		})
		const coordinator = new ResumeCoordinator({
			...ports(order),
			presentInteraction: async (result) => {
				order.push(`present-start:${result.entry.type}`)
				await presentationGate
				order.push(`present-end:${result.entry.type}`)
			},
		})

		const preparation = coordinator.prepare("task-1")
		await vi.waitFor(() => expect(order).toContain("publish:show_resume_interaction"))

		expect(order).toEqual([
			"load:task-1",
			"present-start:show_resume_interaction",
			"persist:paused",
			"hydrate:paused",
			"publish:show_resume_interaction",
		])

		releasePresentation()
		await expect(preparation).resolves.toMatchObject({ snapshot: { phase: TaskPhase.PAUSED } })
		expect(order.at(-1)).toBe("present-end:show_resume_interaction")
	})

	it("publishes the stopped interaction while ordered snapshot persistence is still in flight", async () => {
		const order: string[] = []
		let releasePersistence!: () => void
		const persistenceGate = new Promise<void>((resolve) => {
			releasePersistence = resolve
		})
		const coordinator = new ResumeCoordinator({
			...ports(order),
			persist: async (result) => {
				order.push(`persist-start:${result.snapshot.phase}`)
				await persistenceGate
				order.push(`persist-end:${result.snapshot.phase}`)
			},
		})

		const preparation = coordinator.prepare("task-1")
		await vi.waitFor(() => expect(order).toContain("publish:show_resume_interaction"))

		expect(order).toEqual([
			"load:task-1",
			"present:show_resume_interaction",
			"persist-start:paused",
			"hydrate:paused",
			"publish:show_resume_interaction",
		])

		releasePersistence()
		await expect(preparation).resolves.toMatchObject({ snapshot: { phase: TaskPhase.PAUSED } })
		expect(order.at(-1)).toBe("persist-end:paused")
	})

	it("keeps the published interaction usable when its reconstructable snapshot refresh fails", async () => {
		const order: string[] = []
		const persistenceError = new Error("snapshot refresh failed")
		const reportPersistenceFailure = vi.fn()
		const coordinator = new ResumeCoordinator({
			...ports(order),
			persist: async () => {
				order.push("persist:start")
				throw persistenceError
			},
			reportPersistenceFailure,
		})

		await expect(coordinator.prepare("task-1")).resolves.toMatchObject({
			snapshot: { phase: TaskPhase.PAUSED },
		})

		expect(order).toEqual([
			"load:task-1",
			"present:show_resume_interaction",
			"persist:start",
			"hydrate:paused",
			"publish:show_resume_interaction",
		])
		expect(reportPersistenceFailure).toHaveBeenCalledWith(
			persistenceError,
			expect.objectContaining({ snapshot: expect.objectContaining({ phase: TaskPhase.PAUSED }) }),
		)
	})

	it("waits for both persistence writes after one fails", async () => {
		const order: string[] = []
		let releasePersistence!: () => void
		const persistenceGate = new Promise<void>((resolve) => {
			releasePersistence = resolve
		})
		const reportPersistenceFailure = vi.fn()
		const coordinator = new ResumeCoordinator({
			...ports(order),
			presentInteraction: async () => {
				throw new Error("interaction write failed")
			},
			persist: async () => {
				order.push("persist:start")
				await persistenceGate
				order.push("persist:end")
			},
			reportPersistenceFailure,
		})
		let finished = false

		const preparation = coordinator.prepare("task-1").finally(() => {
			finished = true
		})
		await vi.waitFor(() => expect(order).toContain("persist:start"))
		expect(finished).toBe(false)
		expect(reportPersistenceFailure).not.toHaveBeenCalled()

		releasePersistence()
		await expect(preparation).resolves.toMatchObject({ snapshot: { phase: TaskPhase.PAUSED } })
		expect(order).toContain("persist:end")
		expect(reportPersistenceFailure).toHaveBeenCalledOnce()
	})

	it("fences a preparation still loading before it can write or publish", async () => {
		const order: string[] = []
		let releaseLoad!: () => void
		const loadGate = new Promise<void>((resolve) => {
			releaseLoad = resolve
		})
		const coordinator = new ResumeCoordinator(
			ports(
				order,
				vi.fn(async (taskId: string) => {
					await loadGate
					return input(taskId)
				}),
			),
		)

		const preparation = coordinator.prepare("task-1")
		await vi.waitFor(() => expect(order).toEqual(["load:task-1"]))
		coordinator.fence()
		releaseLoad()

		await expect(preparation).rejects.toThrow("History preparation was superseded")
		await expect(coordinator.waitForIdle()).resolves.toBeUndefined()
		expect(order).toEqual(["load:task-1"])
	})

	it("reports a load aborted by the fence as superseded rather than a failed recovery", async () => {
		const order: string[] = []
		let rejectLoad!: (error: Error) => void
		const load = vi.fn(
			() =>
				new Promise<never>((_resolve, reject) => {
					rejectLoad = reject
				}),
		)
		const reportRecovery = vi.fn()
		const coordinatorPorts = ports(order, load)
		coordinatorPorts.reportRecovery = reportRecovery
		const coordinator = new ResumeCoordinator(coordinatorPorts)

		const preparation = coordinator.prepare("task-1")
		await vi.waitFor(() => expect(load).toHaveBeenCalledOnce())
		coordinator.fence()
		rejectLoad(new Error("task_detached"))

		await expect(preparation).rejects.toThrow("History preparation was superseded")
		expect(reportRecovery).not.toHaveBeenCalled()
	})

	it("drains admitted persistence before a fenced preparation settles", async () => {
		const order: string[] = []
		let releaseHydrate!: () => void
		let releasePersistence!: () => void
		const hydrateGate = new Promise<void>((resolve) => {
			releaseHydrate = resolve
		})
		const persistenceGate = new Promise<void>((resolve) => {
			releasePersistence = resolve
		})
		const coordinator = new ResumeCoordinator({
			...ports(order),
			persist: async () => {
				order.push("persist:start")
				await persistenceGate
				order.push("persist:end")
			},
			hydrate: async () => {
				order.push("hydrate:start")
				await hydrateGate
				order.push("hydrate:end")
			},
		})

		const preparation = coordinator.prepare("task-1")
		await vi.waitFor(() => expect(order).toContain("hydrate:start"))
		coordinator.fence()
		releaseHydrate()
		let idle = false
		const drained = coordinator.waitForIdle().then(() => {
			idle = true
		})
		await vi.waitFor(() => expect(order).toContain("hydrate:end"))
		expect(idle).toBe(false)
		releasePersistence()

		await expect(preparation).rejects.toThrow("History preparation was superseded")
		await drained
		expect(order).toContain("persist:end")
		expect(order.some((entry) => entry.startsWith("publish:"))).toBe(false)
	})

	it("coalesces concurrent preparation for the same task", async () => {
		const order: string[] = []
		let release!: () => void
		const gate = new Promise<void>((resolve) => {
			release = resolve
		})
		const load = vi.fn(async (taskId: string) => {
			await gate
			return input(taskId)
		})
		const coordinator = new ResumeCoordinator(ports(order, load))

		const first = coordinator.prepare("task-1")
		const second = coordinator.prepare("task-1")
		release()
		const [firstResult, secondResult] = await Promise.all([first, second])

		expect(firstResult).toBe(secondResult)
		expect(load).toHaveBeenCalledTimes(1)
	})

	it("keeps preparation transactions separate for different tasks", async () => {
		const order: string[] = []
		const load = vi.fn(async (taskId: string) => input(taskId))
		const coordinator = new ResumeCoordinator(ports(order, load))

		await Promise.all([coordinator.prepare("task-1"), coordinator.prepare("task-2")])

		expect(load).toHaveBeenCalledTimes(2)
		expect(order).toContain("load:task-1")
		expect(order).toContain("load:task-2")
	})

	it("clears a failed preparation so the task can be opened again", async () => {
		const order: string[] = []
		const load = vi
			.fn<ResumeCoordinatorPorts["load"]>()
			.mockRejectedValueOnce(new Error("transient read failure"))
			.mockResolvedValueOnce(input())
		const reportRecovery = vi.fn()
		const coordinatorPorts = ports(order, load)
		coordinatorPorts.reportRecovery = reportRecovery
		const coordinator = new ResumeCoordinator(coordinatorPorts)

		await expect(coordinator.prepare("task-1")).rejects.toThrow("transient read failure")
		expect(reportRecovery).toHaveBeenNthCalledWith(1, {
			source: "history_open",
			outcome: "failed",
			failureStage: "load",
			durationMs: expect.any(Number),
			diagnosticCodes: [],
			persistenceFailed: false,
		})
		await expect(coordinator.prepare("task-1")).resolves.toMatchObject({
			snapshot: { phase: TaskPhase.PAUSED },
		})
		expect(load).toHaveBeenCalledTimes(2)
	})

	it("rebuilds a missing snapshot while remaining stopped", async () => {
		const order: string[] = []
		const missingSnapshot: ResumeInput = {
			taskId: "task-1",
			apiHistory: [{ role: "user", content: "task" }],
			uiHistory: [],
			apiTail: [{ role: "user", content: "task" }],
			uiTail: [],
			apiTailStartIndex: 0,
			apiHistoryLength: 1,
		}
		const reportRecovery = vi.fn()
		const coordinatorPorts = ports(
			order,
			vi.fn(async () => missingSnapshot),
		)
		coordinatorPorts.reportRecovery = reportRecovery
		const result = await new ResumeCoordinator(coordinatorPorts).prepare("task-1")

		expect(result.snapshot.phase).toBe(TaskPhase.PAUSED)
		expect(result.diagnostics).toContainEqual({ code: "snapshot_rebuilt", reason: "missing" })
		expect(order).toEqual([
			"load:task-1",
			"present:show_resume_interaction",
			"persist:paused",
			"hydrate:paused",
			"publish:show_resume_interaction",
		])
		expect(reportRecovery).toHaveBeenCalledWith({
			source: "history_open",
			outcome: "rebuilt",
			entryType: "show_resume_interaction",
			durationMs: expect.any(Number),
			diagnosticCodes: ["snapshot_rebuilt"],
			persistenceFailed: false,
		})
		expect(reportRecovery.mock.calls[0]?.[0]).not.toHaveProperty("taskId")
	})

	it("reopens a resolving completion as feedback and Start New Task without executing", async () => {
		const order: string[] = []
		const result = await new ResumeCoordinator(
			ports(
				order,
				vi.fn(async () => resolvingCompletionInput()),
			),
		).prepare("task-1")
		const view = projectTaskView(hydrateSnapshot(result.snapshot))

		expect(result.entry).toEqual({
			type: "show_completion_interaction",
			turnId: "turn:completion-1",
			interactionId: "completion-1",
		})
		expect(result.snapshot).toMatchObject({
			phase: TaskPhase.COMPLETED,
			interaction: { kind: "completion", status: "awaiting" },
			completion: { completionId: "completion-1" },
		})
		expect(view.input).toMatchObject({ enabled: true, acceptsText: true, enterAction: "reply" })
		expect(view.footer.actions).toMatchObject([{ type: "start_new_task", label: "Start New Task" }])
		expect(order).toEqual([
			"load:task-1",
			"present:show_completion_interaction",
			"persist:completed",
			"hydrate:completed",
			"publish:show_completion_interaction",
		])
	})
})
