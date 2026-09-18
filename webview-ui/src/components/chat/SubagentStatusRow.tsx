import {
	ClineAskUseSubagents,
	ClineMessage,
	ClineSaySubagentStatus,
	SubagentExecutionStatus,
	SubagentStatusItem,
} from "@shared/ExtensionMessage"
import type { TaskActivityEvent, TaskActivityRuntimeConfig } from "@shared/proto/dline/task"
import {
	BotIcon,
	BringToFrontIcon,
	CheckIcon,
	ChevronDownIcon,
	ChevronRightIcon,
	CircleSlashIcon,
	CircleXIcon,
	LoaderCircleIcon,
	NetworkIcon,
	SendToBackIcon,
} from "lucide-react"
import { useEffect, useMemo, useRef, useState } from "react"
import { Button } from "@/components/ui/button"
import { useExtensionState } from "@/context/ExtensionStateContext"
import MarkdownBlock from "../common/MarkdownBlock"
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover"
import { SubagentMetrics } from "./activity/SubagentMetrics"
import { SubagentRetryTimeline } from "./activity/SubagentRetryTimeline"
import { SubagentRuntimeConfig } from "./activity/SubagentRuntimeConfig"
import { SubagentToolTimeline } from "./activity/SubagentToolTimeline"
import { SubagentWorkSection } from "./activity/SubagentWorkSection"
import { buildSubagentActivityPresentation, normalizeSubagentDisplayText } from "./activity/subagent-activity-model"
import { useActivityControlGuard } from "./activity/useActivityControlGuard"
import { cancelTaskActivities, finishTaskActivities, retryTaskActivities, useTaskActivities } from "./activity/useTaskActivities"
import { TOOL_RESPONSE_SCROLL_CLASS } from "./constants"

interface SubagentStatusRowProps {
	message: ClineMessage
	isLast: boolean
	lastModifiedMessage?: ClineMessage
}

type DisplayStatus = SubagentExecutionStatus
type SubagentRowStatus = SubagentExecutionStatus
type SubagentWorkSectionKey = "task" | "tools" | "output"

interface SubagentRowData {
	status: SubagentRowStatus
	items: SubagentDisplayItem[]
}

interface SubagentPromptTextProps {
	prompt: string
	isExpanded: boolean
	onShowMore: () => void
}

interface SubagentDisplayItem extends SubagentStatusItem {
	activityEvents?: TaskActivityEvent[]
	currentAttempt?: number
	runtime?: TaskActivityRuntimeConfig
	finishable?: boolean
	retryable?: boolean
	retryUnavailableReason?: string
}

const statusIcon = (status: DisplayStatus) => {
	switch (status) {
		case "running":
			return <LoaderCircleIcon className="size-2 animate-spin text-link shrink-0 mt-[1px]" />
		case "completed":
			return <CheckIcon className="size-2 text-success shrink-0 mt-[1px]" />
		case "failed":
			return <CircleXIcon className="size-2 text-error shrink-0 mt-[1px]" />
		case "timeout":
			return <CircleXIcon className="size-2 text-warning shrink-0 mt-[1px]" />
		case "cancelled":
			return <CircleSlashIcon className="size-2 text-foreground shrink-0 mt-[1px]" />
		default:
			return <BotIcon className="size-2 text-foreground/70 shrink-0 mt-[1px]" />
	}
}

function SubagentContext({ context }: { context: string }) {
	const displayContext = normalizeSubagentDisplayText(context)
	return (
		<Popover>
			<PopoverTrigger asChild>
				<button
					aria-label="Show full subagent context"
					className="flex w-full min-w-0 max-w-full items-center gap-1 overflow-hidden rounded-xs border border-editor-group-border bg-transparent px-2 py-1 text-left text-[11px] text-foreground opacity-80 cursor-pointer"
					data-testid="subagent-context"
					type="button">
					<span className="shrink-0 font-semibold">Context</span>
					<span className="min-w-0 flex-1 truncate whitespace-nowrap" data-testid="subagent-context-content">
						{displayContext}
					</span>
				</button>
			</PopoverTrigger>
			<PopoverContent
				align="start"
				className="max-h-[60vh] w-(--radix-popover-trigger-width) overflow-y-auto p-3"
				data-testid="subagent-context-popover"
				sideOffset={6}>
				<div
					className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-left text-xs text-foreground"
					data-testid="subagent-context-popover-content">
					{displayContext}
				</div>
			</PopoverContent>
		</Popover>
	)
}

