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
    it("draws no fold while the rollout flag is off, whatever level is stored", () => {
        const { result } = renderRows({ user: "turn", featureFlag: false })

        expect(result.current.some(isActivityFold)).toBe(false)
    })

    it("folds the finished turn when the flag is on and the level is turn", () => {
        const { result } = renderRows({ user: "turn", featureFlag: true })

        expect(result.current.filter(isActivityFold)).toHaveLength(1)
        // Only the user message, the fold and the turn end remain.
        expect(result.current).toHaveLength(3)
    })

    it("draws the standard level row for row like the flag being off", () => {
        const standard = renderRows({ user: "standard", featureFlag: true }).result.current
        const flagOff = renderRows({ user: "turn", featureFlag: false }).result.current
        const noSetting = renderRows(undefined).result.current

        expect(layout(standard)).toEqual(layout(flagOff))
        expect(layout(noSetting)).toEqual(layout(flagOff))
    })

    it("leaves no fold behind after switching back to standard", () => {
        const { result, rerender } = renderRows({ user: "turn", featureFlag: true })
        expect(result.current.some(isActivityFold)).toBe(true)

        rerender({ setting: { user: "standard", featureFlag: true }, activeAskTs: undefined })

        expect(result.current.some(isActivityFold)).toBe(false)
    })

    it("keeps the ask the footer is answering out of every fold", () => {
        const { result } = renderRows({ user: "turn", featureFlag: true }, COMMAND_TS)

        expect(topLevelTimestamps(result.current)).toContain(COMMAND_TS)
        for (const fold of result.current.filter(isActivityFold)) {
            expect(fold.map((message) => message.ts)).not.toContain(COMMAND_TS)
        }
    })
})
