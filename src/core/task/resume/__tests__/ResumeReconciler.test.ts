import type { ClineMessage } from "@shared/ExtensionMessage"
import type { ClineStorageMessage } from "@shared/messages"
import { describe, expect, it } from "vitest"
import { BlockPhase } from "../../BlockPhaseMachine"
import type { InteractionKind } from "../../interaction/Interaction"
import { createTaskRuntimeState } from "../../runtime/TaskRuntimeState"
import { TaskPhase } from "../../TaskPhase"
import { createSnapshot, type TaskSnapshot } from "../../TaskSnapshot"
import { type ResumeInput, selectResumeUiTail } from "../ResumeInput"
import { reconcileResume } from "../ResumeReconciler"

const TASK_ID = "task-resume"

function apiUser(content = "task"): ClineStorageMessage {
	return { role: "user", content }
}

function persistedApiUser(): ClineStorageMessage {
	return { role: "user", content: [{ type: "text", text: "A durable request" }] }
}

function assistantTool(dlineTid: string, functionId: string, name = "read_file"): ClineStorageMessage {
	return {
		role: "assistant",
		ts: 200,
		content: [{ type: "tool_use", name, input: {}, function_id: functionId, dline_tid: dlineTid }],
	}
}

function assistantThinking(): ClineStorageMessage {
	return {
		role: "assistant",
		ts: 200,
		content: [{ type: "thinking", thinking: "Considering the next step.", signature: "thinking-signature" }],
	}
}

function toolResult(dlineTid: string, functionId: string): ClineStorageMessage {
	return {
		role: "user",
		content: [{ type: "tool_result", content: "ok", function_id: functionId, dline_tid: dlineTid }],
	}
}

function partialResult(dlineTid: string, functionId: string, ts = 210): ClineMessage {
	return {
		ts,
		type: "say",
		say: "partial_tool_result",
		conversationHistoryIndex: 1,
		text: JSON.stringify({ function_id: functionId, dline_tid: dlineTid, result: "durable" }),
	}
}

function interactionAsk(
	ask: NonNullable<ClineMessage["ask"]>,
	interactionId: string,
	conversationHistoryIndex = 1,
	ts = 205,
): ClineMessage {
	return { ts, type: "ask", ask, text: "{}", interactionId, conversationHistoryIndex }
}

function baseline(apiIndex = 0): TaskSnapshot {
	return createSnapshot(
		createTaskRuntimeState({
			taskId: TASK_ID,
			phase: TaskPhase.STREAMING,
			revision: 2,
			anchor: { apiIndex },
		}),
		100,
	)
}

function consumedNewTaskSnapshot(): TaskSnapshot {
	const state = createTaskRuntimeState({
		taskId: TASK_ID,
		phase: TaskPhase.ABORTED,
		revision: 9,
		anchor: { apiIndex: 1, turnId: "turn:new-task" },
	})
	state.newTaskConsumed = {
		functionId: "fn-new-task",
		dlineTid: "tid-new-task",
	}
	return createSnapshot(state, 206)
}

function snapshotWithTurn(
	dlineTid: string,
	functionId: string,
	options: {
		toolName?: string
		blockPhase?: BlockPhase
		interaction?: InteractionKind
		interactionStatus?: "opening" | "awaiting" | "resolving"
	} = {},
): TaskSnapshot {
	const state = createTaskRuntimeState({
		taskId: TASK_ID,
		phase: options.interaction ? TaskPhase.AWAITING_APPROVAL : TaskPhase.EXECUTING,
		revision: 4,
		anchor: { apiIndex: 1, turnId: `turn:${dlineTid}` },
	})
	state.turn = {
		turnId: `turn:${dlineTid}`,
		assistantApiIndex: 1,
		mode: "serial",
		blocks: [
			{
				dlineTid,
				functionId,
				toolName: options.toolName ?? "read_file",
				phase: options.blockPhase ?? BlockPhase.EXECUTING,
				ts: 200,
				requiresApproval: Boolean(options.interaction),
				conversationHistoryIndex: 1,
			},
		],
	}
	if (options.interaction) {
		const status = options.interactionStatus ?? "awaiting"
		state.anchor = { ...state.anchor, interactionId: dlineTid, uiMessageTs: 205 }
		state.interaction = {
			taskId: TASK_ID,
			turnId: state.turn.turnId,
			interactionId: dlineTid,
			kind: options.interaction,
			status,
			createdRevision: 3,
			anchor: { messageTs: 205, messageType: "ask" },
			...(status === "resolving"
				? {
						acceptedResponse: {
							taskId: TASK_ID,
							turnId: state.turn.turnId,
							interactionId: dlineTid,
							actionId: "approve" as const,
							stateRevision: 4,
						},
					}
				: {}),
		}
	}
	return createSnapshot(state, 206)
}

function snapshotWithStandaloneInteraction(
	interactionId: string,
	kind: "resume" | "error_retry" | "mistake_limit",
): TaskSnapshot {
	const turnId = `turn:${interactionId}`
	const state = createTaskRuntimeState({
		taskId: TASK_ID,
		phase: kind === "resume" ? TaskPhase.PAUSED : TaskPhase.AWAITING_APPROVAL,
		revision: 4,
		anchor: { apiIndex: 0, turnId, interactionId, uiMessageTs: 205 },
	})
	state.interaction = {
		taskId: TASK_ID,
		turnId,
		interactionId,
		kind,
		status: "resolving",
		createdRevision: 3,
		anchor: { messageTs: 205, messageType: "ask" },
		acceptedResponse: {
			taskId: TASK_ID,
			turnId,
			interactionId,
			actionId: kind === "resume" ? "resume" : kind === "error_retry" ? "retry" : "process_anyway",
			stateRevision: 4,
			draft: { text: "", images: [], files: [] },
		},
	}
	return createSnapshot(state, 206)
}

