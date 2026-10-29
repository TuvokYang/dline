import type { Meta, StoryObj } from "@storybook/react-vite"
import { useCallback, useEffect, useRef, useState } from "react"
import { ConversationTrajectoryRail } from "./ConversationTrajectoryRail"
import type { TrajectoryAttempt, TrajectoryTurn } from "./trajectory-model"

/** How long the rail stays after the last scroll event before fading out. */
const RAIL_IDLE_HIDE_MS = 1_500
/** A user message counts as the current turn once its top is this close to the viewport top. */
const ACTIVE_TURN_TOP_SLACK_PX = 12

const turn = (anchorTs: number, prompt: string, rounds: number, usage: Record<string, number>): TrajectoryTurn => ({
    anchorTs,
    prompt,
    rounds,
    toolUsage: Object.entries(usage)
        .map(([tool, count]) => ({ tool, count }))
        .sort((a, b) => b.count - a.count),
})

const ATTEMPTS: TrajectoryAttempt[] = [
    {
        id: "attempt-1",
        completed: true,
        turns: [
            turn(1, "Add a retry policy to the provider client and cover the timeout path with tests.", 9, {
                read_file: 4,
                search_files: 2,
                replace_in_file: 3,
                execute_command: 2,
            }),
            turn(2, "The timeout test is flaky on Windows, investigate before changing the assertion.", 4, {
                read_file: 2,
                execute_command: 3,
            }),
            turn(3, "Looks good, summarize the change.", 1, {}),
        ],
    },
    {
        id: "attempt-2",
        completed: true,
        turns: [
            turn(4, "Now make the backoff configurable per profile.", 6, {
                read_file: 3,
                use_subagents: 1,
                replace_in_file: 2,
            }),
            turn(5, "Also expose it in the settings UI with validation.", 3, { replace_in_file: 2, execute_command: 1 }),
        ],
    },
    {
        id: "attempt-3",
        completed: false,
        turns: [
            turn(6, "Run the work E2E gate and fix anything that breaks.", 5, { execute_command: 3, read_file: 2 }),
            turn(7, "Continue, and keep the changelog in sync.", 2, { read_file: 1, replace_in_file: 1 }),
        ],
    },
]

/** A task of `attemptCount` attempts of three to nine turns each; only the last attempt is still open. */
const longTask = (attemptCount: number): TrajectoryAttempt[] =>
    Array.from({ length: attemptCount }, (_, attemptIndex) => ({
        id: `long-${attemptIndex}`,
        completed: attemptIndex < attemptCount - 1,
        turns: Array.from({ length: 3 + (attemptIndex % 4) * 2 }, (_, turnIndex) =>
            turn(
                attemptIndex * 100 + turnIndex + 1,
                `Follow-up ${turnIndex + 1} of attempt ${attemptIndex + 1}`,
                2 + (turnIndex % 3),
                {
                    read_file: 1 + (turnIndex % 2),
                    execute_command: 1,
                },
            ),
        ),
    }))

const meta: Meta<typeof ConversationTrajectoryRail> = {
    title: "Chat/ConversationTrajectoryRail",
    component: ConversationTrajectoryRail,
    parameters: {
        layout: "fullscreen",
        docs: {
            description: {
                component:
                    "Right-edge navigation of the chat, overlaid on the messages rather than given its own column: one equal-width bar per user turn, grouped on a band per attempt over one translucent backdrop. Bars use the foreground color in two strengths: full for the current turn, faint for the rest. A long task tightens the bar spacing first; past the tightest spacing the bars scroll inside the rail, follow the current turn, and fade at the edges that hide more. Hover previews the user message, the rounds the turn ran, and how often it called each tool; click jumps to the user message.",
            },
        },
    },
}

export default meta
type Story = StoryObj<typeof meta>

/** Scroll the mock chat: the rail fades in, tracks the current turn, and fades out after the scroll settles. */
export const InChat: Story = {
    render: () => <ChatFixture attempts={ATTEMPTS} />,
}

/** The rail held visible over the chat, for reviewing bar spacing, the attempt bands, and the overlay. */
export const AlwaysVisible: Story = {
    render: () => <ChatFixture alwaysVisible attempts={ATTEMPTS} />,
}

