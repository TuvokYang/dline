import { AGGRESSIVE_RENDERING_LABELS } from "@shared/AggressiveRendering"
import type { TaskViewState, UiMessage } from "@shared/ExtensionMessage"
import { TrajectoryState, TrajectoryTurnSummary, TrajectoryUpdate } from "@shared/proto/dline/task"
import { convertClineMessageToProto } from "@shared/proto-conversions/cline-message"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { useEffect, useId, useMemo, useState } from "react"
import { ExtensionStateContext, useExtensionState } from "@/context/ExtensionStateContext"
import { TaskServiceClient } from "@/services/grpc-client"
import { useChatState } from "../../hooks/useChatState"
import { useScrollBehavior } from "../../hooks/useScrollBehavior"
import type { MessageHandlers } from "../../types/chatTypes"
import { isActivityFold } from "../../utils/chatRowKinds"
import { filterVisibleMessages, groupChatRows } from "../../utils/messageUtils"
import { type DesignFoldingMode, designFoldRows } from "./foldingTrajectoryDesign"
import { createFoldingTranscript } from "./foldingTrajectoryStoryFixtures"
import { createFoldRoundUsage } from "./foldingTrajectoryUsageFixture"
import { MessagesArea } from "./MessagesArea"

type Expansion = "collapsed" | "partial" | "expanded"
interface FixtureProps {
    initialExpansion: Expansion
    turnCount: number
    initialLevel: DesignFoldingMode
    /** Append a turn whose edit, command and subagent batch all failed. */
    withFailures?: boolean
}

const HANDLERS: MessageHandlers = {
    handleSendMessage: async () => undefined,
    handleTaskCloseButtonClick: async () => undefined,
    startNewTask: async () => undefined,
}
const ignoreOption = async () => undefined
const controlClass = "rounded border border-description/30 bg-background px-2 py-1 text-xs text-foreground"
const DESIGN_FOLDING_LABELS = AGGRESSIVE_RENDERING_LABELS
const DESIGN_FOLDING_HELP: Record<DesignFoldingMode, string> = {
    none: "Original chat rows and groups, with no additional folding.",
    message_segment:
        "Fold activity between messages. Plain text, Reply, Phase report and every request boundary split the blocks; no row spans two rounds.",
    user_turn:
        "Fold the whole turn into one block. Completed content is grouped across assistant messages and request boundaries, until the user-turn boundary; live and failed rows stay visible.",
}

function foldIds(rows: readonly (UiMessage | UiMessage[])[]): string[] {
    return rows.filter(isActivityFold).flatMap((fold) => [fold._activityFoldId, ...foldIds(fold._children)])
}

function expansionState(rows: readonly (UiMessage | UiMessage[])[], expansion: Expansion): Record<string, boolean> {
    if (expansion === "collapsed") return {}
    const ids = foldIds(rows)
    const open = expansion === "partial" ? ids.slice(0, 2) : ids
    return Object.fromEntries(open.map((id) => [id, true]))
}

/** Mock only host data, before mounting the real subscription consumer. Never force the rail visible. */
function useFixtureTransport(taskId: string, messages: UiMessage[]): boolean {
    const [ready, setReady] = useState(false)
    useEffect(() => {
        const originalFetch = TaskServiceClient.fetchMessage
        const originalSubscribe = TaskServiceClient.subscribeToTrajectory
        const fetch: typeof originalFetch = async (request) => {
            if (request.taskId !== taskId) return originalFetch(request)
            const startIndex = request.referenceIndex < 0 ? Math.max(0, messages.length - request.count) : request.referenceIndex
            return {
                messages: messages.slice(startIndex, startIndex + request.count).map(convertClineMessageToProto),
                startIndex,
                totalCount: messages.length,
                taskId,
                taskInstanceId: request.taskInstanceId,
                anchorFound: false,
            }
        }
        const turns = messages.filter((message) => message.say === "task" || message.say === "user_feedback")
        const subscribe: typeof originalSubscribe = (request, callbacks) => {
            if (request.taskId !== taskId) return originalSubscribe(request, callbacks)
            const timer = setTimeout(
                () =>
                    callbacks.onResponse(
                        TrajectoryUpdate.create({
                            taskId,
                            taskInstanceId: request.taskInstanceId,
                            state: TrajectoryState.TRAJECTORY_STATE_READY,
                            reset: true,
                            revision: 1,
                            turnCount: turns.length,
                            turns: turns.map((message, seq) =>
                                TrajectoryTurnSummary.create({
                                    seq,
                                    attemptSeq: Math.floor(seq / 4),
                                    endsAttempt: seq % 4 === 3,
                                    anchorTs: message.ts,
                                    prompt: message.text,
                                    rounds: 8,
                                    toolUsage: [
                                        { tool: "read_file", count: 3 },
                                        { tool: "search_files", count: 1 },
                                        { tool: "execute_command", count: 2 },
                                    ],
                                }),
                            ),
                        }),
                    ),
                0,
            )
            return () => clearTimeout(timer)
        }
        TaskServiceClient.fetchMessage = fetch
        TaskServiceClient.subscribeToTrajectory = subscribe
        setReady(true)
        return () => {
            if (TaskServiceClient.fetchMessage === fetch) TaskServiceClient.fetchMessage = originalFetch
            if (TaskServiceClient.subscribeToTrajectory === subscribe) TaskServiceClient.subscribeToTrajectory = originalSubscribe
        }
    }, [taskId, messages])
    return ready
}

