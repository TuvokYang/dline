import type { ClineContent } from "@shared/messages"
import { BlockPhase } from "../BlockPhaseMachine"
import { hostedWebApprovalId } from "../interaction/HostedWebApproval"
import { reduceInteraction } from "../interaction/InteractionReducer"
import { getInteraction } from "../interaction/InteractionRegistry"
import type { InteractionResponseErrorCode } from "../interaction/InteractionResponse"
import { TaskPhase } from "../TaskPhase"
import { TaskPhaseMachine } from "../TaskPhaseMachine"
import type { TaskEffect } from "./TaskEffect"
import type { TaskEvent } from "./TaskEvent"
import type { TaskRuntimeState } from "./TaskRuntimeState"

/** Typed rejection returned for an event that is invalid in the current phase. */
export interface RuntimeEventError {
	code: "invalid_runtime_event" | InteractionResponseErrorCode
	eventType: TaskEvent["type"]
	phase: TaskPhase
}

/** Pure transition output consumed by TaskRuntime. */
export interface TransitionResult {
	accepted: boolean
	next: TaskRuntimeState
	effects: TaskEffect[]
	error?: RuntimeEventError
}

interface AcceptedChange {
	eventType: TaskEvent["type"]
	phase: TaskPhase
	anchor?: TaskRuntimeState["anchor"]
	cancellation?: TaskRuntimeState["cancellation"] | null
	error?: TaskRuntimeState["error"] | null
	completion?: TaskRuntimeState["completion"] | null
	turn?: TaskRuntimeState["turn"] | null
	interaction?: TaskRuntimeState["interaction"] | null
	ordinaryInput?: TaskRuntimeState["ordinaryInput"] | null
	interruptedInteraction?: TaskRuntimeState["interruptedInteraction"] | null
	newTaskConsumed?: TaskRuntimeState["newTaskConsumed"] | null
	supersededEffectRevision?: number
	effects?: TaskEffect[]
}

/** Create a stable effect identity from the next state revision and sequence. */
function effectId(revision: number, sequence: number): string {
	return `task-effect-${revision}-${sequence}`
}

/** Create the standard view and persistence effects for one transition. */
function stateEffects(revision: number): TaskEffect[] {
	return [
		{ id: effectId(revision, 1), type: "POST_TASK_VIEW" },
		{ id: effectId(revision, 2), type: "PERSIST_SNAPSHOT" },
	]
}

/** Map canonical interactions whose handlers still contain a legacy feedback echo guard. */
function handlerFeedbackAcknowledgment(
	kind: NonNullable<TaskRuntimeState["interaction"]>["kind"],
	actionId: string,
): "yesButtonClicked" | "noButtonClicked" | "messageResponse" | undefined {
	switch (kind) {
		case "tool_approval":
		case "command_approval":
		case "browser_approval":
		case "mcp_approval":
		case "subagent_approval":
		case "spawn_task_approval":
			return actionId === "approve" ? "yesButtonClicked" : actionId === "reject" ? "noButtonClicked" : undefined
		case "change_todo_list":
			return actionId === "reject" ? "noButtonClicked" : undefined
		case "new_task":
			return "noButtonClicked"
		case "report_bug":
		case "condense":
		case "followup":
		case "make_plan":
		case "qna_response":
		case "generate_report":
		case "completion":
			return "messageResponse"
		default:
			return undefined
	}
}

/** Persist accepted user-authored interaction input before its continuation consumes the draft. */
function interactionResponseEffects(
	interaction: NonNullable<TaskRuntimeState["interaction"]>,
	response: Extract<TaskEvent, { type: "INTERACTION_RESPONDED" }>["response"],
	revision: number,
): TaskEffect[] {
	const draft = response.presentationDraft ?? response.draft
	const hasVisibleDraft = Boolean(draft && (draft.text.trim() || draft.images.length > 0 || draft.files.length > 0))
	if (!draft || !hasVisibleDraft) {
		return stateEffects(revision)
	}
	return [
		{
			id: effectId(revision, 1),
			type: "APPEND_SAY",
			interactionId: interaction.interactionId,
			taskSay: "user_feedback",
			presentation: draft.text,
			images: draft.images,
			files: draft.files,
			userInputKind: response.userInputKind,
			queuedInputMode: response.queuedInputMode,
			feedbackAcknowledgment: handlerFeedbackAcknowledgment(interaction.kind, response.actionId),
			feedbackAcknowledgmentText: response.draft?.text,
		},
		{ id: effectId(revision, 2), type: "POST_TASK_VIEW" },
		{ id: effectId(revision, 3), type: "PERSIST_SNAPSHOT" },
	]
}

/** Return whether a phase transition is allowed by the canonical phase machine. */
function canTransition(from: TaskPhase, to: TaskPhase): boolean {
	const machine = new TaskPhaseMachine()
	machine.restoreFrom({ phase: from, apiIndex: -1, timestamp: 1 })
	return machine.canTransition(to)
}

/** Build one accepted immutable runtime transition. */
function accept(state: TaskRuntimeState, change: AcceptedChange): TransitionResult {
	if (!canTransition(state.phase, change.phase)) {
		return reject(state, change.eventType)
	}

	const revision = state.revision + 1
	const next: TaskRuntimeState = {
		...state,
		phase: change.phase,
		revision,
		anchor: change.anchor ?? state.anchor,
	}

	if (change.cancellation === null) {
		delete next.cancellation
	} else if (change.cancellation !== undefined) {
		next.cancellation = change.cancellation
	}
	if (change.error === null) {
		delete next.error
	} else if (change.error !== undefined) {
		next.error = change.error
	}
	if (change.completion === null) {
		delete next.completion
	} else if (change.completion !== undefined) {
		next.completion = change.completion
	}
	if (change.turn === null) {
		delete next.turn
	} else if (change.turn !== undefined) {
		next.turn = change.turn
	}
	if (change.interaction === null) {
		delete next.interaction
	} else if (change.interaction !== undefined) {
		next.interaction = change.interaction
	}
	if (change.ordinaryInput === null) {
		delete next.ordinaryInput
	} else if (change.ordinaryInput !== undefined) {
		next.ordinaryInput = change.ordinaryInput
	}
	if (next.phase !== TaskPhase.BETWEEN_TURNS || next.interaction) delete next.ordinaryInput
	if (change.interruptedInteraction === null) {
		delete next.interruptedInteraction
	} else if (change.interruptedInteraction !== undefined) {
		next.interruptedInteraction = change.interruptedInteraction
	}
	if (change.newTaskConsumed === null) {
		delete next.newTaskConsumed
	} else if (change.newTaskConsumed !== undefined) {
		next.newTaskConsumed = change.newTaskConsumed
	}
	if (change.supersededEffectRevision !== undefined) {
		next.supersededEffectRevision = change.supersededEffectRevision
	}

	return {
		accepted: true,
		next,
		effects: change.effects ?? stateEffects(revision),
	}
}

/** Return an unchanged state for a typed runtime rejection. */
function reject(
	state: TaskRuntimeState,
	eventType: TaskEvent["type"],
	code: RuntimeEventError["code"] = "invalid_runtime_event",
): TransitionResult {
	return {
		accepted: false,
		next: state,
		effects: [],
		error: { code, eventType, phase: state.phase },
	}
}

