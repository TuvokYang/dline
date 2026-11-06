import { AGGRESSIVE_RENDERING_LABELS, type AggressiveRenderingLevel } from "@shared/AggressiveRendering"
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
import { createFoldingTranscript } from "./foldingTrajectoryStoryFixtures"
import { MessagesArea } from "./MessagesArea"

type Expansion = "collapsed" | "partial" | "expanded"
interface FixtureProps {
    initialExpansion: Expansion
    turnCount: number
    initialLevel: AggressiveRenderingLevel
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
const DESIGN_FOLDING_HELP: Record<AggressiveRenderingLevel, string> = {
    none: "Original chat rows and groups, with no additional folding.",
    round: "Fold finished activity inside each request round. A block never holds work from two provider sends.",
    message_segment:
        "Fold finished activity between assistant messages, even across request rounds. Prose and assistant updates keep their own rows.",
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
            const anchored = request.anchorIndex !== undefined || request.anchorTs !== undefined
            const position = anchored
                ? messages.findIndex((message) =>
                      request.anchorIndex !== undefined
                          ? message.messageIndex === request.anchorIndex &&
                            (request.anchorTs === undefined || message.ts === request.anchorTs)
                          : message.ts === request.anchorTs,
                  )
                : -1
            const startIndex = anchored
                ? Math.max(0, position - Math.floor(request.count / 2))
                : request.referenceIndex < 0
                  ? Math.max(0, messages.length - request.count)
                  : request.referenceIndex
            return {
                messages: (anchored && position < 0 ? [] : messages.slice(startIndex, startIndex + request.count)).map(
                    convertClineMessageToProto,
                ),
                startIndex,
                totalCount: messages.length,
                taskId,
                taskInstanceId: request.taskInstanceId,
                anchorFound: anchored && position >= 0,
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
                                    anchorIndex: message.messageIndex,
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
    // The fixture owns a committed transcript; attach source metadata before any grouping or paging.
    const initialMessages = useMemo<UiMessage[]>(
        () => createFoldingTranscript(turnCount, withFailures).map((message, messageIndex) => ({ ...message, messageIndex })),
        [turnCount, withFailures],
    )
    const [messages, setMessages] = useState(initialMessages)
    const [firstItemIndex, setFirstItemIndex] = useState(0)
    const level = initialLevel
    const height = 560
    const width = 500
    const visible = useMemo(() => filterVisibleMessages(messages), [messages])
    const standardRows = useMemo(() => groupChatRows(messages, visible, { level: "none" }), [messages, visible])
    // The production pipeline: the same call the chat makes, so the story cannot drift from it.
    const rows = useMemo(() => groupChatRows(messages, visible, { level }), [messages, visible, level])
    const chat = useChatState(messages, taskId)
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
        scroll.replaceFoldExpansion(expansionState(rows, expansion))
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
export const RequestRounds: Story = {
    name: "2 · Fold activity within each request round",
    args: { initialLevel: "round" },
}
export const MessageSegments: Story = { name: "3 · Fold activity between messages", args: { initialLevel: "message_segment" } }
export const WholeTurn: Story = { name: "4 · Fold the whole turn into one block", args: { initialLevel: "user_turn" } }
export const FailedWork: Story = {
    name: "5 · Failed edits, commands and subagents are counted",
    args: { initialLevel: "user_turn", turnCount: 2, withFailures: true },
}
