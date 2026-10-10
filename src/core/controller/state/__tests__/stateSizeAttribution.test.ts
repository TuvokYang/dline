import { describe, expect, it } from "vitest"
import { type HistoryItem, MAX_HISTORY_TASK_TEXT_LENGTH } from "@/shared/HistoryItem"
import { formatStateSizeBreakdown, measureStateFieldSizes } from "../stateSizeProbe"

/**
 * Reproduces the field-level attribution of the ~12.5 MB state pushes seen in
 * the field logs, so the fix targets the field that actually carries the bytes.
 *
 * The decisive evidence from those logs is that three *different* tasks pushed
 * 13126230, 13126516 and 13429378 bytes. Per-task fields cannot explain sizes
 * that close together, so the dominant field must be one shared by every task.
 * `taskHistory` is the only shared field that is unbounded in bytes: it is read
 * from one global key, and its `slice(0, 100)` caps the entry *count* while
 * each entry embeds `HistoryItem.task`, the verbatim task text.
 */

/** Mirrors `buildState()`: newest first, capped at 100 entries, no size cap. */
const TASK_HISTORY_ENTRY_LIMIT = 100

function buildHistoryItem(id: number, taskTextBytes: number): HistoryItem {
    return {
        id: `task-${id}`,
        ts: 1_700_000_000_000 + id,
        task: "x".repeat(taskTextBytes),
        tokensIn: 1000,
        tokensOut: 2000,
        totalCost: 0.42,
    }
}

/** Only the fields needed for attribution; buildState() has many more. */
function buildStateSnapshot(taskHistory: HistoryItem[], perTaskBytes: number) {
    return {
        version: "1.0.0",
        taskHistory,
        focusChainHistory: "f".repeat(perTaskBytes),
        currentFocusChainChecklist: "c".repeat(perTaskBytes),
        platform: "win32",
        mode: "act",
    }
}

function measure(state: object) {
    const totalBytes = Buffer.byteLength(JSON.stringify(state), "utf8")
    return measureStateFieldSizes(state, totalBytes)
}

describe("oversized state attribution", () => {
    it("reaches the observed ~12.5 MB scale from taskHistory alone", () => {
        // 100 entries x ~128 KB of verbatim task text is an ordinary long-running
        // history, and it alone exceeds the size seen in the field logs.
        const history = Array.from({ length: TASK_HISTORY_ENTRY_LIMIT }, (_, index) => buildHistoryItem(index, 128 * 1024))
        const breakdown = measure(buildStateSnapshot(history, 1024))

        expect(breakdown.fields[0].field).toBe("taskHistory")
        expect(breakdown.totalBytes).toBeGreaterThan(12_000_000)
    })

    it("keeps the shared field dominant no matter which task is pushing", () => {
        // Two different tasks: identical shared history, different per-task data.
        const history = Array.from({ length: TASK_HISTORY_ENTRY_LIMIT }, (_, index) => buildHistoryItem(index, 128 * 1024))
        const taskA = measure(buildStateSnapshot(history, 1024))
        const taskB = measure(buildStateSnapshot(history, 300 * 1024))

        expect(taskA.fields[0].field).toBe("taskHistory")
        expect(taskB.fields[0].field).toBe("taskHistory")
        // This is the signature the field logs showed: totals that stay within a
        // few hundred KB of each other across unrelated tasks.
        expect(taskB.totalBytes - taskA.totalBytes).toBeLessThan(1_000_000)
    })

    it("cannot reach that scale from per-task fields once history is bounded", () => {
        // Same per-task payloads, but with each history entry summarized to the
        // history label length now applied when an entry is written.
        const summarized = Array.from({ length: TASK_HISTORY_ENTRY_LIMIT }, (_, index) =>
            buildHistoryItem(index, MAX_HISTORY_TASK_TEXT_LENGTH),
        )
        const breakdown = measure(buildStateSnapshot(summarized, 1024))

        expect(breakdown.totalBytes).toBeLessThan(1_000_000)
    })

    it("names the dominant field in the log line the probe emits", () => {
        const history = Array.from({ length: TASK_HISTORY_ENTRY_LIMIT }, (_, index) => buildHistoryItem(index, 128 * 1024))
        const line = formatStateSizeBreakdown(measure(buildStateSnapshot(history, 1024)))

        expect(line).toMatch(/^totalBytes=\d+ taskHistory=\d+/)
    })
})