/** Commit an interaction update without requiring a task phase self-transition. */
function acceptInteraction(
	state: TaskRuntimeState,
	interaction: TaskRuntimeState["interaction"],
	anchor: TaskRuntimeState["anchor"] = state.anchor,
	effects?: TaskEffect[],
): TransitionResult {
	const revision = state.revision + 1
	const next: TaskRuntimeState = { ...state, revision, anchor, interaction }
	if (next.phase !== TaskPhase.BETWEEN_TURNS || next.interaction) delete next.ordinaryInput
	return {
		accepted: true,
		next,
		effects: effects ?? stateEffects(revision),
	}
}

/** Close only the Profile-related retry interaction after a durable replacement commit. */
function acceptProfileRecovery(state: TaskRuntimeState, interactionId: string): TransitionResult {
	if (
		state.phase !== TaskPhase.AWAITING_APPROVAL ||
		state.interaction?.kind !== "error_retry" ||
		state.interaction.interactionId !== interactionId
	) {
		return reject(state, "PROFILE_RECOVERY_COMMITTED")
	}
	const revision = state.revision + 1
	const anchor = { ...state.anchor }
	delete anchor.interactionId
	delete anchor.turnId
	const next: TaskRuntimeState = {
		...state,
		phase: TaskPhase.BETWEEN_TURNS,
		revision,
		anchor,
		ordinaryInput: { kind: "profile_recovery" },
	}
	delete next.interaction
	delete next.error
	return {
		accepted: true,
		next,
		effects: stateEffects(revision),
	}
}

/** Consume the one ordinary reply admitted after a durable Profile recovery. */
function acceptProfileRecoveryInput(
	state: TaskRuntimeState,
	event: Extract<TaskEvent, { type: "PROFILE_RECOVERY_INPUT_RECEIVED" }>,
): TransitionResult {
	if (state.phase !== TaskPhase.BETWEEN_TURNS || state.interaction || state.ordinaryInput?.kind !== "profile_recovery") {
		return reject(state, event.type)
	}
	const revision = state.revision + 1
	const next = { ...state, revision }
	delete next.ordinaryInput
	return {
		accepted: true,
		next,
		effects: [
			{
				id: effectId(revision, 1),
				type: "APPEND_SAY",
				taskSay: "user_feedback",
				presentation: event.draft.text,
				images: event.draft.images,
				files: event.draft.files,
				userInputKind: "direct",
			},
			{ id: effectId(revision, 2), type: "POST_TASK_VIEW" },
			{ id: effectId(revision, 3), type: "PERSIST_SNAPSHOT" },
		],
	}
}

/** Reduce one initialization event without performing side effects. */
function reduceInitialize(state: TaskRuntimeState, event: TaskEvent): TransitionResult {
	if (event.type === "TASK_INITIALIZE_REQUESTED" && state.phase === TaskPhase.IDLE) {
		return accept(state, { eventType: event.type, phase: TaskPhase.INITIALIZING })
	}
	if (event.type === "TASK_INITIALIZED" && state.phase === TaskPhase.INITIALIZING) {
		return accept(state, {
			eventType: event.type,
			phase: event.hasTask ? TaskPhase.STREAMING : TaskPhase.WAITING_FOR_TASK,
			anchor: event.anchor,
		})
	}
	return reject(state, event.type)
}

/** Reduce one API lifecycle event without performing side effects. */
function reduceApi(state: TaskRuntimeState, event: Extract<TaskEvent, { type: "API_REQUEST_STARTED" }>): TransitionResult {
	const continuationInteraction =
		state.interaction?.status === "resolving" &&
		((state.interaction.kind === "resume" && state.interaction.acceptedResponse?.actionId === "resume") ||
			(state.interaction.kind === "error_retry" && state.interaction.acceptedResponse?.actionId === "retry") ||
			(state.interaction.kind === "mistake_limit" && state.interaction.acceptedResponse?.actionId === "process_anyway"))
	const interaction = continuationInteraction ? undefined : state.interaction
	const anchor = {
		...state.anchor,
		apiIndex: event.apiIndex,
		...(continuationInteraction ? { interactionId: undefined } : {}),
	}
	if (state.phase === TaskPhase.STREAMING) {
		const revision = state.revision + 1
		return {
			accepted: true,
			next: { ...state, revision, anchor, interaction },
			effects: stateEffects(revision),
		}
	}
	if (!canTransition(state.phase, TaskPhase.STREAMING)) {
		return reject(state, event.type)
	}
	return accept(state, {
		eventType: event.type,
		phase: TaskPhase.STREAMING,
		anchor,
		interaction: interaction ?? null,
	})
}

/** Start one reconciled API continuation without reading persisted messages. */
function reduceResumeApi(
	state: TaskRuntimeState,
	event: Extract<TaskEvent, { type: "RESUME_API_CONTINUATION_REQUESTED" }>,
): TransitionResult {
	if (
		state.interaction ||
		event.apiIndex !== state.anchor.apiIndex ||
		state.turn?.blocks.some((block) => !isTerminalBlock(block.phase))
	) {
		return reject(state, event.type)
	}
	if (state.phase !== TaskPhase.STREAMING && !canTransition(state.phase, TaskPhase.STREAMING)) {
		return reject(state, event.type)
	}
	const revision = state.revision + 1
	return {
		accepted: true,
		next: { ...state, phase: TaskPhase.STREAMING, revision, anchor: { ...state.anchor, apiIndex: event.apiIndex } },
		effects: [
			{ id: effectId(revision, 1), type: "POST_TASK_VIEW" },
			{
				id: effectId(revision, 2),
				type: "START_API",
				apiIndex: event.apiIndex,
				...(event.draft ? { draft: event.draft } : {}),
			},
			{ id: effectId(revision, 3), type: "PERSIST_SNAPSHOT" },
		],
	}
}

/** Continue one restored Hosted Web request whose user message is already durable. */
function reduceHostedWebRequest(
	state: TaskRuntimeState,
	event: Extract<TaskEvent, { type: "HOSTED_WEB_REQUEST_CONTINUATION_REQUESTED" }>,
): TransitionResult {
	const interaction = state.interaction
	if (
		interaction?.kind !== "hosted_web_approval" ||
		interaction.status !== "resolving" ||
		interaction.interactionId !== event.interactionId ||
		interaction.acceptedResponse?.actionId !== "approve" ||
		event.apiIndex !== state.anchor.apiIndex
	) {
		return reject(state, event.type)
	}
	if (state.phase !== TaskPhase.STREAMING && !canTransition(state.phase, TaskPhase.STREAMING)) {
		return reject(state, event.type)
	}
	const revision = state.revision + 1
	return {
		accepted: true,
		next: {
			...state,
			phase: TaskPhase.STREAMING,
			revision,
			interaction: undefined,
			anchor: {
				...state.anchor,
				apiIndex: event.apiIndex,
				interactionId: undefined,
			},
		},
		effects: [
			{ id: effectId(revision, 1), type: "POST_TASK_VIEW" },
			{
				id: effectId(revision, 2),
				type: "START_API",
				apiIndex: event.apiIndex,
				persistedRequest: true,
			},
			{ id: effectId(revision, 3), type: "PERSIST_SNAPSHOT" },
		],
	}
}

