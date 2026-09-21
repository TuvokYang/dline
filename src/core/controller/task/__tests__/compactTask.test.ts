import { requestTaskCompaction } from "@core/task/compaction/TaskCompactionRequest"
import { createSessionFixture } from "@core/task/session/__fixtures__/active-task-session"
import { CompactTaskRequest } from "@shared/proto/dline/task"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { compactTask } from "../compactTask"

vi.mock("@core/task/compaction/TaskCompactionRequest", () => ({
	requestTaskCompaction: vi.fn(),
}))

const requestCompaction = vi.mocked(requestTaskCompaction)

/** Create a controller-shaped test boundary with one optional active session. */
function controller(taskId?: string) {
	return taskId ? { task: createSessionFixture({ taskId }) } : {}
}

describe("compactTask", () => {
	beforeEach(() => {
		requestCompaction.mockReset()
		requestCompaction.mockResolvedValue({ accepted: true, result: "accepted" })
	})

	it("rejects a request when no task is active", async () => {
		const response = await compactTask(
			controller() as never,
			CompactTaskRequest.create({ taskId: "task-1", stateRevision: 7 }),
		)

		expect(response).toMatchObject({ accepted: false, result: "missing_task" })
		expect(requestCompaction).not.toHaveBeenCalled()
	})

	it("rejects a request for a different active task without invoking compaction", async () => {
		const response = await compactTask(
			controller("task-1") as never,
			CompactTaskRequest.create({ taskId: "task-2", stateRevision: 7 }),
		)

		expect(response).toMatchObject({ accepted: false, result: "missing_task" })
		expect(requestCompaction).not.toHaveBeenCalled()
	})

	it("forwards the task revision and preserves an accepted result", async () => {
		requestCompaction.mockResolvedValue({ accepted: true, result: "accepted:12" })
		const session = createSessionFixture({ taskId: "task-1" })

		const response = await compactTask(
			{ task: session } as never,
			CompactTaskRequest.create({ taskId: "task-1", stateRevision: 12 }),
		)

		expect(requestCompaction).toHaveBeenCalledOnce()
		expect(requestCompaction).toHaveBeenCalledWith(session, { stateRevision: 12, mode: "summarize" })
		expect(response).toMatchObject({ accepted: true, result: "accepted:12" })
	})

	it("routes an explicit force-truncate request without invoking rolling compaction", async () => {
		requestCompaction.mockResolvedValue({ accepted: true, result: "truncated:12" })
		const session = createSessionFixture({ taskId: "task-1" })

		const response = await compactTask(
			{ task: session } as never,
			CompactTaskRequest.create({ taskId: "task-1", stateRevision: 12, forceTruncate: true }),
		)

		expect(requestCompaction).toHaveBeenCalledOnce()
		expect(requestCompaction).toHaveBeenCalledWith(session, { stateRevision: 12, mode: "force_truncate" })
		expect(response).toMatchObject({ accepted: true, result: "truncated:12" })
	})

	it("preserves a stale-state rejection from the task", async () => {
		requestCompaction.mockResolvedValue({ accepted: false, result: "stale_state" })

		const response = await compactTask(
			controller("task-1") as never,
			CompactTaskRequest.create({ taskId: "task-1", stateRevision: 3 }),
		)

		expect(response).toMatchObject({ accepted: false, result: "stale_state" })
	})
})
