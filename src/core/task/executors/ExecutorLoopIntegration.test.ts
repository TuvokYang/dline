import { describe, expect, it, vi } from "vitest"
import { createInitialTaskState } from "../kernel"
import { ALL_HALT_PARTICIPANTS } from "../kernel/machines/halt"
import { TaskRuntimeV2 } from "../runtime/v2"
import { InMemoryCommandPublicationStore, InMemoryConversationJournal, InMemoryStateVault, InMemoryTaskViewPort } from "../stores"
import { CompactionCommandExecutor } from "./compaction"
import { ComposeCommandExecutor } from "./compose"
import { DialogCommandExecutor } from "./dialog"
import { CallbackHaltParticipant, HaltCommandExecutor } from "./halt"
import { PolicyCommandExecutor } from "./policy"
import { ProviderCommandExecutor } from "./provider"
import { SpawnCoordinator } from "./spawn"

describe("executor loop integration", () => {
	it("runs two compose to provider rounds through TaskRuntimeV2", async () => {
		const vault = new InMemoryStateVault()
		const taskView = new InMemoryTaskViewPort()
		const journal = new InMemoryConversationJournal()
		const compose = vi.fn(async ({ admittedEntryIds }) => ({ draftRef: `draft:${admittedEntryIds.join(",")}` }))
		let turn = 0
		let runtime!: TaskRuntimeV2
		const events = { submit: (event: Parameters<TaskRuntimeV2["submit"]>[0]) => runtime.submit(event) }
		const provider = vi.fn(({ draftRef }: { draftRef: string }) => ({
			async *[Symbol.asyncIterator]() {
				turn += 1
				yield { kind: "final" as const, turnId: `turn-${turn}`, payloadRef: `answer:${draftRef}` }
			},
		}))
		runtime = new TaskRuntimeV2({
			initialState: createInitialTaskState("task-1"),
			vault,
			taskView,
			publications: new InMemoryCommandPublicationStore(),
			executors: [
				new ComposeCommandExecutor({ compose }, events),
				new ProviderCommandExecutor("task-1", { start: provider }, journal, taskView, events),
			],
		})

		await runtime.submit({ type: "user.submit", generation: 0, entryId: "entry-1", payloadRef: "input:1" })
		await runtime.waitForQuiescence()
		await runtime.submit({ type: "user.submit", generation: 0, entryId: "entry-2", payloadRef: "input:2" })
		await runtime.waitForQuiescence()

		expect(compose).toHaveBeenCalledTimes(2)
		expect(provider).toHaveBeenCalledTimes(2)
		expect(await journal.read()).toHaveLength(2)
		expect(runtime.getState().flow.phase).toBe("running")
	})

	it("runs dialog prepare and reveal through the immediate/durable outbox phases", async () => {
		let runtime!: TaskRuntimeV2
		const events = { submit: (event: Parameters<TaskRuntimeV2["submit"]>[0]) => runtime.submit(event) }
		const reveal = vi.fn(async () => undefined)
		runtime = new TaskRuntimeV2({
			initialState: { ...createInitialTaskState("task-1"), flow: { phase: "running" } },
			vault: new InMemoryStateVault(),
			taskView: new InMemoryTaskViewPort(),
			publications: new InMemoryCommandPublicationStore(),
			executors: [
				new DialogCommandExecutor(
					{ prepare: async () => ({ journalRef: "journal:0:1", receiverGeneration: 0 }), reveal },
					events,
				),
			],
		})
		await runtime.submit({
			type: "dialog.requested",
			generation: 0,
			interactionId: "i-1",
			turnId: "turn-1",
			kind: "followup",
			presentationRef: "question:1",
			actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
		})
		await runtime.waitForQuiescence()
		expect(runtime.getState().dialog.primary).toMatchObject({ status: "awaiting", journalRef: "journal:0:1" })
		expect(reveal).toHaveBeenCalledTimes(1)
	})

	it("runs policy evaluation and publishes the resulting tool command", async () => {
		let runtime!: TaskRuntimeV2
		const toolCommands: string[] = []
		const events = { submit: (event: Parameters<TaskRuntimeV2["submit"]>[0]) => runtime.submit(event) }
		runtime = new TaskRuntimeV2({
			initialState: {
				...createInitialTaskState("task-1"),
				flow: { phase: "running" },
				turn: {
					turnId: "turn-1",
					mode: "parallel",
					blocks: [{ blockId: "b1", index: 0, phase: "pending", attempt: "a1", lanes: [], turnEnding: false }],
					manualApprovalBlockIds: [],
					automaticApprovalBlockIds: [],
					executingBlockIds: [],
				},
			},
			vault: new InMemoryStateVault(),
			taskView: new InMemoryTaskViewPort(),
			publications: new InMemoryCommandPublicationStore(),
			executors: [
				new PolicyCommandExecutor({ evaluate: async () => ({ approved: true }) }, events),
				{ domain: "tool", execute: async (command) => void toolCommands.push(command.type) },
			],
		})
		await runtime.submit({
			type: "approval.evaluation_requested",
			generation: 0,
			turnId: "turn-1",
			blockId: "b1",
			attempt: "a1",
			interactionId: "policy:b1",
			policyRevision: 1,
			riskFacts: {},
		})
		await runtime.waitForQuiescence()
		expect(runtime.getState().turn.blocks[0]).toMatchObject({ phase: "ready", policy: { status: "completed" } })
		expect(toolCommands).toEqual(["tool.run"])
	})

	it("runs the nine-participant halt barrier and spawn lease through TaskRuntimeV2", async () => {
		let runtime!: TaskRuntimeV2
		const events = { submit: (event: Parameters<TaskRuntimeV2["submit"]>[0]) => runtime.submit(event) }
		const participants = ALL_HALT_PARTICIPANTS.map(
			(id) => new CallbackHaltParticipant({ id, fence: () => undefined, drain: async () => undefined }),
		)
		runtime = new TaskRuntimeV2({
			initialState: { ...createInitialTaskState("task-1"), flow: { phase: "running" } },
			vault: new InMemoryStateVault(),
			taskView: new InMemoryTaskViewPort(),
			publications: new InMemoryCommandPublicationStore(),
			executors: [
				new HaltCommandExecutor(participants, events),
				new SpawnCoordinator(
					{
						prepare: async () => ({
							admit: async () => ({ childTaskId: "child-1" }),
							dispose: async () => undefined,
						}),
					},
					events,
				),
			],
		})
		await runtime.submit({
			type: "lifecycle.spawn_requested",
			generation: 0,
			spawnAttempt: "spawn-1",
			handoffRef: "handoff:1",
		})
		await runtime.waitForQuiescence()
		expect(runtime.getState().flow.spawn).toMatchObject({ status: "completed", childTaskId: "child-1" })
		await runtime.submit({ type: "user.cancel", generation: 0, haltId: "halt-1" })
		await runtime.waitForQuiescence()
		expect(runtime.getState().flow.phase).toBe("paused")
	})

	it("runs an attempt-scoped compaction command through TaskRuntimeV2", async () => {
		let runtime!: TaskRuntimeV2
		const events = { submit: (event: Parameters<TaskRuntimeV2["submit"]>[0]) => runtime.submit(event) }
		runtime = new TaskRuntimeV2({
			initialState: createInitialTaskState("task-1"),
			vault: new InMemoryStateVault(),
			taskView: new InMemoryTaskViewPort(),
			publications: new InMemoryCommandPublicationStore(),
			executors: [new CompactionCommandExecutor({ run: vi.fn(async () => ({ resultRef: "summary:1" })) }, events)],
		})
		await runtime.submit({
			type: "compaction.requested",
			generation: 0,
			compactionId: "compact-1",
			attempt: "attempt-1",
			contextRef: "auto:ctx",
		})
		await runtime.waitForQuiescence()
		expect(runtime.getState().flow.compaction).toMatchObject({ status: "completed", resultRef: "summary:1" })
	})
})