/** Open a durable Resume interaction after one request-level Hosted Web rejection. */
function reduceHostedWebRejection(
	state: TaskRuntimeState,
	event: Extract<TaskEvent, { type: "HOSTED_WEB_REQUEST_REJECTED" }>,
): TransitionResult {
	const approvalInteractionId = hostedWebApprovalId(state.taskId, event.apiIndex)
	if (
		state.phase !== TaskPhase.PAUSED ||
		state.interaction ||
		state.anchor.turnId !== approvalInteractionId ||
		state.anchor.interactionId !== approvalInteractionId
	) {
		return reject(state, event.type)
	}
	const revision = state.revision + 1
	return acceptInteraction(
		state,
		openingInteraction(state, revision, { ...event, kind: "resume" }),
		{ ...state.anchor, apiIndex: event.apiIndex, turnId: event.turnId, interactionId: event.interactionId },
		interactionEffects(revision, {
			interactionId: event.interactionId,
			taskAsk: "resume_task",
			presentation: event.presentation,
		}),
	)
}

/** Reset only reconciled non-terminal blocks before replaying their normal handler lifecycle. */
function reduceResumeBlocks(
	state: TaskRuntimeState,
	event: Extract<TaskEvent, { type: "RESUME_BLOCK_REPLAY_REQUESTED" }>,
): TransitionResult {
	if (!state.turn || state.turn.turnId !== event.turnId || event.dlineTids.length === 0) {
		return reject(state, event.type)
	}
	const requested = new Set(event.dlineTids)
	if (requested.size !== event.dlineTids.length) {
		return reject(state, event.type)
	}
	if (state.turn.blocks.some((block) => requested.has(block.dlineTid) && isTerminalBlock(block.phase))) {
		return reject(state, event.type)
	}
	const blocks = state.turn.blocks.map((block) =>
		requested.has(block.dlineTid) ? { ...block, phase: BlockPhase.STREAMING } : block,
	)
	if (blocks.filter((block) => requested.has(block.dlineTid)).length !== requested.size) {
		return reject(state, event.type)
	}
	return acceptTurn(state, event.type, { ...state.turn, blocks, activeDlineTid: undefined }, TaskPhase.STREAMING)
}

/** Return one block from the active canonical turn. */
function findTurnBlock(state: TaskRuntimeState, turnId: string, dlineTid: string) {
	if (!state.turn || state.turn.turnId !== turnId) {
		return undefined
	}
	return state.turn.blocks.find((block) => block.dlineTid === dlineTid)
}

/** Replace one block immutably in the active turn. */
function replaceTurnBlock(
	state: TaskRuntimeState,
	dlineTid: string,
	phase: BlockPhase,
	activeDlineTid: string | undefined,
): TaskRuntimeState["turn"] {
	if (!state.turn) {
		return undefined
	}
	return {
		...state.turn,
		activeDlineTid,
		blocks: state.turn.blocks.map((block) => (block.dlineTid === dlineTid ? { ...block, phase } : block)),
	}
}

/** Commit one turn update while preserving or explicitly changing phase. */
function acceptTurn(
	state: TaskRuntimeState,
	eventType: TaskEvent["type"],
	turn: NonNullable<TaskRuntimeState["turn"]>,
	phase: TaskPhase = state.phase,
	effects?: TaskEffect[],
): TransitionResult {
	if (phase !== state.phase) {
		return accept(state, { eventType, phase, turn, anchor: { ...state.anchor, turnId: turn.turnId }, effects })
	}
	const revision = state.revision + 1
	return {
		accepted: true,
		next: { ...state, revision, turn, anchor: { ...state.anchor, turnId: turn.turnId } },
		effects: effects ?? stateEffects(revision),
	}
}

/** Create or advance one canonical assistant turn. */
function reduceTurn(
	state: TaskRuntimeState,
	event: Extract<
		TaskEvent,
		{
			type:
				| "TURN_CREATED"
				| "BLOCK_READY"
				| "BLOCK_APPROVAL_REQUIRED"
				| "BLOCK_APPROVED"
				| "BLOCK_REJECTED"
				| "BLOCK_EXECUTION_STARTED"
				| "BLOCK_EXECUTION_REJECTED"
				| "BLOCK_EXECUTION_COMPLETED"
				| "TURN_COMPLETED"
		}
	>,
): TransitionResult {
	if (event.type === "TURN_CREATED") {
		if (state.turn?.blocks.some((block) => !isTerminalBlock(block.phase))) {
			return reject(state, event.type)
		}
		return acceptTurn(state, event.type, {
			turnId: event.turnId,
			assistantApiIndex: event.assistantApiIndex,
			mode: event.mode,
			blocks: event.blocks.map((block) => ({ ...block, phase: BlockPhase.STREAMING })),
		})
	}

	if (!state.turn || state.turn.turnId !== event.turnId) {
		return reject(state, event.type)
	}
	if (event.type === "TURN_COMPLETED") {
		if (!state.turn.blocks.every((block) => isTerminalBlock(block.phase))) {
			return reject(state, event.type)
		}
		return acceptTurn(state, event.type, { ...state.turn, activeDlineTid: undefined }, TaskPhase.BETWEEN_TURNS)
	}

	const block = findTurnBlock(state, event.turnId, event.dlineTid)
	if (!block) {
		return reject(state, event.type)
	}
	if (event.type === "BLOCK_READY") {
		if (block.phase !== BlockPhase.STREAMING) {
			return reject(state, event.type)
		}
		if (block.requiresApproval) {
			return acceptTurn(state, event.type, state.turn)
		}
		const turn = replaceTurnBlock(state, block.dlineTid, BlockPhase.AUTO_EXECUTING, state.turn.activeDlineTid)
		return turn ? acceptTurn(state, event.type, turn) : reject(state, event.type)
	}
	if (event.type === "BLOCK_APPROVAL_REQUIRED") {
		if (block.phase !== BlockPhase.STREAMING || state.turn.activeDlineTid) {
			return reject(state, event.type)
		}
		const turn = replaceTurnBlock(state, block.dlineTid, BlockPhase.AWAITING_APPROVAL, block.dlineTid)
		return turn ? acceptTurn(state, event.type, turn, TaskPhase.AWAITING_APPROVAL) : reject(state, event.type)
	}
	if (event.type === "BLOCK_APPROVED") {
		if (block.phase !== BlockPhase.AWAITING_APPROVAL || state.turn.activeDlineTid !== block.dlineTid) {
			return reject(state, event.type)
		}
		const turn = replaceTurnBlock(state, block.dlineTid, BlockPhase.EXECUTING, block.dlineTid)
		return turn ? acceptTurn(state, event.type, turn, TaskPhase.EXECUTING) : reject(state, event.type)
	}
	if (event.type === "BLOCK_REJECTED") {
		if (block.phase !== BlockPhase.AWAITING_APPROVAL || state.turn.activeDlineTid !== block.dlineTid) {
			return reject(state, event.type)
		}
		let afterRejected = false
		const turn = {
			...state.turn,
			activeDlineTid: undefined,
			blocks: state.turn.blocks.map((candidate) => {
				if (candidate.dlineTid === block.dlineTid) {
					afterRejected = true
					return { ...candidate, phase: BlockPhase.REJECTED }
				}
				if (afterRejected && candidate.phase === BlockPhase.STREAMING) {
					return { ...candidate, phase: BlockPhase.SKIPPED }
				}
				return candidate
			}),
		}
		return acceptTurn(state, event.type, turn, TaskPhase.BETWEEN_TURNS)
	}
	if (event.type === "BLOCK_EXECUTION_STARTED") {
		if (block.phase !== BlockPhase.EXECUTING && block.phase !== BlockPhase.AUTO_EXECUTING) {
			return reject(state, event.type)
		}
		const revision = state.revision + 1
		return acceptTurn(state, event.type, state.turn, TaskPhase.EXECUTING, [
			{ id: effectId(revision, 1), type: "POST_TASK_VIEW" },
			{ id: effectId(revision, 2), type: "PERSIST_SNAPSHOT" },
			{ id: effectId(revision, 3), type: "EXECUTE_TOOL", dlineTid: block.dlineTid },
		])
	}
	if (event.type === "BLOCK_EXECUTION_REJECTED") {
		if (block.phase !== BlockPhase.EXECUTING && block.phase !== BlockPhase.AUTO_EXECUTING) {
			return reject(state, event.type)
		}
		let afterRejected = false
		const turn = {
			...state.turn,
			activeDlineTid: undefined,
			blocks: state.turn.blocks.map((candidate) => {
				if (candidate.dlineTid === block.dlineTid) {
					afterRejected = true
					return { ...candidate, phase: BlockPhase.REJECTED }
				}
				if (afterRejected && candidate.phase === BlockPhase.STREAMING) {
					return { ...candidate, phase: BlockPhase.SKIPPED }
				}
				return candidate
			}),
		}
		return acceptTurn(state, event.type, turn, TaskPhase.BETWEEN_TURNS)
	}
	if (block.phase !== BlockPhase.EXECUTING && block.phase !== BlockPhase.AUTO_EXECUTING) {
		return reject(state, event.type)
	}
	const activeDlineTid = state.turn.activeDlineTid === block.dlineTid ? undefined : state.turn.activeDlineTid
	const turn = replaceTurnBlock(state, block.dlineTid, BlockPhase.COMPLETED, activeDlineTid)
	return turn ? acceptTurn(state, event.type, turn, TaskPhase.EXECUTING) : reject(state, event.type)
}

