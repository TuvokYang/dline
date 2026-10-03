import type { HistoryItem } from "@shared/HistoryItem"
import { StringRequest } from "@shared/proto/dline/common"
import { GetTaskHistoryRequest } from "@shared/proto/dline/task"
import { ExternalLinkIcon } from "lucide-react"
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { useExtensionState } from "@/context/ExtensionStateContext"
import { TaskServiceClient } from "@/services/grpc-client"
import { TaskCompletionBadge } from "./TaskCompletionBadge"
import { getTaskUsageLabel, isTaskCompleted } from "./task-metrics"

type HistoryPreviewProps = {
	showHistoryView: () => void
}

export type HistoryPreviewFilter = "workspace" | "favorite" | "all"

type PreviewTask = Pick<HistoryItem, "id" | "task" | "ts"> &
	Partial<
		Pick<
			HistoryItem,
			"cacheReads" | "cacheWrites" | "currency" | "isCompleted" | "isFavorited" | "tokensIn" | "tokensOut" | "totalCost"
		>
	>

export const HISTORY_PREVIEW_LIMIT = 10
export const HISTORY_PREVIEW_ROW_HEIGHT_PX = 64
export const HISTORY_PREVIEW_ROW_GAP_PX = 8
const INITIAL_HISTORY_LOAD_RETRY_DELAY_MS = 250

const FILTERS: Array<{ value: HistoryPreviewFilter; label: string }> = [
	{ value: "workspace", label: "Workspace" },
	{ value: "favorite", label: "Favorite" },
	{ value: "all", label: "All" },
]

function normalizeWorkspacePath(value: string): string {
	return value.replace(/\\/g, "/").replace(/\/+$/, "").toLocaleLowerCase()
}

/** Return the number of fixed-height rows that fit without clipping. */
export function getVisibleHistoryTaskCount(containerHeight: number): number {
	const rowStride = HISTORY_PREVIEW_ROW_HEIGHT_PX + HISTORY_PREVIEW_ROW_GAP_PX
	return Math.min(HISTORY_PREVIEW_LIMIT, Math.max(0, Math.floor((containerHeight + HISTORY_PREVIEW_ROW_GAP_PX) / rowStride)))
}

