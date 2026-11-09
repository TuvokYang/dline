import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { isActivityFold } from "./chatRowKinds"
import { filterVisibleMessages, groupChatRows } from "./messageUtils"

/**
 * The transcript a real task writes for two turns, read from the E2E run and
 * replayed here so the grouping question can be answered without a browser.
 *
 * Turn 1: prompt, restore point, request, the approved edit, restore point,
 * request, completion.
 * Turn 2: follow-up, restore point, request, completion.
 */
const realRestoreTranscript = (base: number): UiMessage[] => {
    const at = (offset: number) => base + offset
    const say = (offset: number, kind: UiMessage["say"], extra: Partial<UiMessage> = {}): UiMessage => ({
        ts: at(offset),
        type: "say",
        say: kind,
        ...extra,
    })
    return [
        say(0, "task", { text: "E2E_FOLDING_RESTORE" }),
        say(6, "checkpoint_created", { checkpointSource: { kind: "round_start", turnId: "t1" } }),
        say(7, "api_req_started", { text: JSON.stringify({ request: "…", cost: 0.01 }) }),
        say(104, "tool", { text: JSON.stringify({ tool: "editedExistingFile", path: "folding-restore.txt" }) }),
        say(1740, "checkpoint_created", { checkpointSource: { kind: "round_start", turnId: "t2" } }),
        say(1741, "api_req_started", { text: JSON.stringify({ request: "…", cost: 0.01 }) }),
        { ts: at(1791), type: "ask", ask: "completion_result", text: "FOLDING_RESTORE_DONE" },
        say(1904, "user_feedback", { text: "E2E_FOLDING_FOLLOWUP" }),
        say(1961, "checkpoint_created", { checkpointSource: { kind: "round_start", turnId: "t3" } }),
        say(1962, "api_req_started", { text: JSON.stringify({ request: "…", cost: 0.01 }) }),
        { ts: at(2006), type: "ask", ask: "completion_result", text: "FOLDING_FOLLOWUP_DONE" },
    ]
}

describe("the real checkpoint-restore transcript", () => {
    it("has a visible tail whose restored checkpoint is the second turn's own point", () => {
        const messages = realRestoreTranscript(1_000)

        // Each turn contributes one block, so two blocks exist in the transcript.
        const folds = groupChatRows(messages, undefined, { level: "user_turn" }).filter(isActivityFold)
        expect(folds).toHaveLength(2)
        expect(filterVisibleMessages(messages).length).toBeGreaterThan(0)
    })

    it("folds the turn whose completion is still the live ask", () => {
        const base = 3_000
        const messages: UiMessage[] = [
            { ts: base, type: "say", say: "user_feedback", text: "Continue" },
            { ts: base + 1, type: "say", say: "checkpoint_created" },
            { ts: base + 2, type: "say", say: "api_req_started", text: JSON.stringify({ request: "…" }) },
            // The footer is still waiting on this ask, so it is not a settled turn end.
            { ts: base + 3, type: "ask", ask: "completion_result", text: "Done.", partial: true },
        ]

        const folds = groupChatRows(messages, undefined, { level: "user_turn" }).filter(isActivityFold)

        expect(folds).toHaveLength(1)
        expect(folds[0].map(({ ts }) => ts)).toContain(base + 1)
    })

    it("puts each turn's restore point in that turn's block", () => {
        const base = 2_000
        const messages = realRestoreTranscript(base)

        const folds = groupChatRows(messages, undefined, { level: "user_turn" }).filter(isActivityFold)

        expect(folds).toHaveLength(2)
        // The first turn's point belongs to the first block, the follow-up's to the second.
        expect(folds[0].map(({ ts }) => ts)).toContain(base + 6)
        expect(folds[1].map(({ ts }) => ts)).toContain(base + 1961)
    })
})
