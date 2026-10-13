import type { UiMessage } from "@shared/ExtensionMessage"
import { act, renderHook } from "@testing-library/react"
import { describe, expect, it, vi } from "vitest"

import { useScrollBehavior } from "./useScrollBehavior"

/**
 * Who expanded a row decides whether auto-follow is given up.
 *
 * A reopened task can still show a command from the old session as running;
 * the row expands itself after 500 ms. Treating that as the reader's expand
 * switched auto-follow off, and the list stayed above the bottom (BUGFIX-178).
 */

const COMMAND: UiMessage = { ts: 10, type: "say", say: "command", text: "npm run dev", commandStatus: "running" }
const MESSAGES: UiMessage[] = [{ ts: 1, type: "say", say: "task", text: "task" }, COMMAND]

function renderScrollBehavior() {
    const setExpandedRows = vi.fn()
    return renderHook(() => useScrollBehavior(MESSAGES, MESSAGES, MESSAGES, {}, setExpandedRows))
}

describe("useScrollBehavior row expansion ownership", () => {
    it("keeps auto-follow when a row expands itself", () => {
        const { result } = renderScrollBehavior()

        act(() => {
            result.current.toggleRowExpansion(COMMAND.ts, "auto")
        })

        expect(result.current.disableAutoScrollRef.current).toBe(false)
    })

    it("gives the viewport to a reader who expands a row", () => {
        const { result } = renderScrollBehavior()

        act(() => {
            result.current.toggleRowExpansion(COMMAND.ts)
        })

        expect(result.current.disableAutoScrollRef.current).toBe(true)
    })
})