/** Return whether a block has reached a terminal turn phase. */
function isTerminalBlock(phase: BlockPhase): boolean {
	return (
		phase === BlockPhase.COMPLETED ||
		phase === BlockPhase.REJECTED ||
		phase === BlockPhase.SKIPPED ||
		phase === BlockPhase.CANCELLED
	)
}

/** Reduce one interaction checkpoint event without performing side effects. */
function reduceApproval(state: TaskRuntimeState, event: Extract<TaskEvent, { type: "APPROVAL_REQUIRED" }>): TransitionResult {
	if (!canTransition(state.phase, TaskPhase.AWAITING_APPROVAL)) {
		return reject(state, event.type)
	}
	return accept(state, {
		eventType: event.type,
		phase: TaskPhase.AWAITING_APPROVAL,
		anchor: { ...state.anchor, turnId: event.turnId, interactionId: event.interactionId },
	})
}

/** Open one canonical interaction and request its presentation effect. */
function reduceInteractionOpen(
	state: TaskRuntimeState,
	event: Extract<TaskEvent, { type: "INTERACTION_OPEN_REQUESTED" }>,
): TransitionResult {
	if (state.interaction) {
		return reject(state, event.type)
	}
	const approvalKinds = new Set([
		"tool_approval",
		"hosted_web_approval",
		"command_approval",
		"browser_approval",
		"mcp_approval",
		"subagent_approval",
		"spawn_task_approval",
		"change_todo_list",
		"new_task",
	])
	const approvalBlock = approvalKinds.has(event.kind)
		? state.turn?.blocks.find((block) => block.dlineTid === event.interactionId)
		: undefined
	if (approvalBlock && approvalBlock.phase !== BlockPhase.AUTO_EXECUTING && approvalBlock.phase !== BlockPhase.EXECUTING) {
		return reject(state, event.type)
	}
	if (approvalBlock && state.turn?.activeDlineTid && state.turn.activeDlineTid !== approvalBlock.dlineTid) {
		return reject(state, event.type)
	}
	const turn = approvalBlock
		? replaceTurnBlock(state, approvalBlock.dlineTid, BlockPhase.AWAITING_APPROVAL, approvalBlock.dlineTid)
		: state.turn
	const requestApproval = event.kind === "hosted_web_approval"
	if (requestApproval && !canTransition(state.phase, TaskPhase.AWAITING_APPROVAL)) {
		return reject(state, event.type)
	}
	const revision = state.revision + 1
	const definition = getInteraction(event.kind)
	const next: TaskRuntimeState = {
		...state,
		...(turn ? { turn } : {}),
		...(approvalBlock || requestApproval ? { phase: TaskPhase.AWAITING_APPROVAL } : {}),
		revision,
		anchor: { ...state.anchor, turnId: event.turnId, interactionId: event.interactionId },
		interaction: {
			taskId: state.taskId,
			turnId: event.turnId,
			interactionId: event.interactionId,
			kind: event.kind,
			status: "opening",
			createdRevision: revision,
		},
	}
	delete next.ordinaryInput
	return {
		accepted: true,
		next,
		effects: [
			{
				id: effectId(revision, 1),
				type: "APPEND_ASK",
				interactionId: event.interactionId,
				taskAsk: definition.taskAsk,
				presentation: event.presentation,
				existingTs: event.existingTs,
			},
		],
	}
}

/** Temporarily replace one awaiting interaction while retaining its live causal waiter. */
function reduceInteractionInterrupt(
	state: TaskRuntimeState,
	event: Extract<TaskEvent, { type: "INTERACTION_INTERRUPT_REQUESTED" }>,
): TransitionResult {
	if (!state.interaction || state.interaction.status !== "awaiting" || state.interruptedInteraction) {
		return reject(state, event.type)
	}
	const revision = state.revision + 1
	const definition = getInteraction(event.kind)
	return {
		accepted: true,
		next: {
			...state,
			revision,
			anchor: { ...state.anchor, turnId: event.turnId, interactionId: event.interactionId },
			interruptedInteraction: state.interaction,
			interaction: {
				taskId: state.taskId,
				turnId: event.turnId,
				interactionId: event.interactionId,
				kind: event.kind,
				status: "opening",
				createdRevision: revision,
			},
		},
		effects: [
			{
				id: effectId(revision, 1),
				type: "APPEND_ASK",
				interactionId: event.interactionId,
				taskAsk: definition.taskAsk,
				presentation: event.presentation,
				existingTs: event.existingTs,
			},
		],
	}
}

