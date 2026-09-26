import type { ClineAsk, ClineMessage } from "@shared/ExtensionMessage"
import type { ClineStorageMessage } from "@shared/messages"
import cloneDeep from "clone-deep"
import { BlockPhase } from "../BlockPhaseMachine"
import { hostedWebApprovalApiIndex } from "../interaction/HostedWebApproval"
import type { InteractionKind } from "../interaction/Interaction"
import { getInteraction } from "../interaction/InteractionRegistry"
import { TaskPhase } from "../TaskPhase"
import { createSnapshot, hydrateSnapshot, type TaskSnapshot } from "../TaskSnapshot"
import type { ResumeDiagnostic, ResumeEntry, ResumeInput, ResumeResult } from "./ResumeInput"
import { selectResumeUiTail } from "./ResumeInput"
import { selectAwaitingResumeEntry } from "./ResumeReducer"
import { buildResumeSnapshot } from "./ResumeSnapshotBuilder"
import { foldResumeTail } from "./ResumeTailFold"

const ASK_INTERACTIONS: Partial<Record<ClineAsk, InteractionKind>> = {
	tool: "tool_approval",
	command: "command_approval",
	browser_action_launch: "browser_approval",
	use_mcp_server: "mcp_approval",
	use_subagents: "subagent_approval",
	spawn_task: "spawn_task_approval",
	change_todo_list: "change_todo_list",
	new_task: "new_task",
	report_bug: "report_bug",
	condense: "condense",
	followup: "followup",
	make_plan: "make_plan",
	qna_respond: "qna_response",
	generate_report: "generate_report",
	status_acknowledgment: "status_acknowledgment",
	api_req_failed: "error_retry",
	mistake_limit_reached: "mistake_limit",
	completion_result: "completion",
	resume_completed_task: "completion",
	resume_task: "resume",
}

const TERMINAL_BLOCK_PHASES = new Set([BlockPhase.COMPLETED, BlockPhase.REJECTED, BlockPhase.SKIPPED, BlockPhase.CANCELLED])
const BLOCK_APPROVAL_INTERACTIONS = new Set<InteractionKind>([
	"tool_approval",
	"command_approval",
	"browser_approval",
	"mcp_approval",
	"subagent_approval",
	"spawn_task_approval",
	"change_todo_list",
])

function cloneSnapshot(snapshot: TaskSnapshot): TaskSnapshot {
	return createSnapshot(hydrateSnapshot(snapshot), snapshot.timestamp)
}

function legacyHostedWebApiIndex(taskId: string, interactionId: string): number | undefined {
	const approvalIndex = hostedWebApprovalApiIndex(taskId, interactionId)
	if (approvalIndex !== undefined) return approvalIndex
	const prefix = `hosted-web-rejected:${taskId}:`
	if (!interactionId.startsWith(prefix)) return undefined
	const rawIndex = interactionId.slice(prefix.length)
	if (!/^(0|[1-9]\d*)$/.test(rawIndex)) return undefined
	const apiIndex = Number(rawIndex)
	return Number.isSafeInteger(apiIndex) ? apiIndex : undefined
}

function isLegacyHostedWebInteraction(snapshot: TaskSnapshot, interactionId: string | undefined): boolean {
	return Boolean(snapshot.taskId && interactionId && legacyHostedWebApiIndex(snapshot.taskId, interactionId) !== undefined)
}

/** Convert obsolete Hosted capability approvals into an inert persisted-request Resume. */
function migrateLegacyHostedWebInteraction(
	snapshot: TaskSnapshot,
	apiHistory: readonly ClineStorageMessage[] | undefined,
): boolean {
	const identities = [
		snapshot.interaction?.interactionId,
		snapshot.interruptedInteraction?.interactionId,
		snapshot.anchor?.interactionId,
	]
	const legacyId = identities.find((interactionId) => isLegacyHostedWebInteraction(snapshot, interactionId))
	if (!legacyId) return false
	// Never resurrect an obsolete interrupted approval if the request tail is
	// invalid and the primary interaction falls back to an ordinary Resume.
	if (isLegacyHostedWebInteraction(snapshot, snapshot.interruptedInteraction?.interactionId)) {
		snapshot.interruptedInteraction = undefined
	}
	const apiIndex = snapshot.taskId ? legacyHostedWebApiIndex(snapshot.taskId, legacyId) : undefined
	if (apiIndex === undefined || apiIndex !== snapshot.anchor?.apiIndex) return false
	const request = apiHistory?.[apiIndex]
	if (apiHistory?.length !== apiIndex + 1 || request?.role !== "user" || !Array.isArray(request.content)) {
		return false
	}

	snapshot.interaction = undefined
	snapshot.interruptedInteraction = undefined
	snapshot.completion = undefined
	snapshot.phase = TaskPhase.PAUSED
	snapshot.anchor = { apiIndex }
	return true
}

