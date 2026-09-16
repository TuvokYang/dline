import type { TaskActivity } from "@shared/proto/dline/task"
import {
	AlarmClockIcon,
	BotIcon,
	BringToFrontIcon,
	CheckIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	CircleSlashIcon,
	CircleXIcon,
	LoaderCircleIcon,
	SendToBackIcon,
	TerminalIcon,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { CopyButton } from "@/components/common/CopyButton"
import { Button } from "@/components/ui/button"
import { cn } from "@/lib/utils"
import { CommandOutputContent } from "../CommandOutputRow"
import { getCommandEnvironmentLabel, getCommandOutputSummary } from "../command-output"
import { SubagentMetrics } from "./SubagentMetrics"
import { SubagentRetryTimeline } from "./SubagentRetryTimeline"
import { SubagentRuntimeConfig } from "./SubagentRuntimeConfig"
import { SubagentToolTimeline } from "./SubagentToolTimeline"
import { buildSubagentActivityPresentation, parseSubagentActivityDetail } from "./subagent-activity-model"
import { useActivityControlGuard } from "./useActivityControlGuard"
import { cancelTaskActivities, finishTaskActivities, retryTaskActivities, useTaskActivities } from "./useTaskActivities"

export type StatusFilter = "active" | "all"
export type KindFilter = "all" | "subagent" | "command"

export interface TaskActivityFilters {
	status: StatusFilter
	kind: KindFilter
}

export const DEFAULT_TASK_ACTIVITY_FILTERS: TaskActivityFilters = {
	status: "active",
	kind: "all",
}

const ACTIVE_STATUSES = new Set(["awaiting_approval", "running", "cancelling"])

export function formatCommandTimeout(timeoutSeconds: number): string {
	return timeoutSeconds >= 3600 ? `${(timeoutSeconds / 3600).toFixed(1)} h` : `${timeoutSeconds} s`
}

function formatDuration(activity: TaskActivity): string {
	const end = activity.finishedAt ?? Date.now()
	const seconds = Math.max(0, Math.floor((end - activity.createdAt) / 1000))
	const minutes = Math.floor(seconds / 60)
	return minutes > 0 ? `${minutes}:${String(seconds % 60).padStart(2, "0")}` : `${seconds}s`
}

function StatusIcon({ status }: { status: string }) {
	if (status === "running" || status === "cancelling") return <LoaderCircleIcon className="size-3.5 animate-spin text-link" />
	if (status === "completed") return <CheckIcon className="size-3.5 text-success" />
	if (status === "cancelled" || status === "interrupted" || status === "skipped") {
		return <CircleSlashIcon className="size-3.5 text-description" />
	}
	if (status === "failed" || status === "timeout") return <CircleXIcon className="size-3.5 text-error" />
	return <BotIcon className="size-3.5 text-description" />
}

function statusAccentClass(status: string): string {
	if (status === "running" || status === "cancelling") return "bg-link"
	if (status === "completed") return "bg-success"
	if (status === "failed" || status === "timeout") return "bg-error"
	if (status === "awaiting_approval") return "bg-editor-warning-foreground"
	return "bg-description"
}

function statusChipClass(status: string): string {
	if (status === "running" || status === "cancelling") return "bg-link/10 text-link"
	if (status === "completed") return "bg-success/10 text-success"
	if (status === "failed" || status === "timeout") return "bg-error/10 text-error"
	if (status === "awaiting_approval") return "bg-editor-warning-foreground/10 text-editor-warning-foreground"
	return "bg-description/10 text-description"
}

function ActivityStatusChip({ status }: { status: string }) {
	return (
		<span
			className={cn("rounded-xs px-1.5 py-0.5 text-[10px] capitalize", statusChipClass(status))}
			data-testid="activity-status-chip">
			{status.replaceAll("_", " ")}
		</span>
	)
}

function ActivityTitle({ activity, isSubagent }: { activity: TaskActivity; isSubagent: boolean }) {
	const KindIcon = activity.kind === "command" ? TerminalIcon : BotIcon
	return (
		<div className="flex flex-wrap items-center gap-1.5">
			<KindIcon className="size-3 shrink-0 opacity-70" data-testid="activity-kind-icon" />
			<span
				className={cn("truncate text-xs font-semibold text-foreground", {
					"font-mono": activity.kind === "command",
				})}>
				{activity.title}
			</span>
			{isSubagent && <ActivityStatusChip status={activity.status} />}
		</div>
	)
}

function ActivityStatusText({ isSubagent, status }: { isSubagent: boolean; status: string }) {
	if (isSubagent) return null
	return <span className="capitalize">{status.replaceAll("_", " ")}</span>
}

function CommandActivityOutput({ activity }: { activity: TaskActivity }) {
	const [isOutputFullyExpanded, setIsOutputFullyExpanded] = useState(false)
	if (!activity.output && !activity.logPath) return null
	return (
		<CommandOutputContent
			isCommandActive={ACTIVE_STATUSES.has(activity.status)}
			isContainerExpanded={true}
			isOutputFullyExpanded={isOutputFullyExpanded}
			logPath={activity.logPath}
			onToggle={() => setIsOutputFullyExpanded((value) => !value)}
			output={activity.output ?? ""}
			presentation="activity"
		/>
	)
}

export function TaskActivityPanel({
	taskId,
	focusActivityId,
	filters,
	onFiltersChange,
}: {
	taskId: string
	focusActivityId?: string
	filters?: TaskActivityFilters
	onFiltersChange?: (filters: TaskActivityFilters) => void
}) {
	const { activities } = useTaskActivities(taskId)
	const [internalFilters, setInternalFilters] = useState<TaskActivityFilters>(DEFAULT_TASK_ACTIVITY_FILTERS)
	const selectedFilters = filters ?? internalFilters
	const [expanded, setExpanded] = useState<Record<string, boolean>>({})
	const { isPending, runControl } = useActivityControlGuard()
	const itemRefs = useRef(new Map<string, HTMLDivElement>())
	const handledFocusId = useRef<string>()
	const updateFilters = (nextFilters: TaskActivityFilters) => {
		if (!filters) setInternalFilters(nextFilters)
		onFiltersChange?.(nextFilters)
	}
	useEffect(() => {
		if (!focusActivityId) return
		setExpanded((value) => ({ ...value, [focusActivityId]: true }))
		handledFocusId.current = undefined
	}, [focusActivityId])
	const filtered = useMemo(
		() =>
			focusActivityId
				? activities.filter((activity) => activity.activityId === focusActivityId)
				: activities.filter(
						(activity) =>
							(selectedFilters.status === "all" || ACTIVE_STATUSES.has(activity.status)) &&
							(selectedFilters.kind === "all" || activity.kind === selectedFilters.kind),
					),
		[selectedFilters, activities, focusActivityId],
	)
	useEffect(() => {
		if (!focusActivityId || handledFocusId.current === focusActivityId) return
		if (!filtered.some((activity) => activity.activityId === focusActivityId)) return
		const frame = requestAnimationFrame(() => {
			itemRefs.current.get(focusActivityId)?.scrollIntoView({ block: "center" })
			handledFocusId.current = focusActivityId
		})
		return () => cancelAnimationFrame(frame)
	}, [filtered, focusActivityId])

	return (
		<div className="flex min-h-0 flex-1 flex-col overflow-hidden">
			<div className="space-y-2 border-b border-editor-group-border px-4 py-2">
				<div className="flex gap-1" data-testid="activity-status-filters">
					{(["active", "all"] as const).map((filter) => (
						<button
							className={cn("rounded-xs border px-2 py-1 text-xs cursor-pointer", {
								"border-link bg-link/10 text-foreground": selectedFilters.status === filter,
								"border-editor-group-border bg-transparent text-description": selectedFilters.status !== filter,
							})}
							data-testid={`activity-status-filter-${filter}`}
							key={filter}
							onClick={() => updateFilters({ ...selectedFilters, status: filter })}
							type="button">
							{filter === "active" ? "Active" : "All"}
						</button>
					))}
				</div>
				<div className="flex gap-1" data-testid="activity-kind-filters">
					{(["all", "subagent", "command"] as const).map((filter) => (
						<button
							className={cn("rounded-xs border px-2 py-1 text-[11px] cursor-pointer", {
								"border-link bg-link/10 text-foreground": selectedFilters.kind === filter,
								"border-editor-group-border bg-transparent text-description": selectedFilters.kind !== filter,
							})}
							data-testid={`activity-kind-filter-${filter}`}
							key={filter}
							onClick={() => updateFilters({ ...selectedFilters, kind: filter })}
							type="button">
							{filter === "all" ? "All" : filter === "subagent" ? "Subagents" : "Commands"}
						</button>
					))}
				</div>
			</div>

			<div className="min-h-0 flex-1 space-y-2 overflow-y-auto px-4 py-3" data-testid="activity-list">
				{filtered.length === 0 && (
					<div className="py-8 text-center text-xs text-description">No matching activities.</div>
				)}
				{filtered.map((activity) => {
					const isExpanded = expanded[activity.activityId] === true
					const isActive = ACTIVE_STATUSES.has(activity.status)
					const isSubagent = activity.kind === "subagent"
					const subagentPresentation = isSubagent
						? buildSubagentActivityPresentation(activity.events, activity.currentAttempt)
						: undefined
					const subagentDetail = isSubagent ? parseSubagentActivityDetail(activity.detail) : undefined
					const ExecutionModeIcon = activity.executionMode === "background" ? SendToBackIcon : BringToFrontIcon
					const environmentLabel = activity.kind === "command" ? getCommandEnvironmentLabel(activity.output) : undefined
					const activitySummary =
						activity.kind === "command"
							? (getCommandOutputSummary(activity.output) ?? getCommandOutputSummary(activity.latestEvent))
							: undefined
					const finishKey = `finish:${activity.activityId}`
					const retryKey = `retry:${activity.activityId}`
					return (
						<div
							className="relative overflow-hidden rounded-sm border border-editor-widget-border/60 bg-editor-background [box-shadow:0_1px_2px_var(--vscode-widget-shadow,transparent)]"
							data-activity-id={activity.activityId}
							data-activity-status={activity.status}
							data-testid="activity-item"
							key={activity.activityId}
							ref={(element) => {
								if (element) itemRefs.current.set(activity.activityId, element)
								else itemRefs.current.delete(activity.activityId)
							}}>
							<div
								aria-hidden="true"
								className={cn("absolute inset-y-0 left-0 z-10 w-[3px]", statusAccentClass(activity.status))}
								data-testid="activity-status-accent"
							/>
							<div
								className={cn(
									"flex gap-2 pr-2.5 pl-3",
									isSubagent ? "items-center py-2" : "items-start bg-toolbar-hover/30 py-2.5",
								)}
								data-testid="activity-header">
								<button
									className={cn(
										"flex min-w-0 flex-1 gap-2 border-0 bg-transparent p-0 text-left cursor-pointer",
										isSubagent ? "items-center" : "items-start",
									)}
									data-testid="activity-toggle"
									onClick={() => setExpanded((value) => ({ ...value, [activity.activityId]: !isExpanded }))}
									type="button">
									<StatusIcon status={activity.status} />
									<div className="min-w-0 flex-1">
										<ActivityTitle activity={activity} isSubagent={isSubagent} />
										<div
											className={cn(
												"flex flex-wrap items-center gap-x-1.5 gap-y-1 text-[11px] text-description",
												isSubagent ? "mt-0.5" : "mt-1",
											)}
											data-testid="activity-metadata">
											{activity.kind === "command" ? (
												<span
													className="inline-flex w-fit max-w-full min-w-0 flex-nowrap items-center gap-1.5"
													data-testid="activity-environment-mode">
													{environmentLabel && (
														<span
															className="inline-block min-w-0 max-w-[60%] flex-auto truncate rounded-xs bg-code/70 px-1.5 py-0.5 font-mono text-[10px] text-foreground"
															data-testid="activity-environment-label"
															title={`Environment: ${environmentLabel}`}>
															({environmentLabel})
														</span>
													)}
													<span
														className={cn(
															"inline-flex shrink-0 items-center gap-1 rounded-xs px-1.5 py-0.5",
															{
																"bg-editor-warning-foreground/10 text-editor-warning-foreground":
																	activity.executionMode === "background",
																"bg-info/10 text-info": activity.executionMode !== "background",
															},
														)}
														data-testid="activity-execution-mode">
														<ExecutionModeIcon aria-hidden="true" className="size-2.5 shrink-0" />
														{activity.executionMode === "background" ? "Background" : "Foreground"}
													</span>
												</span>
											) : (
												<span
													className={cn(
														"inline-flex items-center gap-1 rounded-xs px-1.5 py-0.5",
														activity.executionMode === "background"
															? "bg-editor-warning-foreground/10 text-editor-warning-foreground"
															: "bg-info/10 text-info",
													)}
													data-testid="activity-execution-mode">
													<ExecutionModeIcon aria-hidden="true" className="size-2.5 shrink-0" />
													{activity.executionMode === "background" ? "Background" : "Foreground"}
												</span>
											)}
											<ActivityStatusText isSubagent={isSubagent} status={activity.status} />
											{isSubagent ? (
												<SubagentMetrics
													cacheHitRate={activity.metrics?.cacheHitRate}
													contextTokens={activity.metrics?.contextTokens}
													contextWindow={activity.metrics?.contextWindow}
													currency={activity.metrics?.currency}
													finishedAt={activity.finishedAt}
													inputTokens={activity.metrics?.inputTokens}
													outputTokens={activity.metrics?.outputTokens}
													startedAt={activity.createdAt}
													toolCalls={subagentPresentation?.toolCount ?? 0}
													totalCost={activity.metrics?.totalCost}
												/>
											) : (
												<span>{formatDuration(activity)}</span>
											)}
											{activity.kind === "command" &&
												activity.timeoutSeconds !== undefined &&
												activity.timeoutSeconds > 0 && (
													<span
														aria-label={`Command timeout: ${formatCommandTimeout(activity.timeoutSeconds)}`}
														className="inline-flex items-center gap-0.5 leading-none"
														role="img"
														title="Command timeout">
														<AlarmClockIcon aria-hidden="true" className="size-[11px] shrink-0" />
														<span className="leading-none">
															{formatCommandTimeout(activity.timeoutSeconds)}
														</span>
													</span>
												)}
										</div>
										{isSubagent && <SubagentRuntimeConfig runtime={activity.runtime} />}
										{!isExpanded && activitySummary && (
											<div
												className="mt-1.5 truncate rounded-xs bg-code/70 px-2 py-1 font-mono text-[10px] text-description"
												data-testid={activity.kind === "command" ? "activity-output-summary" : undefined}>
												{activitySummary}
											</div>
										)}
									</div>
									{isExpanded ? (
										<ChevronDownIcon className="size-3.5" />
									) : (
										<ChevronRightIcon className="size-3.5" />
									)}
								</button>
								{activity.kind === "command" && (
									<CopyButton
										ariaLabel="Copy command"
										className="h-5"
										textToCopy={activity.detail ?? activity.title}
									/>
								)}
								{activity.kind === "subagent" && activity.finishable && activity.status === "running" && (
									<Button
										className="h-5 self-center bg-button-background px-2 py-0 text-[11px] leading-none text-button-foreground hover:bg-button-hover"
										disabled={isPending(finishKey)}
										onClick={() =>
											void runControl(finishKey, () => finishTaskActivities(taskId, [activity.activityId]))
										}
										size="xs">
										Finish
									</Button>
								)}
								{activity.kind === "subagent" &&
									activity.retryable &&
									(activity.status === "failed" || activity.status === "cancelled") && (
										<Button
											className="h-5 self-center bg-button-background px-2 py-0 text-[11px] leading-none text-button-foreground hover:bg-button-hover"
											disabled={isPending(retryKey)}
											onClick={() =>
												void runControl(retryKey, () =>
													retryTaskActivities(taskId, [activity.activityId]),
												)
											}
											size="xs">
											Retry
										</Button>
									)}
								{activity.cancellable && isActive && activity.status !== "awaiting_approval" && (
									<Button
										className="h-5 self-center px-2 py-0 text-[11px] leading-none"
										disabled={activity.status === "cancelling"}
										onClick={() => void cancelTaskActivities(taskId, [activity.activityId])}
										size="xs"
										variant="danger">
										Cancel
									</Button>
								)}
							</div>
							{isExpanded && (
								<div className="border-t border-editor-widget-border/25 text-xs" data-testid="activity-body">
									{activity.kind === "command" ? (
										<>
											{activity.detail && (
												<div
													className="flex max-h-[72px] items-start gap-2 overflow-y-auto bg-code px-3 py-2.5"
													data-testid="activity-command-line">
													<TerminalIcon
														aria-hidden="true"
														className="mt-0.5 size-3 shrink-0 text-description"
													/>
													<code className="min-w-0 whitespace-pre-wrap break-words font-mono text-[11px] text-code-foreground">
														{activity.detail}
													</code>
												</div>
											)}
											<CommandActivityOutput activity={activity} />
											{activity.result && (
												<div className="max-h-[120px] overflow-y-auto border-t border-editor-widget-border/25 px-3 py-2.5 whitespace-pre-wrap break-words">
													{activity.result}
												</div>
											)}
											{activity.error && (
												<div className="max-h-[120px] overflow-y-auto border-t border-editor-widget-border/25 px-3 py-2.5 whitespace-pre-wrap break-words text-error">
													{activity.error}
												</div>
											)}
										</>
									) : (
										<div className="space-y-2 px-3 py-2" data-testid="subagent-activity-body">
											{(subagentDetail?.task || subagentDetail?.context) && (
												<div
													className="space-y-2 rounded-xs border border-editor-widget-border/25 bg-code/40 px-2.5 py-2"
													data-testid="subagent-activity-detail">
													{subagentDetail.task && (
														<div data-testid="subagent-activity-task">
															<div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-description">
																Task
															</div>
															<div className="whitespace-pre-wrap break-words text-foreground">
																{subagentDetail.task}
															</div>
														</div>
													)}
													{subagentDetail.context && (
														<div data-testid="subagent-activity-context">
															<div className="mb-0.5 text-[10px] font-semibold uppercase tracking-wide text-description">
																Context
															</div>
															<div className="whitespace-pre-wrap break-words text-foreground/80">
																{subagentDetail.context}
															</div>
														</div>
													)}
												</div>
											)}
											{activity.retryUnavailableReason && (
												<div
													className="whitespace-pre-wrap break-words text-warning"
													data-testid="subagent-retry-unavailable-reason">
													{activity.retryUnavailableReason}
												</div>
											)}
											<SubagentRetryTimeline attempts={subagentPresentation?.retryAttempts} />
											<SubagentToolTimeline steps={subagentPresentation?.toolSteps} />
											{activity.result && (
												<div className="max-h-[240px] overflow-y-auto whitespace-pre-wrap break-words border-t border-editor-widget-border/25 pt-2">
													{activity.result}
												</div>
											)}
											{activity.error && (
												<div className="max-h-[120px] overflow-y-auto whitespace-pre-wrap break-words border-t border-editor-widget-border/25 pt-2 text-error">
													{activity.error}
												</div>
											)}
										</div>
									)}
								</div>
							)}
						</div>
					)
				})}
			</div>
		</div>
	)
}
