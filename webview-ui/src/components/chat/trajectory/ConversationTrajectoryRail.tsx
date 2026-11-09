import { type FocusEvent, useState } from "react"
import { FLOATING_CONTROL_VISIBILITY } from "@/components/chat/floating-control-styles"
import { HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/hover-card"
import { useUiTranslation } from "@/i18n/UiLanguageProvider"
import { cn } from "@/lib/utils"
import type { TrajectoryAttempt, TrajectoryTurn } from "./trajectory-model"
import {
    edgeFadeMask,
    RAIL_MAX_HEIGHT_RATIO,
    useCompressedBarGap,
    useFollowActiveTurn,
    useScrollEdges,
} from "./useTrajectoryRailLayout"

/** Delay before a hovered bar opens its preview, so a pointer sweeping the rail does not flash every card. */
const PREVIEW_OPEN_DELAY_MS = 120
const PREVIEW_CLOSE_DELAY_MS = 80

interface ConversationTrajectoryRailProps {
    attempts: readonly TrajectoryAttempt[]
    /** The turn whose user message is at the top of the viewport. */
    activeTurnSeq?: number
    className?: string
    onSelectTurn: (turn: TrajectoryTurn) => void
}

/**
 * Discrete bars overlaid on the right edge of the chat, one per user turn.
 *
 * The rail is absolutely positioned and takes no layout space: the parent must
 * be a positioned element, and the chat content runs underneath it. Each
 * attempt draws its bars on its own background band, so the boundary between
 * attempts reads at a glance. Hovering a bar previews the turn; clicking it
 * hands the turn's user message to `onSelectTurn`.
 *
 * A long task first tightens the spacing between bars; when even the tightest
 * spacing does not fit, the bars scroll inside the rail, follow the current
 * turn, and fade out at each edge that hides more.
 */
export function ConversationTrajectoryRail({
    attempts,
    activeTurnSeq,
    className,
    onSelectTurn,
}: ConversationTrajectoryRailProps) {
    const { t } = useUiTranslation()
    // Pause active-turn following while the reader is using the rail.
    const [engaged, setEngaged] = useState(false)
    // State rather than refs: the rail renders nothing until the first turn arrives, and the
    // layout hooks must attach to the elements once they exist.
    const [rail, setRail] = useState<HTMLElement | null>(null)
    const [scroller, setScroller] = useState<HTMLDivElement | null>(null)
    const barGap = useCompressedBarGap(rail, scroller, countBarGaps(attempts))
    const edges = useScrollEdges(scroller)
    useFollowActiveTurn(scroller, activeTurnSeq, engaged)

    if (attempts.length === 0) return null

    const fadeMask = edgeFadeMask(edges)

    const releaseFocus = (event: FocusEvent<HTMLElement>) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setEngaged(false)
    }

    return (
        // biome-ignore lint/a11y/noNoninteractiveElementInteractions: pointer and focus tracking pause internal scrolling; the bars inside are the controls.
        <nav
            aria-label={t("chatInput.trajectory.title")}
            className={cn(
                // One translucent backdrop behind the whole rail keeps the bars legible over the chat text underneath.
                "absolute top-1/2 right-1 z-10 flex -translate-y-1/2 flex-col rounded-[4px] bg-background/35 p-1 backdrop-blur-sm transition-opacity duration-200",
                FLOATING_CONTROL_VISIBILITY,
                className,
            )}
            data-testid="trajectory-rail"
            onBlur={releaseFocus}
            onFocus={() => setEngaged(true)}
            onPointerEnter={() => setEngaged(true)}
            onPointerLeave={() => setEngaged(false)}
            ref={setRail}
            style={{ maxHeight: `${RAIL_MAX_HEIGHT_RATIO * 100}%` }}>
            {/* The bars scroll inside the backdrop, so the edge fades leave the backdrop itself whole. */}
            <div
                className="flex min-h-0 flex-col gap-1.5 overflow-y-auto [scrollbar-width:none]"
                ref={setScroller}
                style={{ maskImage: fadeMask, WebkitMaskImage: fadeMask }}>
                {attempts.map((attempt, attemptIndex) => (
                    <div
                        className="flex w-[27px] shrink-0 flex-col items-center rounded-[3px] bg-foreground/[0.09] py-1.5"
                        data-testid="trajectory-attempt"
                        key={attempt.id}
                        style={{ rowGap: barGap }}>
                        {attempt.turns.map((turn, turnIndex) => (
                            <TrajectoryBar
                                active={turn.seq === activeTurnSeq}
                                attemptNumber={attemptIndex + 1}
                                key={turn.seq}
                                onSelect={onSelectTurn}
                                turn={turn}
                                turnNumber={turnIndex + 1}
                            />
                        ))}
                    </div>
                ))}
            </div>
        </nav>
    )
}