function isValidAnchor(snapshot: TaskSnapshot, historyLength: number): boolean {
	const index = snapshot.anchor?.apiIndex
	return (
		index !== undefined &&
		Number.isInteger(index) &&
		index >= -1 &&
		index < historyLength &&
		(snapshot.anchor?.uiMessageTs === undefined ||
			(Number.isInteger(snapshot.anchor.uiMessageTs) && snapshot.anchor.uiMessageTs >= 0))
	)
}

type SnapshotRebuildReason = Extract<ResumeDiagnostic, { code: "snapshot_rebuilt" }>["reason"]

function rebuildReason(error: unknown, snapshot: TaskSnapshot | undefined, taskId: string): SnapshotRebuildReason {
	if (!snapshot) return "missing"
	if (snapshot.taskId !== taskId) return "task_mismatch"
	if (error instanceof Error && error.message === "corrupt_anchor") return "corrupt_anchor"
	return "invalid"
}

interface PreparedResumeInput {
	snapshot: TaskSnapshot
	apiTail: readonly ClineStorageMessage[]
	apiHistory?: readonly ClineStorageMessage[]
	uiTail: readonly ClineMessage[]
	apiTailStartIndex: number
	diagnostics: ResumeDiagnostic[]
}

function prepareInput(input: ResumeInput): PreparedResumeInput {
	const fullUiHistory = input.uiHistory ?? input.uiTail
	try {
		if (!input.snapshot) throw new Error("snapshot_missing")
		const snapshot = cloneSnapshot(input.snapshot)
		if (snapshot.taskId !== input.taskId) throw new Error("task_mismatch")
		if (!isValidAnchor(snapshot, input.apiHistory?.length ?? input.apiHistoryLength)) {
			throw new Error("corrupt_anchor")
		}
		return {
			snapshot,
			apiTail: input.apiHistory ? input.apiHistory.slice(snapshot.apiIndex + 1) : input.apiTail,
			apiHistory: input.apiHistory,
			uiTail: input.uiHistory ? selectResumeUiTail(snapshot, input.uiHistory) : input.uiTail,
			apiTailStartIndex: input.apiHistory ? snapshot.apiIndex + 1 : (input.apiTailStartIndex ?? snapshot.apiIndex + 1),
			diagnostics: [],
		}
	} catch (error) {
		const reason = rebuildReason(error, input.snapshot, input.taskId)
		const apiHistory =
			input.apiHistory ?? (input.apiTailStartIndex === 0 || input.apiTailStartIndex === undefined ? input.apiTail : [])
		const built = buildResumeSnapshot({ taskId: input.taskId, uiHistory: fullUiHistory, apiHistory })
		const snapshot = cloneSnapshot(built.snapshot)
		return {
			snapshot,
			apiTail: apiHistory.slice(built.apiTailStartIndex),
			apiHistory,
			uiTail: built.apiTailStartIndex === 0 ? fullUiHistory : selectResumeUiTail(snapshot, fullUiHistory),
			apiTailStartIndex: built.apiTailStartIndex,
			diagnostics: [{ code: "snapshot_rebuilt", reason }],
		}
	}
}

function isPendingCommandApproval(snapshot: TaskSnapshot, message: ClineMessage): boolean {
	if (message.type !== "ask" || message.ask !== "command") return false
	if (message.commandStatus !== undefined && message.commandStatus !== "pending") return false
	const block = snapshot.turn?.blocks.find((candidate) => candidate.dlineTid === message.interactionId)
	return !block || !TERMINAL_BLOCK_PHASES.has(block.phase)
}

