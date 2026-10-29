import type { AggressiveRenderingLevel } from "@shared/AggressiveRendering"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { useMemo, useState } from "react"
import type { MessageHandlers } from "../../types/chatTypes"
import { groupChatRows } from "../../utils/messageUtils"
import { rowIdentity } from "../../utils/rowCoordinate"
import { multiTurnTranscript } from "./activityFoldStoryFixtures"
import { createMessageRenderer } from "./MessageRenderer"

const messageHandlers: MessageHandlers = {
    handleSendMessage: async () => undefined,
    handleTaskCloseButtonClick: async () => undefined,
    startNewTask: async () => undefined,
}

const ignore = () => undefined

/**
 * Draws one conversation at a folding level, owning row and fold expansion the
 * way the chat list does: rows by message timestamp, folds by fold id.
 */
function FoldingFixture({ level }: { level: AggressiveRenderingLevel }) {
    const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({})
    const [expandedFolds, setExpandedFolds] = useState<Record<string, boolean>>({})
    const rows = useMemo(() => groupChatRows(multiTurnTranscript, undefined, { level }), [level])
    const renderRow = createMessageRenderer(
        rows,
        multiTurnTranscript,
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
        <div style={{ width: "100%", maxWidth: 560, paddingTop: 16 }}>
            {rows.map((row, index) => (
                <div key={rowIdentity(row)}>{renderRow(index, row)}</div>
            ))}
        </div>
    )
}

const meta = {
    title: "Chat/Activity Folding",
    component: FoldingFixture,
    parameters: { layout: "fullscreen" },
    args: { level: "standard" },
} satisfies Meta<typeof FoldingFixture>

export default meta
type Story = StoryObj<typeof meta>

/**
 * Today's rendering. Three turns: the first holds an exploration run, a tool group,
 * a command, edits and a failed lint run; the second a working_respond update and a
 * checked-out restore point; the third is still streaming.
 */
export const Standard: Story = { args: { level: "standard" } }

/**
 * Runs of tool activity fold; assistant messages, the failed run, the checked-out
 * restore point and the turn ends stay visible. The streaming turn does not fold.
 */
export const Activity: Story = { args: { level: "activity" } }

/**
 * Everything between a user message and its turn end folds, except the failed run
 * and the checked-out restore point. Click a block to expand it; nested groups
 * expand on their own.
 */
export const Turn: Story = { args: { level: "turn" } }
