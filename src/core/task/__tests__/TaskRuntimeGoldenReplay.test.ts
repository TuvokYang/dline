import { readFileSync } from "node:fs"
import path from "node:path"
import { describe, expect, it, vi } from "vitest"
import { hydrate } from "../kernel/hydrate"
import { transition } from "../kernel/transition"
import {
	createInitialTaskState,
	type DialogInteraction,
	type TaskEvent,
	type TaskState,
	type TransitionResult,
} from "../kernel/types"
import { type CheckpointRestorePorts, restoreCheckpoint } from "../shell/checkpoint-restore"

interface GoldenScenario {
	readonly id: string
	readonly expected: Readonly<Record<string, unknown>>
}

interface GoldenArchive {
	readonly schema: string
	readonly scenarios: readonly GoldenScenario[]
}

const GOLDEN_PATH = path.resolve(__dirname, "../kernel/__fixtures__/task-runtime-legacy-golden.json")
const golden = JSON.parse(readFileSync(GOLDEN_PATH, "utf8")) as GoldenArchive

function expected(id: string): Readonly<Record<string, unknown>> {
	const scenario = golden.scenarios.find((candidate) => candidate.id === id)
	if (!scenario) throw new Error(`Missing frozen golden scenario ${id}`)
	return scenario.expected
}

function accepted(result: TransitionResult): Extract<TransitionResult, { kind: "accepted" }> {
	expect(result.kind).toBe("accepted")
	if (result.kind !== "accepted") throw new Error(result.diagnostic.message)
	return result
}

function runningState(): TaskState {
	const initial = createInitialTaskState("task-1")
	return {
		...initial,
		flow: { phase: "running" },
		turn: {
			turnId: "turn-1",
			mode: "serial",
			blocks: [],
			manualApprovalBlockIds: [],
			automaticApprovalBlockIds: [],
			executingBlockIds: [],
		},
	}
}

function findInteraction(state: TaskState, interactionId: string): DialogInteraction | undefined {
	if (state.dialog.primary?.interactionId === interactionId) return state.dialog.primary
	return Object.values(state.dialog.approvalsByBlock).find((interaction) => interaction.interactionId === interactionId)
}

function prepareAndPresent(state: TaskState, interactionId: string, journalRef: string): TaskState {
	const prepare = findInteraction(state, interactionId)?.prepare
	if (!prepare) throw new Error(`Missing prepare owner for ${interactionId}`)
	const prepared = accepted(
		transition(state, {
			type: "dialog.prepared",
			generation: state.generation,
			commandId: prepare.commandId,
			originRevision: prepare.originRevision,
			interactionId,
			journalRef,
			receiverGeneration: 7,
		}),
	)
	const reveal = prepared.commands[0]
	if (reveal?.type !== "dialog.reveal") throw new Error(`Missing reveal command for ${interactionId}`)
	return accepted(
		transition(prepared.state, {
			type: "dialog.presented",
			generation: prepared.state.generation,
			commandId: reveal.commandId,
			originRevision: reveal.originRevision,
			interactionId,
		}),
	).state
}

function openQuestion(state: TaskState, interactionId = "primary"): TaskState {
	const requested = accepted(
		transition(state, {
			type: "dialog.requested",
			generation: state.generation,
			interactionId,
			turnId: "turn-1",
			kind: "followup",
			presentationRef: `question:${interactionId}`,
			actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
		}),
	)
	return prepareAndPresent(requested.state, interactionId, "journal:1")
}

function reply(
	state: TaskState,
	overrides: Partial<Extract<TaskEvent, { type: "dialog.responded" }>> = {},
): Extract<TaskEvent, { type: "dialog.responded" }> {
	return {
		type: "dialog.responded",
		generation: state.generation,
		taskId: state.taskId,
		turnId: "turn-1",
		interactionId: "primary",
		stateRevision: state.revision,
		receiverGeneration: 7,
		actionId: "reply",
		draftRef: "draft:1",
		...overrides,
	}
}

function prepared(kind: string): DialogInteraction {
	return {
		interactionId: `${kind}:1`,
		turnId: "turn-1",
		kind,
		status: "prepared",
		createdRevision: 1,
		presentationRef: `${kind}:presentation`,
		actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
		journalRef: "journal:2",
		receiverGeneration: 0,
	}
}

function hydrateBase(): TaskState {
	return {
		...runningState(),
		revision: 4,
	}
}

function replayHydrate(snapshot: TaskState) {
	const result = hydrate({ taskId: "task-1", snapshot, journalTail: { seq: 10 }, openReason: "crash_recovery" })
	return {
		form: result.form,
		flow: result.state.flow.phase,
		commands: result.initialCommands.map((command) => command.type),
		automatic_execution: false,
	}
}