function parseSubagentRowData(message: ClineMessage): SubagentRowData | null {
	if (!message.text) {
		return null
	}

	try {
		if (message.ask === "use_subagents" || message.say === "use_subagents") {
			const parsed = JSON.parse(message.text) as ClineAskUseSubagents
			if (!Array.isArray(parsed.prompts)) {
				return null
			}
			const prompts = parsed.prompts.map((prompt) => prompt?.trim()).filter((prompt): prompt is string => !!prompt)
			const structuredItems = parsed.items?.filter((item) => item.task.trim() && item.context.trim())
			// Error payload with message: show failed row with error text
			if (parsed.error && parsed.message) {
				return {
					status: "failed",
					items: [
						{
							index: 1,
							prompt: parsed.message,
							status: "failed",
							error: parsed.message,
							toolCalls: 0,
							inputTokens: 0,
							outputTokens: 0,
							totalCost: 0,
							currency: "",
							contextTokens: 0,
							contextWindow: 0,
							contextUsagePercentage: 0,
						},
					],
				}
			}
			if (prompts.length === 0) {
				return null
			}

			// When the final payload carries an error, mark all items as failed
			// so the frontend does not show a stale pending state.
			const rowStatus = parsed.error ? "failed" : "pending"
			const errorText = parsed.message || parsed.error
			// Items the backend refused during planning are shown alongside the
			// runnable ones. Dropping them would present a batch that is
			// quietly narrower than the one being approved.
			const rejectedRows: SubagentDisplayItem[] = (parsed.rejected ?? []).map((rejected) => ({
				index: rejected.index,
				prompt: rejected.error,
				status: "failed",
				error: rejected.error,
				toolCalls: 0,
				inputTokens: 0,
				outputTokens: 0,
				totalCost: 0,
				currency: "",
				contextTokens: 0,
				contextWindow: 0,
				contextUsagePercentage: 0,
			}))
			const runnableRows: SubagentDisplayItem[] = prompts.map((prompt, index) => ({
				// Planning compacts the runnable array, so the array offset is not
				// the requested position. The backend supplies the original index;
				// the offset is only the fallback for a payload written before that
				// field existed.
				index: structuredItems?.[index]?.index ?? index + 1,
				prompt,
				subagentName: parsed.subagentName ?? structuredItems?.[index]?.subagentName,
				task: parsed.task ?? structuredItems?.[index]?.task,
				context: parsed.context ?? parsed.content ?? structuredItems?.[index]?.context,
				status: rowStatus,
				error: errorText,
				// Carry the run identity when the payload has one so the activity
				// merge below can supply live figures. These zeros are only the
				// pre-start placeholder for a row whose run has not been created
				// yet; once an activity exists it owns every value here.
				jobId: parsed.jobId ?? structuredItems?.[index]?.jobId,
				toolCalls: 0,
				inputTokens: 0,
				outputTokens: 0,
				totalCost: 0,
				currency: "",
				contextTokens: 0,
				contextWindow: 0,
				contextUsagePercentage: 0,
			}))
			return {
				status: rowStatus,
				items: [...runnableRows, ...rejectedRows].sort((left, right) => left.index - right.index),
			}
		}

		const parsed = JSON.parse(message.text) as ClineSaySubagentStatus
		if (!Array.isArray(parsed.items)) {
			return null
		}

		return {
			status: parsed.status,
			items: parsed.items,
		}
	} catch {
		return null
	}
}

