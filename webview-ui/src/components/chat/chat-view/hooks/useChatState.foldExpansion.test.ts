import type { UiMessage } from "@shared/ExtensionMessage"
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { finishedTurnTranscript, restorePoint } from "../components/messages/activityFoldStoryFixtures"
import { type ActivityFold, isActivityFold } from "../utils/chatRowKinds"
import { groupChatRows } from "../utils/messageUtils"
import { getBottomFollowIntent } from "../utils/messageWindowUtils"
import { useChatState } from "./useChatState"
import { useScrollBehavior } from "./useScrollBehavior"

function turnFold(messages: UiMessage[]): ActivityFold {
    const fold = groupChatRows(messages, undefined, { level: "turn" }).find(isActivityFold)
    if (!fold) throw new Error("expected the transcript to fold one turn")
    return fold
}

/** The chat's two owners of expansion, wired the way ChatView wires them. */
function useExpansion({ messages, taskId }: { messages: UiMessage[]; taskId: string }) {
    const chat = useChatState(messages, taskId)
    const scroll = useScrollBehavior(messages, messages, messages, chat.expandedRows, chat.setExpandedRows, chat.setExpandedFolds)
    return { chat, scroll }
}

function renderExpansion() {
    return renderHook(useExpansion, { initialProps: { messages: finishedTurnTranscript, taskId: "task-1" } })
}

describe("fold expansion state", () => {
    it("toggles only the fold's entry and leaves row expansion untouched", () => {
        const fold = turnFold(finishedTurnTranscript)
        const { result } = renderExpansion()
        const rowsBefore = result.current.chat.expandedRows

        act(() => result.current.scroll.toggleFoldExpansion(fold._activityFoldId))

        expect(result.current.chat.expandedFolds).toEqual({ [fold._activityFoldId]: true })
        expect(result.current.chat.expandedRows).toBe(rowsBefore)
    })

    it("keeps a fold and its first member in separate key spaces", () => {
        const fold = turnFold(finishedTurnTranscript)
        const firstMemberTs = fold[0].ts
        const { result } = renderExpansion()

        act(() => result.current.scroll.toggleRowExpansion(firstMemberTs))

        expect(result.current.chat.expandedRows).toEqual({ [firstMemberTs]: true })
        expect(result.current.chat.expandedFolds).toEqual({})
    })

    it("stops the list following new output once a reader opens a fold at the bottom", () => {
        const fold = turnFold(finishedTurnTranscript)
        const { result } = renderExpansion()
        // The decision MessagesArea makes when the tail grows while the bottom is loaded.
        const followOnNewOutput = () =>
            getBottomFollowIntent({
                disableAutoScroll: result.current.scroll.disableAutoScrollRef.current,
                absoluteBottomLoaded: true,
                lastMessageTsChanged: true,
                lastMessageContentChanged: false,
            })
        expect(followOnNewOutput()).toBe("follow")

        act(() => result.current.scroll.toggleFoldExpansion(fold._activityFoldId))

        expect(followOnNewOutput()).toBe("none")
    })

    it("keeps a fold open while later rows arrive", () => {
        const fold = turnFold(finishedTurnTranscript)
        const { result, rerender } = renderExpansion()
        act(() => result.current.scroll.toggleFoldExpansion(fold._activityFoldId))

        const grown = [...finishedTurnTranscript, restorePoint(60, "files-1")]
        rerender({ messages: grown, taskId: "task-1" })

        // The fold keeps the id of its first member, so the stored flag still applies.
        expect(turnFold(grown)._activityFoldId).toBe(fold._activityFoldId)
        expect(result.current.chat.expandedFolds[fold._activityFoldId]).toBe(true)
    })

    it("forgets open folds when another task is shown", () => {
        const fold = turnFold(finishedTurnTranscript)
        const { result, rerender } = renderExpansion()
        act(() => result.current.scroll.toggleFoldExpansion(fold._activityFoldId))

        rerender({ messages: finishedTurnTranscript, taskId: "task-2" })

        expect(result.current.chat.expandedFolds).toEqual({})
    })
})
