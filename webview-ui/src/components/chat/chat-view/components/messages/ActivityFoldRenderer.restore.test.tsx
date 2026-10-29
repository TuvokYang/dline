import type { UiMessage } from "@shared/ExtensionMessage"
import { render } from "@testing-library/react"
import React from "react"
import { describe, expect, it, vi } from "vitest"
import { activeTurnAnchor } from "@/components/chat/trajectory/useActiveTurn"
import type { MessageHandlers } from "../../types/chatTypes"
import { isActivityFold } from "../../utils/chatRowKinds"
import { groupChatRows } from "../../utils/messageUtils"
import { rowIdentity } from "../../utils/rowCoordinate"
import { ROW_TS_ATTRIBUTE } from "../../utils/viewportRowAnchor"
import {
    checkOutFileTree,
    discardedRequests,
    multiTurnTranscript,
    twoTurnTranscript,
    userFeedback,
} from "./activityFoldStoryFixtures"
import { createMessageRenderer, rowTs } from "./MessageRenderer"

void React

vi.mock("@/context/ExtensionStateContext", () => ({
    useExtensionState: () => ({ mode: "act" }),
}))

vi.mock("@/components/chat/ChatRow", () => ({
    default: ({ message }: { message: UiMessage }) => <div data-chat-row-ts={message.ts} />,
}))

vi.mock("./CheckpointMarker", () => ({
    CheckpointMarker: ({ message }: { message: UiMessage }) => <div data-testid="checkpoint" data-ts={message.ts} />,
}))

vi.mock("@/services/grpc-client", () => ({ FileServiceClient: { openFileRelativePath: vi.fn(() => Promise.resolve()) } }))

type ChatRow = UiMessage | UiMessage[]

const messageHandlers: MessageHandlers = {
    handleSendMessage: vi.fn(async () => undefined),
    handleTaskCloseButtonClick: vi.fn(),
    startNewTask: vi.fn(async () => undefined),
}

/** User rows of the multi-turn transcript: the trajectory's turn anchors. */
const USER_ANCHORS = [1, 70, 90]

const DISCARDED_REQUESTS_TS = 100
const EDITED_FEEDBACK_TS = 101

/**
 * The rows of the task the extension reopens after a chat restore.
 *
 * The chat keeps the rows through `keepThroughTs` (the boundary's
 * `uiKeepCount`), records the discarded requests and, for an edit, says the
 * edited text again as new feedback. Checkout markers move only when the
 * workspace is restored too. The reopened task is a new opening, so the webview
 * shows its rows instead of merging them into the window it held.
 */
function reopenedAfterChatRestore(durable: UiMessage[], keepThroughTs: number, editedText?: string): UiMessage[] {
    const kept = durable.slice(0, durable.findIndex((message) => message.ts === keepThroughTs) + 1)
    const edited = editedText === undefined ? [] : [userFeedback(EDITED_FEEDBACK_TS, editedText)]
    return [...kept, discardedRequests(DISCARDED_REQUESTS_TS), ...edited]
}

interface FoldShape {
    id: string
    members: number[]
}

function turnRows(messages: UiMessage[]): ChatRow[] {
    return groupChatRows(messages, undefined, { level: "turn" })
}

const foldsOf = (rows: ChatRow[]): FoldShape[] =>
    rows.filter(isActivityFold).map((fold) => ({ id: fold._activityFoldId, members: fold.map((message) => message.ts) }))
const unfoldedRowTs = (rows: ChatRow[]) => rows.filter((row) => !isActivityFold(row)).map((row) => rowTs(row))

function renderRows(messages: UiMessage[], expandedFolds: Record<string, boolean>) {
    const rows = turnRows(messages)
    const renderRow = createMessageRenderer(
        rows,
        messages,
        {},
        vi.fn(),
        vi.fn(),
        vi.fn(),
        vi.fn(),
        vi.fn(async () => undefined),
        messageHandlers,
        false,
        { expanded: expandedFolds, toggle: vi.fn() },
    )
    const view = render(
        <div data-testid="list">
            {rows.map((row, index) => (
                <React.Fragment key={rowIdentity(row)}>{renderRow(index, row)}</React.Fragment>
            ))}
        </div>,
    )
    return { rows, ...view }
}

const drawnMessageTimestamps = (root: ParentNode | null) =>
    Array.from(root?.querySelectorAll<HTMLElement>("[data-message-ts]") ?? []).map((element) => Number(element.dataset.messageTs))
const openFoldChildren = (container: HTMLElement, foldId: string) =>
    container.querySelector(`[data-fold-id="${foldId}"] [data-testid="activity-fold-children"]`)