function SubagentPromptText({ prompt, isExpanded, onShowMore }: SubagentPromptTextProps) {
	const promptRef = useRef<HTMLDivElement | null>(null)
	const [showMoreVisible, setShowMoreVisible] = useState(false)

	useEffect(() => {
		if (isExpanded) {
			setShowMoreVisible(false)
			return
		}

		const element = promptRef.current
		if (!element) {
			setShowMoreVisible(false)
			return
		}

		const checkOverflow = () => {
			setShowMoreVisible(element.scrollHeight - element.clientHeight > 1)
		}

		checkOverflow()

		if (typeof ResizeObserver === "undefined") {
			return
		}

		const observer = new ResizeObserver(() => checkOverflow())
		observer.observe(element)

		return () => observer.disconnect()
	}, [isExpanded])

	const displayPrompt = normalizeSubagentDisplayText(prompt)
	return (
		<div className="relative">
			<div
				className={`text-xs font-medium text-foreground whitespace-pre-wrap break-words ${!isExpanded ? "overflow-hidden [display:-webkit-box] [-webkit-box-orient:vertical] [-webkit-line-clamp:2]" : ""}`}
				ref={promptRef}
				title={displayPrompt}>
				"{displayPrompt}"
			</div>
			{!isExpanded && showMoreVisible && (
				<button
					aria-label="Show full subagent prompt"
					className="absolute right-0 bottom-0 z-10 text-[11px] text-link border-0 px-1 py-[1px] cursor-pointer leading-none rounded-[2px]"
					onClick={onShowMore}
					style={{ backgroundColor: "var(--vscode-editor-background)" }}
					type="button">
					<span
						aria-hidden="true"
						className="pointer-events-none absolute inset-y-0 -left-[6px] w-[6px]"
						style={{ background: "linear-gradient(to left, var(--vscode-editor-background), transparent)" }}
					/>
					Show more
				</button>
			)}
		</div>
	)
}