function checkpointPorts(snapshot: TaskState): CheckpointRestorePorts & { readonly calls: string[]; saved?: unknown } {
	const calls: string[] = []
	let saved: unknown
	return {
		calls,
		get saved() {
			return saved
		},
		stopAndFence: vi.fn(async () => void calls.push("stop")),
		resolve: vi.fn(async () => {
			calls.push("resolve")
			return { snapshot, boundary: { seq: 4 }, workspaceRef: "workspace:1" }
		}),
		restoreWorkspace: vi.fn(async () => {
			calls.push("workspace")
			return { ok: true } as const
		}),
		applyConversationBoundary: vi.fn(async (boundary) => {
			calls.push("conversation")
			return boundary
		}),
		save: vi.fn(async (nextSaved) => {
			calls.push("save")
			saved = nextSaved
		}),
	}
}

describe("TASK-107 frozen legacy golden replay", () => {
	it("replays dialog acceptance, identity rejection, and payload rejection through the current kernel", () => {
		const state = openQuestion(runningState())
		const acceptedReply = accepted(transition(state, reply(state)))
		expect({
			accepted: true,
			status: acceptedReply.state.dialog.primary?.status,
			commands: acceptedReply.commands.map((command) => command.type),
		}).toEqual(expected("dialog.reply.accept"))

		const wrongTask = transition(state, reply(state, { taskId: "task-other" }))
		expect({ accepted: false, state_changed: wrongTask.state !== state, commands: [] }).toEqual(
			expected("dialog.identity.reject"),
		)

		const missingDraft = transition(state, reply(state, { draftRef: undefined }))
		expect({ accepted: false, state_changed: missingDraft.state !== state, commands: [] }).toEqual(
			expected("dialog.payload.reject"),
		)
	})

	it("restores an interrupted dialog through the current kernel", () => {
		let state = openQuestion(runningState())
		state = accepted(
			transition(state, {
				type: "dialog.interrupt_requested",
				generation: state.generation,
				interactionId: "interrupt",
				turnId: "turn-1",
				kind: "condense",
				presentationRef: "condense:1",
				actionRules: [{ actionId: "confirm_utility", payloadPolicy: "none" }],
			}),
		).state
		state = prepareAndPresent(state, "interrupt", "journal:2")
		state = accepted(
			transition(
				state,
				reply(state, {
					interactionId: "interrupt",
					actionId: "confirm_utility",
					draftRef: undefined,
				}),
			),
		).state
		state = accepted(
			transition(state, { type: "dialog.resolved", generation: state.generation, interactionId: "interrupt" }),
		).state

		expect({
			resolved_primary: state.dialog.primary?.interactionId === "primary" ? "restored" : undefined,
			restored_status: state.dialog.primary?.status,
			interrupted: state.dialog.interrupted ?? null,
		}).toEqual(expected("dialog.interrupt.restore"))
	})

	it("replays all four frozen hydrate forms through the current kernel", () => {
		expect(replayHydrate(hydrateBase())).toEqual(expected("hydrate.interrupted"))
		expect(
			replayHydrate({
				...hydrateBase(),
				flow: { phase: "completed", completionId: "completion-1" },
				dialog: { primary: prepared("completion"), approvalsByBlock: {} },
			}),
		).toEqual(expected("hydrate.completed"))
		expect(
			replayHydrate({
				...hydrateBase(),
				flow: { phase: "error", error: "provider failed" },
				dialog: { primary: prepared("error_retry"), approvalsByBlock: {} },
			}),
		).toEqual(expected("hydrate.error"))

		const consumed = hydrate({
			taskId: "task-1",
			snapshot: {
				...hydrateBase(),
				flow: { phase: "terminated", terminalReason: "consumed", consumedRef: "handoff:1" },
				dialog: { primary: prepared("completion"), approvalsByBlock: {} },
			},
			journalTail: { seq: 10 },
			openReason: "crash_recovery",
		})
		expect({
			form: consumed.form,
			dialog: consumed.state.dialog.primary ?? null,
			commands: consumed.initialCommands.map((command) => command.type),
			automatic_execution: false,
		}).toEqual(expected("hydrate.consumed"))
	})

	it("replays combined and invalid checkpoint restore boundaries", async () => {
		const combinedPorts = checkpointPorts({
			...hydrateBase(),
			revision: 2,
			journalWatermark: { seq: 2 },
		})
		const combined = await restoreCheckpoint(
			{ taskId: "task-1", checkpointRef: "checkpoint:1", mode: "combined" },
			combinedPorts,
		)
		expect(combined.kind).toBe("restored")
		expect({
			order: combinedPorts.calls,
			outbox: combined.kind === "restored" ? combined.snapshot?.outbox.map((command) => command.type) : [],
		}).toEqual(expected("checkpoint.combined"))

		const invalidPorts = checkpointPorts(createInitialTaskState("task-other"))
		const invalid = await restoreCheckpoint(
			{ taskId: "task-1", checkpointRef: "checkpoint:1", mode: "combined" },
			invalidPorts,
		)
		expect(invalid.kind).toBe("rejected")
		expect({
			order: invalidPorts.calls,
			workspace_mutated: vi.mocked(invalidPorts.restoreWorkspace).mock.calls.length > 0,
			conversation_mutated: vi.mocked(invalidPorts.applyConversationBoundary).mock.calls.length > 0,
			vault_mutated: vi.mocked(invalidPorts.save).mock.calls.length > 0,
		}).toEqual(expected("checkpoint.invalid"))
	})
})