function interactionKind(snapshot: TaskSnapshot, message: ClineMessage): InteractionKind | undefined {
	if (message.type !== "ask" || !message.ask) return undefined
	if (isLegacyHostedWebInteraction(snapshot, message.interactionId)) return undefined
	if (message.ask === "command" && !isPendingCommandApproval(snapshot, message)) return undefined
	const currentInteraction = snapshot.interaction
	let knownKind: InteractionKind | undefined
	if (currentInteraction && message.interactionId === currentInteraction.interactionId) {
		knownKind = currentInteraction.kind
	}
	const kind = knownKind ?? ASK_INTERACTIONS[message.ask]
	if (!kind || !BLOCK_APPROVAL_INTERACTIONS.has(kind)) return kind
	const block = snapshot.turn?.blocks.find((candidate) => candidate.dlineTid === message.interactionId)
	return block && TERMINAL_BLOCK_PHASES.has(block.phase) ? undefined : kind
}

function clearInteractionOwnership(snapshot: TaskSnapshot, interactionId: string): void {
	snapshot.interaction = undefined
	snapshot.completion = undefined
	if (snapshot.anchor?.interactionId === interactionId) {
		snapshot.anchor = { ...snapshot.anchor, interactionId: undefined, uiMessageTs: undefined }
	}
	if (snapshot.turn?.activeDlineTid === interactionId) snapshot.turn.activeDlineTid = undefined
}

function retireTerminalBlockApproval(snapshot: TaskSnapshot): string | undefined {
	const interaction = snapshot.interaction
	if (!interaction || !BLOCK_APPROVAL_INTERACTIONS.has(interaction.kind)) return undefined
	const block = snapshot.turn?.blocks.find((candidate) => candidate.dlineTid === interaction.interactionId)
	if (!block || !TERMINAL_BLOCK_PHASES.has(block.phase)) return undefined
	clearInteractionOwnership(snapshot, interaction.interactionId)
	return interaction.interactionId
}

function retireAcceptedBlockApproval(snapshot: TaskSnapshot): string | undefined {
	const interaction = snapshot.interaction
	if (
		!interaction ||
		interaction.kind === "command_approval" ||
		!BLOCK_APPROVAL_INTERACTIONS.has(interaction.kind) ||
		interaction.status !== "resolving"
	) {
		return undefined
	}
	const block = snapshot.turn?.blocks.find((candidate) => candidate.dlineTid === interaction.interactionId)
	if (block && !TERMINAL_BLOCK_PHASES.has(block.phase)) {
		block.phase = BlockPhase.EXECUTING
		block.requiresApproval = false
	}
	clearInteractionOwnership(snapshot, interaction.interactionId)
	return interaction.interactionId
}

function retireCommandApproval(snapshot: TaskSnapshot, uiMessages: readonly ClineMessage[]): string | undefined {
	const interaction = snapshot.interaction
	if (interaction?.kind !== "command_approval") return undefined
	let commandMessage: ClineMessage | undefined
	for (let index = uiMessages.length - 1; index >= 0; index--) {
		const candidate = uiMessages[index]
		if (candidate?.type === "ask" && candidate.ask === "command" && candidate.interactionId === interaction.interactionId) {
			commandMessage = candidate
			break
		}
	}
	const block = snapshot.turn?.blocks.find((candidate) => candidate.dlineTid === interaction.interactionId)
	const responseAccepted = interaction.status === "resolving"
	const blockPassedApproval = block !== undefined && TERMINAL_BLOCK_PHASES.has(block.phase)
	const messagePassedApproval =
		commandMessage !== undefined && commandMessage.commandStatus !== undefined && commandMessage.commandStatus !== "pending"
	if (!responseAccepted && !blockPassedApproval && !messagePassedApproval) return undefined

	clearInteractionOwnership(snapshot, interaction.interactionId)
	if (!block) return interaction.interactionId

	block.requiresApproval = false
	switch (commandMessage?.commandStatus) {
		case "completed":
		case "failed":
			block.phase = BlockPhase.COMPLETED
			break
		case "cancelled":
		case "interrupted":
			block.phase = BlockPhase.CANCELLED
			break
		case "skipped":
			block.phase = BlockPhase.SKIPPED
			break
		default:
			if (!TERMINAL_BLOCK_PHASES.has(block.phase)) block.phase = BlockPhase.EXECUTING
	}
	return interaction.interactionId
}

