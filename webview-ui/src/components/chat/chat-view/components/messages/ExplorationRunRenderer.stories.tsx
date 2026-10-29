import type { UiMessage } from "@shared/ExtensionMessage"
import type { Meta, StoryObj } from "@storybook/react-vite"
import { useState } from "react"
import { isExplorationRun } from "../../utils/chatRowKinds"
import { groupChatRows } from "../../utils/messageUtils"
import { ExplorationRunRenderer } from "./ExplorationRunRenderer"

const request = (ts: number): UiMessage => ({ ts, type: "say", say: "api_req_started", text: JSON.stringify({ cost: 0.01 }) })
const checkpoint = (ts: number): UiMessage => ({
    ts,
    type: "say",
    say: "checkpoint_created",
    lastCheckpointHash: ["files-1"],
    checkpointSource: { kind: "round_start", turnId: `turn-${ts}` },
})
const reasoning = (ts: number, text: string): UiMessage => ({ ts, type: "say", say: "reasoning", text })
const tool = (ts: number, payload: Record<string, unknown>): UiMessage => ({
    ts,
    type: "say",
    say: "tool",
    text: JSON.stringify(payload),
})

/** Four read-only rounds: thinking, then reads, a listing, a search and a reference lookup. */
const transcript: UiMessage[] = [
    checkpoint(10),
    request(11),
    reasoning(12, "Start from the task runtime entry point to see where retries are decided."),
    tool(13, { tool: "readFile", path: "src/core/task/index.ts", readLineStart: 1, readLineEnd: 220 }),
    tool(14, { tool: "listFilesTopLevel", path: "src/core/task/runtime" }),
    checkpoint(20),
    request(21),
    reasoning(22, "The reducer owns the transition; check which events reach it."),
    tool(23, { tool: "readFile", path: "src/core/task/runtime/TaskReducer.ts" }),
    tool(24, { tool: "searchFiles", path: "src/core/task", regex: "retry|resume", filePattern: "*.ts", count: 48, files: 9 }),
    checkpoint(30),
    request(31),
    reasoning(32, "Find every caller of the retry policy before changing it."),
    tool(33, {
        tool: "findReferences",
        path: "src/core/task/auto-retry.ts",
        symbolName: "isRetryableProviderError",
        count: 6,
        files: 3,
    }),
    checkpoint(40),
    request(41),
    reasoning(42, "One more look at the interaction coordinator."),
    tool(43, {
        tool: "readFile",
        path: "src/core/task/interaction/InteractionCoordinator.ts",
        readLineStart: 80,
        readLineEnd: 160,
    }),
]

const run = groupChatRows(transcript).find(isExplorationRun)

/** Owns expansion the way the chat list does: one flag per message timestamp. */
function ExplorationRunFixture() {
    const [expandedRows, setExpandedRows] = useState<Record<number, boolean>>({})
    if (!run) return <div>The transcript did not fold into an exploration run.</div>
    return (
        <div style={{ width: "100%", maxWidth: 520, paddingTop: 16 }}>
            <ExplorationRunRenderer
                allMessages={transcript}
                expandedRows={expandedRows}
                isLastActivity={false}
                isLastRow={false}
                onToggleExpand={(ts) => setExpandedRows((rows) => ({ ...rows, [ts]: !rows[ts] }))}
                run={run}
            />
        </div>
    )
}

const meta = {
    title: "Chat/Exploration Run",
    component: ExplorationRunFixture,
    parameters: { layout: "fullscreen" },
} satisfies Meta<typeof ExplorationRunFixture>

export default meta
type Story = StoryObj<typeof meta>
/** Collapsed: the first restore point, the summary, then every round's calls. Click the summary to see each round. */
export const Collapsed: Story = {}
