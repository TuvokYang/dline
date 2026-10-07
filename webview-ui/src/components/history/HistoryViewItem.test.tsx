import type { HistoryItem } from "@shared/HistoryItem"
import { StringArrayRequest } from "@shared/proto/dline/common"
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { TaskServiceClient } from "@/services/grpc-client"
import HistoryPreview, {
	filterHistoryPreview,
	formatHistoryTimestamp,
	getVisibleHistoryTaskCount,
	HISTORY_PREVIEW_LIMIT,
} from "./HistoryPreview"
import HistoryViewItem from "./HistoryViewItem"

const extensionState = vi.hoisted(() => ({
	openHistoryTask: vi.fn(),
	taskHistory: [] as HistoryItem[],
	workspaceRoots: [{ path: "C:\\work\\current", name: "current" }],
}))

let historyListHeight = 136
let resizeObserverCallback: ResizeObserverCallback | undefined

class TestResizeObserver implements ResizeObserver {
	disconnect = vi.fn()
	observe = vi.fn((target: Element) => {
		Object.defineProperty(target, "clientHeight", { configurable: true, get: () => historyListHeight })
		this.callback([], this)
	})
	unobserve = vi.fn()

	constructor(private readonly callback: ResizeObserverCallback) {
		resizeObserverCallback = callback
	}
}

globalThis.ResizeObserver = TestResizeObserver

vi.mock("@/context/ExtensionStateContext", () => ({
	useExtensionState: () => extensionState,
}))

vi.mock("@/services/grpc-client", () => ({
	TaskServiceClient: {
		deleteTasksWithIds: vi.fn(),
		exportTaskWithId: vi.fn(),
		getTaskHistory: vi.fn(),
		openTaskInNewWindow: vi.fn(),
		showTaskWithId: vi.fn(),
	},
}))

/**
 * Build a history item fixture for interaction tests.
 * @returns History item fixture.
 */
function buildItem(): HistoryItem {
	return {
		id: "task-1",
		task: "Investigate delete behavior",
		ts: Date.now(),
		size: 1024,
	}
}

function historyItem(id: string, ts: number, overrides: Partial<HistoryItem> = {}): HistoryItem {
	return {
		id,
		task: `Task ${id}`,
		ts,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		cwdOnTaskInitialization: "C:\\work\\current",
		...overrides,
	}
}

describe("HistoryViewItem", () => {
	it("does not open the task when clicking delete", () => {
		const handleDeleteHistoryItem = vi.fn()

		render(
			<HistoryViewItem
				handleDeleteHistoryItem={handleDeleteHistoryItem}
				handleHistorySelect={vi.fn()}
				index={0}
				item={buildItem()}
				pendingFavoriteToggles={{}}
				selectedItems={[]}
				toggleFavorite={vi.fn()}
			/>,
		)

		const deleteButton = screen.getByRole("button", { name: "Delete" })
		fireEvent.pointerDown(deleteButton)
		fireEvent.mouseDown(deleteButton)
		fireEvent.click(deleteButton)

		expect(handleDeleteHistoryItem).toHaveBeenCalledWith("task-1")
		expect(extensionState.openHistoryTask).not.toHaveBeenCalled()
		expect(TaskServiceClient.deleteTasksWithIds).not.toHaveBeenCalledWith(StringArrayRequest.create({ value: ["task-1"] }))
	})

	it("opens through the shared immediate-feedback boundary", () => {
		const item = buildItem()
		render(
			<HistoryViewItem
				handleDeleteHistoryItem={vi.fn()}
				handleHistorySelect={vi.fn()}
				index={0}
				item={item}
				pendingFavoriteToggles={{}}
				selectedItems={[]}
				toggleFavorite={vi.fn()}
			/>,
		)
		fireEvent.click(screen.getByText(item.task))
		expect(extensionState.openHistoryTask).toHaveBeenCalledWith(item)
	})
})