export default function SubagentStatusRow({ message }: SubagentStatusRowProps) {
	const [expandedPrompts, setExpandedPrompts] = useState<Record<number, boolean>>({})
	const [collapsedItems, setCollapsedItems] = useState<Record<string, boolean>>({})
	const [expandedSections, setExpandedSections] = useState<Record<string, Partial<Record<SubagentWorkSectionKey, boolean>>>>({})
	const [collapsed, setCollapsed] = useState(false)
	const { isPending, runControl } = useActivityControlGuard()
	const { currentTaskItem } = useExtensionState()
	const taskId = currentTaskItem?.id
	const { activities, getById } = useTaskActivities(taskId)
	const parsedData = useMemo(() => parseSubagentRowData(message), [message])
	const data = useMemo(() => {
		if (!parsedData) return null
		const items = parsedData.items.map((entry) => {
			const activity = entry.jobId ? getById(entry.jobId) : undefined
			if (!activity) return entry
			return {
				...entry,
				status: activity.status === "cancelling" ? "running" : (activity.status as SubagentExecutionStatus),
				latestToolCall: activity.latestEvent || entry.latestToolCall,
				result: activity.result || entry.result,
				error: activity.error || entry.error,
				startedAt: activity.createdAt,
				finishedAt: activity.finishedAt,
				background: activity.executionMode === "background",
				backgroundHandoffAvailable: entry.backgroundHandoffAvailable === true && activity.executionMode === "foreground",
				toolCalls: activity.metrics?.toolCalls ?? entry.toolCalls,
				inputTokens: activity.metrics?.inputTokens ?? entry.inputTokens,
				outputTokens: activity.metrics?.outputTokens ?? entry.outputTokens,
				totalCost: activity.metrics?.totalCost ?? entry.totalCost,
				currency: activity.metrics?.currency ?? entry.currency,
				cacheHitRate: activity.metrics?.cacheHitRate ?? entry.cacheHitRate,
				contextTokens: activity.metrics?.contextTokens ?? entry.contextTokens,
				contextWindow: activity.metrics?.contextWindow ?? entry.contextWindow,
				activityEvents: activity.events,
				currentAttempt: activity.currentAttempt,
				runtime: activity.runtime,
				finishable: activity.finishable,
				retryable: activity.retryable,
				retryUnavailableReason: activity.retryUnavailableReason,
			}
		})
		const statuses = items.map((entry) => entry.status)
		const status = statuses.some((status) => status === "running")
			? "running"
			: statuses.some((status) => status === "failed")
				? "failed"
				: statuses.some((status) => status === "timeout")
					? "timeout"
					: statuses.some((status) => status === "cancelled")
						? "cancelled"
						: statuses.every((status) => status === "completed")
							? "completed"
							: parsedData.status
		return { ...parsedData, status, items }
	}, [getById, parsedData])

	if (!data) {
		return <div className="text-foreground opacity-80">Subagent status update unavailable.</div>
	}

	const liveCancellableIds = new Set(
		activities
			.filter((activity) => activity.kind === "subagent" && activity.status === "running" && activity.cancellable)
			.map((activity) => activity.activityId),
	)
	const cancellableIds = data.items
		.filter((entry) => entry.jobId && liveCancellableIds.has(entry.jobId))
		.map((entry) => entry.jobId as string)
	const showCancelButton = Boolean(taskId && cancellableIds.length > 1)

	const singular = data.items.length === 1
	const title = singular ? "Dline wants to use a subagent:" : "Dline wants to use subagents:"
	const isPromptConstructionRow = message.ask === "use_subagents" || message.say === "use_subagents"
	const statusSummary =
		data.status === "timeout"
			? "Timed out"
			: data.status === "cancelled"
				? "Cancelled"
				: data.status === "running" && data.items.some((entry) => entry.background)
					? "Running in background"
					: undefined
	const toggleSection = (itemKey: string, section: SubagentWorkSectionKey) => {
		setExpandedSections((previous) => {
			const defaultExpanded = section !== "output"
			const currentExpanded = previous[itemKey]?.[section] ?? defaultExpanded
			return {
				...previous,
				[itemKey]: {
					...previous[itemKey],
					[section]: !currentExpanded,
				},
			}
		})
	}
	const expandPrompt = (index: number) => {
		setExpandedPrompts((prev) => ({
			...prev,
			[index]: true,
		}))
	}
	const toggleCollapsedItem = (itemKey: string) => {
		setCollapsedItems((prev) => ({
			...prev,
			[itemKey]: !prev[itemKey],
		}))
	}
	return (
		<div className="mb-2">
			<div className="flex items-center gap-2.5 mb-3">
				<button
					aria-label={collapsed ? "Expand subagent status" : "Collapse subagent status"}
					className="flex min-w-0 items-center gap-2.5 border-0 bg-transparent p-0 text-left cursor-pointer"
					onClick={() => setCollapsed((value) => !value)}
					type="button">
					{collapsed ? <ChevronRightIcon className="size-3" /> : <ChevronDownIcon className="size-3" />}
					<NetworkIcon className="size-2 text-foreground" />
					<span className="font-bold text-foreground">{title}</span>
				</button>
				{statusSummary && <span className="text-[11px] opacity-70">{statusSummary}</span>}
				{showCancelButton && (
					<Button
						className="ml-auto h-5 border px-2 py-0 text-[11px] leading-none"
						onClick={(e) => {
							e.stopPropagation()
							if (taskId) void cancelTaskActivities(taskId, cancellableIds)
						}}
						size="sm"
						variant="danger">
						Cancel all
					</Button>
				)}
			</div>
			{!collapsed && (
				<div className={`space-y-2 pr-0.5 ${TOOL_RESPONSE_SCROLL_CLASS}`} data-testid="subagent-list-scroll">
					{data.items.map((entry, index) => {
						const displayStatus: DisplayStatus = entry.status
						const itemKey = entry.jobId ?? String(entry.index)
						const isItemCollapsed = collapsedItems[itemKey] === true
						const activityPresentation = buildSubagentActivityPresentation(entry.activityEvents, entry.currentAttempt)
						const { retryAttempts, toolSteps, toolCount } = activityPresentation
						const hasOutput = Boolean(
							retryAttempts.length > 0 ||
								(entry.result && entry.status === "completed") ||
								(entry.error &&
									(entry.status === "failed" || entry.status === "timeout" || entry.status === "cancelled")),
						)
						const taskExpanded = expandedSections[itemKey]?.task ?? true
						const toolsExpanded = expandedSections[itemKey]?.tools ?? true
						const outputExpanded = expandedSections[itemKey]?.output ?? false
						const hasStructuredPrompt = Boolean(entry.task || entry.context)
						const displaySubagentName = entry.subagentName?.trim() || "default"
						const isStreamingPromptUnderConstruction =
							isPromptConstructionRow && message.partial === true && index === data.items.length - 1
						const showToolsSection = !isStreamingPromptUnderConstruction && toolSteps.length > 0
						const showOutputSection = !isStreamingPromptUnderConstruction && hasOutput
						const isBackground = entry.background === true
						const ExecutionModeIcon = isBackground ? SendToBackIcon : BringToFrontIcon
						const executionModeLabel = isBackground ? "Background" : "Foreground"
						const executionModeIndicator = (
							<div
								aria-label={`Execution mode: ${executionModeLabel}`}
								className={`flex min-w-[88px] shrink-0 items-center justify-center gap-1 rounded-xs border px-1.5 py-0.5 text-[11px] font-medium ${
									isBackground
										? "border-editor-warning-foreground/40 bg-editor-warning-foreground/10 text-editor-warning-foreground"
										: "border-info/40 bg-info/10 text-info"
								}`}
								data-testid="subagent-execution-mode"
								role="status">
								<ExecutionModeIcon aria-hidden="true" className="size-2.5 shrink-0" />
								<span>{executionModeLabel}</span>
							</div>
						)
						const showItemCancelButton = Boolean(taskId && entry.jobId && liveCancellableIds.has(entry.jobId))
						const showItemFinishButton = Boolean(taskId && entry.jobId && entry.finishable)
						const showItemRetryButton = Boolean(taskId && entry.jobId && entry.retryable)
						const finishKey = `finish:${entry.jobId ?? ""}`
						const retryKey = `retry:${entry.jobId ?? ""}`
						return (
							<div
								className="flex max-h-[30vh] flex-col overflow-hidden rounded-xs border border-editor-group-border"
								data-testid="subagent-item"
								key={itemKey}
								style={{ backgroundColor: "var(--vscode-editor-background)" }}>
								<div
									className="flex min-w-0 shrink-0 flex-wrap items-center gap-x-2 gap-y-1 overflow-hidden px-2 py-1.5"
									data-testid="subagent-item-header">
									<button
										aria-label={`${isItemCollapsed ? "Expand" : "Collapse"} subagent ${displaySubagentName}`}
										className="flex min-w-0 flex-1 items-center gap-1.5 border-0 bg-transparent p-0 text-left text-foreground cursor-pointer"
										onClick={() => toggleCollapsedItem(itemKey)}
										type="button">
										{isItemCollapsed ? (
											<ChevronRightIcon className="size-3 shrink-0" />
										) : (
											<ChevronDownIcon className="size-3 shrink-0" />
										)}
										{statusIcon(displayStatus)}
										<div
											className="min-w-0 flex-1 truncate text-[11px] font-semibold uppercase tracking-wide opacity-70"
											data-testid="subagent-name"
											title={displaySubagentName}>
											{displaySubagentName}
										</div>
									</button>
									<div className="flex shrink-0 items-center gap-2">
										{executionModeIndicator}
										{showItemFinishButton && (
											<Button
												className="h-5 border border-button-background px-2 py-0 text-[11px] leading-none hover:border-button-hover"
												disabled={isPending(finishKey)}
												onClick={() =>
													void runControl(finishKey, () =>
														finishTaskActivities(taskId as string, [entry.jobId as string]),
													)
												}
												size="sm">
												Finish
											</Button>
										)}
										{showItemRetryButton && (
											<Button
												className="h-5 border px-2 py-0 text-[11px] leading-none"
												disabled={isPending(retryKey)}
												onClick={() =>
													void runControl(retryKey, () =>
														retryTaskActivities(taskId as string, [entry.jobId as string]),
													)
												}
												size="sm">
												Retry
											</Button>
										)}
										{showItemCancelButton && (
											<Button
												className="h-5 border px-2 py-0 text-[11px] leading-none"
												onClick={() =>
													void cancelTaskActivities(taskId as string, [entry.jobId as string])
												}
												size="sm"
												variant="danger">
												Cancel
											</Button>
										)}
									</div>
									<SubagentMetrics
										cacheHitRate={entry.cacheHitRate}
										className="basis-full pl-8"
										contextTokens={entry.contextTokens}
										contextWindow={entry.contextWindow}
										currency={entry.currency}
										finishedAt={entry.finishedAt}
										inputTokens={entry.inputTokens}
										outputTokens={entry.outputTokens}
										startedAt={entry.startedAt}
										toolCalls={toolCount}
										totalCost={entry.totalCost}
									/>
									<SubagentRuntimeConfig className="basis-full pl-8" runtime={entry.runtime} />
									{entry.retryUnavailableReason && (
										<div
											className="basis-full pl-8 text-[11px] text-warning whitespace-pre-wrap break-words"
											data-testid="subagent-retry-unavailable-reason">
											{entry.retryUnavailableReason}
										</div>
									)}
								</div>
								{!isItemCollapsed && (
									<div
										className="flex min-h-0 flex-[0_1_auto] flex-col overflow-hidden px-2 pb-1.5"
										data-testid="subagent-item-body">
										<SubagentWorkSection
											ariaLabel={`${taskExpanded ? "Collapse" : "Expand"} subagent task`}
											expanded={taskExpanded}
											onToggle={() => toggleSection(itemKey, "task")}
											scrollTestId="subagent-task-scroll"
											title="Task">
											<div className="min-w-0 max-w-full space-y-1.5">
												{hasStructuredPrompt ? (
													<>
														{entry.task && (
															<h4 className="m-0 whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-xs font-semibold text-foreground">
																{normalizeSubagentDisplayText(entry.task)}
															</h4>
														)}
														{entry.context && <SubagentContext context={entry.context} />}
													</>
												) : (
													<SubagentPromptText
														isExpanded={expandedPrompts[entry.index] === true}
														onShowMore={() => expandPrompt(entry.index)}
														prompt={entry.prompt}
													/>
												)}
											</div>
										</SubagentWorkSection>
										{showToolsSection && (
											<SubagentWorkSection
												ariaLabel={`${toolsExpanded ? "Collapse" : "Expand"} subagent tools`}
												expanded={toolsExpanded}
												onToggle={() => toggleSection(itemKey, "tools")}
												scrollTestId="subagent-tools-scroll"
												title={`Tools (${toolSteps.length})`}>
												<SubagentToolTimeline
													compact
													detailsMode="none"
													showHeader={false}
													steps={toolSteps}
												/>
											</SubagentWorkSection>
										)}
										{showOutputSection && (
											<SubagentWorkSection
												ariaLabel={`${outputExpanded ? "Hide" : "Show"} subagent output`}
												contentClassName="space-y-2 text-xs"
												expanded={outputExpanded}
												onToggle={() => toggleSection(itemKey, "output")}
												scrollTestId="subagent-output-scroll"
												title="Output">
												<SubagentRetryTimeline attempts={retryAttempts} />
												{entry.result && entry.status === "completed" && (
													<div className="opacity-80 wrap-anywhere" data-testid="subagent-output">
														<MarkdownBlock markdown={entry.result} />
													</div>
												)}
												{entry.error &&
													(entry.status === "failed" ||
														entry.status === "timeout" ||
														entry.status === "cancelled") && (
														<div className="whitespace-pre-wrap break-words text-error">
															{entry.error}
														</div>
													)}
											</SubagentWorkSection>
										)}
									</div>
								)}
							</div>
						)
					})}
				</div>
			)}
		</div>
	)
}
