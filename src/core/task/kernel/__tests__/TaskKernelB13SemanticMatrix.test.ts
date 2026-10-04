import { describe, expect, it } from "vitest"
import { hydrate, transition } from ".."
import type {
	Command,
	DialogInteraction,
	HydrateInput,
	HydrateResult,
	KernelBlock,
	TaskEvent,
	TaskState,
	TransitionResult,
} from "../types"
import { createInitialTaskState } from "../types"

type Transition = (state: TaskState, event: TaskEvent) => TransitionResult
type Hydrator = (input: HydrateInput) => HydrateResult

function accepted(result: TransitionResult): Extract<TransitionResult, { kind: "accepted" }> {
	if (result.kind !== "accepted") throw new Error(`${result.reason}: ${result.diagnostic.message}`)
	return result
}

function apply(state: TaskState, event: TaskEvent, reducer: Transition = transition) {
	return accepted(reducer(state, event))
}

function command<T extends Command["type"]>(commands: readonly Command[], type: T): Extract<Command, { type: T }> {
	const found = commands.find((candidate): candidate is Extract<Command, { type: T }> => candidate.type === type)
	if (!found) throw new Error(`Missing ${type} command`)
	return found
}

function block(blockId: string, index: number, phase: KernelBlock["phase"], attempt = `attempt:${blockId}`): KernelBlock {
	return { blockId, index, phase, attempt, lanes: [], turnEnding: false, invocationRef: `invocation:${blockId}` }
}

function running(turn: TaskState["turn"] = createInitialTaskState("task-b13").turn): TaskState {
	return { ...createInitialTaskState("task-b13"), flow: { phase: "running" }, turn }
}

function normalRound(reducer: Transition = transition) {
	let state = createInitialTaskState("task-b13")
	const emitted: string[] = []
	let result = apply(state, { type: "user.submit", generation: 0, entryId: "input-1", payloadRef: "payload:input-1" }, reducer)
	state = result.state
	emitted.push(...result.commands.map(({ type }) => type))
	const compose = command(result.commands, "compose.round")
	result = apply(
		state,
		{
			type: "compose.completed",
			generation: 0,
			commandId: compose.commandId,
			originRevision: compose.originRevision,
			turnId: "turn-1",
			draftRef: "draft:1",
		},
		reducer,
	)
	state = result.state
	emitted.push(...result.commands.map(({ type }) => type))
	const provider = command(result.commands, "provider.start")
	result = apply(
		state,
		{
			type: "provider.turn_ready",
			generation: 0,
			commandId: provider.commandId,
			originRevision: provider.originRevision,
			turnId: "turn-1",
			finalPayloadRef: "answer:1",
			journalWatermark: { seq: 1 },
			turnPlan: {
				mode: "serial",
				blocks: [
					{
						blockId: "tool-1",
						attempt: "attempt:tool-1",
						index: 0,
						lanes: [],
						turnEnding: false,
						invocationRef: "invocation:tool-1",
						approval: { kind: "none" },
					},
				],
			},
		},
		reducer,
	)
	state = result.state
	emitted.push(...result.commands.map(({ type }) => type))
	result = apply(
		state,
		{ type: "tool.started", generation: 0, turnId: "turn-1", blockId: "tool-1", attempt: "attempt:tool-1" },
		reducer,
	)
	state = result.state
	result = apply(
		state,
		{ type: "tool.completed", generation: 0, turnId: "turn-1", blockId: "tool-1", attempt: "attempt:tool-1" },
		reducer,
	)
	emitted.push(...result.commands.map(({ type }) => type))
	return {
		emitted,
		phases: result.state.turn.blocks.map(({ phase }) => phase),
		order: result.state.turn.blocks.map(({ blockId }) => blockId),
		flow: result.state.flow.phase,
	}
}

function parallelFailure(reducer: Transition = transition) {
	let state = running({
		turnId: "turn-parallel",
		mode: "parallel",
		blocks: [block("first", 0, "executing"), block("second", 1, "executing")],
		manualApprovalBlockIds: [],
		automaticApprovalBlockIds: [],
		executingBlockIds: ["first", "second"],
	})
	let result = apply(
		state,
		{
			type: "tool.failed",
			generation: 0,
			turnId: "turn-parallel",
			blockId: "second",
			attempt: "attempt:second",
			message: "boom",
		},
		reducer,
	)
	state = result.state
	result = apply(
		state,
		{ type: "tool.completed", generation: 0, turnId: "turn-parallel", blockId: "first", attempt: "attempt:first" },
		reducer,
	)
	return {
		phases: result.state.turn.blocks.map(({ phase }) => phase),
		order: result.state.turn.blocks.map(({ blockId }) => blockId),
		commands: result.commands.map(({ type }) => type),
		executing: result.state.turn.executingBlockIds,
	}
}