describe("HistoryPreview", () => {
	beforeEach(() => {
		extensionState.openHistoryTask.mockClear()
		historyListHeight = 136
		resizeObserverCallback = undefined
		extensionState.taskHistory = []
		extensionState.workspaceRoots = [{ path: "C:\\work\\current", name: "current" }]
		vi.mocked(TaskServiceClient.getTaskHistory).mockReset().mockResolvedValue({ tasks: [], totalCount: 0 })
	})

	it("defaults to the current workspace and requests newest tasks", async () => {
		extensionState.taskHistory = [
			historyItem("workspace", new Date(2026, 0, 1, 2, 3, 4).getTime()),
			historyItem("other", new Date(2026, 0, 2).getTime(), { cwdOnTaskInitialization: "C:\\work\\other" }),
		]

		render(<HistoryPreview showHistoryView={vi.fn()} />)

		expect(screen.getByRole("button", { name: "Workspace" })).toHaveAttribute("aria-pressed", "true")
		expect(screen.getByText("Task workspace")).toBeInTheDocument()
		expect(screen.queryByText("Task other")).not.toBeInTheDocument()
		expect(screen.getByText("2026/01/01 02:03:04")).toBeInTheDocument()
		await waitFor(() =>
			expect(TaskServiceClient.getTaskHistory).toHaveBeenCalledWith(
				expect.objectContaining({
					currentWorkspaceOnly: true,
					favoritesOnly: false,
					includeCompletionStatus: true,
					resultLimit: HISTORY_PREVIEW_LIMIT,
					sortBy: "newest",
				}),
			),
		)
	})

	it("opens Recent selections through the shared immediate-feedback boundary", async () => {
		const item = historyItem("workspace", 1)
		vi.mocked(TaskServiceClient.getTaskHistory).mockResolvedValue({ tasks: [item], totalCount: 1 })
		render(<HistoryPreview showHistoryView={vi.fn()} />)
		fireEvent.click(await screen.findByText(item.task))
		expect(extensionState.openHistoryTask).toHaveBeenCalledWith(expect.objectContaining({ id: item.id, task: item.task }))
	})

	it("switches between favorite and all task requests", async () => {
		render(<HistoryPreview showHistoryView={vi.fn()} />)
		await waitFor(() => expect(TaskServiceClient.getTaskHistory).toHaveBeenCalledTimes(1))

		fireEvent.click(screen.getByRole("button", { name: "Favorite" }))
		await waitFor(() =>
			expect(TaskServiceClient.getTaskHistory).toHaveBeenLastCalledWith(
				expect.objectContaining({ currentWorkspaceOnly: false, favoritesOnly: true }),
			),
		)

		fireEvent.click(screen.getByRole("button", { name: "All" }))
		await waitFor(() =>
			expect(TaskServiceClient.getTaskHistory).toHaveBeenLastCalledWith(
				expect.objectContaining({ currentWorkspaceOnly: false, favoritesOnly: false }),
			),
		)
	})

	it("does not restart the initial workspace request for equivalent state snapshots", async () => {
		extensionState.taskHistory = [historyItem("other", 1, { cwdOnTaskInitialization: "C:\\work\\other" })]
		const { rerender } = render(<HistoryPreview showHistoryView={vi.fn()} />)
		await waitFor(() => expect(TaskServiceClient.getTaskHistory).toHaveBeenCalledTimes(1))

		extensionState.taskHistory = [...extensionState.taskHistory]
		extensionState.workspaceRoots = extensionState.workspaceRoots.map((root) => ({ ...root }))
		rerender(<HistoryPreview showHistoryView={vi.fn()} />)

		await waitFor(() => expect(TaskServiceClient.getTaskHistory).toHaveBeenCalledTimes(1))
	})

	it("retries a transient initial workspace request failure", async () => {
		vi.mocked(TaskServiceClient.getTaskHistory)
			.mockRejectedValueOnce(new Error("bridge not ready"))
			.mockResolvedValueOnce({ tasks: [historyItem("workspace", 1)], totalCount: 1 })

		render(<HistoryPreview showHistoryView={vi.fn()} />)

		await waitFor(() => expect(TaskServiceClient.getTaskHistory).toHaveBeenCalledTimes(2))
		expect(await screen.findByText("Task workspace")).toBeInTheDocument()
	})

	it("renders only complete rows that fit the available list height", async () => {
		extensionState.taskHistory = Array.from({ length: 4 }, (_, index) => historyItem(String(index + 1), 4 - index))
		vi.mocked(TaskServiceClient.getTaskHistory).mockResolvedValue({ tasks: extensionState.taskHistory, totalCount: 4 })

		render(<HistoryPreview showHistoryView={vi.fn()} />)

		await waitFor(() => expect(screen.queryByText("Task 3")).not.toBeInTheDocument())
		expect(screen.getByText("Task 1")).toBeInTheDocument()
		expect(screen.getByText("Task 2")).toBeInTheDocument()
		expect(screen.queryByText("Task 4")).not.toBeInTheDocument()
	})

	it("recalculates complete rows when the list height changes", async () => {
		extensionState.taskHistory = Array.from({ length: 4 }, (_, index) => historyItem(String(index + 1), 4 - index))
		vi.mocked(TaskServiceClient.getTaskHistory).mockResolvedValue({ tasks: extensionState.taskHistory, totalCount: 4 })

		render(<HistoryPreview showHistoryView={vi.fn()} />)
		expect(await screen.findByText("Task 2")).toBeInTheDocument()
		expect(screen.queryByText("Task 3")).not.toBeInTheDocument()

		act(() => {
			historyListHeight = 208
			resizeObserverCallback?.([], {} as ResizeObserver)
		})
		expect(screen.getByText("Task 3")).toBeInTheDocument()

		act(() => {
			historyListHeight = 135
			resizeObserverCallback?.([], {} as ResizeObserver)
		})
		expect(screen.getByText("Task 1")).toBeInTheDocument()
		expect(screen.queryByText("Task 2")).not.toBeInTheDocument()
	})

	it("does not show an unrevisioned legacy completion while the filtered request is pending", () => {
		const legacy = historyItem("legacy", 1, { isCompleted: true })
		extensionState.taskHistory = [legacy]
		vi.mocked(TaskServiceClient.getTaskHistory).mockReturnValue(new Promise(() => {}))

		render(<HistoryPreview showHistoryView={vi.fn()} />)

		expect(screen.queryByLabelText("Completed")).not.toBeInTheDocument()
	})

	it("shows a completion check with a completion tooltip", async () => {
		const user = userEvent.setup()
		const completed = historyItem("completed", 1, {
			isCompleted: true,
			completionStateRevision: 1,
			totalCost: 22.588,
			currency: "USD",
		})
		extensionState.taskHistory = [completed]
		vi.mocked(TaskServiceClient.getTaskHistory).mockResolvedValue({ tasks: [completed], totalCount: 1 })

		render(<HistoryPreview showHistoryView={vi.fn()} />)

		const completionStatus = await screen.findByLabelText("Completed")
		const metadataRow = completionStatus.closest(".history-meta-row")
		const cost = screen.getByText("$22.59")
		expect(metadataRow).toContainElement(cost)
		expect(metadataRow).toContainElement(completionStatus)
		expect(cost.compareDocumentPosition(completionStatus) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
		expect(getComputedStyle(metadataRow as HTMLElement).alignSelf).toBe("stretch")
		expect(getComputedStyle(metadataRow as HTMLElement).justifyContent).toBe("flex-start")
		expect(getComputedStyle(completionStatus).marginLeft).toBe("auto")
		await user.hover(completionStatus)
		expect(await screen.findByRole("tooltip")).toHaveTextContent("Completed")
	})

	it("never counts a partially visible row", () => {
		expect(getVisibleHistoryTaskCount(135)).toBe(1)
		expect(getVisibleHistoryTaskCount(136)).toBe(2)
		expect(getVisibleHistoryTaskCount(207)).toBe(2)
		expect(getVisibleHistoryTaskCount(208)).toBe(3)
	})

	it("shows up to ten newest tasks for the selected workspace", () => {
		const tasks = Array.from({ length: 12 }, (_, index) => historyItem(String(index), index + 1))
		tasks.push(historyItem("other", 100, { cwdOnTaskInitialization: "C:\\work\\other" }))

		const result = filterHistoryPreview(tasks, "workspace", ["c:/work/current/"])

		expect(result).toHaveLength(HISTORY_PREVIEW_LIMIT)
		expect(result.map((item) => item.id)).toEqual(["11", "10", "9", "8", "7", "6", "5", "4", "3", "2"])
	})

	it("keeps favorites independent of workspace", () => {
		const result = filterHistoryPreview(
			[
				historyItem("current", 1, { isFavorited: false }),
				historyItem("favorite", 2, { cwdOnTaskInitialization: "C:\\work\\other", isFavorited: true }),
			],
			"favorite",
			["C:\\work\\current"],
		)

		expect(result.map((item) => item.id)).toEqual(["favorite"])
	})

	it("formats the last-edit timestamp with seconds", () => {
		expect(formatHistoryTimestamp(new Date(2026, 0, 1, 2, 3, 4).getTime())).toBe("2026/01/01 02:03:04")
	})

	it("shows consumed tokens instead of a zero cost", async () => {
		const free = historyItem("free", 1, { totalCost: 0, tokensIn: 900, tokensOut: 400 })
		extensionState.taskHistory = [free]
		vi.mocked(TaskServiceClient.getTaskHistory).mockResolvedValue({ tasks: [free], totalCount: 1 })

		render(<HistoryPreview showHistoryView={vi.fn()} />)

		expect(await screen.findByText("1.3k tokens")).toBeInTheDocument()
		expect(screen.queryByText("$0.00")).not.toBeInTheDocument()
	})

	it("keeps a completion returned by the filtered request", async () => {
		// The service emits the canonical projection, so the response carries the
		// revision alongside the flag; a bare flag is not authoritative.
		const completed = historyItem("completed", 1, { isCompleted: true, completionStateRevision: 4 })
		extensionState.taskHistory = []
		vi.mocked(TaskServiceClient.getTaskHistory).mockResolvedValue({ tasks: [completed], totalCount: 1 })

		render(<HistoryPreview showHistoryView={vi.fn()} />)

		expect(await screen.findByLabelText("Completed")).toBeInTheDocument()
	})
})