/** Rebuild a stale snapshot's complete tool turn from one exact persisted ask anchor. */
function restoreAnchoredInteractionTurn(
	snapshot: TaskSnapshot,
	message: ClineMessage,
	uiMessages: readonly ClineMessage[],
	apiHistory: readonly ClineStorageMessage[] | undefined,
	diagnostics: ResumeDiagnostic[],
): Set<string> {
	const interactionId = message.interactionId
	if (!interactionId || snapshot.turn?.blocks.some((block) => block.dlineTid === interactionId)) return new Set()
	const apiIndex = message.conversationHistoryIndex
	if (!apiHistory || apiIndex === undefined || !Number.isInteger(apiIndex) || apiIndex < 0) return new Set()
	const anchored = apiHistory[apiIndex]
	const matchingBlocks =
		anchored?.role === "assistant" && Array.isArray(anchored.content)
			? anchored.content.filter((block) => block.type === "tool_use" && block.dline_tid === interactionId)
			: []
	if (matchingBlocks.length !== 1 || !anchored) return new Set()

	const restored = foldResumeTail({
		snapshot,
		apiTail: [anchored],
		uiTail: uiMessages,
		apiTailStartIndex: apiIndex,
	})
	diagnostics.push(...restored.diagnostics)
	return restored.answeredDlineTids
}

function bindPersistedInteraction(snapshot: TaskSnapshot, message: ClineMessage, kind: InteractionKind): void {
	const interactionId = message.interactionId
	const taskId = snapshot.taskId
	if (!interactionId || !taskId) return
	const matchingTurn = snapshot.turn?.blocks.some((block) => block.dlineTid === interactionId) ? snapshot.turn : undefined
	const existing = snapshot.interaction?.interactionId === interactionId ? snapshot.interaction : undefined
	const turnId = matchingTurn?.turnId ?? existing?.turnId ?? snapshot.anchor?.turnId ?? `turn:${interactionId}`
	const status = existing?.status === "resolving" ? "resolving" : "awaiting"
	snapshot.interaction = {
		taskId,
		turnId,
		interactionId,
		kind,
		status,
		createdRevision: existing?.createdRevision ?? snapshot.revision ?? 0,
		...((kind === "error_retry" || kind === "resume") && existing?.persistedRequest !== undefined
			? { persistedRequest: existing.persistedRequest }
			: {}),
		...(kind === "error_retry" && existing?.retryContent ? { retryContent: cloneDeep(existing.retryContent) } : {}),
		// A completed task rebinds through `resume_completed_task` while still
		// driving the `completion` kind, so the kind cannot name its entry ask.
		// Persist the ask actually presented for the Webview to match against.
		anchor: { messageTs: message.ts, messageType: "ask", ...(message.ask ? { taskAsk: message.ask } : {}) },
		...(status === "resolving" && existing?.acceptedResponse ? { acceptedResponse: existing.acceptedResponse } : {}),
	}
	snapshot.anchor = {
		apiIndex: snapshot.anchor?.apiIndex ?? snapshot.apiIndex,
		turnId,
		interactionId,
		uiMessageTs: message.ts,
	}

	if (matchingTurn) {
		const block = matchingTurn.blocks.find((candidate) => candidate.dlineTid === interactionId)
		if (block && !TERMINAL_BLOCK_PHASES.has(block.phase)) {
			block.phase = BlockPhase.AWAITING_APPROVAL
			block.requiresApproval = true
			matchingTurn.activeDlineTid = interactionId
		}
	}

	if (kind === "completion") {
		snapshot.phase = TaskPhase.COMPLETED
		snapshot.completion = { completionId: interactionId }
	} else if (kind === "resume") {
		snapshot.phase = TaskPhase.PAUSED
		snapshot.completion = undefined
	} else {
		snapshot.phase = TaskPhase.AWAITING_APPROVAL
		snapshot.completion = undefined
	}
}

