import { describe, expect, it, vi } from "vitest"
import { RetainedInputJournalBatch } from "../executors/compose/RetainedInputJournalBatch"
import { createDeniedSurface } from "../executors/tool/ToolDomainSurface"
import { TurnToolScheduler } from "../executors/tool/TurnToolScheduler"
import {
	type Command,
	createInitialTaskState,
	type ProviderStartCommand,
	type TaskState,
	type TransitionResult,
	transition,
} from "../kernel"
import {
	InMemoryCommandPublicationStore,
	InMemoryConversationJournal,
	InMemoryStateVault,
	InMemoryTaskPayloadStore,
	InMemoryTaskViewPort,
	type TaskPayloadStore,
} from "../stores"
import { encodeTaskPayload } from "../stores/payload/TaskPayloadCodec"
import { openTaskShell } from "./TaskShellFactory"

const payloads: TaskPayloadStore = {
	put: async () => "payload:1",
	read: async () => new Uint8Array(),
}

function execution(reveal: () => void) {
	return {
		provider: { execution: { async *start() {} } },
		compose: { compose: async () => ({ draftRef: "draft:1" }) },
		compaction: { run: async () => ({ resultRef: "result:1" }) },
		dialog: {
			execution: {
				prepare: async () => ({
					journalRef: "journal:1",
					journalWatermark: { seq: 0 },
					receiverGeneration: 0,
					disposition: "existing" as const,
				}),
				reveal: async () => {
					reveal()
					return { disposition: "revealed" as const }
				},
			},
		},
		policy: { evaluate: async () => ({ approved: true }) },
		tool: {
			runner: { runBlock: async () => undefined, release: async () => undefined },
			surface: createDeniedSurface("detached_domain"),
			scheduler: new TurnToolScheduler({ readConfiguredLimit: () => undefined }),
		},
	}
}

function accepted(result: TransitionResult): Extract<TransitionResult, { kind: "accepted" }> {
	if (result.kind !== "accepted") throw new Error(result.diagnostic.message)
	return result
}

async function retainedCrashFixture() {
	const payloadStore = new InMemoryTaskPayloadStore()
	const journal = new InMemoryConversationJournal()
	const entries = await Promise.all(
		["A", "B"].map(async (text, index) => ({
			entryId: `retained-${index}`,
			payloadRef: await payloadStore.put(encodeTaskPayload({ kind: "user_input", text })),
		})),
	)
	const delivery = {
		deliveryId: "delivery-crash-1",
		point: "tool_round" as const,
		ownerId: "compose-crash-1",
		generation: 0,
	}
	const receipt = await new RetainedInputJournalBatch(payloadStore, journal).stage({
		deliveryId: delivery.deliveryId,
		entries,
		generation: 0,
		signal: new AbortController().signal,
	})
	const base = createInitialTaskState("task-1")
	const state: TaskState = {
		...base,
		revision: 5,
		flow: {
			phase: "running",
			compose: {
				commandId: delivery.ownerId,
				originRevision: 4,
				status: "completed",
				admittedEntryIds: entries.map((entry) => entry.entryId),
				queueJournalReceipt: {
					deliveryId: receipt.deliveryId,
					entries: receipt.entries,
					journalWatermark: receipt.watermark,
				},
			},
		},
		intake: {
			...base.intake,
			queued: entries.map((entry, sequence) => ({
				...entry,
				source: "user" as const,
				mode: "steering" as const,
				sequence,
				state: "included" as const,
				queue: { editing: false, delivery },
			})),
		},
	}
	const vault = new InMemoryStateVault()
	await vault.save({ state, outbox: [] })
	return {
		state,
		journal,
		payloads: payloadStore,
		persistence: { ports: { vault, journal, publications: new InMemoryCommandPublicationStore() }, payloads: payloadStore },
	}
}

function awaitingProvider(): { readonly state: TaskState; readonly command: ProviderStartCommand } {
	const submitted = accepted(
		transition(createInitialTaskState("task-1"), {
			type: "user.submit",
			generation: 0,
			entryId: "entry-1",
			payloadRef: "input:1",
		}),
	)
	const compose = submitted.commands.find((command) => command.type === "compose.round")
	if (compose?.type !== "compose.round") throw new Error("Missing compose command")
	const composed = accepted(
		transition(submitted.state, {
			type: "compose.completed",
			generation: compose.generation,
			commandId: compose.commandId,
			originRevision: compose.originRevision,
			turnId: "turn-1",
			draftRef: "draft:1",
		}),
	)
	const provider = composed.commands.find((command) => command.type === "provider.start")
	if (provider?.type !== "provider.start") throw new Error("Missing provider command")
	return { state: composed.state, command: provider }
}

