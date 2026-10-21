import { describe, expect, it } from "vitest"
import {
    compareToolCandidates,
    EMPTY_EXECUTION_SUMMARY,
    MAX_TOOL_NAMES_PER_FACT,
    roleCarriesTodos,
    selectToolNames,
    sumOutcomeCounts,
    TODO_ROUND_BUCKETS,
    type ToolNameCandidate,
    todoRoundBucket,
    validateTaskAttempts,
    validateTodos,
    validateTools,
} from "../../contracts/usageExecution"
import { canonicalToolName, isCatalogToolName } from "../executionMetricsCatalog"

function candidate(toolName: string, completed: number, failed = 0, factKey = "fact-a"): ToolNameCandidate {
    return { factKey, toolName, completed, failed, cancelled: 0 }
}

describe("tool name counters", () => {
    it("accepts a by_name map whose outcomes plus the remainder equal the fact totals", () => {
        const violations = validateTools({
            completed: 5,
            failed: 2,
            cancelled: 1,
            by_name: {
                read_file: { completed: 3, failed: 0, cancelled: 0 },
                execute_command: { completed: 2, failed: 2, cancelled: 1 },
            },
            unlisted: { completed: 0, failed: 0, cancelled: 0 },
        })

        expect(violations).toEqual([])
    })

    it("reports conservation when a name is counted twice or missed", () => {
        const doubleCounted = validateTools({
            completed: 1,
            failed: 0,
            cancelled: 0,
            by_name: { read_file: { completed: 2, failed: 0, cancelled: 0 } },
        })
        const missed = validateTools({
            completed: 3,
            failed: 0,
            cancelled: 0,
            by_name: { read_file: { completed: 1, failed: 0, cancelled: 0 } },
        })

        expect(doubleCounted).toContain("tools_conservation")
        expect(missed).toContain("tools_conservation")
    })

    it("rejects a name that is not a wire identity and a map beyond the bound", () => {
        const nine = Object.fromEntries(
            Array.from({ length: MAX_TOOL_NAMES_PER_FACT + 1 }, (_, index) => [
                `tool-${index}`,
                { completed: 1, failed: 0, cancelled: 0 },
            ]),
        )
        const violations = validateTools({
            completed: 9,
            failed: 0,
            cancelled: 0,
            by_name: { "Read File": { completed: 1, failed: 0, cancelled: 0 }, ...nine },
        })

        expect(violations).toContain("tools_by_name_key")
        expect(violations).toContain("tools_by_name_limit")
    })

    it("does not treat a missing by_name as an error but refuses an unlisted-only claim", () => {
        expect(validateTools({ completed: 0, failed: 0, cancelled: 0 })).toEqual([])
        expect(
            validateTools({
                completed: 0,
                failed: 0,
                cancelled: 0,
                unlisted: { completed: 1, failed: 0, cancelled: 0 },
            }),
        ).toContain("tools_conservation")
    })

    it("keeps the busiest names and folds the rest into the remainder", () => {
        const candidates = [
            candidate("read_file", 1),
            candidate("execute_command", 9),
            candidate("apply_patch", 5),
            ...Array.from({ length: 6 }, (_, index) => candidate(`filler_${index}`, 0)),
        ]

        const { selected, unlisted } = selectToolNames(candidates, 3)

        // read_file is busier than every filler, so it wins the last slot.
        expect(selected.map((entry) => entry.toolName)).toEqual(["execute_command", "apply_patch", "read_file"])
        expect(unlisted).toHaveLength(6)
        expect(sumOutcomeCounts(unlisted)).toEqual({ completed: 0, failed: 0, cancelled: 0 })
    })

    it("folds a busy name that misses the bound, keeping its count in the remainder", () => {
        const candidates = [
            candidate("execute_command", 9),
            candidate("apply_patch", 5),
            candidate("read_file", 4),
            candidate("web_fetch", 3),
        ]

        const { selected, unlisted } = selectToolNames(candidates, 3)

        expect(selected.map((entry) => entry.toolName)).toEqual(["execute_command", "apply_patch", "read_file"])
        expect(sumOutcomeCounts(unlisted)).toEqual({ completed: 3, failed: 0, cancelled: 0 })
    })

    it("selects the same names regardless of insertion order", () => {
        const forward = [candidate("read_file", 2), candidate("apply_patch", 2), candidate("web_fetch", 2)]
        const backward = [...forward].reverse()

        expect(selectToolNames(forward, 2).selected.map((entry) => entry.toolName)).toEqual(
            selectToolNames(backward, 2).selected.map((entry) => entry.toolName),
        )
    })

    it("breaks a name tie with the fact key so two facts stay independent", () => {
        const first = candidate("read_file", 1, 0, "fact-a")
        const second = candidate("read_file", 1, 0, "fact-b")

        expect(compareToolCandidates(first, second)).toBeLessThan(0)
        expect(selectToolNames([first, second], 1).selected).toHaveLength(2)
    })

    it("applies the bound per fact rather than per batch", () => {
        const candidates = [
            candidate("read_file", 1, 0, "fact-a"),
            candidate("apply_patch", 1, 0, "fact-a"),
            candidate("web_fetch", 1, 0, "fact-b"),
            candidate("web_search", 1, 0, "fact-b"),
        ]

        expect(selectToolNames(candidates, 2).selected).toHaveLength(4)
        expect(selectToolNames(candidates, 2).unlisted).toEqual([])
    })
})