/** Format a task's last-edit timestamp using local time. */
export function formatHistoryTimestamp(timestamp: number): string {
	const date = new Date(timestamp)
	if (Number.isNaN(date.getTime())) return ""
	const pad = (value: number) => String(value).padStart(2, "0")
	return `${date.getFullYear()}/${pad(date.getMonth() + 1)}/${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** Build an immediate preview while the authoritative filtered request is in flight. */
export function filterHistoryPreview(
	taskHistory: HistoryItem[],
	filter: HistoryPreviewFilter,
	workspacePaths: string[],
): PreviewTask[] {
	const normalizedWorkspacePaths = new Set(workspacePaths.map(normalizeWorkspacePath).filter(Boolean))
	return taskHistory
		.filter((item) => {
			if (!item.ts || !item.task) return false
			if (filter === "favorite") return item.isFavorited === true
			if (filter === "all") return true
			const taskWorkspace = item.cwdOnTaskInitialization ?? item.shadowGitConfigWorkTree
			return taskWorkspace ? normalizedWorkspacePaths.has(normalizeWorkspacePath(taskWorkspace)) : false
		})
		.sort((a, b) => b.ts - a.ts)
		.slice(0, HISTORY_PREVIEW_LIMIT)
		.map((item) => ({ ...item, isCompleted: isTaskCompleted(item) }))
}

/** One Recent-list row: task text, timestamp, usage badge and completion state. */
function HistoryPreviewRow({ item, onSelect }: { item: PreviewTask; onSelect: (item: PreviewTask) => void }) {
	const usage = getTaskUsageLabel(item)
	const timestamp = formatHistoryTimestamp(item.ts)

	return (
		<div className="history-preview-item" onClick={() => onSelect(item)} onContextMenu={(event) => event.preventDefault()}>
			<div className="history-task-content">
				{item.isFavorited && (
					<span
						aria-label="Favorited"
						className="codicon codicon-star-full"
						style={{ color: "var(--vscode-button-background)", flexShrink: 0 }}
					/>
				)}
				<div className="history-task-description ph-no-capture">{item.task}</div>
			</div>
			<div className="history-preview-btns">
				<button
					onClick={(event) => {
						event.stopPropagation()
						TaskServiceClient.openTaskInNewWindow(StringRequest.create({ value: item.id })).catch((error) =>
							console.error("Failed to open task in new window:", error),
						)
					}}
					style={{
						background: "none",
						border: "none",
						cursor: "pointer",
						padding: "2px",
						color: "var(--vscode-descriptionForeground)",
						display: "flex",
						alignItems: "center",
					}}
					title="Open in New Window"
					type="button">
					<ExternalLinkIcon size={14} />
				</button>
			</div>
			<div className="history-meta-stack">
				<span className="history-date" title={`Last edited ${timestamp}`}>
					{timestamp}
				</span>
				{(usage || item.isCompleted) && (
					<div className="history-meta-row">
						{usage && (
							<span className="history-cost-chip" title={usage.title}>
								{usage.text}
							</span>
						)}
						{item.isCompleted && <TaskCompletionBadge side="left" />}
					</div>
				)}
			</div>
		</div>
	)
}

const HistoryPreview = ({ showHistoryView }: HistoryPreviewProps) => {
	const { taskHistory, workspaceRoots, openHistoryTask } = useExtensionState()
	const [filter, setFilter] = useState<HistoryPreviewFilter>("workspace")
	const workspacePaths = useMemo(() => workspaceRoots.map((root) => root.path), [workspaceRoots])
	const fallbackTasks = useMemo(
		() => filterHistoryPreview(taskHistory, filter, workspacePaths),
		[filter, taskHistory, workspacePaths],
	)
	// Extension state snapshots recreate arrays even when their contents are unchanged.
	const requestKey = useMemo(() => JSON.stringify([filter, workspacePaths, taskHistory]), [filter, taskHistory, workspacePaths])
	const [loadedTasks, setLoadedTasks] = useState<{
		requestKey: string
		tasks: PreviewTask[]
	}>()
	const listRef = useRef<HTMLDivElement>(null)
	const [visibleTaskCount, setVisibleTaskCount] = useState(0)
	const tasks = loadedTasks?.requestKey === requestKey ? loadedTasks.tasks : fallbackTasks
	const visibleTasks = tasks.slice(0, visibleTaskCount)

	useEffect(() => {
		let cancelled = false
		let retryTimer: ReturnType<typeof setTimeout> | undefined
		const loadTasks = async (attempt: number) => {
			try {
				const response = await TaskServiceClient.getTaskHistory(
					GetTaskHistoryRequest.create({
						currentWorkspaceOnly: filter === "workspace",
						favoritesOnly: filter === "favorite",
						includeCompletionStatus: true,
						resultLimit: HISTORY_PREVIEW_LIMIT,
						sortBy: "newest",
					}),
				)
				if (!cancelled) {
					// The service carries the canonical projection, including its
					// revision, so the shared completion rule applies directly.
					setLoadedTasks({
						requestKey,
						tasks: response.tasks.slice(0, HISTORY_PREVIEW_LIMIT).map((task) => ({
							...task,
							isCompleted: isTaskCompleted(task),
						})),
					})
				}
			} catch (error) {
				if (cancelled) return
				if (attempt === 0) {
					retryTimer = setTimeout(() => void loadTasks(1), INITIAL_HISTORY_LOAD_RETRY_DELAY_MS)
					return
				}
				console.error("Error loading recent tasks:", error)
			}
		}
		void loadTasks(0)

		return () => {
			cancelled = true
			if (retryTimer) clearTimeout(retryTimer)
		}
	}, [filter, requestKey])

	useLayoutEffect(() => {
		const list = listRef.current
		if (!list) return
		const updateVisibleTaskCount = () => setVisibleTaskCount(getVisibleHistoryTaskCount(list.clientHeight))
		updateVisibleTaskCount()
		if (typeof ResizeObserver === "undefined") {
			window.addEventListener("resize", updateVisibleTaskCount)
			return () => window.removeEventListener("resize", updateVisibleTaskCount)
		}
		const observer = new ResizeObserver(updateVisibleTaskCount)
		observer.observe(list)
		return () => observer.disconnect()
	}, [])

	const handleHistorySelect = (item: PreviewTask) => openHistoryTask(item)

	return (
		<div className="history-preview">
			<style>
				{`
					.history-preview {
						display: flex;
						flex: 1;
						flex-direction: column;
						min-height: 0;
					}
					.history-preview-item {
						background-color: color-mix(in srgb, var(--vscode-toolbar-hoverBackground) 65%, transparent);
						border-radius: 4px;
						position: relative;
						overflow: hidden;
						box-sizing: border-box;
						cursor: pointer;
						height: ${HISTORY_PREVIEW_ROW_HEIGHT_PX}px;
						min-height: ${HISTORY_PREVIEW_ROW_HEIGHT_PX}px;
						padding: 10px 12px;
						display: flex;
						align-items: flex-start;
						gap: 12px;
					}
					.history-preview-item:hover {
						background-color: color-mix(in srgb, var(--vscode-toolbar-hoverBackground) 100%, transparent);
						pointer-events: auto;
					}
					.history-task-content {
						flex: 1;
						display: flex;
						align-items: flex-start;
						gap: 8px;
						min-width: 0;
					}
					.history-task-description {
						flex: 1;
						overflow: hidden;
						display: -webkit-box;
						-webkit-line-clamp: 2;
						-webkit-box-orient: vertical;
						color: var(--vscode-foreground);
						font-size: var(--vscode-font-size);
						line-height: 1.4;
					}
					.history-meta-stack {
						display: flex;
						flex-direction: column;
						align-items: flex-end;
						gap: 4px;
						flex-shrink: 0;
					}
					.history-meta-row {
						display: flex;
						align-items: center;
						align-self: stretch;
						justify-content: flex-start;
						gap: 4px;
						min-height: 18px;
					}
					.history-date {
						color: var(--vscode-descriptionForeground);
						font-size: 0.85em;
						white-space: nowrap;
					}
					.history-cost-chip {
						background-color: var(--vscode-badge-background);
						color: var(--vscode-badge-foreground);
						padding: 2px 8px;
						border-radius: 12px;
						font-size: 0.85em;
						font-weight: 500;
						white-space: nowrap;
					}
					.history-view-all-btn {
						background: none;
						border: none;
						padding: 4px 0 4px 8px;
						cursor: pointer;
						font-size: 0.85em;
						font-weight: 500;
						color: var(--vscode-descriptionForeground);
						white-space: nowrap;
						display: flex;
						align-items: center;
						gap: 2px;
					}
					.history-view-all-btn .codicon {
						font-size: 1.2em;
					}
					.history-view-all-btn:hover {
						color: var(--vscode-foreground);
					}
					.history-preview-btns {
						display: flex;
						gap: 4px;
						opacity: 0;
						transition: opacity 0.15s;
					}
					.history-preview-item:hover .history-preview-btns {
						opacity: 1;
					}
					.history-completion-status {
						color: var(--vscode-testing-iconPassed, var(--vscode-button-background));
						display: inline-flex;
						flex-shrink: 0;
						margin-left: auto;
					}
					.history-preview-list {
						display: flex;
						flex: 1;
						flex-direction: column;
						gap: ${HISTORY_PREVIEW_ROW_GAP_PX}px;
						min-height: 0;
						overflow: hidden;
					}
					.history-preview-filters {
						display: flex;
						gap: 4px;
						margin-top: 8px;
					}
					.history-preview-filter {
						background: transparent;
						border: 1px solid var(--vscode-widget-border, transparent);
						border-radius: 4px;
						color: var(--vscode-descriptionForeground);
						cursor: pointer;
						font: inherit;
						font-size: 0.82em;
						padding: 3px 8px;
					}
					.history-preview-filter:hover {
						background: var(--vscode-toolbar-hoverBackground);
						color: var(--vscode-foreground);
					}
					.history-preview-filter[aria-pressed="true"] {
						background: var(--vscode-button-secondaryBackground);
						color: var(--vscode-button-secondaryForeground);
					}
				`}
			</style>

			<div
				className="history-header"
				style={{
					color: "var(--vscode-descriptionForeground)",
					margin: "10px 16px 10px 16px",
				}}>
				<div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
					<div style={{ display: "flex", alignItems: "center" }}>
						<span
							className="codicon codicon-comment-discussion"
							style={{ marginRight: "4px", transform: "scale(0.9)" }}
						/>
						<span style={{ fontWeight: 500, fontSize: "0.85em", textTransform: "uppercase" }}>Recent</span>
					</div>
					{taskHistory.some((item) => item.ts && item.task) && (
						<button className="history-view-all-btn" onClick={() => showHistoryView()} type="button">
							View All
							<span className="codicon codicon-chevron-right" />
						</button>
					)}
				</div>
				<div aria-label="Recent task filter" className="history-preview-filters" role="group">
					{FILTERS.map((option) => (
						<button
							aria-pressed={filter === option.value}
							className="history-preview-filter"
							key={option.value}
							onClick={() => setFilter(option.value)}
							type="button">
							{option.label}
						</button>
					))}
				</div>
			</div>

			<div className="px-4 history-preview-list" ref={listRef}>
				{tasks.length > 0 ? (
					visibleTasks.map((item) => <HistoryPreviewRow item={item} key={item.id} onSelect={handleHistorySelect} />)
				) : (
					<div
						style={{
							textAlign: "center",
							color: "var(--vscode-descriptionForeground)",
							fontSize: "var(--vscode-font-size)",
							padding: "10px 0",
						}}>
						No recent tasks
					</div>
				)}
			</div>
		</div>
	)
}

export default memo(HistoryPreview)
