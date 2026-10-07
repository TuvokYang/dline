import { StringArrayRequest } from "@shared/proto/dline/common"
import { TaskDeletionResult } from "@shared/proto/dline/task"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TaskServiceClient } from "@/services/grpc-client"
import DeleteTaskButton from "./DeleteTaskButton"

vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: {
		deleteTasksWithIds: vi.fn(),
	},
}))

describe("DeleteTaskButton", () => {
	beforeEach(() => {
		vi.mocked(TaskServiceClient.deleteTasksWithIds).mockReset()
		vi.mocked(TaskServiceClient.deleteTasksWithIds).mockResolvedValue(
			TaskDeletionResult.create({
				totalRequested: 1,
				deleted: 1,
				failed: 0,
				skippedLocked: 0,
				failedIds: [],
				lockedIds: [],
			}),
		)
	})

	it("opens a flat themed confirmation dialog before deleting", async () => {
		const onDeleteConfirmed = vi.fn()
		render(<DeleteTaskButton onDeleteConfirmed={onDeleteConfirmed} taskId="task-1" taskSize={1024} />)

		fireEvent.click(screen.getByRole("button"))

		expect(screen.getByText("Delete Task")).toBeInTheDocument()
		expect(screen.getByText(/This permanently removes the task history/)).toBeInTheDocument()
		expect(screen.getByText("Cancel")).toBeInTheDocument()
		expect(screen.getByText("Delete")).toBeInTheDocument()
		expect(onDeleteConfirmed).not.toHaveBeenCalled()
		expect(TaskServiceClient.deleteTasksWithIds).not.toHaveBeenCalled()
	})

	it("closes the current surface as soon as deletion is confirmed", async () => {
		let resolveDeletion: ((result: TaskDeletionResult) => void) | undefined
		vi.mocked(TaskServiceClient.deleteTasksWithIds).mockReturnValue(
			new Promise((resolve) => {
				resolveDeletion = resolve
			}),
		)
		const onDeleteConfirmed = vi.fn()
		render(<DeleteTaskButton onDeleteConfirmed={onDeleteConfirmed} taskId="task-1" taskSize={1024} />)

		fireEvent.click(screen.getByRole("button"))
		fireEvent.click(screen.getByText("Delete"))

		expect(onDeleteConfirmed).toHaveBeenCalledOnce()
		expect(TaskServiceClient.deleteTasksWithIds).toHaveBeenCalledWith(StringArrayRequest.create({ value: ["task-1"] }))

		resolveDeletion?.(
			TaskDeletionResult.create({
				totalRequested: 1,
				deleted: 1,
				failed: 0,
				skippedLocked: 0,
				failedIds: [],
				lockedIds: [],
			}),
		)
		await waitFor(() => expect(screen.queryByText("Delete Task")).not.toBeInTheDocument())
	})
})