/** Bind a persisted ask anchor to the opening interaction. */
function reduceInteractionPresented(
	state: TaskRuntimeState,
	event: Extract<TaskEvent, { type: "INTERACTION_PRESENTED" }>,
): TransitionResult {
	const interaction = state.interaction
	if (!interaction || interaction.status !== "opening" || interaction.interactionId !== event.interactionId) {
		return reject(state, event.type)
	}
	const revision = state.revision + 1
	const effects =
		state.error && interaction.kind === "resume"
			? stateEffects(revision).filter((effect) => effect.type !== state.error?.effectType)
			: undefined
	return acceptInteraction(
		state,
		{ ...interaction, status: "awaiting", anchor: { messageTs: event.messageTs, messageType: "ask" } },
		{
			...state.anchor,
			uiMessageTs: event.messageTs,
			turnId: interaction.turnId,
			interactionId: interaction.interactionId,
		},
		effects,
	)
}

/** Remove one resolved interaction after its response was consumed or its failed continuation was retired. */
function reduceInteractionResolved(
	state: TaskRuntimeState,
	event: Extract<TaskEvent, { type: "INTERACTION_RESOLVED" }>,
): TransitionResult {
	const interaction = state.interaction
	const hasAcceptedContinuation =
		interaction?.status === "resolving" || (interaction?.status === "awaiting" && interaction.acceptedResponse !== undefined)
	if (!interaction || !hasAcceptedContinuation || interaction.interactionId !== event.interactionId) {
		return reject(state, event.type)
	}
	if (!state.interruptedInteraction) return acceptInteraction(state, undefined)

	const revision = state.revision + 1
	const restored = state.interruptedInteraction
	return {
		accepted: true,
		next: {
			...state,
			revision,
			interaction: restored,
			interruptedInteraction: undefined,
			anchor: {
				...state.anchor,
				uiMessageTs: restored.anchor?.messageTs ?? state.anchor.uiMessageTs,
				turnId: restored.turnId,
				interactionId: restored.interactionId,
			},
		},
		effects: stateEffects(revision),
	}
}

/** Reduce one causal interaction response without reading message history. */
function reduceInteractionResponse(
	state: TaskRuntimeState,
	event: Extract<TaskEvent, { type: "INTERACTION_RESPONDED" }>,
): TransitionResult {
	if (!state.interaction || event.response.stateRevision !== state.revision) {
		return reject(state, event.type, "stale_interaction")
	}
	const result = reduceInteraction(state.interaction, event.response)
	if (!result.accepted) {
		return reject(state, event.type, result.error.code)
	}
	const revision = state.revision + 1
	const effects = interactionResponseEffects(state.interaction, event.response, revision)
	if (state.interaction.kind === "hosted_web_approval") {
		const phase = event.response.actionId === "approve" ? TaskPhase.STREAMING : TaskPhase.PAUSED
		if (!canTransition(state.phase, phase)) {
			return reject(state, event.type)
		}
		return accept(state, {
			eventType: event.type,
			phase,
			interaction: result.next,
			anchor: { ...state.anchor },
			effects,
		})
	}
	const turn = state.turn
	if (!turn || turn.turnId !== event.response.turnId) {
		return acceptInteraction(state, result.next, state.anchor, effects)
	}
	const block = turn.blocks.find((candidate) => candidate.dlineTid === event.response.interactionId)
	if (!block || block.phase !== BlockPhase.AWAITING_APPROVAL || turn.activeDlineTid !== block.dlineTid) {
		return acceptInteraction(state, result.next, state.anchor, effects)
	}
	if (event.response.actionId === "approve") {
		const nextTurn = replaceTurnBlock(state, block.dlineTid, BlockPhase.EXECUTING, block.dlineTid)
		if (!nextTurn || !canTransition(state.phase, TaskPhase.EXECUTING)) {
			return reject(state, event.type)
		}
		return {
			accepted: true,
			next: { ...state, revision, phase: TaskPhase.EXECUTING, turn: nextTurn, interaction: result.next },
			effects,
		}
	}
	if (event.response.actionId === "reject") {
		let afterRejected = false
		const nextTurn = {
			...turn,
			activeDlineTid: undefined,
			blocks: turn.blocks.map((candidate) => {
				if (candidate.dlineTid === block.dlineTid) {
					afterRejected = true
					return { ...candidate, phase: BlockPhase.REJECTED }
				}
				if (afterRejected && candidate.phase === BlockPhase.STREAMING) {
					return { ...candidate, phase: BlockPhase.SKIPPED }
				}
				return candidate
			}),
		}
		return {
			accepted: true,
			next: { ...state, revision, phase: TaskPhase.BETWEEN_TURNS, turn: nextTurn, interaction: result.next },
			effects,
		}
	}
	return acceptInteraction(state, result.next, state.anchor, effects)
}

/** Create one opening interaction embedded in a lifecycle transaction. */
function openingInteraction(
	state: TaskRuntimeState,
	revision: number,
	input: {
		turnId: string
		interactionId: string
		kind: "resume" | "error_retry" | "mistake_limit" | "completion"
		persistedRequest?: boolean
		retryContent?: ClineContent[]
	},
): NonNullable<TaskRuntimeState["interaction"]> {
	return {
		taskId: state.taskId,
		turnId: input.turnId,
		interactionId: input.interactionId,
		kind: input.kind,
		status: "opening",
		createdRevision: revision,
		...(input.kind === "error_retry" && input.persistedRequest !== undefined
			? { persistedRequest: input.persistedRequest }
			: {}),
		...(input.kind === "error_retry" && input.retryContent?.length ? { retryContent: input.retryContent } : {}),
	}
}

/** Create the ordered effects for a lifecycle transaction that presents one interaction. */
function interactionEffects(
	revision: number,
	input: { interactionId: string; taskAsk: string; presentation: string; existingTs?: number },
): TaskEffect[] {
	return [
		{
			id: effectId(revision, 1),
			type: "APPEND_ASK",
			interactionId: input.interactionId,
			taskAsk: input.taskAsk,
			presentation: input.presentation,
			existingTs: input.existingTs,
		},
	]
}

/** Preserve every causal interaction that can still accept or finish a persisted response. */
function shouldPreserveInteractionOnTerminate(state: TaskRuntimeState): boolean {
	return state.interaction?.status === "awaiting" || state.interaction?.status === "resolving"
}

function reduceCancel(
	state: TaskRuntimeState,
	event: Extract<TaskEvent, { type: "TASK_CANCEL_REQUESTED" | "TASK_TERMINATE_REQUESTED" | "TASK_CANCELLED" }>,
): TransitionResult {
	if (event.type === "TASK_TERMINATE_REQUESTED") {
		return accept(state, {
			eventType: event.type,
			phase: TaskPhase.CANCELLING,
			cancellation: { source: "system", fromPhase: state.phase },
			...(shouldPreserveInteractionOnTerminate(state) ? {} : { interaction: null }),
		})
	}
	if (event.type === "TASK_CANCEL_REQUESTED") {
		if (!canTransition(state.phase, TaskPhase.CANCELLING)) {
			return reject(state, event.type)
		}
		const revision = state.revision + 1
		return accept(state, {
			eventType: event.type,
			phase: TaskPhase.CANCELLING,
			cancellation: { source: event.source, fromPhase: state.phase },
			supersededEffectRevision: Math.max(state.supersededEffectRevision ?? -1, state.revision),
			interaction: null,
			interruptedInteraction: null,
			effects: [
				{ id: effectId(revision, 1), type: "POST_TASK_VIEW" },
				{ id: effectId(revision, 2), type: "CANCEL_RUNTIME" },
				{ id: effectId(revision, 3), type: "PERSIST_SNAPSHOT" },
			],
		})
	}
	if (state.phase !== TaskPhase.CANCELLING) {
		return reject(state, event.type)
	}
	if (!event.resume) {
		return accept(state, { eventType: event.type, phase: TaskPhase.PAUSED, cancellation: null })
	}
	const revision = state.revision + 1
	return accept(state, {
		eventType: event.type,
		phase: TaskPhase.PAUSED,
		cancellation: null,
		interaction: openingInteraction(state, revision, { ...event.resume, kind: "resume" }),
		anchor: { ...state.anchor, turnId: event.resume.turnId, interactionId: event.resume.interactionId },
		effects: interactionEffects(revision, {
			interactionId: event.resume.interactionId,
			taskAsk: "resume_task",
			presentation: event.resume.presentation,
		}),
	})
}

