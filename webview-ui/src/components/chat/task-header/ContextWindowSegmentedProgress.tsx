import type { ContextWindowIndicatorPhase, ContextWindowIndicatorSnapshot } from "@shared/context-window-indicator"
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import {
	type ContextWindowSegmentKind,
	type ContextWindowSegmentViewModel,
	createContextWindowIndicatorViewModel,
	getContextWindowActiveTokens,
} from "./ContextWindowIndicatorViewModel"
export type ContextWindowSegmentMotion = "none" | "commit" | "rollback"

interface ContextWindowSegmentedProgressProps {
	snapshot: ContextWindowIndicatorSnapshot
	onOccupiedMouseEnter?: () => void
}

interface SegmentDefinition extends ContextWindowSegmentViewModel {
	color: string
	temporary: boolean
	transitionSource: "authoritative" | "previous"
}

interface SegmentTransitionState {
	motion: ContextWindowSegmentMotion
	previous?: ContextWindowIndicatorSnapshot
	revision?: number
}

const MOTION_SETTLE_MS = 720
const MIN_VISIBLE_SEGMENT_PX = 3
const WIDTH_PERCENT_SCALE = 1_000_000
const TRACK_WIDTH_SAFETY_PERCENT = 0.000_05

const SEGMENT_COLORS: Record<ContextWindowSegmentKind, string> = {
	durable: "var(--vscode-charts-green, #3fb950)",
	active: "var(--vscode-charts-blue, #58a6ff)",
	staged: "var(--vscode-charts-orange, #d18616)",
	environment: "var(--vscode-charts-purple, #bc8cff)",
}

function getSegmentColor(segment: ContextWindowSegmentViewModel): string {
	if (segment.kind === "active" && segment.label === "Receiving") return "var(--vscode-charts-yellow, #d29922)"
	return SEGMENT_COLORS[segment.kind]
}

function explicitMotionForPhase(phase: ContextWindowIndicatorPhase): ContextWindowSegmentMotion {
	if (phase === "committing") return "commit"
	if (phase === "rolling_back") return "rollback"
	return "none"
}

function inferSettledMotion(
	previous: ContextWindowIndicatorSnapshot | undefined,
	current: ContextWindowIndicatorSnapshot,
): ContextWindowSegmentMotion {
	if (!previous || current.phase !== "stable") return "none"
	// Re-rendering the same snapshot, or refreshing a stable Staged estimate, settles nothing; inferring
	// a commit there would keep Staged hidden for the whole stable phase and show the previous round.
	if (previous.revision === current.revision) return "none"
	if (previous.phase === "stable" && current.epoch === previous.epoch) return "none"
	if (previous.pendingSendTokens + previous.receivingTokens + (previous.stagedTokens ?? 0) <= 0) return "none"
	return current.epoch > previous.epoch ? "rollback" : "commit"
}

function useSegmentTransition(snapshot: ContextWindowIndicatorSnapshot): SegmentTransitionState {
	const previousRef = useRef<ContextWindowIndicatorSnapshot | undefined>(undefined)
	const latestTemporaryRef = useRef<ContextWindowIndicatorSnapshot | undefined>(undefined)
	const clearTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
	const [settledTransition, setSettledTransition] = useState<SegmentTransitionState>({ motion: "none" })
	const previous = previousRef.current
	const explicitMotion = explicitMotionForPhase(snapshot.phase)
	const inheritedMotion = snapshot.phase === "stable" && previous ? explicitMotionForPhase(previous.phase) : "none"
	const inferredMotion = inferSettledMotion(previous, snapshot)
	const candidateMotion =
		explicitMotion !== "none" ? explicitMotion : inheritedMotion !== "none" ? inheritedMotion : inferredMotion
	const candidatePrevious = latestTemporaryRef.current ?? previous
	const candidateTransition: SegmentTransitionState = {
		motion: candidateMotion,
		previous: candidatePrevious,
		revision: snapshot.revision,
	}
	const activeRequestPhase = snapshot.phase === "sending" || snapshot.phase === "receiving"
	const transition: SegmentTransitionState =
		candidateMotion !== "none" ? candidateTransition : activeRequestPhase ? { motion: "none" } : settledTransition

	useLayoutEffect(() => {
		previousRef.current = snapshot
		if (snapshot.pendingSendTokens + snapshot.receivingTokens + (snapshot.stagedTokens ?? 0) > 0) {
			latestTemporaryRef.current = snapshot
		}
	}, [snapshot])

	useEffect(() => {
		if (activeRequestPhase) {
			if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
			clearTimerRef.current = undefined
			setSettledTransition({ motion: "none" })
			return
		}
		if (candidateMotion === "none") return
		if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
		setSettledTransition({ motion: candidateMotion, previous: candidatePrevious, revision: snapshot.revision })
		clearTimerRef.current = setTimeout(() => {
			setSettledTransition({ motion: "none" })
			latestTemporaryRef.current = undefined
			clearTimerRef.current = undefined
		}, MOTION_SETTLE_MS)
	}, [activeRequestPhase, candidateMotion, candidatePrevious, snapshot.revision])

	useEffect(
		() => () => {
			if (clearTimerRef.current) clearTimeout(clearTimerRef.current)
		},
		[],
	)

	return transition
}