describe("activity folds across a checkpoint restore", () => {
    it("folds each finished turn before any restore", () => {
        const rows = turnRows(twoTurnTranscript)

        expect(foldsOf(rows)).toEqual([
            { id: "fold:10", members: [10, 12, 20, 22, 30, 32, 33] },
            { id: "fold:41", members: [41, 43] },
        ])
        expect(unfoldedRowTs(rows)).toEqual([1, 35, 40, 45])
    })

    it("splits a fold at the restore point a workspace restore checks out", () => {
        // A workspace restore rewinds the files only: the chat keeps its rows and every marker is recomputed.
        const restored = checkOutFileTree(twoTurnTranscript, "tree-b")
        // The same opening keeps its expansion; MessagesArea.test covers that ownership.
        const { container, rows } = renderRows(restored, { "fold:10": true })

        expect(foldsOf(rows)).toEqual([
            { id: "fold:10", members: [10, 12] },
            { id: "fold:22", members: [22, 30, 32, 33] },
            { id: "fold:41", members: [41, 43] },
        ])
        expect(unfoldedRowTs(rows)).toEqual([1, 20, 35, 40, 45])
        expect(drawnMessageTimestamps(openFoldChildren(container, "fold:10"))).toEqual([10, 12])
        // The activity level cuts at the same restore point.
        expect(foldsOf(groupChatRows(restored, undefined, { level: "activity" })).map(({ id }) => id)).toEqual([
            "fold:10",
            "fold:22",
            "fold:41",
        ])
    })

    it("rebuilds the folds of the reopened task after an edit, leaving the checkout where it was", () => {
        // An earlier workspace restore left restore point 20 checked out.
        const held = checkOutFileTree(twoTurnTranscript, "tree-b")
        // The message editor restores the task only, one row before the edited feedback.
        const reopened = reopenedAfterChatRestore(held, 35, "Split the lexer and its tokens.")

        expect(reopened.map(({ ts }) => ts)).toEqual([
            1,
            10,
            11,
            12,
            20,
            21,
            22,
            30,
            31,
            32,
            33,
            34,
            35,
            DISCARDED_REQUESTS_TS,
            EDITED_FEEDBACK_TS,
        ])
        const { container, rows } = renderRows(reopened, {})

        expect(foldsOf(rows)).toEqual([
            { id: "fold:10", members: [10, 12] },
            { id: "fold:22", members: [22, 30, 32, 33] },
        ])
        // The edited feedback opens a turn that has not ended, so it stays
        // outside every fold; the discarded-request bookkeeping is never drawn.
        expect(unfoldedRowTs(rows)).toEqual([1, 20, 35, EDITED_FEEDBACK_TS])
        expect(drawnMessageTimestamps(container)).not.toContain(DISCARDED_REQUESTS_TS)
    })

    it("unfolds a kept turn that a task and workspace restore cut before its end", () => {
        // Restoring restore point 30 keeps it, drops the rest of turn 1 with its
        // end and checks it out. Rows 10, 12, 20 and 22 stay behind it: enough to
        // fold, with no checked-out restore point among them, so only the lost end
        // keeps them unfolded.
        const reopened = checkOutFileTree(reopenedAfterChatRestore(twoTurnTranscript, 30), "tree-c")
        expect(reopened.map(({ ts }) => ts)).toEqual([1, 10, 11, 12, 20, 21, 22, 30, DISCARDED_REQUESTS_TS])
        expect(reopened.filter(({ isCheckpointCheckedOut }) => isCheckpointCheckedOut).map(({ ts }) => ts)).toEqual([30])

        const { container, rows } = renderRows(reopened, {})

        expect(foldsOf(rows)).toEqual([])
        expect(unfoldedRowTs(rows)).toEqual([1, 10, 12, 20, 22, 30])
        expect(drawnMessageTimestamps(container)).toEqual([1, 10, 12, 20, 22, 30])
    })
})

describe("trajectory turns over activity folds", () => {
    /** The turn each fold of the multi-turn transcript belongs to, listed by hand. */
    const TURN_OF_FOLD: Record<string, number> = {
        "fold:10": 1,
        "fold:60": 1,
        "fold:71": 70,
    }

    it("draws every loaded user anchor as a row of its own", () => {
        const { container } = renderRows(multiTurnTranscript, {})

        for (const anchor of USER_ANCHORS) {
            const row = container.querySelector(`[${ROW_TS_ATTRIBUTE}="${anchor}"]`)
            expect(row).not.toBeNull()
            expect(row?.querySelector(`[data-message-ts="${anchor}"]`) ?? null).not.toBeNull()
            // A row of its own: no fold holds it.
            expect(row?.closest("[data-fold-id]") ?? null).toBeNull()
            expect(row?.querySelector("[data-fold-id]") ?? null).toBeNull()
        }
    })

    it("marks the turn that holds a fold when the fold is the top visible row", () => {
        const { container } = renderRows(multiTurnTranscript, {})

        const folds = Array.from(container.querySelectorAll<HTMLElement>("[data-fold-id]"))
        expect(folds.map((fold) => fold.dataset.foldId)).toEqual(Object.keys(TURN_OF_FOLD))
        for (const fold of folds) {
            // The rail reads the top visible row's ts from its row wrapper, as for every other row.
            const topVisibleTs = Number(fold.closest<HTMLElement>(`[${ROW_TS_ATTRIBUTE}]`)?.getAttribute(ROW_TS_ATTRIBUTE))
            expect(activeTurnAnchor(USER_ANCHORS, topVisibleTs)).toBe(TURN_OF_FOLD[fold.dataset.foldId ?? ""])
        }
    })
})
