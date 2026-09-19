import { describe, expect, it } from "vitest"
import type { Command } from "../../../kernel"
import { InMemoryCommandPublicationStore, InMemoryStateVault, InMemoryTaskViewPort } from "../../../stores"
import { TaskRuntimeV2 } from "../TaskRuntimeV2"
import { ControlledVault, RecordingExecutor, runningState, tick } from "./support"

function runtime(vault: ControlledVault, executors: RecordingExecutor[]) {
	return new TaskRuntimeV2({
		initialState: runningState(),
		vault,
		taskView: new InMemoryTaskViewPort(),
		publications: new InMemoryCommandPublicationStore(),
		executors,
	})
}

describe("TaskRuntimeV2", () => {
	it("commits multiple events in memory without awaiting persistence or execution", async () => {
		const vault = new ControlledVault()
		const compose = new RecordingExecutor("compose")
		const subject = runtime(vault, [compose])
		const one = await subject.submit({ type: "user.submit", generation: 0, entryId: "e-1", payloadRef: "p-1" })
		const two = await subject.submit({ type: "user.submit", generation: 0, entryId: "e-2", payloadRef: "p-2" })

		expect(one.kind).toBe("accepted")
		expect(two.kind).toBe("accepted")
		expect(subject.getState().revision).toBe(2)
		await vault.waitForSaveCount(1)
		expect(vault.saves.map((snapshot) => snapshot.state.revision)).toEqual([1])
		expect(compose.commands).toEqual([])

		vault.resolve(0)
		await compose.waitForCommandCount(1)
		await vault.waitForSaveCount(2)
		expect(compose.commands.map((command) => command.originRevision)).toEqual([1])
		expect(vault.saves.map((snapshot) => snapshot.state.revision)).toEqual([1, 2])
		vault.resolve(1)
		await subject.waitForQuiescence()
		expect(compose.commands.map((command) => command.originRevision)).toEqual([1, 2])
	})

	it("routes dialog.prepare before durability and dialog.reveal after it", async () => {
		const vault = new ControlledVault()
		const dialog = new RecordingExecutor("dialog")
		const subject = runtime(vault, [dialog])
		const requested = await subject.submit({
			type: "dialog.requested",
			generation: 0,
			interactionId: "i-1",
			turnId: "turn-1",
			kind: "question",
			presentationRef: "question:1",
			actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
		})
		expect(requested.kind).toBe("accepted")
		await dialog.waitForCommandCount(1)
		expect(dialog.commands.map((command) => command.type)).toEqual(["dialog.prepare"])

		const prepared = await subject.submit({
			type: "dialog.prepared",
			generation: 0,
			interactionId: "i-1",
			journalRef: "j-1",
			receiverGeneration: 1,
		})
		expect(prepared.kind).toBe("accepted")
		expect(dialog.commands.map((command) => command.type)).toEqual(["dialog.prepare"])
		await vault.waitForSaveCount(1)
		vault.resolve(0)
		await vault.waitForSaveCount(2)
		vault.resolve(1)
		await subject.waitForQuiescence()
		expect(dialog.commands.map((command) => command.type)).toEqual(["dialog.prepare", "dialog.reveal"])
	})

	it("projects transient state immediately and waits for domain completion by revision", async () => {
		const view = new InMemoryTaskViewPort()
		const compose = new RecordingExecutor("compose", false)
		const subject = new TaskRuntimeV2({
			initialState: runningState(),
			vault: new InMemoryStateVault(),
			taskView: view,
			publications: new InMemoryCommandPublicationStore(),
			executors: [compose],
		})
		subject.projectTransient({ partial: "token" })
		expect(view.transient).toEqual([{ taskId: "task-1", projection: { partial: "token" } }])
		const submitted = await subject.submit({ type: "user.submit", generation: 0, entryId: "e-1", payloadRef: "p-1" })
		expect(submitted.kind).toBe("accepted")
		if (submitted.kind !== "accepted") return
		const waiting = subject.waitForDomainCompletion(submitted.receipt.revision)
		await compose.waitForCommandCount(1)
		let settled = false
		void waiting.then(() => (settled = true))
		await tick()
		expect(settled).toBe(false)
		compose.completions[0].resolve()
		await waiting
	})

	it("restores durable outbox commands once and skips them after publication", async () => {
		const publications = new InMemoryCommandPublicationStore()
		const providerCommand: Command = {
			commandId: "provider:1",
			originRevision: 1,
			generation: 0,
			type: "provider.start",
			draftRef: "draft-1",
		}
		const firstProvider = new RecordingExecutor("provider")
		const first = new TaskRuntimeV2({
			initialState: runningState(),
			vault: new InMemoryStateVault(),
			taskView: new InMemoryTaskViewPort(),
			publications,
			executors: [firstProvider],
			restoredOutbox: [providerCommand],
		})
		await first.waitForQuiescence()
		expect(firstProvider.commands).toEqual([providerCommand])

		const secondProvider = new RecordingExecutor("provider")
		const second = new TaskRuntimeV2({
			initialState: runningState(),
			vault: new InMemoryStateVault(),
			taskView: new InMemoryTaskViewPort(),
			publications,
			executors: [secondProvider],
			restoredOutbox: [providerCommand],
		})
		await second.waitForQuiescence()
		expect(secondProvider.commands).toEqual([])
	})

	it("persists a halt snapshot without older outbox work and dispatches halt immediately", async () => {
		const vault = new ControlledVault()
		const compose = new RecordingExecutor("compose")
		const halt = new RecordingExecutor("halt")
		const subject = runtime(vault, [compose, halt])
		await subject.submit({ type: "user.submit", generation: 0, entryId: "e-1", payloadRef: "p-1" })
		await subject.submit({ type: "user.cancel", generation: 0, haltId: "h-1" })
		await halt.waitForCommandCount(1)
		await vault.waitForSaveCount(1)
		expect(halt.commands).toHaveLength(1)
		expect(vault.saves[0].outbox.map((command) => command.type)).toEqual(["compose.round"])
		vault.resolve(0)
		await vault.waitForSaveCount(2)
		expect(vault.saves[1].outbox).toEqual([])
		expect(compose.commands).toEqual([])
		vault.resolve(1)
		await subject.waitForQuiescence()
	})
})