function transientTransform(motion: ContextWindowSegmentMotion): string {
	if (motion === "commit") return "translateX(-8px)"
	if (motion === "rollback") return "translateX(8px)"
	return "translateX(0)"
}

function quantizeWidthPercent(widthPercent: number): number {
	const bounded = Math.max(0, Math.min(100, widthPercent))
	return Math.floor(bounded * WIDTH_PERCENT_SCALE + 1e-6) / WIDTH_PERCENT_SCALE
}

/** Render the authoritative context snapshot as four ordered, independently animated segments. */
const ContextWindowSegmentedProgress = memo(({ snapshot, onOccupiedMouseEnter }: ContextWindowSegmentedProgressProps) => {
	const transition = useSegmentTransition(snapshot)
	const motion = transition.motion
	const previousTemporaryTokens = transition.previous
		? {
				active:
					transition.previous.phase === "receiving"
						? transition.previous.receivingTokens
						: transition.previous.pendingSendTokens,
				staged: transition.previous.stagedTokens ?? 0,
			}
		: undefined
	const activeDisplayTokens =
		motion !== "none" && getContextWindowActiveTokens(snapshot) === 0 && (previousTemporaryTokens?.active ?? 0) > 0
			? (previousTemporaryTokens?.active ?? 0)
			: getContextWindowActiveTokens(snapshot)
	const stagedDisplayTokens =
		motion !== "none" && (snapshot.stagedTokens ?? 0) === 0 && (previousTemporaryTokens?.staged ?? 0) > 0
			? (previousTemporaryTokens?.staged ?? 0)
			: (snapshot.stagedTokens ?? 0)
	const viewModel = useMemo(
		() =>
			createContextWindowIndicatorViewModel(snapshot, {
				active: activeDisplayTokens,
				staged: stagedDisplayTokens,
			}),
		[activeDisplayTokens, stagedDisplayTokens, snapshot],
	)
	const segments = useMemo<SegmentDefinition[]>(() => {
		const projected = viewModel.segments.map((segment) => ({
			...segment,
			widthPercent: quantizeWidthPercent(segment.widthPercent),
			color: getSegmentColor(segment),
			temporary: segment.kind === "active" || segment.kind === "staged",
			transitionSource:
				segment.kind === "active" && activeDisplayTokens !== getContextWindowActiveTokens(snapshot)
					? ("previous" as const)
					: segment.kind === "staged" && stagedDisplayTokens !== (snapshot.stagedTokens ?? 0)
						? ("previous" as const)
						: ("authoritative" as const),
		}))
		const totalWidth = projected.reduce((total, segment) => total + segment.widthPercent, 0)
		const hasQuantizedWidth = projected.some(
			(segment, index) => segment.widthPercent !== viewModel.segments[index]?.widthPercent,
		)
		const maximumTrackWidth = 100 - TRACK_WIDTH_SAFETY_PERCENT
		if (!hasQuantizedWidth || totalWidth <= maximumTrackWidth) return projected
		let lastVisibleIndex = -1
		for (let index = projected.length - 1; index >= 0; index -= 1) {
			const segment = projected[index]
			if (segment && segment.displayTokens > 0) {
				lastVisibleIndex = index
				break
			}
		}
		if (lastVisibleIndex < 0) return projected
		const reduction = totalWidth - maximumTrackWidth
		return projected.map((segment, index) =>
			index === lastVisibleIndex
				? { ...segment, widthPercent: quantizeWidthPercent(Math.max(0, segment.widthPercent - reduction)) }
				: segment,
		)
	}, [activeDisplayTokens, stagedDisplayTokens, snapshot, viewModel.segments])
	const nonZeroSegmentCount = segments.filter((segment) => segment.displayTokens > 0).length
	const rawWidthPercent = viewModel.segments.reduce(
		(total, segment) => total + (segment.displayTokens > 0 ? segment.widthPercent : 0),
		0,
	)
	const safeMinimumWidthPercent =
		nonZeroSegmentCount > 0 ? quantizeWidthPercent(Math.max(0, (100 - rawWidthPercent) / nonZeroSegmentCount)) : 0
	const safeMinimumWidth = `min(${MIN_VISIBLE_SEGMENT_PX}px, ${safeMinimumWidthPercent}%)`

	return (
		<div
			aria-label="Context window usage progress"
			aria-valuemax={snapshot.contextWindow}
			aria-valuemin={0}
			aria-valuenow={Math.min(viewModel.totalTokens, snapshot.contextWindow)}
			aria-valuetext={`${viewModel.totalTokens} of ${snapshot.contextWindow} tokens; phase ${snapshot.phase}`}
			className="relative h-3 w-full overflow-hidden rounded-full bg-code-foreground/20"
			data-context-window={snapshot.contextWindow}
			data-epoch={snapshot.epoch}
			data-minimum-width-percent={safeMinimumWidthPercent}
			data-mode={snapshot.mode}
			data-motion={motion}
			data-phase={snapshot.phase}
			data-profile-name={snapshot.profileName}
			data-revision={snapshot.revision}
			data-testid="context-window-segmented-progress"
			role="progressbar">
			<div className="absolute inset-0 flex items-stretch overflow-hidden rounded-full">
				{segments.map((segment) => {
					const active = segment.kind === "active" && (snapshot.phase === "sending" || snapshot.phase === "receiving")
					const settling = segment.temporary && motion !== "none"
					return (
						<div
							aria-hidden={segment.displayTokens <= 0 ? "true" : undefined}
							aria-label={`${segment.label}: ${segment.authoritativeTokens} tokens`}
							className={`h-full shrink transition-[width,opacity,transform,filter] duration-300 ease-out motion-reduce:transition-none motion-reduce:transform-none ${
								active ? "animate-pulse motion-reduce:animate-none" : ""
							}`}
							data-active={active ? "true" : "false"}
							data-authoritative-tokens={segment.authoritativeTokens}
							data-segment={segment.kind}
							data-testid={`context-window-segment-${segment.kind}`}
							data-tokens={segment.displayTokens}
							data-transition-source={segment.transitionSource}
							key={segment.kind}
							onMouseEnter={segment.displayTokens > 0 && !settling ? onOccupiedMouseEnter : undefined}
							role="img"
							style={{
								backgroundColor: segment.color,
								filter: motion === "commit" && segment.kind === "durable" ? "brightness(1.16)" : "none",
								minWidth: segment.displayTokens > 0 && !settling ? safeMinimumWidth : "0px",
								opacity: settling ? 0 : segment.displayTokens > 0 ? 1 : 0,
								pointerEvents: segment.displayTokens > 0 && !settling ? "auto" : "none",
								transform: segment.temporary ? transientTransform(motion) : "translateX(0)",
								width: settling ? "0%" : `${segment.widthPercent}%`,
							}}
						/>
					)
				})}
			</div>
		</div>
	)
})

ContextWindowSegmentedProgress.displayName = "ContextWindowSegmentedProgress"

export default ContextWindowSegmentedProgress
