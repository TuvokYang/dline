import { StringRequest } from "@shared/proto/dline/common"
import { TaskLockStatus } from "@shared/proto/dline/task"
import { fireEvent, render, screen, waitFor } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"
import { TaskServiceClient } from "@/services/grpc-client"
import { TaskLockBanner } from "./TaskLockBanner"

vi.mock("@/services/grpc-client", () => ({
    TaskServiceClient: {
        checkTaskLock: vi.fn(),
        forceReleaseTaskLock: vi.fn().mockResolvedValue({}),
    },
}))

/**
 * Build a locked task status fixture.
 * @returns Locked task status fixture.
 */
function buildLockStatus(): TaskLockStatus {
    return TaskLockStatus.create({
        isLocked: true,
        isStale: false,
        lockedBy: "other-window",
    })
}

describe("TaskLockBanner", () => {
    it("opens the shared alert dialog before force unlocking", async () => {
        render(<TaskLockBanner currentTaskId="task-1" taskLockStatus={buildLockStatus()} />)

        fireEvent.click(screen.getByRole("button", { name: "Unlock" }))

        expect(screen.getByRole("dialog")).toBeInTheDocument()
        expect(screen.getByText("Unlock Task")).toBeInTheDocument()
        expect(screen.getByText(/Confirm unlock/)).toBeInTheDocument()
        expect(TaskServiceClient.forceReleaseTaskLock).not.toHaveBeenCalled()
    })

    it("force unlocks only after confirmation", async () => {
        render(<TaskLockBanner currentTaskId="task-1" taskLockStatus={buildLockStatus()} />)

        fireEvent.click(screen.getByRole("button", { name: "Unlock" }))
        fireEvent.click(screen.getByText("Confirm"))

        await waitFor(() => {
            expect(TaskServiceClient.forceReleaseTaskLock).toHaveBeenCalledWith(StringRequest.create({ value: "task-1" }))
        })
    })
})