/** Verify that a restored handler interaction still owns one canonical tool block. */
function retainInteractionWithContinuation(
	snapshot: TaskSnapshot,
	interactionId: string,
	kind: InteractionKind,
	diagnostics: ResumeDiagnostic[],
): boolean {
	if (kind === "resume" || kind === "error_retry" || kind === "mistake_limit") {
		return true
	}
	const interaction = snapshot.interaction
	const turn = snapshot.turn
	if (
		interaction?.interactionId === interactionId &&
		turn?.turnId === interaction.turnId &&
		turn.blocks.filter((block) => block.dlineTid === interactionId).length === 1
	) {
		return true
	}

	diagnostics.push({ code: "missing_interaction_continuation", interactionId })
	clearInteractionOwnership(snapshot, interactionId)
	return false
}

function reconcilePersistedInteraction(
	snapshot: TaskSnapshot,
	uiMessages: readonly ClineMessage[],
	initialAnsweredDlineTids: ReadonlySet<string>,
	apiHistory: readonly ClineStorageMessage[] | undefined,
	diagnostics: ResumeDiagnostic[],
): void {
	const answeredDlineTids = new Set(initialAnsweredDlineTids)
	const current = snapshot.interaction
	if (current && answeredDlineTids.has(current.interactionId)) {
		snapshot.interaction = undefined
		snapshot.completion = undefined
	}
	for (const retiredInteractionId of [
		retireTerminalBlockApproval(snapshot),
		retireCommandApproval(snapshot, uiMessages),
		retireAcceptedBlockApproval(snapshot),
	]) {
		if (retiredInteractionId) answeredDlineTids.add(retiredInteractionId)
	}

	const currentTurnIndex = snapshot.turn?.assistantApiIndex ?? snapshot.apiIndex
	let latest: { message: ClineMessage; kind: InteractionKind } | undefined
	for (const message of uiMessages) {
		const kind = interactionKind(snapshot, message)
		if (!kind || !message.interactionId || answeredDlineTids.has(message.interactionId)) continue
		const preservesKnownIdentity =
			message.interactionId === snapshot.interaction?.interactionId ||
			message.interactionId === snapshot.completion?.completionId
		if (
			!preservesKnownIdentity &&
			message.conversationHistoryIndex !== undefined &&
			message.conversationHistoryIndex < currentTurnIndex
		) {
			continue
		}
		latest = { message, kind }
	}

	if (!latest) {
		if (snapshot.interaction) {
			if (snapshot.interaction.kind === "completion") {
				if (
					!retainInteractionWithContinuation(
						snapshot,
						snapshot.interaction.interactionId,
						snapshot.interaction.kind,
						diagnostics,
					)
				) {
					return
				}
				snapshot.phase = TaskPhase.COMPLETED
				snapshot.completion = { completionId: snapshot.interaction.interactionId }
				snapshot.interaction.status = "opening"
				snapshot.interaction.anchor = undefined
				snapshot.interaction.acceptedResponse = undefined
				snapshot.anchor = {
					apiIndex: snapshot.anchor?.apiIndex ?? snapshot.apiIndex,
					turnId: snapshot.interaction.turnId,
					interactionId: snapshot.interaction.interactionId,
				}
				return
			}
			const expectedAsk = getInteraction(snapshot.interaction.kind).taskAsk
			const anchored = uiMessages.find(
				(message) =>
					message.type === "ask" &&
					message.ask === expectedAsk &&
					message.interactionId === snapshot.interaction?.interactionId &&
					interactionKind(snapshot, message) === snapshot.interaction?.kind,
			)
			if (anchored) {
				const interactionId = snapshot.interaction.interactionId
				const kind = snapshot.interaction.kind
				bindPersistedInteraction(snapshot, anchored, kind)
				retainInteractionWithContinuation(snapshot, interactionId, kind, diagnostics)
				return
			}
			diagnostics.push({ code: "missing_interaction_anchor", interactionId: snapshot.interaction.interactionId })
			snapshot.interaction = undefined
			snapshot.completion = undefined
		}
		return
	}

	const interactionId = latest.message.interactionId
	if (!interactionId) return
	for (const dlineTid of restoreAnchoredInteractionTurn(snapshot, latest.message, uiMessages, apiHistory, diagnostics)) {
		answeredDlineTids.add(dlineTid)
	}
	if (answeredDlineTids.has(interactionId)) return
	bindPersistedInteraction(snapshot, latest.message, latest.kind)
	retainInteractionWithContinuation(snapshot, interactionId, latest.kind, diagnostics)
}