/** Reduce retry and completion transactions without message-derived inference. */
function reduceRecovery(
	state: TaskRuntimeState,
	event: Extract<
		TaskEvent,
		{
			type:
				| "ERROR_RETRY_REQUESTED"
				| "MISTAKE_LIMIT_CONTINUE_REQUESTED"
				| "API_RETRY_SCHEDULED"
				| "API_RETRY_EXHAUSTED"
				| "MISTAKE_LIMIT_REACHED"
				| "ATTEMPT_COMPLETION_PRESENTED"
				| "COMPLETION_FEEDBACK_RECEIVED"
				| "TASK_CLEAR_REQUESTED"
		}
	>,
): TransitionResult {
	if (event.type === "API_RETRY_SCHEDULED") {
		if (state.interaction) {
			return reject(state, event.type)
		}
		const revision = state.revision + 1
		return {
			accepted: true,
			next: {
				...state,
				phase: TaskPhase.STREAMING,
				revision,
				anchor: { ...state.anchor, apiIndex: event.apiIndex },
			},
			effects: [
				{ id: effectId(revision, 1), type: "POST_TASK_VIEW" },
				{ id: effectId(revision, 2), type: "START_API", apiIndex: event.apiIndex },
				{ id: effectId(revision, 3), type: "PERSIST_SNAPSHOT" },
			],
		}
	}
	if (event.type === "ERROR_RETRY_REQUESTED") {
		if (state.interaction?.kind !== "error_retry" || state.interaction.status !== "resolving") {
			return reject(state, event.type)
		}
		if (!canTransition(state.phase, TaskPhase.STREAMING)) {
			return reject(state, event.type)
		}
		const revision = state.revision + 1
		return {
			accepted: true,
			next: {
				...state,
				phase: TaskPhase.STREAMING,
				revision,
				error: undefined,
				anchor: { ...state.anchor, apiIndex: event.apiIndex },
			},
			effects: [
				{ id: effectId(revision, 1), type: "POST_TASK_VIEW" },
				{
					id: effectId(revision, 2),
					type: "START_API",
					apiIndex: event.apiIndex,
					draft: event.draft,
					persistedRequest: event.persistedRequest !== false,
					...((event.retryContent ?? state.interaction.retryContent)?.length
						? { retryContent: event.retryContent ?? state.interaction.retryContent }
						: {}),
				},
				{ id: effectId(revision, 3), type: "PERSIST_SNAPSHOT" },
			],
		}
	}
	if (event.type === "MISTAKE_LIMIT_CONTINUE_REQUESTED") {
		if (state.interaction?.kind !== "mistake_limit" || state.interaction.status !== "resolving") {
			return reject(state, event.type)
		}
		if (!canTransition(state.phase, TaskPhase.STREAMING)) {
			return reject(state, event.type)
		}
		const revision = state.revision + 1
		return {
			accepted: true,
			next: {
				...state,
				phase: TaskPhase.STREAMING,
				revision,
				error: undefined,
				anchor: { ...state.anchor, apiIndex: event.apiIndex },
			},
			effects: [
				{ id: effectId(revision, 1), type: "POST_TASK_VIEW" },
				{
					id: effectId(revision, 2),
					type: "START_API",
					apiIndex: event.apiIndex,
					draft: event.draft,
					contentTransform: "mistake_limit",
				},
				{ id: effectId(revision, 3), type: "PERSIST_SNAPSHOT" },
			],
		}
	}
	if (event.type === "API_RETRY_EXHAUSTED") {
		if (!canTransition(state.phase, TaskPhase.AWAITING_APPROVAL) || state.interaction) {
			return reject(state, event.type)
		}
		const revision = state.revision + 1
		return accept(state, {
			eventType: event.type,
			phase: TaskPhase.AWAITING_APPROVAL,
			interaction: openingInteraction(state, revision, { ...event, kind: "error_retry" }),
			anchor: { ...state.anchor, turnId: event.turnId, interactionId: event.interactionId },
			effects: interactionEffects(revision, {
				interactionId: event.interactionId,
				taskAsk: "api_req_failed",
				presentation: event.presentation,
			}),
		})
	}
	if (event.type === "MISTAKE_LIMIT_REACHED") {
		if (!canTransition(state.phase, TaskPhase.AWAITING_APPROVAL) || state.interaction) {
			return reject(state, event.type)
		}
		const revision = state.revision + 1
		return accept(state, {
			eventType: event.type,
			phase: TaskPhase.AWAITING_APPROVAL,
			interaction: openingInteraction(state, revision, { ...event, kind: "mistake_limit" }),
			anchor: {
				...state.anchor,
				apiIndex: event.apiIndex,
				turnId: event.turnId,
				interactionId: event.interactionId,
			},
			effects: interactionEffects(revision, {
				interactionId: event.interactionId,
				taskAsk: "mistake_limit_reached",
				presentation: event.presentation,
			}),
		})
	}
	if (event.type === "ATTEMPT_COMPLETION_PRESENTED") {
		if (!canTransition(state.phase, TaskPhase.COMPLETED) || state.interaction) {
			return reject(state, event.type)
		}
		const revision = state.revision + 1
		return accept(state, {
			eventType: event.type,
			phase: TaskPhase.COMPLETED,
			completion: { completionId: event.completionId },
			interaction: openingInteraction(state, revision, { ...event, kind: "completion" }),
			anchor: { ...state.anchor, turnId: event.turnId, interactionId: event.interactionId },
			effects: interactionEffects(revision, {
				interactionId: event.interactionId,
				taskAsk: "completion_result",
				presentation: event.presentation,
				existingTs: event.existingTs,
			}),
		})
	}
	if (event.type === "COMPLETION_FEEDBACK_RECEIVED") {
		if (
			state.phase !== TaskPhase.COMPLETED ||
			state.interaction?.kind !== "completion" ||
			state.interaction.status !== "resolving"
		) {
			return reject(state, event.type)
		}
		return accept(state, {
			eventType: event.type,
			phase: TaskPhase.STREAMING,
			interaction: null,
			completion: null,
			anchor: { ...state.anchor, interactionId: undefined },
		})
	}
	if (
		state.interaction?.status !== "resolving" ||
		(state.interaction.kind !== "completion" &&
			state.interaction.kind !== "error_retry" &&
			state.interaction.kind !== "mistake_limit")
	) {
		return reject(state, event.type)
	}
	const revision = state.revision + 1
	return {
		accepted: true,
		next: {
			...state,
			revision,
			interaction: undefined,
			anchor: { ...state.anchor, interactionId: undefined },
		},
		effects: [
			{ id: effectId(revision, 1), type: "POST_TASK_VIEW" },
			{ id: effectId(revision, 2), type: "PERSIST_SNAPSHOT" },
			{ id: effectId(revision, 3), type: "START_NEW_TASK", draft: event.draft },
		],
	}
}

