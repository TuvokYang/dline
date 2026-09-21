import { describe, expect, it } from "vitest"
import { createInitialTaskState, type TaskEvent, type TaskState } from "../kernel"
import type { EventSubmissionResult, RuntimeFacade } from "../runtime"
import { TaskShell } from "./TaskShell"

class RecordingRuntime implements RuntimeFacade {
	readonly events: TaskEvent[] = []
	readonly durable: number[] = []
	private state: TaskState = createInitialTaskState("task-1")

	getState(): Readonly<TaskState> {
		return this.state
	}

	async submit(event: TaskEvent): Promise<EventSubmissionResult> {
		this.events.push(event)
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
		return Promise.resolve()
	}
	waitForQuiescence(): Promise<void> {
		return Promise.resolve()
	}
}

describe("TaskShell", () => {
	it("maps one approval action through dialog acceptance before approval feedback", async () => {
		const runtime = new RecordingRuntime()
		const shell = new TaskShell(runtime, { rearm: async () => undefined })
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
})