/** Restore the user-visible phase after a system stop while preserving its durable interaction. */
export function normalizeStoppedTaskSnapshot(snapshot: TaskSnapshot): void {
	snapshot.cancellation = undefined
	if (snapshot.interaction) {
		if (snapshot.phase === TaskPhase.CANCELLING) {
			snapshot.phase =
				snapshot.interaction.kind === "resume"
					? TaskPhase.PAUSED
					: snapshot.interaction.kind === "completion"
						? TaskPhase.COMPLETED
						: TaskPhase.AWAITING_APPROVAL
		}
		return
	}
	if (snapshot.phase === TaskPhase.COMPLETED && snapshot.completion) return
	snapshot.phase = TaskPhase.PAUSED
}

/** Remove an approval owner that no longer identifies an awaiting approval block. */
function clearStaleApprovalOwner(snapshot: TaskSnapshot): void {
	const turn = snapshot.turn
	if (!turn?.activeDlineTid) return
	const activeBlock = turn.blocks.find((block) => block.dlineTid === turn.activeDlineTid)
	if (!activeBlock || activeBlock.phase !== BlockPhase.AWAITING_APPROVAL) {
		turn.activeDlineTid = undefined
	}
}

/** Recover the narrow close race after completion is visible but before its interaction opens. */
function restorePresentedCompletion(snapshot: TaskSnapshot, uiMessages: readonly ClineMessage[]): void {
	if (
		snapshot.interaction ||
		snapshot.completion ||
		snapshot.phase !== TaskPhase.CANCELLING ||
		snapshot.cancellation?.source !== "system" ||
		(snapshot.cancellation.fromPhase !== TaskPhase.STREAMING && snapshot.cancellation.fromPhase !== TaskPhase.EXECUTING)
	) {
		return
	}

	const turn = snapshot.turn
	if (!turn) return
	const completionBlocks = turn.blocks.filter(
		(block) =>
			block.toolName === "attempt_completion" &&
			(block.phase === BlockPhase.EXECUTING ||
				block.phase === BlockPhase.AUTO_EXECUTING ||
				block.phase === BlockPhase.CANCELLED),
	)
	if (completionBlocks.length !== 1) return
	const completionBlock = completionBlocks[0]
	if (!completionBlock) return

	const hasPresentedResult = uiMessages.some(
		(message) =>
			message.type === "say" &&
			message.say === "completion_result" &&
			Boolean(message.text) &&
			message.ts === completionBlock.ts &&
			message.conversationHistoryIndex === turn.assistantApiIndex,
	)
	if (hasPresentedResult) {
		snapshot.completion = { completionId: completionBlock.dlineTid }
	}
}

/** Materialize an inert Resume interaction for a stopped state with no original interaction. */
function ensureResumeInteraction(snapshot: TaskSnapshot, persistedRequest = false): ResumeEntry {
	const taskId = snapshot.taskId
	if (!taskId) throw new Error("resume_snapshot_task_missing")
	const revision = (snapshot.revision ?? 0) + 1
	const apiIndex = snapshot.anchor?.apiIndex ?? snapshot.apiIndex
	const interactionId = `resume:${taskId}:${apiIndex}:${revision}`
	const turnId = snapshot.turn?.turnId ?? interactionId
	snapshot.revision = revision
	snapshot.phase = TaskPhase.PAUSED
	snapshot.interaction = {
		taskId,
		turnId,
		interactionId,
		kind: "resume",
		status: "opening",
		createdRevision: revision,
		...(persistedRequest ? { persistedRequest: true } : {}),
	}
	snapshot.anchor = { apiIndex, turnId, interactionId }
	return { type: "show_resume_interaction", interactionId, turnId }
}

/** Restore a completion footer even when the crash preceded its ask-row append. */
function ensureCompletionInteraction(snapshot: TaskSnapshot, entry: ResumeEntry): ResumeEntry {
	if (entry.type !== "show_completion_interaction" || snapshot.interaction) return entry
	const taskId = snapshot.taskId
	if (!taskId) throw new Error("completion_snapshot_task_missing")
	const revision = (snapshot.revision ?? 0) + 1
	snapshot.revision = revision
	snapshot.phase = TaskPhase.COMPLETED
	snapshot.interaction = {
		taskId,
		turnId: entry.turnId,
		interactionId: entry.interactionId,
		kind: "completion",
		status: "opening",
		createdRevision: revision,
	}
	snapshot.anchor = {
		apiIndex: snapshot.anchor?.apiIndex ?? snapshot.apiIndex,
		turnId: entry.turnId,
		interactionId: entry.interactionId,
	}
	return entry
}