/** A task stopped with a prepared question whose reveal was still in the outbox. */
async function preparedDialogTask() {
	const interaction = {
		interactionId: "interaction-1",
		turnId: "turn-1",
		kind: "question",
		status: "prepared" as const,
		createdRevision: 7,
		presentationRef: "question:1",
		actionRules: [],
		journalRef: "journal:1",
		journalWatermark: { seq: 1 },
		receiverGeneration: 0,
		prepareKey: "dialog.prepare:interaction-1",
		revealKey: "dialog.reveal:interaction-1:0",
	}
	const state: TaskState = {
		...createInitialTaskState("task-1"),
		revision: 8,
		journalWatermark: { seq: 1 },
		dialog: { primary: interaction, approvalsByBlock: {} },
	}
	const reveal: Command = {
		type: "dialog.reveal",
		commandId: "legacy-reveal",
		originRevision: 8,
		generation: 0,
		...interaction,
		revealKey: interaction.revealKey,
	}
	const vault = new InMemoryStateVault()
	await vault.save({ state, outbox: [reveal] })
	const journal = new InMemoryConversationJournal()
	await journal.append({ operationId: "dialog.prepare:interaction-1", payloadRef: "journal:1", source: "dialog" })
	return { ports: { vault, journal, publications: new InMemoryCommandPublicationStore() }, payloads }
}