/** Admit a successor only after the current assistant turn has fully closed. */
function reduceTaskSuccessor(
	state: TaskRuntimeState,
	event: Extract<TaskEvent, { type: "TASK_SUCCESSOR_REQUESTED" | "TASK_SUCCESSOR_START_COMMITTED" }>,
): TransitionResult {
	if (event.type === "TASK_SUCCESSOR_START_COMMITTED") {
		if (
			state.phase !== TaskPhase.CANCELLING ||
			state.cancellation?.source !== "system" ||
			state.newTaskConsumed?.functionId !== event.source.functionId ||
			state.newTaskConsumed.dlineTid !== event.source.dlineTid
		) {
			return reject(state, event.type)
		}
		return accept(state, {
			eventType: event.type,
			phase: TaskPhase.ABORTED,
			cancellation: null,
			interaction: null,
		})
	}

	if (state.phase !== TaskPhase.BETWEEN_TURNS || state.interaction || state.newTaskConsumed) {
		return reject(state, event.type)
	}
	const revision = state.revision + 1
	return accept(state, {
		eventType: event.type,
		phase: TaskPhase.CANCELLING,
		cancellation: { source: "system", fromPhase: state.phase },
		newTaskConsumed: { ...event.handoff.source },
		supersededEffectRevision: Math.max(state.supersededEffectRevision ?? -1, state.revision),
		interaction: null,
		effects: [
			{ id: effectId(revision, 1), type: "POST_TASK_VIEW" },
			{ id: effectId(revision, 2), type: "PERSIST_SNAPSHOT" },
			{ id: effectId(revision, 3), type: "START_SUCCESSOR_TASK", handoff: event.handoff },
		],
	})
}

/** Commit a checkpoint chat rewind as one canonical runtime boundary. */
function reduceCheckpointRestore(
	state: TaskRuntimeState,
	event: Extract<TaskEvent, { type: "CHECKPOINT_CHAT_RESTORED" }>,
): TransitionResult {
	if (event.apiIndex < -1 || !Number.isInteger(event.apiIndex)) {
		return reject(state, event.type)
	}
	const revision = state.revision + 1
	const resume = event.draft
		? undefined
		: (event.resume ?? {
				turnId: `checkpoint-resume:${state.taskId}:${revision}`,
				interactionId: `checkpoint-resume:${state.taskId}:${revision}`,
				presentation: "",
			})
	const baseState: TaskRuntimeState = {
		...state,
		phase: event.draft ? TaskPhase.RESUMING : TaskPhase.PAUSED,
		revision,
		supersededEffectRevision: Math.max(state.supersededEffectRevision ?? -1, state.revision),
		anchor: resume
			? { apiIndex: event.apiIndex, turnId: resume.turnId, interactionId: resume.interactionId }
			: { apiIndex: event.apiIndex },
	}
	delete baseState.turn
	delete baseState.interaction
	delete baseState.cancellation
	delete baseState.error
	delete baseState.completion
	if (resume) {
		baseState.interaction = openingInteraction(state, revision, { ...resume, kind: "resume" })
	}
	return {
		accepted: true,
		next: baseState,
		effects: event.draft
			? [
					{ id: effectId(revision, 1), type: "POST_TASK_VIEW" },
					{ id: effectId(revision, 2), type: "START_API", apiIndex: event.apiIndex, draft: event.draft },
					{ id: effectId(revision, 3), type: "PERSIST_SNAPSHOT" },
				]
			: interactionEffects(revision, {
					interactionId: resume!.interactionId,
					taskAsk: "resume_task",
					presentation: resume!.presentation,
				}),
	}
}

/** Reduce one resume request without performing side effects. */
function reduceResume(state: TaskRuntimeState, event: Extract<TaskEvent, { type: "TASK_RESUME_REQUESTED" }>): TransitionResult {
	if (state.phase !== TaskPhase.PAUSED) {
		return reject(state, event.type)
	}
	if (
		!state.interaction ||
		state.interaction.kind !== "resume" ||
		state.interaction.status !== "resolving" ||
		state.interaction.interactionId !== event.interactionId
	) {
		return reject(state, event.type)
	}
	const revision = state.revision + 1
	const hasVisibleDraft = Boolean(event.draft.text || event.draft.images.length > 0 || event.draft.files.length > 0)
	const abandonedTurn = state.turn
		? {
				...state.turn,
				activeDlineTid: undefined,
				blocks: state.turn.blocks.map((block) =>
					isTerminalBlock(block.phase) ? block : { ...block, phase: BlockPhase.CANCELLED },
				),
			}
		: undefined
	return accept(state, {
		eventType: event.type,
		phase: TaskPhase.RESUMING,
		...(abandonedTurn ? { turn: abandonedTurn } : {}),
		anchor: { ...state.anchor },
		error: null,
		effects: [
			{ id: effectId(revision, 1), type: "POST_TASK_VIEW" },
			{ id: effectId(revision, 2), type: "PREPARE_RESUME" },
			...(hasVisibleDraft
				? [
						{
							id: effectId(revision, 3),
							type: "APPEND_SAY" as const,
							taskSay: "user_feedback" as const,
							presentation: event.draft.text,
							images: event.draft.images,
							files: event.draft.files,
							interactionId: state.interaction.interactionId,
						},
					]
				: []),
			{
				id: effectId(revision, hasVisibleDraft ? 4 : 3),
				type: "START_API",
				apiIndex: state.anchor.apiIndex,
				draft: event.draft,
			},
			{ id: effectId(revision, hasVisibleDraft ? 5 : 4), type: "PERSIST_SNAPSHOT" },
		],
	})
}

/** Reduce one completion event without performing side effects. */
function reduceCompletion(state: TaskRuntimeState, event: Extract<TaskEvent, { type: "TASK_COMPLETED" }>): TransitionResult {
	if (!canTransition(state.phase, TaskPhase.COMPLETED)) {
		return reject(state, event.type)
	}
	return accept(state, {
		eventType: event.type,
		phase: TaskPhase.COMPLETED,
		completion: { completionId: event.completionId },
	})
}