/** Full MessagesArea + real Virtuoso, row renderer, scroll policy and trajectory subscription. */
function FoldingTrajectoryFixture({ initialExpansion, turnCount, initialLevel, withFailures = false }: FixtureProps) {
    const base = useExtensionState()
    const id = useId()
    const taskId = `folding-trajectory-${id}`
    const initialMessages = useMemo(() => createFoldingTranscript(turnCount, withFailures), [turnCount, withFailures])
    const [messages, setMessages] = useState(initialMessages)
    const [firstItemIndex, setFirstItemIndex] = useState(0)
    const level = initialLevel
    const height = 560
    const width = 500
    const visible = useMemo(() => filterVisibleMessages(messages), [messages])
    const standardRows = useMemo(() => groupChatRows(messages, visible, { level: "none" }), [messages, visible])
    const roundUsage = useMemo(() => createFoldRoundUsage(messages), [messages])
    const foldedRows = useMemo(
        () => designFoldRows(messages, standardRows, level, roundUsage),
        [messages, standardRows, level, roundUsage],
    )
    const chat = useChatState(messages, taskId)
    // An open fold keeps its header and draws its members beneath it.
    const rows = foldedRows
    const matchesStandard = rows.length === standardRows.length && rows.every((row, index) => row === standardRows[index])
    const scroll = useScrollBehavior(messages, visible, rows, chat.expandedRows, chat.setExpandedRows, chat.setExpandedFolds)
    const ready = useFixtureTransport(taskId, messages)
    const taskViewState: TaskViewState = {
        taskId,
        taskInstanceId: "story-opening",
        phase: "idle",
        stateRevision: 0,
        input: { enabled: false, acceptsText: false, acceptsImages: false, acceptsFiles: false },
        footer: { actions: [] },
    }
    const context = {
        ...base,
        taskViewState,
        clineMessages: messages,
        setClineMessages: setMessages,
        firstItemIndex,
        setFirstItemIndex,
        totalMessageCount: messages.length,
        mode: "act" as const,
        aggressiveRendering: { user: level, featureFlag: true },
    }

    const setExpansion = (expansion: Expansion) => {
        scroll.replaceFoldExpansion(expansionState(foldedRows, expansion))
    }
    const { setExpandedFolds } = chat
    const initialFolds = useMemo(() => groupChatRows(initialMessages, undefined, { level }), [initialMessages, level])
    useEffect(() => {
        setExpandedFolds(expansionState(initialFolds, initialExpansion))
    }, [initialExpansion, initialFolds, setExpandedFolds])

    return (
        <ExtensionStateContext.Provider value={context}>
            <div className="p-3">
                <h2 className="m-0 mb-2 text-sm">{DESIGN_FOLDING_LABELS[level]}</h2>
                <p className="m-0 mb-2 max-w-2xl text-xs text-description">
                    All levels use the original MessagesArea, Virtuoso and trajectory rail. Only collapse boundaries change.
                    Expand all restores the same Standard rows, groups and order, without extra round headers or indentation. The
                    second option splits at messages; the third keeps whole-turn folding. These are the production folding rules.
                </p>
                <p className="m-0 mb-2 max-w-2xl text-xs text-description">
                    Compare this story with the separate Standard story. Expand all restores the Standard layout. Click a block to
                    open it; use the controls to fold it again. Original tool, exploration and browser cards keep their controls.
                    Scroll to reveal the original rail (1.2s idle fade); no alternate trajectory renderer is used.
                </p>
                <div className="mb-3 flex flex-wrap items-center gap-2">
                    <button
                        className={controlClass}
                        disabled={level === "none"}
                        onClick={() => setExpansion("collapsed")}
                        type="button">
                        Collapse all
                    </button>
                    <button
                        className={controlClass}
                        disabled={level === "none"}
                        onClick={() => setExpansion("partial")}
                        type="button">
                        Partially expand
                    </button>
                    <button
                        className={controlClass}
                        disabled={level === "none"}
                        onClick={() => setExpansion("expanded")}
                        type="button">
                        Expand all
                    </button>
                </div>
                <p className="mb-2 text-xs text-description">{DESIGN_FOLDING_HELP[level]}</p>
                <div
                    className="border border-description/30 bg-background"
                    data-testid="folding-trajectory-fixture"
                    style={{ height, width, maxWidth: "100%" }}>
                    {ready && (
                        <MessagesArea
                            chatState={chat}
                            groupedMessages={rows}
                            messageHandlers={HANDLERS}
                            modifiedMessages={messages}
                            onFollowupOptionSelect={ignoreOption}
                            scrollBehavior={scroll}
                            task={messages[0]}
                        />
                    )}
                </div>
                <p className="mt-2 text-xs text-description">
                    {turnCount} turns · {rows.length} displayed / {standardRows.length} Standard rows · Standard row identity:
                    {matchesStandard ? " identical" : " activity segments collapsed"} · trajectory: fixture READY
                </p>
            </div>
        </ExtensionStateContext.Provider>
    )
}

const meta = {
    title: "Chat/Folding and Trajectory",
    component: FoldingTrajectoryFixture,
    render: (args) => <FoldingTrajectoryFixture key={`${args.turnCount}:${args.initialLevel}`} {...args} />,
    parameters: { layout: "fullscreen" },
    argTypes: { initialLevel: { table: { disable: true } } },
    args: { initialExpansion: "collapsed", turnCount: 12, initialLevel: "user_turn" },
} satisfies Meta<typeof FoldingTrajectoryFixture>
export default meta
type Story = StoryObj<typeof meta>
export const Standard: Story = { name: "1 · Standard (no folding)", args: { initialLevel: "none" } }
export const MessageSegments: Story = { name: "2 · Fold activity between messages", args: { initialLevel: "message_segment" } }
export const WholeTurn: Story = { name: "3 · Fold the whole turn into one block", args: { initialLevel: "user_turn" } }
export const FailedWork: Story = {
    name: "4 · Failed edits, commands and subagents are counted",
    args: { initialLevel: "user_turn", turnCount: 2, withFailures: true },
}