describe("openTaskShell", () => {
	it("merges hydrate reveal and restored outbox into one replay owner", async () => {
		const revealed = vi.fn()
		const opened = await openTaskShell({
			taskId: "task-1",
			openReason: "crash_recovery",
			execution: execution(revealed),
			taskView: new InMemoryTaskViewPort(),
			persistence: await preparedDialogTask(),
		})
		expect(opened.kind).toBe("ready")
		await opened.runtime.waitForQuiescence()
		expect(revealed).toHaveBeenCalledTimes(1)
	})

	it("holds recovered commands until a window without the task lock opens the task", async () => {
		const revealed = vi.fn()
		const opened = await openTaskShell({
			taskId: "task-1",
			openReason: "crash_recovery",
			execution: execution(revealed),
			taskView: new InMemoryTaskViewPort(),
			persistence: await preparedDialogTask(),
			deferRestoredCommands: true,
		})
		await opened.runtime.waitForQuiescence()
		expect(revealed).not.toHaveBeenCalled()

		await opened.shell.open()
		await opened.runtime.waitForQuiescence()
		expect(revealed).toHaveBeenCalledTimes(1)

		// A second open (lock re-acquired after a later release) must not replay again.
		await opened.shell.open()
		await opened.runtime.waitForQuiescence()
		expect(revealed).toHaveBeenCalledTimes(1)
	})

	it("commits nothing for a window without the task lock until it opens the task", async () => {
		const opened = await openTaskShell({
			taskId: "task-1",
			openReason: "crash_recovery",
			execution: execution(vi.fn()),
			taskView: new InMemoryTaskViewPort(),
			persistence: await preparedDialogTask(),
			deferRestoredCommands: true,
		})
		const revision = opened.runtime.getState().revision

		const refused = await opened.shell.submitInput({ entryId: "entry-1", payloadRef: "input:1" })
		expect(refused).toMatchObject({ kind: "rejected", reason: "read_only", diagnostic: { code: "task_read_only" } })
		expect(await opened.shell.cancel("halt-1")).toMatchObject({ kind: "rejected", reason: "read_only" })
		expect(opened.runtime.getState().revision).toBe(revision)
		expect(opened.runtime.isWritable()).toBe(false)

		await opened.shell.open()
		expect(opened.runtime.isWritable()).toBe(true)
	})

	it("rebuilds a task whose unfinished work lost its payload and drops the stored commands", async () => {
		const missingRef = `sha256:${"a".repeat(64)}`
		const interaction = {
			interactionId: "interaction-1",
			turnId: "turn-1",
			kind: "question",
			status: "prepared" as const,
			createdRevision: 7,
			presentationRef: "question:1",
			actionRules: [],
			journalRef: "journal:1",
			receiverGeneration: 0,
			prepareKey: "dialog.prepare:interaction-1",
			revealKey: "dialog.reveal:interaction-1:0",
		}
		const state: TaskState = {
			...createInitialTaskState("task-1"),
			revision: 8,
			journalWatermark: { seq: 1 },
			flow: { phase: "running" },
			turn: {
				turnId: "turn-1",
				mode: "serial",
				blocks: [
					{
						blockId: "block-1",
						index: 0,
						phase: "ready",
						attempt: "attempt-1",
						lanes: [],
						turnEnding: false,
						invocationRef: missingRef,
					},
				],
				manualApprovalBlockIds: [],
				automaticApprovalBlockIds: [],
				executingBlockIds: [],
			},
			dialog: { primary: interaction, approvalsByBlock: {} },
		}
		const staleReveal: Command = {
			type: "dialog.reveal",
			commandId: "stale-reveal",
			originRevision: 8,
			generation: 0,
			...interaction,
		}
		const vault = new InMemoryStateVault()
		await vault.save({ state, outbox: [staleReveal] })
		const journal = new InMemoryConversationJournal()
		await journal.append({ operationId: "seed:1", payloadRef: "journal:1", source: "system" })
		const revealedInteractions: string[] = []
		const base = execution(() => undefined)
		const recorded: { code: string; severity?: string }[] = []

		const opened = await openTaskShell({
			taskId: "task-1",
			openReason: "crash_recovery",
			execution: {
				...base,
				dialog: {
					execution: {
						...base.dialog.execution,
						reveal: async (input: { readonly interactionId: string }) => {
							revealedInteractions.push(input.interactionId)
							return { disposition: "revealed" as const }
						},
					},
				},
			},
			taskView: new InMemoryTaskViewPort(),
			diagnostics: { record: (diagnostic) => recorded.push(diagnostic) },
			persistence: {
				ports: { vault, journal, publications: new InMemoryCommandPublicationStore() },
				payloads: {
					put: payloads.put,
					read: async (ref) => {
						if (ref === missingRef) throw new Error(`TaskPayloadNotFound: ${ref}`)
						return new Uint8Array()
					},
				},
			},
		})
		await opened.runtime.waitForQuiescence()

		expect(opened.form).toBe("interrupted")
		expect(opened.runtime.getState().dialog.primary).toMatchObject({ kind: "resume" })
		expect(revealedInteractions).not.toContain("interaction-1")
		expect(recorded).toContainEqual(expect.objectContaining({ code: "payload_missing", severity: "failure" }))
	})

	it("reports rebuilding a task that never had a snapshot as an observation", async () => {
		const journal = new InMemoryConversationJournal()
		await journal.append({ operationId: "seed:1", payloadRef: "journal:1", source: "system" })
		const recorded: { code: string; severity?: string }[] = []

		const opened = await openTaskShell({
			taskId: "task-1",
			openReason: "resume",
			execution: execution(() => undefined),
			taskView: new InMemoryTaskViewPort(),
			diagnostics: { record: (diagnostic) => recorded.push(diagnostic) },
			persistence: {
				ports: { vault: new InMemoryStateVault(), journal, publications: new InMemoryCommandPublicationStore() },
				payloads,
			},
		})

		expect(opened.form).toBe("interrupted")
		expect(recorded).toContainEqual(expect.objectContaining({ code: "snapshot_missing", severity: "observation" }))
		expect(recorded.filter((diagnostic) => diagnostic.severity === "failure")).toEqual([])
	})

	it("opens a task whose snapshot cannot be read", async () => {
		const recorded: { code: string; severity?: string }[] = []

		const opened = await openTaskShell({
			taskId: "task-1",
			openReason: "resume",
			execution: execution(() => undefined),
			taskView: new InMemoryTaskViewPort(),
			diagnostics: { record: (diagnostic) => recorded.push(diagnostic) },
			persistence: {
				ports: {
					vault: {
						load: async () => {
							throw new Error("InvalidTaskStateVault")
						},
						save: async () => undefined,
					},
					journal: new InMemoryConversationJournal(),
					publications: new InMemoryCommandPublicationStore(),
				},
				payloads,
			},
		})

		expect(opened.form).toBe("interrupted")
		expect(recorded.map((diagnostic) => diagnostic.code)).toEqual(
			expect.arrayContaining(["snapshot_unreadable", "snapshot_missing"]),
		)
		// The unreadable snapshot is the fault; rebuilding without it is the recovery.
		expect(recorded).toContainEqual(expect.objectContaining({ code: "snapshot_unreadable", severity: "failure" }))
	})

	it("retracts an unconsumed retained batch before hydrate and releases its canonical entries", async () => {
		const fixture = await retainedCrashFixture()
		const opened = await openTaskShell({
			taskId: "task-1",
			openReason: "crash_recovery",
			execution: execution(() => undefined),
			taskView: new InMemoryTaskViewPort(),
			persistence: fixture.persistence,
		})

		expect(
			opened.runtime.getState().intake.queued.map((entry) => ({ state: entry.state, delivery: entry.queue?.delivery })),
		).toEqual([
			{ state: "released", delivery: undefined },
			{ state: "released", delivery: undefined },
		])
		expect((await fixture.journal.project()).visibleMessages).toEqual([])
	})

	it("defers retained batch reconciliation until the window owns and opens the task", async () => {
		const fixture = await retainedCrashFixture()
		const opened = await openTaskShell({
			taskId: "task-1",
			openReason: "crash_recovery",
			execution: execution(() => undefined),
			taskView: new InMemoryTaskViewPort(),
			persistence: fixture.persistence,
			deferRestoredCommands: true,
		})

		expect(opened.runtime.getState().intake.queued.map((entry) => entry.state)).toEqual(["uncertain", "uncertain"])
		expect((await fixture.journal.project()).visibleMessages).toHaveLength(1)

		await opened.shell.open()
		await opened.runtime.waitForQuiescence()

		expect(
			opened.runtime.getState().intake.queued.map((entry) => ({ state: entry.state, delivery: entry.queue?.delivery })),
		).toEqual([
			{ state: "released", delivery: undefined },
			{ state: "released", delivery: undefined },
		])
		expect((await fixture.journal.project()).visibleMessages).toEqual([])
	})

	it("does not replay a provider command when its final journal entry is ahead of the snapshot", async () => {
		const { state, command } = awaitingProvider()
		const vault = new InMemoryStateVault()
		const journal = new InMemoryConversationJournal()
		const publications = new InMemoryCommandPublicationStore()
		await vault.save({ state, outbox: [command] })
		await journal.append({
			operationId: `provider.final:${command.commandId}`,
			payloadRef: "payload:final",
			source: "provider",
			causation: {
				commandId: command.commandId,
				originRevision: command.originRevision,
				generation: command.generation,
				turnId: command.turnId,
			},
		})

		const providerStart = vi.fn(() => ({
			async *[Symbol.asyncIterator]() {
				yield {
					kind: "final" as const,
					turnId: command.turnId ?? "turn-1",
					payloadRef: "payload:duplicate",
					turnPlan: { mode: "serial" as const, blocks: [] },
				}
			},
		}))
		const providerPresentation = {
			showPartial: vi.fn(),
			commit: vi.fn(async () => undefined),
		}
		const revealed = vi.fn()
		const opened = await openTaskShell({
			taskId: "task-1",
			openReason: "crash_recovery",
			execution: {
				...execution(revealed),
				provider: { execution: { start: providerStart }, presentation: providerPresentation },
			},
			taskView: new InMemoryTaskViewPort(),
			persistence: { ports: { vault, journal, publications }, payloads },
		})
		await opened.runtime.waitForQuiescence()

		expect(opened.form).toBe("interrupted")
		expect(opened.runtime.getState()).toMatchObject({
			generation: state.generation + 1,
			flow: { phase: "paused" },
		})
		expect(providerStart).not.toHaveBeenCalled()
		expect(providerPresentation.showPartial).not.toHaveBeenCalled()
		expect(providerPresentation.commit).not.toHaveBeenCalled()
		expect(await publications.has(command.commandId)).toBe(false)
		expect(
			(await journal.read()).filter((entry) => entry.operationId === `provider.final:${command.commandId}`),
		).toHaveLength(1)
		expect(revealed).toHaveBeenCalledTimes(1)
		expect(opened.runtime.getState().dialog.primary).toMatchObject({ kind: "resume", status: "awaiting" })
	})
})
