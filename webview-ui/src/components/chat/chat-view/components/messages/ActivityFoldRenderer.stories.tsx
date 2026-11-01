import { AGGRESSIVE_RENDERING_LABELS, type AggressiveRenderingLevel } from "@shared/AggressiveRendering"
import type { UiMessage } from "@shared/ExtensionMessage"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { useEffect, useMemo, useState } from "react"
import type { MessageHandlers } from "../../types/chatTypes"
import { isActivityFold } from "../../utils/chatRowKinds"
import { groupChatRows } from "../../utils/messageUtils"
import { rowIdentity } from "../../utils/rowCoordinate"
import { liveTwoTurnSteps } from "./activityFoldStoryFixtures"
import { createMessageRenderer } from "./MessageRenderer"

const messageHandlers: MessageHandlers = {
    handleSendMessage: async () => undefined,
    handleTaskCloseButtonClick: async () => undefined,
    startNewTask: async () => undefined,
}

const ignore = () => undefined

const STEP_INTERVAL_MS = 1_200

/**
 * Draws one conversation at a folding level, owning row and fold expansion the
 * way the chat list does: rows by message timestamp, folds by fold id.
 */
function ConversationRows({ level, messages }: { level: AggressiveRenderingLevel; messages: readonly UiMessage[] }) {
    const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({})
    const [expandedFolds, setExpandedFolds] = useState<Record<string, boolean>>({})
    const transcript = messages as UiMessage[]
    // The production pipeline: the same call the chat makes, so the story cannot drift from it.
    const rows = useMemo(() => groupChatRows(transcript, undefined, { level }), [transcript, level])
    const folded = rows
    const renderRow = createMessageRenderer(
        rows,
        transcript,
        expandedRows,
        (ts) => setExpandedRows((current) => ({ ...current, [ts]: !current[ts] })),
        ignore,
        ignore,
        ignore,
        async () => undefined,
        messageHandlers,
        false,
        {
            expanded: expandedFolds,
            toggle: (foldId) => setExpandedFolds((current) => ({ ...current, [foldId]: !current[foldId] })),
        },
    )
    return (
        <div>
            {level !== "none" && (
                <div className="flex gap-3 px-4 py-1">
                    <button
                        className={controlButton}
                        onClick={() =>
                            setExpandedFolds(
                                Object.fromEntries(folded.filter(isActivityFold).map((fold) => [fold._activityFoldId, true])),
                            )
                        }
                        type="button">
                        Expand all activity
                    </button>
                    <button className={controlButton} onClick={() => setExpandedFolds({})} type="button">
                        Collapse all activity
                    </button>
                </div>
            )}
            {rows.map((row, index) => (
                <div key={rowIdentity(row)}>{renderRow(index, row)}</div>
            ))}
        </div>
    )
}

const controlButton =
    "rounded-xs border border-(--vscode-button-border,transparent) bg-(--vscode-button-secondaryBackground) px-2 py-0.5 text-xs text-(--vscode-button-secondaryForeground) cursor-pointer disabled:cursor-default disabled:opacity-50"

/**
 * Replays two turns one extension event at a time, so folding can be watched as
 * each round ends. Playback starts on its own; the controls pause, step and replay.
 */
function LiveFoldingFixture({ level }: { level: AggressiveRenderingLevel }) {
    const lastStep = liveTwoTurnSteps.length - 1
    const [step, setStep] = useState(0)
    const [playing, setPlaying] = useState(true)

    useEffect(() => {
        if (!playing) return
        if (step >= lastStep) {
            setPlaying(false)
            return
        }
        const timer = setTimeout(() => setStep((current) => Math.min(current + 1, lastStep)), STEP_INTERVAL_MS)
        return () => clearTimeout(timer)
    }, [playing, step, lastStep])

    const { caption, messages } = liveTwoTurnSteps[step]
    return (
        <div style={{ width: "100%", maxWidth: 560, paddingTop: 12 }}>
            <div className="sticky top-0 z-10 mb-2 flex flex-wrap items-center gap-1.5 bg-(--vscode-sideBar-background) px-4 py-2 text-xs">
                <span className="font-medium">{AGGRESSIVE_RENDERING_LABELS[level]}</span>
                <span className="text-description" data-testid="live-step-caption">
                    · Step {step + 1}/{lastStep + 1}: {caption}
                </span>
                <div className="flex w-full gap-1.5 pt-1">
                    <button className={controlButton} onClick={() => setPlaying((current) => !current)} type="button">
                        {playing ? "Pause" : "Play"}
                    </button>
                    <button
                        className={controlButton}
                        disabled={step === 0}
                        onClick={() => {
                            setPlaying(false)
                            setStep((current) => Math.max(current - 1, 0))
                        }}
                        type="button">
                        Back
                    </button>
                    <button
                        className={controlButton}
                        disabled={step === lastStep}
                        onClick={() => {
                            setPlaying(false)
                            setStep((current) => Math.min(current + 1, lastStep))
                        }}
                        type="button">
                        Next
                    </button>
                    <button
                        className={controlButton}
                        onClick={() => {
                            setStep(0)
                            setPlaying(true)
                        }}
                        type="button">
                        Replay
                    </button>
                    <button
                        className={controlButton}
                        disabled={step === lastStep}
                        onClick={() => {
                            setPlaying(false)
                            setStep(lastStep)
                        }}
                        type="button">
                        End
                    </button>
                </div>
            </div>
            <ConversationRows level={level} messages={messages} />
        </div>
    )
}

const meta = {
    title: "Chat/Activity Folding",
    component: LiveFoldingFixture,
    parameters: { layout: "fullscreen" },
    argTypes: { level: { table: { disable: true } } },
    args: { level: "none" },
} satisfies Meta<typeof LiveFoldingFixture>

export default meta
type Story = StoryObj<typeof meta>

/** The same production pipeline at three independent, fixed levels. */
export const Standard: Story = { name: "1 · Standard (no folding)", args: { level: "none" } }
export const RequestRounds: Story = { name: "2 · Fold activity within each request round", args: { level: "round" } }
export const MessageSegments: Story = { name: "3 · Fold activity between messages", args: { level: "message_segment" } }
export const WholeTurn: Story = { name: "4 · Fold the whole turn into one block", args: { level: "user_turn" } }