function serialRefusal(reducer: Transition = transition) {
	const state = running({
		turnId: "turn-serial",
		mode: "serial",
		blocks: [
			block("first", 0, "completed"),
			{
				...block("refused", 1, "pending"),
				policy: {
					commandId: "policy:1",
					originRevision: 4,
					status: "running",
					interactionId: "policy:refused",
					policyRevision: 7,
				},
			},
			block("later", 2, "pending"),
		],
		manualApprovalBlockIds: [],
		automaticApprovalBlockIds: ["refused"],
		executingBlockIds: [],
	})
	const result = apply(
		state,
		{
			type: "approval.evaluated",
			generation: 0,
			commandId: "policy:1",
			originRevision: 4,
			interactionId: "policy:refused",
			blockId: "refused",
			policyRevision: 7,
			attempt: "attempt:refused",
			approved: false,
		},
		reducer,
	)
	return { phases: result.state.turn.blocks.map(({ phase }) => phase), flow: result.state.flow.phase }
}

function settleHalt(state: TaskState, event: Extract<TaskEvent, { type: "user.cancel" | "user.terminate" }>, dropLast = false) {
	let result = apply(state, event)
	state = result.state
	if (state.halt.status !== "stopping") throw new Error("expected stopping halt")
	const participants = dropLast ? state.halt.pending.slice(0, -1) : state.halt.pending
	for (const participantId of participants) {
		result = apply(state, {
			type: "halt.halted",
			generation: state.generation,
			haltId: event.haltId,
			participantId,
		})
		state = result.state
	}
	return { phase: state.flow.phase, halt: state.halt.status, generation: state.generation }
}

function cancelAcrossPhases(dropLast = false) {
	const samples: readonly TaskState[] = [
		createInitialTaskState("task-b13"),
		{
			...running(),
			flow: {
				phase: "initializing",
				compose: { commandId: "compose", originRevision: 1, status: "running", admittedEntryIds: [] },
			},
		},
		{ ...running(), flow: { phase: "running", provider: { commandId: "provider", originRevision: 1, status: "running" } } },
		running({
			turnId: "turn-tool",
			mode: "serial",
			blocks: [block("tool", 0, "executing")],
			manualApprovalBlockIds: [],
			automaticApprovalBlockIds: [],
			executingBlockIds: ["tool"],
		}),
		{
			...running(),
			flow: { phase: "running", compaction: { compactionId: "cmp", attempt: "a1", contextRef: "ctx", status: "running" } },
		},
	]
	return samples.map((state, index) =>
		settleHalt(state, { type: "user.cancel", generation: 0, haltId: `cancel-${index}` }, dropLast),
	)
}

function terminate(useCancel = false) {
	const state = running({
		turnId: "turn-terminal",
		mode: "serial",
		blocks: [block("tool", 0, "executing")],
		manualApprovalBlockIds: [],
		automaticApprovalBlockIds: [],
		executingBlockIds: ["tool"],
	})
	return settleHalt(
		state,
		useCancel
			? { type: "user.cancel", generation: 0, haltId: "terminal" }
			: { type: "user.terminate", generation: 0, haltId: "terminal" },
	)
}

function prepared(kind: string): DialogInteraction {
	return {
		interactionId: `${kind}:1`,
		turnId: "turn-1",
		kind,
		status: "prepared",
		createdRevision: 2,
		presentationRef: `${kind}:presentation`,
		actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
		journalRef: "journal:1",
		receiverGeneration: 0,
	}
}

function hydrateForms(hydrator: Hydrator = hydrate) {
	const base = { ...running(), revision: 4, journalWatermark: { seq: 1 } }
	const snapshots: readonly TaskState[] = [
		{
			...base,
			turn: {
				turnId: "turn-1",
				mode: "serial",
				blocks: [block("tool", 0, "executing")],
				manualApprovalBlockIds: [],
				automaticApprovalBlockIds: [],
				executingBlockIds: ["tool"],
			},
		},
		{
			...base,
			flow: { phase: "completed", completionId: "done" },
			dialog: { primary: prepared("completion"), approvalsByBlock: {} },
		},
		{
			...base,
			flow: { phase: "error", error: "failed" },
			dialog: { primary: prepared("error_retry"), approvalsByBlock: {} },
		},
		{ ...base, flow: { phase: "terminated", terminalReason: "consumed", consumedRef: "handoff:1" } },
	]
	return snapshots.map((snapshot) => {
		const result = hydrator({ taskId: "task-b13", snapshot, journalTail: { seq: 1 }, openReason: "crash_recovery" })
		return {
			form: result.form,
			flow: result.state.flow.phase,
			commands: result.initialCommands.map(({ type }) => type),
			executing: result.state.turn.executingBlockIds,
		}
	})
}

function pausedArrivals(reducer: Transition = transition) {
	let state: TaskState = { ...createInitialTaskState("task-b13"), flow: { phase: "paused" } }
	const commands: string[] = []
	let result = apply(
		state,
		{ type: "background.ready", generation: 0, entryId: "background", payloadRef: "payload:background" },
		reducer,
	)
	state = result.state
	commands.push(...result.commands.map(({ type }) => type))
	result = apply(state, { type: "cotask.received", generation: 0, entryId: "cotask", payloadRef: "payload:cotask" }, reducer)
	commands.push(...result.commands.map(({ type }) => type))
	return {
		phase: result.state.flow.phase,
		background: result.state.intake.background.map(({ state: entryState }) => entryState),
		cotask: result.state.intake.coTask.map(({ state: entryState }) => entryState),
		commands,
	}
}

