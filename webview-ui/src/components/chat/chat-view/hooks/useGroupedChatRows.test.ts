import type { AggressiveRenderingSetting } from "@shared/AggressiveRendering"
import { renderHook } from "@testing-library/react"
import { describe, expect, it } from "vitest"
import { finishedTurnTranscript } from "../components/messages/activityFoldStoryFixtures"
import { isActivityFold } from "../utils/chatRowKinds"
import { filterVisibleMessages } from "../utils/messageUtils"
import { rowIdentity } from "../utils/rowCoordinate"
import { useGroupedChatRows } from "./useGroupedChatRows"

const visible = filterVisibleMessages(finishedTurnTranscript)
/** The command row in the middle of the finished turn. */
const COMMAND_TS = 42

function renderRows(setting: AggressiveRenderingSetting | undefined, activeAskTs?: number) {
    return renderHook(({ setting, activeAskTs }) => useGroupedChatRows(finishedTurnTranscript, visible, setting, activeAskTs), {
        initialProps: { setting, activeAskTs },
    })
}

const layout = (rows: ReturnType<typeof useGroupedChatRows>) => rows.map(rowIdentity)
const topLevelTimestamps = (rows: ReturnType<typeof useGroupedChatRows>) =>
    rows.flatMap((row) => (Array.isArray(row) ? [] : [row.ts]))

describe("useGroupedChatRows", () => {
    it("draws Standard with the flag off, and folds the whole turn with it on", () => {
        const disabled = renderRows({ user: "user_turn", featureFlag: false }).result.current
        expect(disabled.some(isActivityFold)).toBe(false)
        const enabled = renderRows({ user: "user_turn", featureFlag: true }).result.current
        expect(layout(enabled)).toEqual(["1", "turn:10", "51"])
    })

    it("uses the same Standard baseline for none, flag-off and missing settings", () => {
        const standard = renderRows({ user: "none", featureFlag: true }).result.current
        expect(layout(renderRows({ user: "user_turn", featureFlag: false }).result.current)).toEqual(layout(standard))
        expect(layout(renderRows(undefined).result.current)).toEqual(layout(standard))
    })

    it("drops fold wrappers when switching back to none", () => {
        const { result, rerender } = renderRows({ user: "user_turn", featureFlag: true })
        expect(result.current.some(isActivityFold)).toBe(true)
        rerender({ setting: { user: "none", featureFlag: true }, activeAskTs: undefined })
        expect(result.current.some(isActivityFold)).toBe(false)
    })

    it("keeps the footer's ask visible", () => {
        const { result } = renderRows({ user: "user_turn", featureFlag: true }, COMMAND_TS)
        expect(topLevelTimestamps(result.current)).toContain(COMMAND_TS)
        for (const fold of result.current.filter(isActivityFold)) {
            expect(fold.map((message) => message.ts)).not.toContain(COMMAND_TS)
        }
    })

    it("keeps one row per block whether the block is open or closed", () => {
        // Expansion belongs to the renderer, which draws members beneath a header
        // that stays in place. If grouping reacted to it, the header — and the
        // control that closes the block — would leave the list.
        const { result } = renderRows({ user: "user_turn", featureFlag: true })
        expect(layout(result.current)).toEqual(["1", "turn:10", "51"])
        expect(result.current.filter(isActivityFold)).toHaveLength(1)
    })

    it("folds within one request round at the round level", () => {
        const rows = renderRows({ user: "round", featureFlag: true }).result.current
        const folds = rows.filter(isActivityFold)
        expect(folds.length).toBeGreaterThan(0)
        // A round-level block never holds two provider sends.
        for (const fold of folds) expect(fold._roundCount).toBeLessThanOrEqual(1)
    })
})