/** The gaps between bars inside the attempts, which the compressed spacing applies to. */
function countBarGaps(attempts: readonly TrajectoryAttempt[]): number {
    return attempts.reduce((gaps, attempt) => gaps + Math.max(attempt.turns.length - 1, 0), 0)
}

interface TrajectoryBarProps {
    turn: TrajectoryTurn
    turnNumber: number
    attemptNumber: number
    active: boolean
    onSelect: (turn: TrajectoryTurn) => void
}

function TrajectoryBar({ turn, turnNumber, attemptNumber, active, onSelect }: TrajectoryBarProps) {
    const { t } = useUiTranslation()
    return (
        <HoverCard closeDelay={PREVIEW_CLOSE_DELAY_MS} openDelay={PREVIEW_OPEN_DELAY_MS}>
            <HoverCardTrigger asChild>
                <button
                    aria-current={active ? "location" : undefined}
                    aria-label={t("chatInput.trajectory.jump", { prompt: turn.prompt })}
                    className="group flex h-2 w-full cursor-pointer items-center justify-center border-0 bg-transparent p-0"
                    data-testid="trajectory-turn"
                    data-turn-index={turn.anchorIndex}
                    data-turn-seq={turn.seq}
                    data-turn-ts={turn.anchorTs}
                    onClick={() => onSelect(turn)}
                    type="button">
                    <span
                        className={cn(
                            "block h-[2px] w-4 rounded-full transition-colors duration-150",
                            // One color in two strengths: full for where the reader is, faint for the rest.
                            active ? "bg-foreground" : "bg-foreground/15 group-hover:bg-foreground/70",
                        )}
                    />
                </button>
            </HoverCardTrigger>
            <HoverCardContent
                align="center"
                arrowClassName="hidden"
                className="w-60 border-foreground/10 bg-code/50 p-0 backdrop-blur-md"
                side="left"
                sideOffset={10}>
                <TrajectoryTurnPreview attemptNumber={attemptNumber} turn={turn} turnNumber={turnNumber} />
            </HoverCardContent>
        </HoverCard>
    )
}

interface TrajectoryTurnPreviewProps {
    turn: TrajectoryTurn
    turnNumber: number
    attemptNumber: number
}

/** The hover card of one turn: the user's message, then how many rounds it ran and which tools it called how often. */
function TrajectoryTurnPreview({ turn, turnNumber, attemptNumber }: TrajectoryTurnPreviewProps) {
    const { t } = useUiTranslation()
    return (
        <div className="flex flex-col gap-2 p-2.5 text-xs" data-testid="trajectory-turn-preview">
            <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wide text-description">
                <span>{t("chatInput.trajectory.attempt", { number: attemptNumber })}</span>
                <span aria-hidden="true">·</span>
                <span>{t("chatInput.trajectory.turn", { number: turnNumber })}</span>
            </div>
            <p className="m-0 line-clamp-3 whitespace-pre-wrap break-words text-foreground">{turn.prompt}</p>
            {turn.rounds > 0 && (
                // The summary is secondary to the message, so it sits back behind it.
                <div className="flex flex-col gap-1 border-t border-foreground/10 pt-2 opacity-60">
                    <span className="text-description">{t("chatInput.trajectory.rounds", { count: turn.rounds })}</span>
                    {turn.toolUsage.length > 0 && (
                        <ul className="m-0 flex list-none flex-col gap-0.5 p-0">
                            {turn.toolUsage.map(({ tool, count }) => (
                                <li className="flex items-baseline justify-between gap-3 font-mono" key={tool}>
                                    <span className="min-w-0 truncate text-foreground">{tool}</span>
                                    <span className="shrink-0 text-description tabular-nums">{count}</span>
                                </li>
                            ))}
                        </ul>
                    )}
                </div>
            )}
        </div>
    )
}
