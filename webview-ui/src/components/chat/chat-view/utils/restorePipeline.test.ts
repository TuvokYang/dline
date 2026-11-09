import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { isActivityFold } from "./chatRowKinds"
import { filterVisibleMessages, groupChatRows, processMessages } from "./messageUtils"

/**
 * The transcript a real two-turn restore task writes.
 *
 * Turn 1: prompt, restore point, request, the approved edit, restore point,
 * request, completion.
 * Turn 2: follow-up, restore point, request, completion.
 *
 * The chat does not group the stored list directly: it runs the same combine
 * steps the chat view runs, then filters what is drawn.
 */
const storedRestoreTranscript = (base: number): UiMessage[] => {
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

describe("the chat's own pipeline over a two-turn restore task", () => {
    it("folds each turn, including the follow-up whose only work is its restore point", () => {
        const stored = storedRestoreTranscript(1_000)
        const modified = processMessages(stored)
        const visible = filterVisibleMessages(modified)

        const folds = groupChatRows(modified, visible, { level: "user_turn" }).filter(isActivityFold)

        expect(folds).toHaveLength(2)
    })
})
