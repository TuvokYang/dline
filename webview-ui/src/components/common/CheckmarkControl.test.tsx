import { act, fireEvent, render, screen } from "@testing-library/react"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { CheckpointsServiceClient } from "@/services/grpc-client"
import { CheckmarkControl } from "./CheckmarkControl"

const relinquishListeners = new Set<() => void>()
let checkpointManagerErrorMessage: string | undefined

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => ({
		checkpointManagerErrorMessage,
		onRelinquishControl: (listener: () => void) => {
			relinquishListeners.add(listener)
			return () => relinquishListeners.delete(listener)
		},
	}),
}))

vi.mock("@/services/grpc-client", () => ({
	CheckpointsServiceClient: {
		checkpointDiff: vi.fn(async () => ({})),
		checkpointRestore: vi.fn(async () => ({})),
	},
}))

describe("CheckmarkControl", () => {
	beforeEach(() => {
		checkpointManagerErrorMessage = undefined
		relinquishListeners.clear()
		vi.mocked(CheckpointsServiceClient.checkpointDiff).mockClear()
		vi.mocked(CheckpointsServiceClient.checkpointRestore).mockClear()
	})

	it("shows partial multi-root coverage without disabling available file restore", () => {
		render(<CheckmarkControl messageTs={42} workspaceCheckpointCoverage={{ available: 1, total: 2 }} />)

		expect(screen.getByText("Checkpoint (1/2 workspaces)", { exact: true })).toBeInTheDocument()
		expect(screen.getByRole("button", { name: "Compare", exact: true, hidden: true })).toBeInTheDocument()
	})

	it("opens the restore confirmation and restores files and task", async () => {
		render(<CheckmarkControl messageTs={42} />)

		fireEvent.click(screen.getByRole("button", { name: "Restore", exact: true, hidden: true }))
		const restoreAll = screen.getByRole("button", { name: "Restore Files & Task", exact: true })
		expect(restoreAll).toBeVisible()

		await act(async () => {
			fireEvent.click(restoreAll)
		})
		expect(CheckpointsServiceClient.checkpointRestore).toHaveBeenCalledWith(
			expect.objectContaining({ number: 42, restoreType: "taskAndWorkspace" }),
		)
	})

	it("keeps historical file checkpoint controls available when current backend health reports an error", () => {
		checkpointManagerErrorMessage = "One workspace checkpoint backend is unhealthy."
		render(<CheckmarkControl hasWorkspaceCheckpoint messageTs={42} />)

		expect(screen.getByRole("button", { name: "Compare", exact: true, hidden: true })).toBeInTheDocument()
	})

	it("keeps chat restore available when the Git checkpoint backend is unavailable", async () => {
		checkpointManagerErrorMessage = "Git must be installed to use checkpoints."
		render(<CheckmarkControl hasWorkspaceCheckpoint={false} messageTs={42} />)

		expect(screen.queryByRole("button", { name: "Compare", exact: true, hidden: true })).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Restore", exact: true, hidden: true }))

		expect(screen.queryByRole("button", { name: "Restore Files & Task", exact: true })).not.toBeInTheDocument()
		expect(screen.queryByRole("button", { name: "Restore Files Only", exact: true })).not.toBeInTheDocument()

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Restore Task Only", exact: true }))
		})
		expect(CheckpointsServiceClient.checkpointRestore).toHaveBeenCalledWith(
			expect.objectContaining({ number: 42, restoreType: "task" }),
		)
	})

	it("routes a compaction card restore through the typed pre-Pass checkpoint request", async () => {
		render(
			<CheckmarkControl
				compactionRestore={{
					expectedChainRevision: 3,
					expectedHeadCheckpointId: "sha256:post-pass",
					operationId: "operation-1",
					prePassCheckpointId: "sha256:pre-pass",
				}}
				messageTs={42}
			/>,
		)

		expect(screen.queryByRole("button", { name: "Compare", exact: true, hidden: true })).not.toBeInTheDocument()
		fireEvent.click(screen.getByRole("button", { name: "Restore", exact: true, hidden: true }))
		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Restore Task Only", exact: true }))
		})

		expect(CheckpointsServiceClient.checkpointRestore).toHaveBeenCalledWith(
			expect.objectContaining({
				compactionCheckpointId: "sha256:pre-pass",
				compactionExpectedChainRevision: 3,
				compactionExpectedHeadCheckpointId: "sha256:post-pass",
				compactionOperationId: "operation-1",
				number: 42,
				restoreType: "task",
			}),
		)
	})

	it("can reopen Restore after Compare relinquishes control", async () => {
		render(<CheckmarkControl messageTs={42} />)

		await act(async () => {
			fireEvent.click(screen.getByRole("button", { name: "Compare", exact: true, hidden: true }))
		})
		act(() => {
			for (const listener of relinquishListeners) listener()
		})
		fireEvent.click(screen.getByRole("button", { name: "Restore", exact: true, hidden: true }))

		expect(screen.getByRole("button", { name: "Restore Files & Task", exact: true })).toBeVisible()
	})

	it("keeps the restore confirmation open when the pointer leaves the checkpoint control", () => {
		vi.useFakeTimers()
		try {
			render(<CheckmarkControl messageTs={42} />)
			fireEvent.click(screen.getByRole("button", { name: "Restore", exact: true, hidden: true }))

			const checkpointLabel = screen.getByText("Checkpoint", { exact: true })
			const checkpointControl = checkpointLabel.parentElement?.parentElement
			if (!checkpointControl) throw new Error("Checkpoint control container was not rendered")
			fireEvent.mouseLeave(checkpointControl)
			act(() => vi.advanceTimersByTime(400))

			expect(screen.getByRole("button", { name: "Restore Files & Task", exact: true })).toBeVisible()
		} finally {
			vi.useRealTimers()
		}
	})

	it("closes the restore confirmation on an outside pointer press", () => {
		render(
			<div>
				<button type="button">Outside</button>
				<CheckmarkControl messageTs={42} />
			</div>,
		)
		fireEvent.click(screen.getByRole("button", { name: "Restore", exact: true, hidden: true }))

		fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }))

		expect(screen.queryByRole("button", { name: "Restore Files & Task", exact: true })).not.toBeInTheDocument()
	})

	it("closes the restore confirmation on Escape", () => {
		render(<CheckmarkControl messageTs={42} />)
		fireEvent.click(screen.getByRole("button", { name: "Restore", exact: true, hidden: true }))

		fireEvent.keyDown(document, { key: "Escape" })

		expect(screen.queryByRole("button", { name: "Restore Files & Task", exact: true })).not.toBeInTheDocument()
	})
})