function fullInput(apiHistory: ClineStorageMessage[], uiHistory: ClineMessage[] = [], snapshot?: TaskSnapshot): ResumeInput {
	const start = snapshot ? snapshot.apiIndex + 1 : 0
	return {
		taskId: TASK_ID,
		snapshot,
		apiHistory,
		uiHistory,
		apiTail: apiHistory.slice(Math.max(0, start)),
		uiTail: snapshot ? selectResumeUiTail(snapshot, uiHistory) : uiHistory,
		apiTailStartIndex: Math.max(0, start),
		apiHistoryLength: apiHistory.length,
	}
}

describe("reconcileResume", () => {
	it("uses a valid snapshot as the baseline and folds every later API row", () => {
		const result = reconcileResume(
			fullInput([apiUser(), assistantTool("tid-1", "fn-1"), toolResult("tid-1", "fn-1")], [], baseline(0)),
		)

		expect(result.entry).toMatchObject({ type: "show_resume_interaction" })
		expect(result.snapshot.phase).toBe(TaskPhase.PAUSED)
		expect(result.snapshot.turn?.blocks).toMatchObject([{ dlineTid: "tid-1", phase: BlockPhase.COMPLETED }])
		expect(result.diagnostics).toEqual([])
	})

	it("keeps a consumed old Task inert without synthesizing Resume or a successor", () => {
		const result = reconcileResume(
			fullInput([apiUser(), assistantTool("tid-new-task", "fn-new-task", "new_task")], [], consumedNewTaskSnapshot()),
		)

		expect(result.entry).toEqual({ type: "show_consumed_task" })
		expect(result.snapshot.phase).toBe(TaskPhase.ABORTED)
		expect(result.snapshot.newTaskConsumed).toEqual({
			functionId: "fn-new-task",
			dlineTid: "tid-new-task",
		})
		expect(result.snapshot.interaction).toBeUndefined()
	})

	it("rebuilds a missing snapshot from the complete histories", () => {
		const result = reconcileResume(fullInput([apiUser(), assistantTool("tid-1", "fn-1")], [partialResult("tid-1", "fn-1")]))

		expect(result.diagnostics).toContainEqual({ code: "snapshot_rebuilt", reason: "missing" })
		expect(result.snapshot.apiIndex).toBe(1)
		expect(result.snapshot.turn?.blocks).toMatchObject([{ dlineTid: "tid-1", phase: BlockPhase.COMPLETED }])
		expect(result.entry).toMatchObject({ type: "show_resume_interaction" })
	})

	it("rebuilds a corrupt snapshot instead of creating a read-only dead end", () => {
		const corrupt = baseline(0)
		corrupt.apiIndex = 99
		corrupt.anchor = { apiIndex: 99 }
		const result = reconcileResume(fullInput([apiUser(), assistantTool("tid-new", "fn-new")], [], corrupt))

		expect(result.diagnostics).toContainEqual({ code: "snapshot_rebuilt", reason: "corrupt_anchor" })
		expect(result.entry).toMatchObject({ type: "show_resume_interaction" })
		expect(result.snapshot.phase).toBe(TaskPhase.PAUSED)
	})

	it("uses the latest valid legacy JSONL snapshot before folding its stale tail", () => {
		const embedded = baseline(0)
		const uiHistory: ClineMessage[] = [
			{ ts: 101, type: "say", say: "state_snapshot", text: "{broken" },
			{ ts: 102, type: "say", say: "state_snapshot", text: JSON.stringify(embedded) },
		]
		const result = reconcileResume(fullInput([apiUser(), assistantTool("tid-tail", "fn-tail")], uiHistory))

		expect(result.diagnostics).toContainEqual({ code: "snapshot_rebuilt", reason: "missing" })
		expect(result.snapshot.anchor).toMatchObject({ apiIndex: 1, turnId: "turn:tid-tail" })
		expect(result.entry.type).toBe("show_resume_interaction")
	})

	it("keeps a pending approval as the original Approve/Reject interaction", () => {
		const apiHistory = [apiUser(), assistantTool("tid-approve", "fn-approve", "write_to_file")]
		const ask = interactionAsk("tool", "tid-approve")
		const result = reconcileResume(fullInput(apiHistory, [ask]))

		expect(result.entry).toEqual({
			type: "reopen_interaction",
			turnId: "turn:tid-approve",
			interactionId: "tid-approve",
		})
		expect(result.snapshot.phase).toBe(TaskPhase.AWAITING_APPROVAL)
		expect(result.snapshot.turn?.blocks[0]).toMatchObject({
			phase: BlockPhase.AWAITING_APPROVAL,
			requiresApproval: true,
		})
	})

	it("keeps a pending command ask as command approval", () => {
		const interactionId = "tid-pending-command"
		const functionId = "fn-pending-command"
		const snapshot = snapshotWithTurn(interactionId, functionId, {
			toolName: "execute_command",
			blockPhase: BlockPhase.AWAITING_APPROVAL,
			interaction: "command_approval",
		})
		const result = reconcileResume(
			fullInput(
				[apiUser(), assistantTool(interactionId, functionId, "execute_command")],
				[{ ...interactionAsk("command", interactionId), commandStatus: "pending" }],
				snapshot,
			),
		)

		expect(result.entry).toEqual({
			type: "reopen_interaction",
			turnId: `turn:${interactionId}`,
			interactionId,
		})
		expect(result.snapshot.interaction).toMatchObject({ kind: "command_approval", status: "awaiting" })
	})

	it("keeps handler-owned command approval while its outer block is already executing", () => {
		const interactionId = "tid-handler-command"
		const functionId = "fn-handler-command"
		const snapshot = snapshotWithTurn(interactionId, functionId, {
			toolName: "execute_command",
			blockPhase: BlockPhase.EXECUTING,
			interaction: "command_approval",
		})
		if (!snapshot.turn) throw new Error("expected restored command turn")
		snapshot.turn.blocks[0].requiresApproval = false

		const result = reconcileResume(
			fullInput(
				[apiUser(), assistantTool(interactionId, functionId, "execute_command")],
				[{ ...interactionAsk("command", interactionId), commandStatus: "pending" }],
				snapshot,
			),
		)

		expect(result.entry).toEqual({
			type: "reopen_interaction",
			turnId: `turn:${interactionId}`,
			interactionId,
		})
		expect(result.snapshot.turn).toMatchObject({
			activeDlineTid: interactionId,
			blocks: [{ dlineTid: interactionId, phase: BlockPhase.AWAITING_APPROVAL, requiresApproval: true }],
		})
	})

	it("rebuilds the exact anchored tool turn when a valid stale snapshot has no turn", () => {
		const interactionId = "tid-anchored"
		const apiHistory: ClineStorageMessage[] = [
			apiUser(),
			{
				role: "assistant",
				ts: 200,
				content: [
					{
						type: "tool_use",
						name: "write_to_file",
						input: {},
						function_id: "fn-anchored",
						dline_tid: interactionId,
					},
					{
						type: "tool_use",
						name: "read_file",
						input: {},
						function_id: "fn-sibling",
						dline_tid: "tid-sibling",
					},
				],
			},
		]
		const result = reconcileResume(fullInput(apiHistory, [interactionAsk("tool", interactionId)], baseline(1)))

		expect(result.entry).toEqual({
			type: "reopen_interaction",
			turnId: `turn:${interactionId}`,
			interactionId,
		})
		expect(result.snapshot.turn).toMatchObject({
			turnId: `turn:${interactionId}`,
			assistantApiIndex: 1,
			activeDlineTid: interactionId,
			blocks: [
				{
					dlineTid: interactionId,
					functionId: "fn-anchored",
					phase: BlockPhase.AWAITING_APPROVAL,
				},
				{
					dlineTid: "tid-sibling",
					functionId: "fn-sibling",
					phase: BlockPhase.STREAMING,
				},
			],
		})
		expect(result.snapshot.interaction?.turnId).toBe(result.snapshot.turn?.turnId)
	})

	it.each([
		["followup", "followup"],
		["make_plan", "make_plan"],
		["qna_respond", "qna_response"],
		["generate_report", "generate_report"],
	] as const)("keeps awaiting %s as its original reply interaction", (ask, kind) => {
		const interactionId = `tid-${kind}`
		const snapshot = snapshotWithTurn(interactionId, `fn-${kind}`, {
			toolName: ask,
			interaction: kind,
			blockPhase: BlockPhase.EXECUTING,
		})
		const result = reconcileResume(
			fullInput(
				[apiUser(), assistantTool(interactionId, `fn-${kind}`, ask)],
				[interactionAsk(ask, interactionId)],
				snapshot,
			),
		)

		expect(result.entry).toEqual({
			type: "reopen_interaction",
			turnId: `turn:${interactionId}`,
			interactionId,
		})
		expect(result.snapshot.phase).toBe(TaskPhase.AWAITING_APPROVAL)
		expect(result.snapshot.interaction).toMatchObject({ kind, status: "awaiting" })
	})

	it("keeps attempt completion as Start New Task only", () => {
		const result = reconcileResume(
			fullInput(
				[apiUser(), assistantTool("tid-complete", "fn-complete", "attempt_completion")],
				[interactionAsk("completion_result", "tid-complete")],
			),
		)

		expect(result.entry).toEqual({
			type: "show_completion_interaction",
			turnId: "turn:tid-complete",
			interactionId: "tid-complete",
		})
		expect(result.snapshot.phase).toBe(TaskPhase.COMPLETED)
		expect(result.snapshot.interaction?.kind).toBe("completion")
	})

	it("keeps the same completion identity when reopening before its ask row was persisted", () => {
		const snapshot = snapshotWithTurn("tid-complete", "fn-complete", {
			toolName: "attempt_completion",
			interaction: "completion",
			interactionStatus: "opening",
			blockPhase: BlockPhase.COMPLETED,
		})
		snapshot.phase = TaskPhase.COMPLETED
		snapshot.completion = { completionId: "tid-complete" }
		const result = reconcileResume(
			fullInput([apiUser(), assistantTool("tid-complete", "fn-complete", "attempt_completion")], [], snapshot),
		)

		expect(result.entry).toEqual({
			type: "show_completion_interaction",
			turnId: "turn:tid-complete",
			interactionId: "tid-complete",
		})
		expect(result.snapshot.phase).toBe(TaskPhase.COMPLETED)
		expect(result.snapshot.interaction).toMatchObject({
			interactionId: "tid-complete",
			kind: "completion",
			status: "opening",
		})
		expect(result.entry.type).not.toBe("show_resume_interaction")
	})

	it("restores completion when close persisted after its result but before its interaction", () => {
		const interactionId = "tid-complete-close-race"
		const snapshot = snapshotWithTurn(interactionId, "fn-complete-close-race", {
			toolName: "attempt_completion",
			blockPhase: BlockPhase.EXECUTING,
		})
		snapshot.phase = TaskPhase.CANCELLING
		snapshot.cancellation = { source: "system", fromPhase: TaskPhase.EXECUTING }

		const result = reconcileResume(
			fullInput(
				[apiUser(), assistantTool(interactionId, "fn-complete-close-race", "attempt_completion")],
				[
					{
						ts: 200,
						type: "say",
						say: "completion_result",
						text: "Completion is already visible.",
						conversationHistoryIndex: 1,
					},
				],
				snapshot,
			),
		)

		expect(result.entry).toEqual({
			type: "show_completion_interaction",
			turnId: `turn:${interactionId}`,
			interactionId,
		})
		expect(result.snapshot.interaction).toMatchObject({
			interactionId,
			kind: "completion",
			status: "opening",
		})
		expect(result.snapshot.interaction?.interactionId).not.toContain("resume:")
	})

	it("restores presented completion after close cancels its streaming turn", () => {
		const interactionId = "tid-complete-stream-close"
		const snapshot = snapshotWithTurn(interactionId, "fn-complete-stream-close", {
			toolName: "attempt_completion",
			blockPhase: BlockPhase.CANCELLED,
		})
		snapshot.phase = TaskPhase.CANCELLING
		snapshot.cancellation = { source: "system", fromPhase: TaskPhase.STREAMING }

		const result = reconcileResume(
			fullInput(
				[apiUser(), assistantTool(interactionId, "fn-complete-stream-close", "attempt_completion")],
				[
					{
						ts: 200,
						type: "say",
						say: "completion_result",
						text: "Completion committed before the streaming turn was cancelled.",
						conversationHistoryIndex: 1,
					},
				],
				snapshot,
			),
		)

		expect(result.entry).toEqual({
			type: "show_completion_interaction",
			turnId: `turn:${interactionId}`,
			interactionId,
		})
		expect(result.snapshot.interaction).toMatchObject({
			interactionId,
			kind: "completion",
			status: "opening",
		})
	})

	it("restores presented completion while its auto-executing turn closes", () => {
		const interactionId = "tid-complete-auto-close"
		const snapshot = snapshotWithTurn(interactionId, "fn-complete-auto-close", {
			toolName: "attempt_completion",
			blockPhase: BlockPhase.AUTO_EXECUTING,
		})
		snapshot.phase = TaskPhase.CANCELLING
		snapshot.cancellation = { source: "system", fromPhase: TaskPhase.STREAMING }

		const result = reconcileResume(
			fullInput(
				[apiUser(), assistantTool(interactionId, "fn-complete-auto-close", "attempt_completion")],
				[
					{
						ts: 200,
						type: "say",
						say: "completion_result",
						text: "Completion committed while the block remained auto-executing.",
						conversationHistoryIndex: 1,
					},
				],
				snapshot,
			),
		)

		expect(result.entry).toEqual({
			type: "show_completion_interaction",
			turnId: `turn:${interactionId}`,
			interactionId,
		})
		expect(result.snapshot.interaction).toMatchObject({
			interactionId,
			kind: "completion",
			status: "opening",
		})
	})

	it("keeps API admission failure as Retry", () => {
		const result = reconcileResume(fullInput([apiUser()], [interactionAsk("api_req_failed", "retry-1", 0)]))

		expect(result.entry).toEqual({
			type: "show_error_recovery",
			turnId: "turn:retry-1",
			interactionId: "retry-1",
			apiIndex: 0,
		})
		expect(result.snapshot.interaction?.kind).toBe("error_retry")
	})

	it("uses a later durable result to retire a stale approval", () => {
		const snapshot = snapshotWithTurn("tid-approve", "fn-approve", {
			interaction: "tool_approval",
			blockPhase: BlockPhase.AWAITING_APPROVAL,
		})
		const ask = interactionAsk("tool", "tid-approve")
		const result = reconcileResume(
			fullInput(
				[apiUser(), assistantTool("tid-approve", "fn-approve")],
				[ask, partialResult("tid-approve", "fn-approve", 220)],
				snapshot,
			),
		)

		expect(result.entry).toMatchObject({ type: "show_resume_interaction" })
		expect(result.snapshot.interaction).toMatchObject({
			kind: "resume",
			status: "opening",
		})
		expect(result.snapshot.interaction?.interactionId).not.toBe("tid-approve")
		expect(result.snapshot.turn?.blocks[0]?.phase).toBe(BlockPhase.COMPLETED)
	})

	it("does not reopen terminal tool approval when its result predates the snapshot tail", () => {
		const interactionId = "tid-terminal-write"
		const functionId = "fn-terminal-write"
		const snapshot = snapshotWithTurn(interactionId, functionId, {
			toolName: "write_to_file",
			interaction: "tool_approval",
			blockPhase: BlockPhase.COMPLETED,
		})
		snapshot.apiIndex = 2
		snapshot.anchor = { ...snapshot.anchor, apiIndex: 2 }
		if (!snapshot.turn) throw new Error("expected restored write turn")
		snapshot.turn.activeDlineTid = interactionId

		const result = reconcileResume(
			fullInput(
				[apiUser(), assistantTool(interactionId, functionId, "write_to_file"), toolResult(interactionId, functionId)],
				[interactionAsk("tool", interactionId)],
				snapshot,
			),
		)

		expect(result.entry).toMatchObject({ type: "show_resume_interaction" })
		expect(result.snapshot.interaction).toMatchObject({ kind: "resume", status: "opening" })
		expect(result.snapshot.turn).toMatchObject({
			activeDlineTid: undefined,
			blocks: [{ dlineTid: interactionId, phase: BlockPhase.COMPLETED }],
		})
		expect(result.diagnostics).not.toContainEqual(
			expect.objectContaining({ code: "missing_interaction_anchor", interactionId }),
		)
	})

	it("clears a stale approval owner from a terminal restored turn", () => {
		const snapshot = snapshotWithTurn("tid-report", "fn-report", {
			toolName: "generate_report",
			blockPhase: BlockPhase.COMPLETED,
		})
		if (!snapshot.turn) throw new Error("expected restored turn")
		snapshot.phase = TaskPhase.PAUSED
		snapshot.turn.activeDlineTid = "tid-report"

		const result = reconcileResume(
			fullInput([apiUser(), assistantTool("tid-report", "fn-report", "generate_report")], [], snapshot),
		)

		expect(result.entry).toMatchObject({ type: "show_resume_interaction" })
		expect(result.snapshot.turn).toMatchObject({
			activeDlineTid: undefined,
			blocks: [{ dlineTid: "tid-report", phase: BlockPhase.COMPLETED }],
		})
	})

	it("does not reopen a completed command ask as command approval", () => {
		const interactionId = "tid-completed-command"
		const functionId = "fn-completed-command"
		const snapshot = snapshotWithTurn(interactionId, functionId, {
			toolName: "execute_command",
			blockPhase: BlockPhase.COMPLETED,
			interaction: "command_approval",
		})
		snapshot.apiIndex = 2
		snapshot.anchor = { ...snapshot.anchor, apiIndex: 2 }
		if (!snapshot.turn) throw new Error("expected restored command turn")
		snapshot.turn.blocks[0].requiresApproval = false
		snapshot.turn.activeDlineTid = interactionId

		const result = reconcileResume(
			fullInput(
				[apiUser(), assistantTool(interactionId, functionId, "execute_command"), toolResult(interactionId, functionId)],
				[
					{
						...interactionAsk("command", interactionId),
						commandStatus: "completed",
					},
				],
				snapshot,
			),
		)

		expect(result.entry).toMatchObject({ type: "show_resume_interaction" })
		expect(result.snapshot.phase).toBe(TaskPhase.PAUSED)
		expect(result.snapshot.interaction).toMatchObject({ kind: "resume", status: "opening" })
		expect(result.snapshot.interaction?.interactionId).not.toBe(interactionId)
		expect(result.snapshot.turn?.blocks).toMatchObject([
			{ dlineTid: interactionId, phase: BlockPhase.COMPLETED, requiresApproval: false },
		])
		expect(result.snapshot.turn?.activeDlineTid).toBeUndefined()
		expect(result.diagnostics).not.toContainEqual(
			expect.objectContaining({ code: "missing_interaction_anchor", interactionId }),
		)
	})

	it("does not reopen an already approved running command as command approval", () => {
		const interactionId = "tid-running-command"
		const functionId = "fn-running-command"
		const snapshot = snapshotWithTurn(interactionId, functionId, {
			toolName: "execute_command",
			blockPhase: BlockPhase.EXECUTING,
			interaction: "command_approval",
		})
		if (!snapshot.turn) throw new Error("expected restored command turn")
		snapshot.turn.blocks[0].requiresApproval = false
		snapshot.turn.activeDlineTid = interactionId

		const result = reconcileResume(
			fullInput(
				[apiUser(), assistantTool(interactionId, functionId, "execute_command")],
				[{ ...interactionAsk("command", interactionId), commandStatus: "running" }],
				snapshot,
			),
		)

		expect(result.entry).toMatchObject({ type: "show_resume_interaction" })
		expect(result.snapshot.phase).toBe(TaskPhase.PAUSED)
		expect(result.snapshot.interaction).toMatchObject({ kind: "resume", status: "opening" })
		expect(result.snapshot.interaction?.interactionId).not.toBe(interactionId)
		expect(result.snapshot.turn?.activeDlineTid).toBeUndefined()
		expect(result.diagnostics).not.toContainEqual(
			expect.objectContaining({ code: "missing_interaction_anchor", interactionId }),
		)
	})

	it("clears a stale active owner after an approved command was cancelled without an interaction", () => {
		const interactionId = "tid-cancelled-command"
		const functionId = "fn-cancelled-command"
		const snapshot = snapshotWithTurn(interactionId, functionId, {
			toolName: "execute_command",
			blockPhase: BlockPhase.EXECUTING,
		})
		if (!snapshot.turn) throw new Error("expected restored command turn")
		snapshot.turn.blocks[0].requiresApproval = false
		snapshot.turn.activeDlineTid = interactionId

		const result = reconcileResume(
			fullInput(
				[apiUser(), assistantTool(interactionId, functionId, "execute_command")],
				[{ ...interactionAsk("command", interactionId), commandStatus: "cancelled" }],
				snapshot,
			),
		)

		expect(result.entry).toMatchObject({ type: "show_resume_interaction" })
		expect(result.snapshot.phase).toBe(TaskPhase.PAUSED)
		expect(result.snapshot.interaction).toMatchObject({ kind: "resume", status: "opening" })
		expect(result.snapshot.turn).toMatchObject({
			activeDlineTid: undefined,
			blocks: [{ dlineTid: interactionId, phase: BlockPhase.EXECUTING, requiresApproval: false }],
		})
	})

	it("does not reopen command approval after its response was durably accepted", () => {
		const interactionId = "tid-accepted-command"
		const functionId = "fn-accepted-command"
		const snapshot = snapshotWithTurn(interactionId, functionId, {
			toolName: "execute_command",
			blockPhase: BlockPhase.AWAITING_APPROVAL,
			interaction: "command_approval",
			interactionStatus: "resolving",
		})
		if (!snapshot.turn) throw new Error("expected restored command turn")
		snapshot.turn.activeDlineTid = interactionId

		const result = reconcileResume(
			fullInput(
				[apiUser(), assistantTool(interactionId, functionId, "execute_command")],
				[{ ...interactionAsk("command", interactionId), commandStatus: "pending" }],
				snapshot,
			),
		)

		expect(result.entry).toMatchObject({ type: "show_resume_interaction" })
		expect(result.snapshot.interaction).toMatchObject({ kind: "resume", status: "opening" })
		expect(result.snapshot.turn).toMatchObject({
			activeDlineTid: undefined,
			blocks: [{ dlineTid: interactionId, phase: BlockPhase.EXECUTING, requiresApproval: false }],
		})
	})

	it("does not offer Approve again after an accepted response with unknown outcome", () => {
		const snapshot = snapshotWithTurn("tid-accepted", "fn-accepted", {
			interaction: "tool_approval",
			interactionStatus: "resolving",
			blockPhase: BlockPhase.EXECUTING,
		})
		const result = reconcileResume(
			fullInput(
				[apiUser(), assistantTool("tid-accepted", "fn-accepted")],
				[interactionAsk("tool", "tid-accepted")],
				snapshot,
			),
		)

		expect(result.entry).toMatchObject({ type: "show_resume_interaction" })
		expect(result.snapshot.phase).toBe(TaskPhase.PAUSED)
		expect(result.snapshot.interaction).toMatchObject({
			kind: "resume",
			status: "opening",
		})
		expect(result.snapshot.interaction?.interactionId).not.toBe("tid-accepted")
	})

	it("migrates a pending Hosted Web approval to an explicit persisted-request Resume", () => {
		const interactionId = `hosted-web:${TASK_ID}:0`
		const state = createTaskRuntimeState({
			taskId: TASK_ID,
			phase: TaskPhase.AWAITING_APPROVAL,
			revision: 4,
			anchor: { apiIndex: 0, turnId: interactionId, interactionId, uiMessageTs: 205 },
		})
		state.interaction = {
			taskId: TASK_ID,
			turnId: interactionId,
			interactionId,
			kind: "hosted_web_approval",
			status: "awaiting",
			createdRevision: 3,
			anchor: { messageTs: 205, messageType: "ask" },
		}
		const snapshot = createSnapshot(state, 206)
		const result = reconcileResume(fullInput([persistedApiUser()], [interactionAsk("tool", interactionId, 0)], snapshot))

		expect(result.entry).toMatchObject({ type: "show_resume_interaction" })
		expect(result.snapshot.phase).toBe(TaskPhase.PAUSED)
		expect(result.snapshot.turn).toBeUndefined()
		expect(result.snapshot.interaction).toMatchObject({
			kind: "resume",
			status: "opening",
			persistedRequest: true,
		})
		expect(result.snapshot.interaction?.interactionId).not.toBe(interactionId)
		expect(result.snapshot.anchor?.interactionId).toBe(result.snapshot.interaction?.interactionId)
	})

	it("keeps the migrated persisted request through repeated close and reopen without dispatching it", () => {
		const legacyId = `hosted-web:${TASK_ID}:0`
		const snapshot = baseline(0)
		snapshot.phase = TaskPhase.AWAITING_APPROVAL
		snapshot.anchor = { apiIndex: 0, turnId: legacyId, interactionId: legacyId, uiMessageTs: 205 }
		snapshot.interaction = {
			taskId: TASK_ID,
			turnId: legacyId,
			interactionId: legacyId,
			kind: "hosted_web_approval",
			status: "awaiting",
			createdRevision: 2,
			anchor: { messageTs: 205, messageType: "ask" },
		}
		const first = reconcileResume(fullInput([persistedApiUser()], [interactionAsk("tool", legacyId, 0)], snapshot))
		const resumeId = first.snapshot.interaction?.interactionId
		if (!resumeId) throw new Error("expected migrated Resume interaction")
		const uiHistory = [interactionAsk("tool", legacyId, 0), interactionAsk("resume_task", resumeId, 0, 210)]
		const second = reconcileResume(fullInput([persistedApiUser()], uiHistory, first.snapshot))
		const third = reconcileResume(fullInput([persistedApiUser()], uiHistory, second.snapshot))

		for (const result of [second, third]) {
			expect(result.entry).toMatchObject({ type: "show_resume_interaction", interactionId: resumeId })
			expect(result.snapshot.phase).toBe(TaskPhase.PAUSED)
			expect(result.snapshot.interaction).toMatchObject({
				kind: "resume",
				status: "awaiting",
				persistedRequest: true,
			})
			expect(result.snapshot.apiIndex).toBe(0)
		}
	})

	it("does not replay an obsolete Hosted approval without an intact persisted user request", () => {
		const legacyId = `hosted-web-rejected:${TASK_ID}:0`
		const snapshot = baseline(0)
		snapshot.phase = TaskPhase.PAUSED
		snapshot.anchor = { apiIndex: 0, turnId: legacyId, interactionId: legacyId, uiMessageTs: 205 }
		snapshot.interaction = {
			taskId: TASK_ID,
			turnId: legacyId,
			interactionId: legacyId,
			kind: "hosted_web_approval",
			status: "awaiting",
			createdRevision: 2,
		}
		snapshot.interruptedInteraction = { ...snapshot.interaction }
		const result = reconcileResume(
			fullInput(
				[{ role: "assistant", content: "Not a persisted user request." }],
				[interactionAsk("tool", legacyId, 0)],
				snapshot,
			),
		)

		expect(result.entry).toMatchObject({ type: "show_resume_interaction" })
		expect(result.snapshot.interaction?.persistedRequest).not.toBe(true)
		expect(result.snapshot.interruptedInteraction).toBeUndefined()
	})

	it("does not replay an obsolete Hosted approval after the API history tail has advanced", () => {
		const legacyId = `hosted-web:${TASK_ID}:0`
		const snapshot = baseline(0)
		snapshot.phase = TaskPhase.AWAITING_APPROVAL
		snapshot.anchor = { apiIndex: 0, turnId: legacyId, interactionId: legacyId, uiMessageTs: 205 }
		snapshot.interaction = {
			taskId: TASK_ID,
			turnId: legacyId,
			interactionId: legacyId,
			kind: "hosted_web_approval",
			status: "awaiting",
			createdRevision: 2,
			anchor: { messageTs: 205, messageType: "ask" },
		}
		snapshot.interruptedInteraction = { ...snapshot.interaction }
		const result = reconcileResume(
			fullInput(
				[apiUser(), { role: "assistant", content: "Already answered." }],
				[interactionAsk("tool", legacyId, 0)],
				snapshot,
			),
		)

		expect(result.entry).toMatchObject({ type: "show_resume_interaction" })
		expect(result.snapshot.interaction).toMatchObject({ kind: "resume", status: "opening" })
		expect(result.snapshot.interaction?.persistedRequest).not.toBe(true)
		expect(result.snapshot.interruptedInteraction).toBeUndefined()
		expect(result.snapshot.apiIndex).toBe(1)
	})

	it.each([
		["resume_task", "resume", "show_resume_interaction"],
		["api_req_failed", "error_retry", "show_error_recovery"],
		["mistake_limit_reached", "mistake_limit", "show_error_recovery"],
	] as const)("reopens a resolving %s interaction as clickable awaiting", (ask, kind, entryType) => {
		const interactionId = `${kind}-resolving`
		const snapshot = snapshotWithStandaloneInteraction(interactionId, kind)
		const result = reconcileResume(fullInput([apiUser()], [interactionAsk(ask, interactionId, 0)], snapshot))

		expect(result.entry).toMatchObject({
			type: entryType,
			turnId: `turn:${interactionId}`,
			interactionId,
		})
		expect(result.snapshot.interaction).toMatchObject({
			interactionId,
			kind,
			status: "awaiting",
		})
		expect(result.snapshot.interaction?.acceptedResponse).toBeUndefined()
		expect(result.diagnostics).not.toContainEqual(expect.objectContaining({ code: "missing_interaction_continuation" }))
	})

	it("restores a cancelling reload snapshot to its durable error retry phase", () => {
		const interactionId = "error-retry-cancelling"
		const snapshot = snapshotWithStandaloneInteraction(interactionId, "error_retry")
		snapshot.phase = TaskPhase.CANCELLING
		snapshot.cancellation = { source: "system", fromPhase: TaskPhase.AWAITING_APPROVAL }
		snapshot.interaction = {
			...snapshot.interaction!,
			status: "awaiting",
			persistedRequest: false,
			acceptedResponse: undefined,
		}

		const result = reconcileResume(fullInput([apiUser()], [interactionAsk("api_req_failed", interactionId, 0)], snapshot))

		expect(result.entry).toMatchObject({
			type: "show_error_recovery",
			interactionId,
		})
		expect(result.snapshot.phase).toBe(TaskPhase.AWAITING_APPROVAL)
		expect(result.snapshot.cancellation).toBeUndefined()
		expect(result.snapshot.interaction).toMatchObject({
			interactionId,
			kind: "error_retry",
			status: "awaiting",
			persistedRequest: false,
		})
	})

	it.each([
		["qna_respond", "qna_respond"],
		["completion_result", "attempt_completion"],
	] as const)("does not revive a stale %s ask over a later paused snapshot", (ask, toolName) => {
		const snapshot = snapshotWithTurn("tid-stale", "fn-stale", {
			toolName,
			blockPhase: BlockPhase.COMPLETED,
		})
		snapshot.phase = TaskPhase.PAUSED
		const result = reconcileResume(
			fullInput(
				[apiUser(), assistantTool("tid-stale", "fn-stale", toolName)],
				[interactionAsk(ask, "tid-stale")],
				snapshot,
			),
		)

		expect(result.entry).toMatchObject({ type: "show_resume_interaction" })
		expect(result.snapshot.phase).toBe(TaskPhase.PAUSED)
		expect(result.snapshot.interaction).toMatchObject({ kind: "resume", status: "opening" })
	})

	it("treats a thinking-only assistant tail with no original interaction as ordinary Resume", () => {
		const result = reconcileResume(fullInput([apiUser(), assistantThinking()], [], baseline(0)))

		expect(result.entry).toMatchObject({ type: "show_resume_interaction" })
		expect(result.snapshot.phase).toBe(TaskPhase.PAUSED)
		expect(result.snapshot.interaction).toMatchObject({ kind: "resume", status: "opening" })
		expect(result.snapshot.turn).toBeUndefined()
	})

	it("turns a runtime effect diagnostic into a stopped normal continuation", () => {
		const snapshot = baseline(0)
		snapshot.runtimeError = { effectId: "effect-1", effectType: "START_API", message: "provider stopped" }
		const result = reconcileResume(fullInput([apiUser()], [], snapshot))

		expect(result.snapshot.phase).toBe(TaskPhase.PAUSED)
		expect(result.snapshot.runtimeError).toBeUndefined()
		expect(result.entry).toMatchObject({ type: "show_resume_interaction" })
		expect(result.diagnostics).toContainEqual({ code: "unsafe_runtime_error", effectType: "START_API" })
	})

	it("falls back to normal Resume when the stored interaction ask is gone", () => {
		const snapshot = snapshotWithTurn("tid-missing", "fn-missing", { interaction: "qna_response" })
		const result = reconcileResume(fullInput([apiUser(), assistantTool("tid-missing", "fn-missing")], [], snapshot))

		expect(result.entry).toMatchObject({ type: "show_resume_interaction" })
		expect(result.snapshot.interaction).toMatchObject({
			kind: "resume",
			status: "opening",
		})
		expect(result.snapshot.interaction?.interactionId).not.toBe("tid-missing")
		expect(result.diagnostics).toContainEqual({
			code: "missing_interaction_anchor",
			interactionId: "tid-missing",
		})
	})

	it("falls back to normal Resume when a stored handler interaction has no canonical assistant turn", () => {
		const interactionId = "tid-missing-continuation"
		const snapshot = snapshotWithTurn(interactionId, "fn-missing-continuation", { interaction: "qna_response" })
		snapshot.turn = undefined
		const result = reconcileResume(
			fullInput(
				[apiUser(), { role: "assistant", content: "The original tool declaration is unavailable." }],
				[interactionAsk("qna_respond", interactionId)],
				snapshot,
			),
		)

		expect(result.entry).toMatchObject({ type: "show_resume_interaction" })
		expect(result.snapshot.phase).toBe(TaskPhase.PAUSED)
		expect(result.snapshot.interaction).toMatchObject({ kind: "resume", status: "opening" })
		expect(result.snapshot.interaction?.interactionId).not.toBe(interactionId)
		expect(result.diagnostics).toContainEqual({
			code: "missing_interaction_continuation",
			interactionId,
		})
	})

	it("falls back to normal Resume when the canonical turn lacks the handler interaction block", () => {
		const interactionId = "tid-missing-block"
		const snapshot = snapshotWithTurn(interactionId, "fn-missing-block", { interaction: "qna_response" })
		const block = snapshot.turn?.blocks[0]
		if (!block) throw new Error("test block missing")
		block.dlineTid = "tid-unrelated"
		const result = reconcileResume(
			fullInput(
				[apiUser(), { role: "assistant", content: "The original tool declaration is unavailable." }],
				[interactionAsk("qna_respond", interactionId)],
				snapshot,
			),
		)

		expect(result.entry).toMatchObject({ type: "show_resume_interaction" })
		expect(result.snapshot.interaction).toMatchObject({ kind: "resume", status: "opening" })
		expect(result.snapshot.interaction?.interactionId).not.toBe(interactionId)
		expect(result.diagnostics).toContainEqual({
			code: "missing_interaction_continuation",
			interactionId,
		})
	})

	it("falls back to normal Resume when more than one block claims the handler interaction", () => {
		const interactionId = "tid-duplicate-block"
		const snapshot = snapshotWithTurn(interactionId, "fn-duplicate-block", { interaction: "qna_response" })
		const block = snapshot.turn?.blocks[0]
		if (!block || !snapshot.turn) throw new Error("test turn missing")
		snapshot.turn.blocks.push({ ...block, functionId: "fn-duplicate-block-2" })
		const result = reconcileResume(
			fullInput(
				[apiUser(), assistantTool(interactionId, "fn-duplicate-block", "qna_respond")],
				[interactionAsk("qna_respond", interactionId)],
				snapshot,
			),
		)

		expect(result.entry).toMatchObject({ type: "show_resume_interaction" })
		expect(result.snapshot.interaction).toMatchObject({ kind: "resume", status: "opening" })
		expect(result.diagnostics).toContainEqual({
			code: "missing_interaction_continuation",
			interactionId,
		})
	})

	it("clears completion ownership and falls back to Resume when its canonical turn is missing", () => {
		const interactionId = "tid-completion-missing-turn"
		const snapshot = snapshotWithTurn(interactionId, "fn-completion-missing-turn", {
			toolName: "attempt_completion",
			interaction: "completion",
			interactionStatus: "opening",
			blockPhase: BlockPhase.COMPLETED,
		})
		snapshot.phase = TaskPhase.COMPLETED
		snapshot.completion = { completionId: interactionId }
		snapshot.turn = undefined
		const result = reconcileResume(
			fullInput(
				[apiUser(), { role: "assistant", content: "The original completion declaration is unavailable." }],
				[],
				snapshot,
			),
		)

		expect(result.entry).toMatchObject({ type: "show_resume_interaction" })
		expect(result.snapshot.phase).toBe(TaskPhase.PAUSED)
		expect(result.snapshot.completion).toBeUndefined()
		expect(result.snapshot.interaction).toMatchObject({ kind: "resume", status: "opening" })
		expect(result.snapshot.interaction?.interactionId).not.toBe(interactionId)
		expect(result.diagnostics).toContainEqual({
			code: "missing_interaction_continuation",
			interactionId,
		})
	})

	it("selects same-index UI results written after a snapshot", () => {
		const snapshot = baseline(1)
		const before: ClineMessage = { ts: 99, type: "say", say: "text", conversationHistoryIndex: 1 }
		const after = partialResult("tid-1", "fn-1", 101)

		expect(selectResumeUiTail(snapshot, [before, after])).toEqual([after])
	})
})