function staleFeedback(reducer: Transition = transition) {
	const state = running({
		turnId: "turn-stale",
		mode: "serial",
		blocks: [block("tool", 0, "executing", "attempt:current")],
		manualApprovalBlockIds: [],
		automaticApprovalBlockIds: [],
		executingBlockIds: ["tool"],
	})
	const result = reducer(state, {
		type: "tool.completed",
		generation: 0,
		turnId: "turn-stale",
		blockId: "tool",
		attempt: "attempt:stale",
	})
	return {
		kind: result.kind,
		reason: result.kind === "rejected" ? result.reason : undefined,
		stateChanged: result.state !== state,
		commands: result.kind === "accepted" ? result.commands.map(({ type }) => type) : [],
	}
}

interface Scenario {
	readonly id: string
	readonly run: () => unknown
	readonly expected: unknown
	readonly mutated: () => unknown
}

const MATRIX: readonly Scenario[] = [
	{
		id: "B13-1 normal round",
		run: () => normalRound(),
		expected: {
			emitted: ["compose.round", "provider.start", "tool.run", "tool.retire", "compose.round"],
			phases: ["completed"],
			order: ["tool-1"],
			flow: "running",
		},
		mutated: () =>
			normalRound((state, event) => {
				const result = transition(state, event)
				return event.type === "tool.completed" && result.kind === "accepted" ? { ...result, commands: [] } : result
			}),
	},
	{
		id: "B13-2 parallel out-of-order completion and partial failure",
		run: () => parallelFailure(),
		expected: {
			phases: ["completed", "failed"],
			order: ["first", "second"],
			commands: ["tool.retire", "compose.round"],
			executing: [],
		},
		mutated: () =>
			parallelFailure((state, event) =>
				transition(state, event.type === "tool.failed" ? { ...event, type: "tool.completed" } : event),
			),
	},
	{
		id: "B13-3 serial refusal cascades skipped blocks",
		run: () => serialRefusal(),
		expected: { phases: ["completed", "rejected", "skipped"], flow: "waiting" },
		mutated: () =>
			serialRefusal((state, event) =>
				transition(state, event.type === "approval.evaluated" ? { ...event, approved: true } : event),
			),
	},
	{
		id: "B13-4 cancellation settles every active phase",
		run: () => cancelAcrossPhases(),
		expected: Array.from({ length: 5 }, () => ({ phase: "paused", halt: "idle", generation: 1 })),
		mutated: () => cancelAcrossPhases(true),
	},
	{
		id: "B13-5 terminate reaches an idempotent terminal state",
		run: () => terminate(),
		expected: { phase: "terminated", halt: "idle", generation: 1 },
		mutated: () => terminate(true),
	},
	{
		id: "B13-6 hydrate preserves four stable forms",
		run: () => hydrateForms(),
		expected: [
			{ form: "interrupted", flow: "paused", commands: ["dialog.prepare"], executing: [] },
			{ form: "completed", flow: "completed", commands: ["dialog.reveal"], executing: [] },
			{ form: "error", flow: "error", commands: ["dialog.reveal"], executing: [] },
			{ form: "consumed", flow: "terminated", commands: [], executing: [] },
		],
		mutated: () =>
			hydrateForms((input) => {
				const result = hydrate(input)
				return { ...result, form: "interrupted" }
			}),
	},
	{
		id: "B13-7 paused background and co-task arrivals stay durable without auto-running",
		run: () => pausedArrivals(),
		expected: {
			phase: "paused",
			background: ["accepted"],
			cotask: ["accepted"],
			commands: ["dialog.prepare", "dialog.prepare"],
		},
		mutated: () =>
			pausedArrivals((state, event) =>
				transition(
					event.type === "background.ready" || event.type === "cotask.received"
						? { ...state, flow: { phase: "waiting" } }
						: state,
					event,
				),
			),
	},
	{
		id: "B13-8 stale tool feedback is rejected without state pollution",
		run: () => staleFeedback(),
		expected: { kind: "rejected", reason: "stale_attempt", stateChanged: false, commands: [] },
		mutated: () =>
			staleFeedback((state, event) =>
				transition(state, event.type.startsWith("tool.") ? { ...event, attempt: "attempt:current" } : event),
			),
	},
]

describe("WS-051 §B13 semantic mutation matrix", () => {
	it("contains the complete eight-scenario contract", () => {
		expect(MATRIX.map(({ id }) => id.slice(0, 5))).toEqual([
			"B13-1",
			"B13-2",
			"B13-3",
			"B13-4",
			"B13-5",
			"B13-6",
			"B13-7",
			"B13-8",
		])
	})

	it.each(MATRIX)("$id matches the real kernel oracle", ({ run, expected }) => {
		expect(run()).toEqual(expected)
	})

	it.each(MATRIX)("$id fails under its semantic mutation", ({ mutated, expected }) => {
		expect(mutated()).not.toEqual(expected)
	})
})
