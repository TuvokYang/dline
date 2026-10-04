import { describe, expect, it } from "vitest"
import { createInitialTaskState, type TaskEvent, type TaskState } from "../kernel"
import type { EventSubmissionResult, RuntimeFacade } from "../runtime"
import { TaskCheckpointRestoreSuspension, TaskShell } from "./TaskShell"

class RecordingRuntime implements RuntimeFacade {
	readonly events: TaskEvent[] = []
	readonly durable: number[] = []
	readonly order: string[] = []
	released = 0
	private state: TaskState = createInitialTaskState("task-1")

	getState(): Readonly<TaskState> {
		return this.state
	}

	constructor(state?: Partial<TaskState>) {
		if (state) this.state = { ...this.state, ...state }
	}

	async submit(event: TaskEvent): Promise<EventSubmissionResult> {
		this.events.push(event)
		this.order.push(`submit:${event.type}`)
		this.state = { ...this.state, revision: this.state.revision + 1 }
		return {
			kind: "accepted",
			state: this.state,
			commands: [],
			receipt: { revision: this.state.revision, durable: Promise.resolve() },
		}
	}

	projectTransient(): void {}
	waitForDurable(revision: number): Promise<void> {
		this.durable.push(revision)
		return Promise.resolve()
	}
	waitForDomainCompletion(): Promise<void> {
		this.order.push("domain-complete")
		return Promise.resolve()
	}
	waitForQuiescence(): Promise<void> {
		this.order.push("quiescent")
		return Promise.resolve()
	}
	releaseRestoredCommands(): void {
		this.released += 1
		this.order.push("release-restored")
	}
}

describe("TaskShell", () => {
	it("maps one approval action through dialog acceptance before approval feedback", async () => {
		const runtime = new RecordingRuntime()
		const shell = new TaskShell(runtime, { rearm: async () => undefined, forceClose: () => undefined })
		await shell.respond({
			type: "approval.respond",
			taskId: "task-1",
			turnId: "turn-1",
			interactionId: "interaction-1",
			blockId: "block-1",
			stateRevision: 7,
			receiverGeneration: 2,
			approved: true,
		})
		expect(runtime.events).toEqual([
			expect.objectContaining({ type: "dialog.responded", actionId: "approve" }),
			expect.objectContaining({ type: "approval.responded", approved: true }),
		])
		expect(runtime.durable).toEqual([1])
	})

	it("offers a way back after a cancelled round, without claiming the session was restored", async () => {
		// Cancelling only pauses, but nothing planned the dialog that resumes it:
		// the footer showed neither Cancel nor Resume and the task was stuck.
		const runtime = new RecordingRuntime({ flow: { phase: "paused" } })
		const shell = new TaskShell(runtime, { rearm: async () => undefined, forceClose: () => undefined })

		await shell.cancel("halt-1")

		// `resume` is the kind reserved for a session that really was closed and
		// restored; a live cancellation must not borrow that claim.
		expect(runtime.events).toEqual([
			expect.objectContaining({ type: "user.cancel" }),
			expect.objectContaining({
				type: "dialog.requested",
				kind: "cancelled_resume",
				actionRules: [{ actionId: "resume", payloadPolicy: "draft" }],
			}),
		])
	})

	it("fails checkpoint restore closed when a halt participant is still timed out", async () => {
		const runtime = new RecordingRuntime({
			halt: {
				status: "stopping",
				generation: 1,
				haltId: "restore-1",
				target: "paused",
				pending: ["provider"],
				halted: [],
				failed: [],
				timedOut: ["provider"],
			},
		})
		const suspension = new TaskCheckpointRestoreSuspension(runtime)

		await expect(suspension.stopAndFence("restore-1")).rejects.toThrow("CheckpointRestoreHaltTimedOut:restore-1")
		expect(runtime.order).toEqual(["submit:user.cancel", "domain-complete"])
	})

	it("keeps restore fences installed without offering a cancelled-resume dialog", async () => {
		const runtime = new RecordingRuntime({ flow: { phase: "paused" } })
		const rearm = vi.fn(async () => undefined)
		const suspension = new TaskCheckpointRestoreSuspension(runtime, {
			settle: async () => {
				runtime.order.push("settle-queue")
			},
		})

		await suspension.stopAndFence("restore-1")

		expect(runtime.events.map((event) => event.type)).toEqual(["user.cancel"])
		expect(runtime.order).toEqual(["submit:user.cancel", "domain-complete", "quiescent", "settle-queue"])
		expect(rearm).not.toHaveBeenCalled()
	})

	it("settles retained queue facts after halt writers drain and before rearm", async () => {
		const runtime = new RecordingRuntime({ flow: { phase: "paused" } })
		const shell = new TaskShell(
			runtime,
			{
				rearm: async () => {
					runtime.order.push("rearm")
				},
				forceClose: () => undefined,
			},
			undefined,
			{
				settle: async () => {
					runtime.order.push("settle-queue")
				},
			},
		)

		await shell.cancel("halt-1")

		expect(runtime.order).toEqual([
			"submit:user.cancel",
			"domain-complete",
			"quiescent",
			"settle-queue",
			"rearm",
			"submit:dialog.requested",
		])
	})

	it("leaves a terminated task alone, because there is nothing to resume", async () => {
		const runtime = new RecordingRuntime({ flow: { phase: "running" } })
		const shell = new TaskShell(runtime, { rearm: async () => undefined, forceClose: () => undefined })

		await shell.terminate("halt-1")

		expect(runtime.events.map((event) => event.type)).toEqual(["user.terminate"])
	})

	it("does not displace a question the user still has to answer", async () => {
		const runtime = new RecordingRuntime({
			flow: { phase: "paused" },
			dialog: {
				primary: {
					interactionId: "ask-1",
					turnId: "turn-1",
					kind: "followup",
					status: "awaiting",
					createdRevision: 1,
					presentationRef: "question:1",
					actionRules: [],
				},
				approvalsByBlock: {},
			},
		})
		const shell = new TaskShell(runtime, { rearm: async () => undefined, forceClose: () => undefined })

		await shell.cancel("halt-1")

		expect(runtime.events.map((event) => event.type)).toEqual(["user.cancel"])
	})

	it("settles recovered queue facts before releasing held commands", async () => {
		const runtime = new RecordingRuntime()
		const shell = new TaskShell(runtime, { rearm: async () => undefined, forceClose: () => undefined }, undefined, {
			settle: async () => {
				runtime.order.push("settle-queue")
			},
		})

		expect(runtime.released).toBe(0)
		await shell.open()

		expect(runtime.released).toBe(1)
		expect(runtime.events.map((event) => event.type)).toEqual(["lifecycle.open"])
		expect(runtime.order).toEqual(["settle-queue", "release-restored", "submit:lifecycle.open"])
	})
})