/** Reduce one effect failure into an explicit paused recovery state. */
function reduceFailure(state: TaskRuntimeState, event: Extract<TaskEvent, { type: "EFFECT_FAILED" }>): TransitionResult {
	// A cancelled API/tool can reject after cancellation has completed and even
	// after the next input was admitted. Its failure cannot supersede newer work.
	if (event.originRevision <= (state.supersededEffectRevision ?? -1)) {
		return { accepted: true, next: state, effects: [] }
	}
	const originInteraction = event.originInteraction
	const currentInteraction = state.interaction
	const failedContinuation =
		(!originInteraction || !currentInteraction || currentInteraction.interactionId === originInteraction.interactionId) &&
		(currentInteraction ?? originInteraction)?.status === "resolving"
			? (currentInteraction ?? originInteraction)
			: undefined
	const retryableInteraction =
		failedContinuation?.anchor?.messageType === "ask" &&
		((failedContinuation.kind === "resume" && failedContinuation.acceptedResponse?.actionId === "resume") ||
			(failedContinuation.kind === "error_retry" && failedContinuation.acceptedResponse?.actionId === "retry") ||
			(failedContinuation.kind === "mistake_limit" && failedContinuation.acceptedResponse?.actionId === "process_anyway"))
			? failedContinuation
			: undefined
	const awaitingAnchoredInteraction =
		currentInteraction?.status === "awaiting" &&
		currentInteraction.anchor?.messageType === "ask" &&
		(event.effectType === "POST_TASK_VIEW" ||
			event.effectType === "PERSIST_SNAPSHOT" ||
			currentInteraction.createdRevision > event.originRevision)
			? currentInteraction
			: undefined
	const preservedInteraction = retryableInteraction ?? awaitingAnchoredInteraction
	const canPause = state.phase === TaskPhase.PAUSED || canTransition(state.phase, TaskPhase.PAUSED)
	const shouldCreateResume = !preservedInteraction && state.phase !== TaskPhase.COMPLETED && canPause
	const failedPhase = retryableInteraction
		? retryableInteraction.kind === "resume"
			? TaskPhase.PAUSED
			: TaskPhase.AWAITING_APPROVAL
		: awaitingAnchoredInteraction
			? state.phase
			: shouldCreateResume
				? TaskPhase.PAUSED
				: state.phase
	if (failedPhase !== state.phase && !canTransition(state.phase, failedPhase)) {
		return reject(state, event.type)
	}
	const revision = state.revision + 1
	const resumeInteractionId = `resume:${state.taskId}:effect:${event.originRevision}:${revision}`
	const recoveryInteraction = shouldCreateResume
		? openingInteraction(state, revision, {
				turnId: state.turn?.turnId ?? resumeInteractionId,
				interactionId: resumeInteractionId,
				kind: "resume",
			})
		: undefined
	const nextInteraction = preservedInteraction
		? { ...preservedInteraction, status: "awaiting" as const, createdRevision: revision }
		: recoveryInteraction
	const effects: TaskEffect[] = []
	if (event.effectType !== "PERSIST_SNAPSHOT") {
		effects.push({ id: effectId(revision, effects.length + 1), type: "PERSIST_SNAPSHOT" })
	}
	if (recoveryInteraction && event.effectType !== "APPEND_ASK") {
		effects.push({
			id: effectId(revision, effects.length + 1),
			type: "APPEND_ASK",
			interactionId: recoveryInteraction.interactionId,
			taskAsk: "resume_task",
			presentation: "",
		})
	} else if (event.effectType !== "POST_TASK_VIEW") {
		effects.push({ id: effectId(revision, effects.length + 1), type: "POST_TASK_VIEW" })
	}
	const next: TaskRuntimeState = {
		...state,
		phase: failedPhase,
		revision,
		...(nextInteraction ? { interaction: nextInteraction } : {}),
		...(nextInteraction
			? {
					anchor: {
						apiIndex: state.anchor.apiIndex,
						turnId: nextInteraction.turnId,
						interactionId: nextInteraction.interactionId,
						...(nextInteraction.anchor ? { uiMessageTs: nextInteraction.anchor.messageTs } : {}),
					},
				}
			: {}),
		error: {
			effectId: event.effectId,
			effectType: event.effectType,
			originRevision: event.originRevision,
			message: event.message,
		},
	}
	if (!nextInteraction) {
		delete next.interaction
	}
	if (failedPhase === TaskPhase.PAUSED) {
		delete next.cancellation
	}
	return {
		accepted: true,
		next,
		effects,
	}
}

/** Reduce a typed task event into the next state and ordered effects. */
export function reduceTask(state: TaskRuntimeState, event: TaskEvent): TransitionResult {
	switch (event.type) {
		case "TASK_INITIALIZE_REQUESTED":
		case "TASK_INITIALIZED":
			return reduceInitialize(state, event)
		case "PROFILE_RECOVERY_COMMITTED":
			return acceptProfileRecovery(state, event.interactionId)
		case "PROFILE_RECOVERY_INPUT_RECEIVED":
			return acceptProfileRecoveryInput(state, event)
		case "API_REQUEST_STARTED":
			return reduceApi(state, event)
		case "RESUME_API_CONTINUATION_REQUESTED":
			return reduceResumeApi(state, event)
		case "HOSTED_WEB_REQUEST_CONTINUATION_REQUESTED":
			return reduceHostedWebRequest(state, event)
		case "HOSTED_WEB_REQUEST_REJECTED":
			return reduceHostedWebRejection(state, event)
		case "RESUME_BLOCK_REPLAY_REQUESTED":
			return reduceResumeBlocks(state, event)
		case "TURN_CREATED":
		case "BLOCK_READY":
		case "BLOCK_APPROVAL_REQUIRED":
		case "BLOCK_APPROVED":
		case "BLOCK_REJECTED":
		case "BLOCK_EXECUTION_STARTED":
		case "BLOCK_EXECUTION_REJECTED":
		case "BLOCK_EXECUTION_COMPLETED":
		case "TURN_COMPLETED":
			return reduceTurn(state, event)
		case "APPROVAL_REQUIRED":
			return reduceApproval(state, event)
		case "INTERACTION_OPEN_REQUESTED":
			return reduceInteractionOpen(state, event)
		case "INTERACTION_INTERRUPT_REQUESTED":
			return reduceInteractionInterrupt(state, event)
		case "INTERACTION_PRESENTED":
			return reduceInteractionPresented(state, event)
		case "INTERACTION_RESPONDED":
			return reduceInteractionResponse(state, event)
		case "INTERACTION_RESOLVED":
			return reduceInteractionResolved(state, event)
		case "TASK_CANCEL_REQUESTED":
		case "TASK_TERMINATE_REQUESTED":
		case "TASK_CANCELLED":
			return reduceCancel(state, event)
		case "ERROR_RETRY_REQUESTED":
		case "MISTAKE_LIMIT_CONTINUE_REQUESTED":
		case "API_RETRY_SCHEDULED":
		case "API_RETRY_EXHAUSTED":
		case "MISTAKE_LIMIT_REACHED":
		case "ATTEMPT_COMPLETION_PRESENTED":
		case "COMPLETION_FEEDBACK_RECEIVED":
		case "TASK_CLEAR_REQUESTED":
			return reduceRecovery(state, event)
		case "TASK_SUCCESSOR_REQUESTED":
		case "TASK_SUCCESSOR_START_COMMITTED":
			return reduceTaskSuccessor(state, event)
		case "CHECKPOINT_CHAT_RESTORED":
			return reduceCheckpointRestore(state, event)
		case "TASK_RESUME_REQUESTED":
			return reduceResume(state, event)
		case "TASK_COMPLETED":
			return reduceCompletion(state, event)
		case "EFFECT_FAILED":
			return reduceFailure(state, event)
	}
}
