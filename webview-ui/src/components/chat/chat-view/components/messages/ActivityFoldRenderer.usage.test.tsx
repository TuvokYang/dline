import { summarizeRoundsUsage } from "@shared/chat/foldUsage"
import type { UiMessage } from "@shared/ExtensionMessage"
import { fireEvent, render, screen } from "@testing-library/react"
import { useState } from "react"
import { describe, expect, it, vi } from "vitest"
import { isActivityFold } from "../../utils/chatRowKinds"
import { groupChatRows, indexRequestRounds } from "../../utils/messageUtils"
import { createFoldRoundUsage } from "../layout/foldingTrajectoryUsageFixture"
import { ActivityFoldRenderer } from "./ActivityFoldRenderer"
import {
    completion,
    failedCommand,
    finishedCommand,
    finishedRequest,
    finishedTurnTranscript,
    userTask,
} from "./activityFoldStoryFixtures"

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({ mode: "act", onRelinquishControl: () => () => undefined }),
}))

vi.mock("@/components/chat/ChatRow", () => ({
    default: ({ message }: { message: UiMessage }) => <div data-chat-row-ts={message.ts} />,
}))

vi.mock("@/components/chat/BrowserSessionRow", () => ({
    default: ({ messages }: { messages: UiMessage[] }) => <div data-browser-session={messages[0]?.ts} />,
}))

vi.mock("@/components/chat/CheckpointMarker", () => ({
    CheckpointMarker: ({ message }: { message: UiMessage }) => <div data-testid="checkpoint" data-ts={message.ts} />,
}))

vi.mock("@/services/grpc-client", () => ({ FileServiceClient: { openFileRelativePath: vi.fn(() => Promise.resolve()) } }))

/** The first fold of the finished-turn transcript, drawn with chat-owned expansion. */
function Harness() {
    const [expanded, setExpanded] = useState(false)
    const roundUsage = createFoldRoundUsage(finishedTurnTranscript)
    const fold = groupChatRows(finishedTurnTranscript, undefined, { level: "user_turn", roundUsage }).find(isActivityFold)
    if (!fold) throw new Error("the fixture produces a block")

    return (
        <ActivityFoldRenderer
            checkpointAttachments={new Map()}
            expanded={expanded}
            expandedRows={{}}
            fold={fold}
            footerActive={false}
            modifiedMessages={finishedTurnTranscript}
            onAddToInput={() => undefined}
            onFollowupOptionSelect={async () => undefined}
            onHeightChange={() => undefined}
            onSetQuote={() => undefined}
            onToggleExpand={() => undefined}
            onToggleFold={() => setExpanded((current) => !current)}
        />
    )
}

const usageLine = () => screen.queryByTestId("activity-fold-usage")
const header = () => screen.getByTestId("activity-fold-header")

/** A block whose only failed work item is one command, so the header states one error. */
function failedHarness() {
    const transcript = [
        userTask(1, "Run the checks"),
        finishedRequest(2),
        finishedCommand(3, "npm run lint"),
        failedCommand(4, "npm run test", 2),
        completion(5, "Checks finished."),
    ]
    const fold = groupChatRows(transcript, undefined, { level: "user_turn" }).find(isActivityFold)
    if (!fold) throw new Error("the fixture produces a block")
    return fold
}

describe("a folded block states what it cost", () => {
    it("shows the cost line while closed", () => {
        render(<Harness />)
        expect(usageLine()).not.toBeNull()
        // Time, tokens and the average rate, all from the block's own rounds.
        expect(usageLine()?.textContent).toMatch(/\d+(\.\d+)?s/)
        expect(usageLine()?.textContent).toContain(" in / ")
        expect(usageLine()?.textContent).toContain("tok/s")
    })

    it("keeps the cost line while the block is open", () => {
        render(<Harness />)
        fireEvent.click(header())
        expect(screen.getByTestId("activity-fold-children")).toBeInTheDocument()
        expect(usageLine()?.textContent).toContain("tok/s")
    })

    it("keeps the cost line when the same header closes it again", () => {
        render(<Harness />)
        fireEvent.click(header())
        fireEvent.click(header())
        expect(usageLine()).not.toBeNull()
        expect(screen.queryByTestId("activity-fold-children")).toBeNull()
    })

    it("states figures the block's own rounds support", () => {
        const roundUsage = createFoldRoundUsage(finishedTurnTranscript)
        const rounds = indexRequestRounds(finishedTurnTranscript)
        const fold = groupChatRows(finishedTurnTranscript, undefined, { level: "user_turn", roundUsage }).find(isActivityFold)
        if (!fold?._usage) throw new Error("expected usage on the block")

        // Derive the expectation from the block's members independently of the
        // implementation: the rounds they belong to, looked up in the same fixture.
        const providerRounds = [...new Set(rounds.values())].filter((round) => round > 0).sort((left, right) => left - right)
        const byRound = new Map(providerRounds.map((round, position) => [round, roundUsage[position]]))
        const memberRounds = new Set(
            fold
                .filter((member) => member.say !== "checkpoint_created")
                .map((member) => rounds.get(member.ts))
                .filter((round): round is number => round !== undefined),
        )
        const expected = summarizeRoundsUsage([...memberRounds].map((round) => byRound.get(round)).filter((r) => r !== undefined))
        expect(fold._usage).toEqual(expected)
    })

    it("keeps the figures in the wrapping line beside the summary instead of a separate block", () => {
        render(<Harness />)

        // The summary and the figures share one wrapping line so a wide chat puts
        // them side by side and a narrow one drops the figures below without
        // reserving a second row. A sibling block would always cost two rows.
        const line = usageLine()?.parentElement
        if (!line) throw new Error("expected the figures to sit inside the summary line")
        expect(line.contains(header().querySelector("span"))).toBe(true)
        expect(header().contains(usageLine())).toBe(true)
    })

    it("draws no cost line when the chat has no usage for the block", () => {
        const fold = groupChatRows(finishedTurnTranscript, undefined, { level: "user_turn" }).find(isActivityFold)
        if (!fold) throw new Error("the fixture produces a block")
        expect(fold._usage).toBeUndefined()
    })
})
