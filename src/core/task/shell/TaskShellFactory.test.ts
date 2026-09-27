import { describe, expect, it, vi } from "vitest"
import { createDeniedSurface } from "../executors/tool/ToolDomainSurface"
import { TurnToolScheduler } from "../executors/tool/TurnToolScheduler"
import { type Command, createInitialTaskState, type TaskState } from "../kernel"
import {
	InMemoryCommandPublicationStore,
	InMemoryConversationJournal,
	InMemoryStateVault,
	InMemoryTaskViewPort,
	type TaskPayloadStore,
} from "../stores"
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
		spawn: {
			prepare: async () => ({ admit: async () => ({ childTaskId: "child-1" }), dispose: async () => undefined }),
		},
	}
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
})
