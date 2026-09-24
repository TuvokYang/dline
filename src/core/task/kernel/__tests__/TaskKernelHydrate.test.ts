import { describe, expect, it } from "vitest"
import { hydrate } from "../hydrate"
import type { DialogInteraction, TaskState } from "../types"
import { createInitialTaskState } from "../types"

function prepared(kind: string): DialogInteraction {
	return {
		interactionId: `${kind}:1`,
		turnId: "turn-1",
		kind,
		status: "prepared",
		createdRevision: 1,
		presentationRef: `${kind}:presentation`,
		actionRules: [{ actionId: "reply", payloadPolicy: "draft" }],
		journalRef: "journal:0:2",
		receiverGeneration: 0,
	}
}

function base(): TaskState {
	return {
		...createInitialTaskState("task-1"),
		revision: 4,
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

function ready(snapshot: TaskState) {
	const result = hydrate({ taskId: "task-1", snapshot, journalTail: { epoch: 0, seq: 10 }, openReason: "crash_recovery" })
	expect(result.kind).toBe("ready")
	if (result.kind !== "ready") throw new Error(result.diagnostics[0]?.message)
	return result
}

describe("task kernel hydrate forms", () => {
	it("creates an inert resume interaction for interrupted work", () => {
		const result = ready(base())
		expect(result.form).toBe("interrupted")
		expect(result.state).toMatchObject({ generation: 1, revision: 5, flow: { phase: "paused" } })
		expect(result.state.dialog.primary).toMatchObject({ kind: "resume", status: "planned" })
		expect(result.initialCommands.map((command) => command.type)).toEqual(["dialog.prepare"])
	})

	it.each([
		["completed", { phase: "completed", completionId: "completion-1" }, "completion"],
		["error", { phase: "error", error: "provider failed" }, "error_retry"],
	] as const)("normalizes %s without automatic execution", (form, flow, kind) => {
		const result = ready({ ...base(), flow, dialog: { primary: prepared(kind), approvalsByBlock: {} } })
		expect(result.form).toBe(form)
		expect(result.state.flow).toEqual(flow)
		expect(result.initialCommands.map((command) => command.type)).toEqual(["dialog.reveal"])
	})

	it("makes a consumed task inert", () => {
		const result = ready({
			...base(),
			flow: { phase: "terminated", terminalReason: "consumed", consumedRef: "handoff:1" },
			dialog: { primary: prepared("completion"), approvalsByBlock: {} },
		})
		expect(result.form).toBe("consumed")
		expect(result.state.dialog.primary).toBeUndefined()
		expect(result.initialCommands).toEqual([])
	})

	it.each([
		[
			"prepared without journal",
			{ ...base(), dialog: { primary: { ...prepared("resume"), journalRef: undefined }, approvalsByBlock: {} } },
			"missing_journal_ref",
		],
		[
			"journal ahead of tail",
			{ ...base(), dialog: { primary: { ...prepared("resume"), journalRef: "journal:1:0" }, approvalsByBlock: {} } },
			"journal_ahead_of_tail",
		],
	] as const)("rejects %s as read-only", (_name, snapshot, code) => {
		const result = hydrate({ taskId: "task-1", snapshot, journalTail: { epoch: 0, seq: 10 }, openReason: "resume" })
		expect(result).toMatchObject({ kind: "read_only", reason: "snapshot_invalid", diagnostics: [{ code }] })
	})

	// A task written before runtime snapshots existed, or one whose snapshot write
	// never landed, still has its conversation. Refusing it left the surface
	// offering Resume while every promotion failed with `snapshot_missing`.
	it.each([
		["conversation history", { hasConversationHistory: true, journalTail: { epoch: 0, seq: 0 } }],
		["journal content", { hasConversationHistory: false, journalTail: { epoch: 0, seq: 7 } }],
	] as const)("recovers a snapshotless task that still has %s", (_name, evidence) => {
		const result = hydrate({ taskId: "task-1", openReason: "resume", ...evidence })

		expect(result.kind).toBe("ready")
		if (result.kind !== "ready") throw new Error(result.diagnostics[0]?.message)
		expect(result.form).toBe("interrupted")
		expect(result.state.flow).toEqual({ phase: "paused" })
		expect(result.state.dialog.primary).toMatchObject({ kind: "resume", status: "planned" })
		expect(result.diagnostics.some((diagnostic) => diagnostic.code === "snapshot_missing")).toBe(true)
	})

	it("still refuses a task with neither snapshot nor any history", () => {
		const result = hydrate({ taskId: "task-1", journalTail: { epoch: 0, seq: 0 }, openReason: "resume" })

		expect(result).toMatchObject({ kind: "read_only", reason: "snapshot_missing" })
	})
})