function completionEntry(snapshot: TaskSnapshot): ResumeEntry | undefined {
	const completionId = snapshot.completion?.completionId
	if (!completionId) return undefined
	const completionBlock = snapshot.turn?.blocks.find(
		(block) => block.dlineTid === completionId && block.toolName === "attempt_completion",
	)
	if (!completionBlock) return undefined
	const turnId = snapshot.turn?.turnId ?? snapshot.anchor?.turnId
	if (!turnId) return undefined
	return { type: "show_completion_interaction", interactionId: completionId, turnId }
}

/** Reconcile persisted state into a stopped task without dispatching API or tool work. */
export function reconcileResume(input: ResumeInput): ResumeResult {
	const prepared = prepareInput(input)
	const diagnostics = [...prepared.diagnostics]
	const folded = foldResumeTail({
		snapshot: prepared.snapshot,
		apiTail: prepared.apiTail,
		uiTail: prepared.uiTail,
		apiTailStartIndex: prepared.apiTailStartIndex,
	})
	diagnostics.push(...folded.diagnostics)
	const next = folded.snapshot

	if (next.runtimeError) {
		diagnostics.push({ code: "unsafe_runtime_error", effectType: next.runtimeError.effectType })
		next.runtimeError = undefined
	}

	if (next.newTaskConsumed) {
		next.phase = TaskPhase.ABORTED
		next.cancellation = undefined
		next.interaction = undefined
		return {
			snapshot: next,
			entry: { type: "show_consumed_task" },
			diagnostics,
		}
	}

	const migratedHostedWebRequest = migrateLegacyHostedWebInteraction(next, prepared.apiHistory)
	reconcilePersistedInteraction(next, prepared.uiTail, folded.answeredDlineTids, prepared.apiHistory, diagnostics)
	clearStaleApprovalOwner(next)
	restorePresentedCompletion(next, input.uiHistory ?? prepared.uiTail)
	normalizeStoppedTaskSnapshot(next)

	if (migratedHostedWebRequest) {
		return { snapshot: next, entry: ensureResumeInteraction(next, true), diagnostics }
	}

	if (next.interaction) {
		if (next.interaction.status === "opening" && next.interaction.anchor) next.interaction.status = "awaiting"
		if (
			next.interaction.status === "resolving" &&
			(next.interaction.kind === "completion" ||
				next.interaction.kind === "resume" ||
				next.interaction.kind === "error_retry" ||
				next.interaction.kind === "mistake_limit")
		) {
			next.interaction.status = "awaiting"
			next.interaction.acceptedResponse = undefined
		}
		if (
			next.interaction.status === "resolving" &&
			next.interaction.kind !== "resume" &&
			next.interaction.kind !== "error_retry" &&
			next.interaction.kind !== "mistake_limit"
		) {
			next.interaction = undefined
			next.phase = TaskPhase.PAUSED
			return { snapshot: next, entry: ensureResumeInteraction(next), diagnostics }
		}
		return { snapshot: next, entry: selectAwaitingResumeEntry(next), diagnostics }
	}

	const completed = completionEntry(next)
	if (completed) return { snapshot: next, entry: ensureCompletionInteraction(next, completed), diagnostics }
	if (diagnostics.some((diagnostic) => diagnostic.code === "missing_interaction_anchor")) {
		return { snapshot: next, entry: ensureResumeInteraction(next), diagnostics }
	}

	const turn = next.turn
	const pending = turn?.blocks.filter((block) => !TERMINAL_BLOCK_PHASES.has(block.phase)) ?? []
	if (turn && pending.length > 0 && folded.diagnostics.length === 0) {
		const entry = ensureResumeInteraction(next)
		return {
			snapshot: next,
			entry,
			diagnostics,
		}
	}

	if (folded.diagnostics.length > 0) {
		return { snapshot: next, entry: ensureResumeInteraction(next), diagnostics }
	}
	return { snapshot: next, entry: ensureResumeInteraction(next), diagnostics }
}
