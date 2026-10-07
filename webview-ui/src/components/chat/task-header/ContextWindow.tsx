import type { ContextWindowIndicatorSnapshot } from "@shared/context-window-indicator"
import { VSCodeButton } from "@vscode/webview-ui-toolkit/react"
import { AlertTriangle } from "lucide-react"
import React, { memo, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { Progress } from "@/components/ui/progress"
import { formatLargeNumber as formatTokenNumber } from "@/utils/format"
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "../../common/AlertDialog"
import { Input } from "../../ui/input"
import CompactTaskButton from "./buttons/CompactTaskButton"
import ForceTruncateTaskButton from "./buttons/ForceTruncateTaskButton"
import { createContextWindowIndicatorViewModel } from "./ContextWindowIndicatorViewModel"
import ContextWindowSegmentedProgress from "./ContextWindowSegmentedProgress"
import { ContextWindowSummary } from "./ContextWindowSummary"

// Type definitions
interface ContextWindowInfoProps {
	tokensIn?: number
	tokensOut?: number
	cacheWrites?: number
	cacheReads?: number
	size?: number
}

interface ContextWindowProgressProps extends ContextWindowInfoProps {
	useAutoCondense: boolean
	lastApiReqTotalTokens?: number
	contextWindow?: number
	contextWindowIndicator?: ContextWindowIndicatorSnapshot
	taskId?: string
	compactTaskDisabled?: boolean
	forceTruncateAvailable?: boolean
	onCompactTask?: () => Promise<boolean>
	forceTruncateTaskDisabled?: boolean
	onForceTruncateTask?: () => Promise<boolean>
}

type ConfirmationAction = "compact"

const ConfirmationDialog = memo<{
	onConfirm: (event: React.MouseEvent) => void
	onCancel: (event: React.MouseEvent) => void
}>(({ onConfirm, onCancel }) => {
	return (
		<div className="text-sm my-2 flex items-center justify-between gap-0">
			<span className="font-semibold text-sm">Compact the current task?</span>
			<span className="flex gap-1">
				<VSCodeButton
					appearance="secondary"
					className="text-sm"
					onClick={onCancel}
					title="No, keep the task as is"
					type="button">
					Cancel
				</VSCodeButton>
				<VSCodeButton
					appearance="primary"
					className="text-sm"
					onClick={onConfirm}
					title="Yes, compact the task"
					type="button">
					Yes
				</VSCodeButton>
			</span>
		</div>
	)
})
ConfirmationDialog.displayName = "ConfirmationDialog"

const ContextWindow: React.FC<ContextWindowProgressProps> = ({
	contextWindow = 0,
	lastApiReqTotalTokens = 0,
	tokensIn,
	tokensOut,
	cacheWrites,
	cacheReads,
	contextWindowIndicator,
	taskId,
	compactTaskDisabled,
	forceTruncateAvailable,
	onCompactTask,
	forceTruncateTaskDisabled,
	onForceTruncateTask,
}) => {
	const [isOpened, setIsOpened] = useState(false)
	const [confirmationAction, setConfirmationAction] = useState<ConfirmationAction>()
	const [forceTruncateDialogOpen, setForceTruncateDialogOpen] = useState(false)
	const [forceTruncateConfirmation, setForceTruncateConfirmation] = useState("")
	const progressBarRef = useRef<HTMLDivElement>(null)

	const indicatorViewModel = useMemo(
		() => (contextWindowIndicator ? createContextWindowIndicatorViewModel(contextWindowIndicator) : undefined),
		[contextWindowIndicator],
	)
	const tokenData = useMemo(() => {
		const max = indicatorViewModel?.contextWindow ?? contextWindow
		if (!max) return null
		const used = indicatorViewModel?.totalTokens ?? lastApiReqTotalTokens
		return {
			percentage: indicatorViewModel?.percentage ?? (used / max) * 100,
			max,
			used,
		}
	}, [contextWindow, indicatorViewModel, lastApiReqTotalTokens])

	const handleMouseLeave = useCallback(() => setIsOpened(false), [])

	const handleFocus = useCallback(() => {
		setIsOpened(true)
	}, [])

	const handleCompactClick = useCallback(
		(event: React.MouseEvent) => {
			event.preventDefault()
			event.stopPropagation()
			if (compactTaskDisabled) return
			setConfirmationAction((action) => (action === "compact" ? undefined : "compact"))
		},
		[compactTaskDisabled],
	)

	const handleOpenForceTruncateDialog = useCallback(() => {
		if (forceTruncateTaskDisabled || !forceTruncateAvailable || !onForceTruncateTask) return
		setForceTruncateConfirmation("")
		setForceTruncateDialogOpen(true)
	}, [forceTruncateAvailable, forceTruncateTaskDisabled, onForceTruncateTask])

	const handleConfirm = useCallback(
		async (event: React.MouseEvent) => {
			event.preventDefault()
			event.stopPropagation()
			const accepted = await onCompactTask?.()
			if (accepted) setConfirmationAction(undefined)
		},
		[onCompactTask],
	)

	const handleCancel = useCallback((event: React.MouseEvent) => {
		event.preventDefault()
		event.stopPropagation()
		setConfirmationAction(undefined)
	}, [])

	const handleForceTruncateDialogChange = useCallback((open: boolean) => {
		setForceTruncateDialogOpen(open)
		if (!open) setForceTruncateConfirmation("")
	}, [])

	const handleForceTruncateConfirm = useCallback(
		async (event: React.MouseEvent) => {
			event.preventDefault()
			event.stopPropagation()
			if (forceTruncateConfirmation !== "TRUNCATE") return
			const accepted = await onForceTruncateTask?.()
			if (accepted) handleForceTruncateDialogChange(false)
		},
		[forceTruncateConfirmation, handleForceTruncateDialogChange, onForceTruncateTask],
	)

	useEffect(() => {
		if (!onCompactTask) setConfirmationAction(undefined)
	}, [onCompactTask])

	useEffect(() => {
		if (!forceTruncateAvailable || !onForceTruncateTask) handleForceTruncateDialogChange(false)
	}, [forceTruncateAvailable, handleForceTruncateDialogChange, onForceTruncateTask, taskId])

	// Close tooltip when clicking outside
	useEffect(() => {
		const handleClickOutside = (event: MouseEvent) => {
			const target = event.target as Element
			const isInsideProgressBar = progressBarRef.current?.contains(target as Node)

			// Check if click is inside any tooltip content by looking for our custom class
			const isInsideTooltipContent = target.closest(".context-window-tooltip-content") !== null

			if (!isInsideProgressBar && !isInsideTooltipContent) {
				setIsOpened(false)
			}
		}

		if (isOpened) {
			document.addEventListener("mousedown", handleClickOutside)
			return () => document.removeEventListener("mousedown", handleClickOutside)
		}
	}, [isOpened])

	if (!tokenData) {
		return null
	}

	return (
		<div
			className="flex min-w-0 w-full flex-col my-1.5"
			data-testid="context-window-indicator"
			onMouseLeave={handleMouseLeave}>
			<div className="flex min-w-0 w-full gap-1 flex-row @max-xs:flex-col @max-xs:items-start items-center text-sm">
				<div className="grid min-w-0 w-full flex-1 grid-cols-[auto_minmax(2rem,1fr)_auto] items-center gap-1.5 whitespace-nowrap">
					<span className="cursor-pointer text-sm" title="Current tokens used in this request">
						{formatTokenNumber(tokenData.used)}
					</span>
					<div
						className="relative min-w-0 w-full h-full"
						data-testid="context-window-progress-track"
						onMouseEnter={() => setIsOpened(true)}>
						<HoverCard closeDelay={0} open={isOpened} openDelay={0}>
							<HoverCardContent
								arrowClassName="border-menu-foreground/10 bg-menu fill-menu"
								className="w-72 bg-menu"
								data-context-window-surface="summary">
								<ContextWindowSummary
									cacheReads={cacheReads}
									cacheWrites={cacheWrites}
									contextWindow={tokenData.max}
									indicatorViewModel={indicatorViewModel}
									percentage={tokenData.percentage}
									tokensIn={tokensIn}
									tokensOut={tokensOut}
									tokenUsed={tokenData.used}
								/>
							</HoverCardContent>
							<HoverCardTrigger asChild>
								{/* TODO: Re-add role="slider", aria-value*, onKeyDown, onClick, and tabIndex
								    when click-to-set-threshold is implemented. See PR #9348 for context. */}
								<div
									className="relative w-full text-foreground context-window-progress brightness-100"
									data-testid="context-window-tooltip-trigger"
									onFocus={handleFocus}
									ref={progressBarRef}
									tabIndex={0}>
									{contextWindowIndicator ? (
										<ContextWindowSegmentedProgress snapshot={contextWindowIndicator} />
									) : (
										<Progress
											aria-label="Context window usage progress"
											indicatorStyle={{ backgroundColor: "var(--vscode-charts-green, #3fb950)" }}
											value={Math.min(100, Math.max(0, tokenData.percentage))}
										/>
									)}
								</div>
							</HoverCardTrigger>
						</HoverCard>
					</div>
					<span className="cursor-pointer text-sm" title="Maximum context window size for this model">
						{formatTokenNumber(tokenData.max)}
					</span>
				</div>
				{onCompactTask && <CompactTaskButton disabled={compactTaskDisabled} onClick={handleCompactClick} />}
				{forceTruncateAvailable && onForceTruncateTask && (
					<ForceTruncateTaskButton disabled={forceTruncateTaskDisabled} onSelect={handleOpenForceTruncateDialog} />
				)}
			</div>
			{confirmationAction === "compact" && <ConfirmationDialog onCancel={handleCancel} onConfirm={handleConfirm} />}
			<AlertDialog onOpenChange={handleForceTruncateDialogChange} open={forceTruncateDialogOpen}>
				<AlertDialogContent>
					<AlertDialogHeader>
						<AlertDialogTitle>
							<AlertTriangle className="h-5 w-5 text-(--vscode-errorForeground)" />
							Force truncate conversation history?
						</AlertDialogTitle>
						<AlertDialogDescription>
							This permanently removes older conversation history from future requests. Use it only when automatic
							context compaction has failed and Retry cannot recover the task.
						</AlertDialogDescription>
					</AlertDialogHeader>
					<div className="mt-4 space-y-2">
						<label className="text-sm" htmlFor="force-truncate-confirmation">
							Type <code>TRUNCATE</code> to confirm.
						</label>
						<Input
							aria-label="Type TRUNCATE to confirm"
							id="force-truncate-confirmation"
							onChange={(event) => setForceTruncateConfirmation(event.target.value)}
							value={forceTruncateConfirmation}
						/>
					</div>
					<AlertDialogFooter>
						<AlertDialogCancel autoFocus onClick={() => handleForceTruncateDialogChange(false)}>
							Cancel
						</AlertDialogCancel>
						<AlertDialogAction
							disabled={forceTruncateConfirmation !== "TRUNCATE"}
							onClick={handleForceTruncateConfirm}>
							Force truncate conversation history
						</AlertDialogAction>
					</AlertDialogFooter>
				</AlertDialogContent>
			</AlertDialog>
		</div>
	)
}

export default memo(ContextWindow)
