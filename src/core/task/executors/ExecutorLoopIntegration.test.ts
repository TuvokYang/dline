import { describe, expect, it, vi } from "vitest"
import { createInitialTaskState, type TaskState } from "../kernel"
import { ALL_HALT_PARTICIPANTS } from "../kernel/machines/halt"
import { TaskRuntime } from "../runtime"
import { TaskShell } from "../shell/TaskShell"
import {
	InMemoryCommandPublicationStore,
	InMemoryConversationJournal,
	InMemoryStateVault,
	InMemoryTaskPayloadStore,
	InMemoryTaskViewPort,
} from "../stores"
import { decodeTaskPayload, encodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import type { ProviderDraftEnvelope, UserInputEnvelope } from "../stores/payload/TaskPayloadEnvelopes"
import { CompactionCommandExecutor } from "./compaction"
import { ComposeCommandExecutor } from "./compose"
import { ProductionComposeAdapter } from "./compose/ProductionComposeAdapter"
import { DialogCommandExecutor } from "./dialog"
import { CallbackHaltParticipant, HaltCommandExecutor } from "./halt"
import { PolicyCommandExecutor } from "./policy"
import { ProviderCommandExecutor } from "./provider"
import { SpawnCoordinator } from "./spawn"

describe("executor loop integration", () => {
	it("runs two compose to provider rounds through TaskRuntime", async () => {
		const vault = new InMemoryStateVault()
		const taskView = new InMemoryTaskViewPort()
		const journal = new InMemoryConversationJournal()
		const compose = vi.fn(async ({ admittedEntryIds }) => ({ draftRef: `draft:${admittedEntryIds.join(",")}` }))
		let turn = 0
		let runtime!: TaskRuntime
		// An event the kernel refuses is answered, not thrown, so a refused round
		// would otherwise be indistinguishable from the loop deciding to stop.
		const refusals: string[] = []
		const events = {
			submit: async (event: Parameters<TaskRuntime["submit"]>[0]) => {
				const result = await runtime.submit(event)
				if (result.kind === "rejected")
					refusals.push(`${event.type}:${result.diagnostic.code}:${result.diagnostic.message}`)
				return result
			},
		}
		const provider = vi.fn(({ draftRef }: { draftRef: string }) => ({
			async *[Symbol.asyncIterator]() {
				turn += 1
				yield {
					kind: "final" as const,
					turnId: `turn-${turn}`,
					payloadRef: `answer:${draftRef}`,
					turnPlan: { mode: "serial" as const, blocks: [] },
				}
			},
		}))
		// A command the runtime could not run is reported here rather than thrown,
		// so without this the loop would look like it simply chose to stop.
		const diagnostics: string[] = []
		runtime = new TaskRuntime({
			initialState: createInitialTaskState("task-1"),
			vault,
			taskView,
			publications: new InMemoryCommandPublicationStore(),
			diagnostics: { record: (entry) => void diagnostics.push(`${entry.source}:${entry.code}:${entry.message}`) },
			executors: [
				new ComposeCommandExecutor({ compose }, events),
				new ProviderCommandExecutor("task-1", { start: provider }, journal, taskView, events),
			],
		})

		await runtime.submit({ type: "user.submit", generation: 0, entryId: "entry-1", payloadRef: "input:1" })
		await runtime.waitForQuiescence()
		await runtime.submit({ type: "user.submit", generation: 0, entryId: "entry-2", payloadRef: "input:2" })
		// A round the kernel opens for itself can be scheduled as the previous one
		// settles, so one quiescence is not the end of the conversation. Draining
		// until no new round appears is what "the loop has stopped" actually means.
		await drainRounds(runtime, [compose, provider])

		// The text-only bound hands the task back through a mistake-limit dialog.
		// This loop registers no dialog executor, so that one dispatch is expected
		// to report itself; anything else the runtime could not run is a failure.
		const unexpectedDiagnostics = diagnostics.filter((entry) => !entry.includes("No command executor registered for dialog"))
		expect({ diagnostics: unexpectedDiagnostics, refusals }).toEqual({ diagnostics: [], refusals: [] })
		expect(runtime.getState().dialog.primary?.kind).toBe("mistake_limit")
		// Both submissions are carried by a round, each exactly once.
		const composedEntryIds = compose.mock.calls.flatMap(
			([input]) => (input as { admittedEntryIds: readonly string[] }).admittedEntryIds,
		)
		expect(composedEntryIds).toEqual(["entry-1", "entry-2"])
		// A turn that plans no tool continues on its own until the text-only streak
		// is exhausted, so these replies also produce rounds carrying no entry.
		// Asserting a fixed round count would encode the older behaviour where such
		// a turn simply ended the flow with nothing to run next.
		expect(compose.mock.calls.length).toBeGreaterThan(composedEntryIds.length)
		// Every composed round runs its turn, and every turn lands one journal entry.
		expect(provider).toHaveBeenCalledTimes(compose.mock.calls.length)
		expect(await journal.read()).toHaveLength(provider.mock.calls.length)
	})

	it("retracts a staged retained batch when removal wins before compose completion", async () => {
		const payloads = new InMemoryTaskPayloadStore()
		const journal = new InMemoryConversationJournal()
		const refs = await Promise.all(
			["A", "B"].map((text) => payloads.put(encodeTaskPayload<UserInputEnvelope>({ kind: "user_input", text }))),
		)
		const base = createInitialTaskState("task-1")
		const initialState: TaskState = {
			...base,
			flow: { phase: "running" },
			turn: {
				turnId: "turn-1",
				mode: "serial",
				blocks: [
					{
						blockId: "tool-1",
						attempt: "attempt-1",
						index: 0,
						phase: "executing",
						lanes: [],
						turnEnding: false,
						invocationRef: "invocation:1",
					},
				],
				manualApprovalBlockIds: [],
				automaticApprovalBlockIds: [],
				executingBlockIds: ["tool-1"],
			},
			intake: {
				...base.intake,
				queued: refs.map((payloadRef, sequence) => ({
					entryId: `retained-${sequence}`,
					payloadRef,
					source: "user" as const,
					mode: "steering" as const,
					sequence,
					state: "accepted" as const,
					queue: { editing: false },
				})),
			},
		}
		let releaseDraft!: () => void
		let announceDraft!: () => void
		const draftReached = new Promise<void>((resolve) => (announceDraft = resolve))
		const draftGate = new Promise<void>((resolve) => (releaseDraft = resolve))
		const put = payloads.put.bind(payloads)
		vi.spyOn(payloads, "put").mockImplementation(async (bytes) => {
			const payload = decodeTaskPayload<ProviderDraftEnvelope | UserInputEnvelope>(bytes)
			if (payload.kind === "provider_draft") {
				announceDraft()
				await draftGate
			}
			return put(bytes)
		})
		let runtime!: TaskRuntime
		const events = { submit: (event: Parameters<TaskRuntime["submit"]>[0]) => runtime.submit(event) }
		const adapter = new ProductionComposeAdapter({ payloads, journal, readState: () => runtime.getState() })
		const providerExecute = vi.fn(async () => undefined)
		runtime = new TaskRuntime({
			initialState,
			vault: new InMemoryStateVault(),
			taskView: new InMemoryTaskViewPort(),
			publications: new InMemoryCommandPublicationStore(),
			executors: [new ComposeCommandExecutor(adapter, events), { domain: "provider", execute: providerExecute }],
		})

		await runtime.submit({
			type: "tool.completed",
			generation: 0,
			turnId: "turn-1",
			blockId: "tool-1",
			attempt: "attempt-1",
		})
		await draftReached
		expect(runtime.getState().intake.queued.map((entry) => entry.state)).toEqual(["reserved", "reserved"])
		await runtime.submit({ type: "input_queue.removed", generation: 0, entryId: "retained-0" })
		releaseDraft()
		await runtime.waitForQuiescence()

		expect(providerExecute).not.toHaveBeenCalled()
		expect(runtime.getState()).toMatchObject({ flow: { phase: "waiting", compose: { status: "cancelled" } } })
		expect(runtime.getState().intake.queued).toEqual([
			expect.objectContaining({ entryId: "retained-1", state: "released", queue: { editing: false } }),
		])
		expect((await journal.project()).visibleMessages).toEqual([])
		expect((await journal.read()).map((entry) => entry.operationId)).toEqual([
			expect.stringMatching(/^intake\.retained:/),
			expect.stringMatching(/^intake\.retained\.retract:/),
		])
	})

	/** Settle the runtime until none of the watched executors is invoked again. */
	async function drainRounds(runtime: TaskRuntime, watched: readonly { mock: { calls: readonly unknown[] } }[]) {
		const counts = () => watched.map((spy) => spy.mock.calls.length).join(",")
		// The continuation is bounded by the text-only streak, so this terminates;
		// the cap only stops a runaway from hanging the suite.
		for (let attempt = 0; attempt < 20; attempt++) {
			const before = counts()
			await runtime.waitForQuiescence()
			if (counts() === before) return
		}
		throw new Error("Rounds never stopped being opened")
	}

	it("runs dialog prepare and reveal through the immediate/durable outbox phases", async () => {
		let runtime!: TaskRuntime
		const events = { submit: (event: Parameters<TaskRuntime["submit"]>[0]) => runtime.submit(event) }
		const reveal = vi.fn(async () => ({ disposition: "revealed" as const }))
		runtime = new TaskRuntime({
			initialState: { ...createInitialTaskState("task-1"), flow: { phase: "running" } },
			vault: new InMemoryStateVault(),
			taskView: new InMemoryTaskViewPort(),
			publications: new InMemoryCommandPublicationStore(),
			executors: [
				new DialogCommandExecutor(
					{
						prepare: async () => ({
							journalRef: "journal:1",
							journalWatermark: { seq: 1 },
							receiverGeneration: 0,
							disposition: "created" as const,
						}),
						reveal,
					},
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
		expect(runtime.getState().dialog.primary).toMatchObject({ status: "awaiting", journalRef: "journal:1" })
		expect(reveal).toHaveBeenCalledTimes(1)
	})

	it("runs policy evaluation and publishes the resulting tool command", async () => {
		let runtime!: TaskRuntime
		const toolCommands: string[] = []
		const events = { submit: (event: Parameters<TaskRuntime["submit"]>[0]) => runtime.submit(event) }
		runtime = new TaskRuntime({
			initialState: {
				...createInitialTaskState("task-1"),
				flow: { phase: "running" },
				turn: {
					turnId: "turn-1",
					mode: "parallel",
					blocks: [
						{
							blockId: "b1",
							index: 0,
							phase: "pending",
							attempt: "a1",
							invocationRef: "invocation:b1",
							lanes: [],
							turnEnding: false,
						},
					],
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

	it("returns a timed-out cancel without waiting forever and settles after the late drain", async () => {
		let runtime!: TaskRuntime
		let releaseProvider!: () => void
		const providerDrain = new Promise<void>((resolve) => (releaseProvider = resolve))
		const providerRearm = vi.fn()
		const events = { submit: (event: Parameters<TaskRuntime["submit"]>[0]) => runtime.submit(event) }
		const participants = ALL_HALT_PARTICIPANTS.map(
			(id) =>
				new CallbackHaltParticipant({
					id,
					fence: () => undefined,
					drain: id === "provider" ? () => providerDrain : async () => undefined,
					rearm: id === "provider" ? providerRearm : undefined,
				}),
		)
		const halt = new HaltCommandExecutor(participants, events, { timeoutMs: 5 })
		runtime = new TaskRuntime({
			initialState: { ...createInitialTaskState("task-1"), flow: { phase: "running" } },
			vault: new InMemoryStateVault(),
			taskView: new InMemoryTaskViewPort(),
			publications: new InMemoryCommandPublicationStore(),
			executors: [halt],
		})
		const shell = new TaskShell(runtime, halt)

		await expect(shell.cancel("halt-1")).resolves.toMatchObject({ kind: "accepted" })
		expect(runtime.getState().halt).toMatchObject({ status: "stopping", timedOut: ["provider"] })
		expect(providerRearm).not.toHaveBeenCalled()

		releaseProvider()
		await vi.waitFor(() => expect(runtime.getState().flow.phase).toBe("paused"))
		await vi.waitFor(() => expect(providerRearm).toHaveBeenCalledWith("halt-1"))
		await vi.waitFor(() => expect(runtime.getState().dialog.primary).toMatchObject({ kind: "cancelled_resume" }))
	})

	it("runs the nine-participant halt barrier and spawn lease through TaskRuntime", async () => {
		let runtime!: TaskRuntime
		const events = { submit: (event: Parameters<TaskRuntime["submit"]>[0]) => runtime.submit(event) }
		const participants = ALL_HALT_PARTICIPANTS.map(
			(id) => new CallbackHaltParticipant({ id, fence: () => undefined, drain: async () => undefined }),
		)
		runtime = new TaskRuntime({
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

	it("runs an attempt-scoped compaction command through TaskRuntime", async () => {
		let runtime!: TaskRuntime
		const events = { submit: (event: Parameters<TaskRuntime["submit"]>[0]) => runtime.submit(event) }
		runtime = new TaskRuntime({
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