/** Six attempts and thirty-two turns: the bar spacing tightens so every turn still fits the rail. */
export const ManyTurns: Story = {
    render: () => <ChatFixture alwaysVisible attempts={longTask(6)} />,
}

/** Fourteen attempts are too many even at the tightest spacing: scroll the chat to watch the rail follow and fade. */
export const Overflowing: Story = {
    render: () => <ChatFixture alwaysVisible attempts={longTask(14)} />,
}

interface ChatFixtureProps {
    attempts: TrajectoryAttempt[]
    /** Holds the rail up instead of showing it only while scrolling. */
    alwaysVisible?: boolean
}

function ChatFixture({ attempts, alwaysVisible = false }: ChatFixtureProps) {
    const scrollerRef = useRef<HTMLDivElement>(null)
    const [scrolling, setScrolling] = useState(false)
    const [activeTurnTs, setActiveTurnTs] = useState<number | undefined>(attempts[0]?.turns[0]?.anchorTs)

    useEffect(() => {
        const scroller = scrollerRef.current
        if (!scroller) return
        let hideTimer: ReturnType<typeof setTimeout> | undefined
        const onScroll = () => {
            setScrolling(true)
            clearTimeout(hideTimer)
            hideTimer = setTimeout(() => setScrolling(false), RAIL_IDLE_HIDE_MS)
            const anchors = Array.from(scroller.querySelectorAll<HTMLElement>("[data-anchor-ts]"))
            const passed = anchors.filter((anchor) => anchor.offsetTop <= scroller.scrollTop + ACTIVE_TURN_TOP_SLACK_PX)
            setActiveTurnTs(Number((passed.at(-1) ?? anchors[0])?.dataset.anchorTs))
        }
        scroller.addEventListener("scroll", onScroll, { passive: true })
        return () => {
            clearTimeout(hideTimer)
            scroller.removeEventListener("scroll", onScroll)
        }
    }, [])

    const jumpToTurn = useCallback((anchorTs: number) => {
        scrollerRef.current
            ?.querySelector(`[data-anchor-ts="${anchorTs}"]`)
            ?.scrollIntoView({ behavior: "smooth", block: "start" })
    }, [])

    return (
        <div className="relative h-[640px] w-full max-w-[460px] overflow-hidden border border-muted-foreground/30 bg-background">
            <div className="h-full overflow-y-auto px-3 [scrollbar-width:none]" ref={scrollerRef}>
                {attempts.map((attempt) => (
                    <div key={attempt.id}>
                        {attempt.turns.map((chatTurn) => (
                            <MockTurn key={chatTurn.anchorTs} turn={chatTurn} />
                        ))}
                        {attempt.completed && (
                            <div className="mb-6 rounded-xs border border-success/40 px-2 py-1.5 text-xs text-success">
                                Task Completed
                            </div>
                        )}
                    </div>
                ))}
            </div>
            <ConversationTrajectoryRail
                activeTurnTs={activeTurnTs}
                attempts={attempts}
                onSelectTurn={jumpToTurn}
                visible={alwaysVisible || scrolling}
            />
        </div>
    )
}

function MockTurn({ turn: chatTurn }: { turn: TrajectoryTurn }) {
    return (
        <section className="pt-3 pb-4">
            <div className="rounded-xs bg-badge-background p-2 text-sm text-badge-foreground" data-anchor-ts={chatTurn.anchorTs}>
                {chatTurn.prompt}
            </div>
            <ul className="m-0 mt-2 flex list-none flex-col gap-1 p-0">
                {chatTurn.toolUsage.map(({ tool, count }) => (
                    <li className="truncate font-mono text-xs text-description" key={tool}>
                        {tool} {count}
                    </li>
                ))}
            </ul>
            <p className="mt-2 text-sm leading-6 text-foreground">
                The agent works through the request here. This placeholder stands in for its reasoning, tool rows, and reply, so
                the list is long enough to scroll and the rail has distances to navigate.
            </p>
            <p className="text-sm leading-6 text-foreground opacity-80">
                Each section starts at the user message the rail jumps to, and ends where the next user message begins.
            </p>
        </section>
    )
}
