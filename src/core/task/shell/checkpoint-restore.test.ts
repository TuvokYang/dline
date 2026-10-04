import { describe, expect, it, vi } from "vitest"
import { createInitialTaskState } from "../kernel/types"
import { type CheckpointRestorePorts, restoreCheckpoint } from "./checkpoint-restore"

function ports(workspaceOk = true): CheckpointRestorePorts & { calls: string[] } {
	const calls: string[] = []
	return {
		calls,
		stopAndFence: vi.fn(async () => void calls.push("stop")),
		resolve: vi.fn(async () => {
			calls.push("resolve")
			return {
				snapshot: {
					state: { ...createInitialTaskState("task-1"), revision: 2, flow: { phase: "running" as const } },
					outbox: [],
				},
				boundary: { seq: 4 },
				workspaceRef: "workspace:1",
			}
		}),
		restoreWorkspace: vi.fn(async () => {
			calls.push("workspace")
			return workspaceOk
				? ({ ok: true } as const)
				: ({ ok: false, diagnostic: { code: "workspace_restore_failed", message: "workspace failed" } } as const)
		}),
		applyConversationBoundary: vi.fn(async (boundary) => {
			calls.push("conversation")
			return boundary
		}),
		save: vi.fn(async () => void calls.push("save")),
	}
}

describe("checkpoint restore coordinator", () => {
	it("orders halt, validation, workspace, conversation, and atomic save", async () => {
		const subject = ports()
		const result = await restoreCheckpoint({ taskId: "task-1", checkpointRef: "checkpoint:1", mode: "combined" }, subject)
		expect(result.kind).toBe("restored")
		expect(subject.calls).toEqual(["resolve", "stop", "workspace", "conversation", "save"])
		expect(subject.save).toHaveBeenCalledWith(
			expect.objectContaining({ outbox: [expect.objectContaining({ type: "dialog.prepare" })] }),
		)
	})

	it("falls back to chat restore when combined workspace restore fails", async () => {
		const subject = ports(false)
		const result = await restoreCheckpoint({ taskId: "task-1", checkpointRef: "checkpoint:1", mode: "combined" }, subject)
		expect(result).toMatchObject({ kind: "restored", diagnostics: [{ code: "workspace_restore_failed" }] })
		expect(subject.calls).toEqual(["resolve", "stop", "workspace", "conversation", "save"])
	})

	it("does not mutate workspace, conversation, or vault for an invalid snapshot", async () => {
		const subject = ports()
		vi.mocked(subject.resolve).mockResolvedValue({
			snapshot: { state: createInitialTaskState("another-task"), outbox: [] },
			boundary: { seq: 4 },
			workspaceRef: "workspace:1",
		})
		const result = await restoreCheckpoint({ taskId: "task-1", checkpointRef: "checkpoint:1", mode: "combined" }, subject)
		expect(result).toMatchObject({ kind: "rejected", diagnostics: [{ code: "task_identity_mismatch" }] })
		expect(subject.calls).toEqual([])
		expect(subject.restoreWorkspace).not.toHaveBeenCalled()
		expect(subject.applyConversationBoundary).not.toHaveBeenCalled()
		expect(subject.save).not.toHaveBeenCalled()
	})

	it("restores workspace only without stopping or mutating chat state", async () => {
		const subject = ports()
		const result = await restoreCheckpoint(
			{ taskId: "task-1", checkpointRef: "checkpoint:1", mode: "workspace_only" },
			subject,
		)
		expect(result).toEqual({ kind: "restored", diagnostics: [] })
		expect(subject.calls).toEqual(["resolve", "workspace"])
		expect(subject.stopAndFence).not.toHaveBeenCalled()
		expect(subject.applyConversationBoundary).not.toHaveBeenCalled()
		expect(subject.save).not.toHaveBeenCalled()
	})

	it("restores chat only without touching workspace", async () => {
		const subject = ports()
		const result = await restoreCheckpoint({ taskId: "task-1", checkpointRef: "checkpoint:1", mode: "chat_only" }, subject)
		expect(result.kind).toBe("restored")
		expect(subject.calls).toEqual(["resolve", "stop", "conversation", "save"])
		expect(subject.restoreWorkspace).not.toHaveBeenCalled()
	})

	it("rejects a combined checkpoint without a workspace reference before stopping", async () => {
		const subject = ports()
		const resolved = await subject.resolve("checkpoint:1")
		vi.mocked(subject.resolve).mockResolvedValue({ snapshot: resolved.snapshot, boundary: resolved.boundary })
		subject.calls.length = 0

		const result = await restoreCheckpoint({ taskId: "task-1", checkpointRef: "checkpoint:1", mode: "combined" }, subject)

		expect(result).toMatchObject({ kind: "rejected", diagnostics: [{ code: "workspace_checkpoint_missing" }] })
		expect(subject.calls).toEqual([])
		expect(subject.stopAndFence).not.toHaveBeenCalled()
	})
})