describe("todo efficiency", () => {
    it("accepts a consistent todo object", () => {
        const violations = validateTodos({
            declared: 5,
            completed: 4,
            reopened: 1,
            abandoned: 1,
            rounds_to_complete: { count: 4, sum: 11, min: 2, max: 4, buckets: [0, 1, 3, 0, 0, 0, 0, 0, 0, 0, 0] },
            active_ms_to_complete: { count: 4, sum: 183_000, min: 12_000, max: 90_000 },
        })

        expect(violations).toEqual([])
    })

    it("allows fewer round samples than completions because a lost record has no honest count", () => {
        const violations = validateTodos({
            declared: 4,
            completed: 4,
            reopened: 0,
            abandoned: 0,
            rounds_to_complete: { count: 2, sum: 5, min: 2, max: 3, buckets: [0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0] },
            active_ms_to_complete: { count: 2, sum: 40_000, min: 15_000, max: 25_000 },
        })

        expect(violations).toEqual([])
    })

    it("rejects more round samples than completions", () => {
        const violations = validateTodos({
            declared: 1,
            completed: 1,
            reopened: 0,
            abandoned: 0,
            rounds_to_complete: { count: 2, sum: 5, min: 2, max: 3, buckets: [0, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0] },
            active_ms_to_complete: { count: 2, sum: 40_000, min: 15_000, max: 25_000 },
        })

        expect(violations).toContain("todos_rounds")
    })

    it("rejects counters that cannot describe real checklist progress", () => {
        expect(validateTodos({ declared: 1, completed: 3, reopened: 0, abandoned: 0 })).toContain("todos_counters")
        expect(validateTodos({ declared: 2, completed: 1, reopened: 5, abandoned: 0 })).toContain("todos_counters")
    })

    it("rejects a bucket count that contradicts its summary", () => {
        const violations = validateTodos({
            declared: 1,
            completed: 1,
            reopened: 0,
            abandoned: 0,
            rounds_to_complete: { count: 2, sum: 4, min: 2, max: 2, buckets: [0, 2, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
            active_ms_to_complete: { count: 2, sum: 4_000, min: 2_000, max: 2_000 },
        })

        expect(violations).toContain("todos_rounds")
    })

    it("requires the active duration sample count to match the round sample count", () => {
        const violations = validateTodos({
            declared: 1,
            completed: 1,
            reopened: 0,
            abandoned: 0,
            rounds_to_complete: { count: 1, sum: 2, min: 2, max: 2, buckets: [0, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0] },
            active_ms_to_complete: { count: 2, sum: 4_000, min: 2_000, max: 2_000 },
        })

        expect(violations).toContain("todos_active_ms")
    })

    it("keeps an empty summary at zero rather than a measured zero", () => {
        expect(
            validateTodos({
                declared: 1,
                completed: 1,
                reopened: 0,
                abandoned: 0,
                rounds_to_complete: { ...EMPTY_EXECUTION_SUMMARY, buckets: Array(TODO_ROUND_BUCKETS).fill(0) },
                active_ms_to_complete: EMPTY_EXECUTION_SUMMARY,
            }),
        ).toEqual([])
        expect(
            validateTodos({
                declared: 1,
                completed: 1,
                reopened: 0,
                abandoned: 0,
                rounds_to_complete: { count: 0, sum: 5, min: 0, max: 0, buckets: Array(TODO_ROUND_BUCKETS).fill(0) },
            }),
        ).toContain("todos_rounds")
    })

    it("places a round count in the first bucket whose bound it does not exceed", () => {
        expect(todoRoundBucket(1)).toBe(0)
        expect(todoRoundBucket(5)).toBe(4)
        expect(todoRoundBucket(6)).toBe(5)
        expect(todoRoundBucket(51)).toBe(10)
        expect(() => todoRoundBucket(0)).toThrow()
    })
})

describe("task attempts", () => {
    it("accepts a distribution of attempt counts", () => {
        expect(validateTaskAttempts({ count: 12, sum: 19, min: 1, max: 4 })).toEqual([])
    })

    it("rejects a sample below one attempt", () => {
        expect(validateTaskAttempts({ count: 2, sum: 2, min: 0, max: 2 })).toContain("task_attempts")
    })

    it("rejects a sum outside what the samples allow", () => {
        expect(validateTaskAttempts({ count: 2, sum: 20, min: 1, max: 4 })).toContain("task_attempts")
        expect(validateTaskAttempts({ count: 2, sum: 1, min: 1, max: 4 })).toContain("task_attempts")
    })

    it("requires an empty distribution to stay zero", () => {
        expect(validateTaskAttempts(EMPTY_EXECUTION_SUMMARY)).toEqual([])
        expect(validateTaskAttempts({ count: 0, sum: 3, min: 0, max: 0 })).toContain("task_attempts")
    })
})

describe("role applicability", () => {
    it("carries todos only where a checklist exists", () => {
        expect(roleCarriesTodos("task")).toBe(true)
        expect(roleCarriesTodos("compaction")).toBe(true)
        // A subagent keeps no checklist, so its absence is expected, not a zero.
        expect(roleCarriesTodos("subagent")).toBe(false)
        expect(roleCarriesTodos("reviewer")).toBe(false)
        expect(roleCarriesTodos("other")).toBe(false)
    })
})

describe("tool name catalog", () => {
    it("reports a registered tool under its own name", () => {
        expect(canonicalToolName("read_file")).toBe("read_file")
        expect(canonicalToolName("Execute_Command")).toBe("execute_command")
        expect(isCatalogToolName("read_file")).toBe(true)
    })

    it("folds a user-chosen MCP server name into one stable category", () => {
        expect(canonicalToolName("mcp__private-crm__lookup")).toBe("mcp.remote")
        expect(canonicalToolName("mcp/private-crm/lookup")).toBe("mcp.remote")
    })

    it("refuses to transmit a name the contract does not know", () => {
        expect(canonicalToolName("plugin_tool_from_the_future")).toBeUndefined()
        expect(canonicalToolName("")).toBeUndefined()
        expect(canonicalToolName(undefined)).toBeUndefined()
    })
})
