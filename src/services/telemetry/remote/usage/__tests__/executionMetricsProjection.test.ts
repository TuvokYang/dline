import { describe, expect, it } from "vitest"
import {
    isEmptyToolCounters,
    projectToolCounters,
    type SettledToolBlock,
    toolCountersConserve,
    toolOutcomeOf,
} from "../executionMetricsProjection"

function block(phase: SettledToolBlock["phase"], toolName?: string, awaitingBlockId?: string): SettledToolBlock {
    return {
        phase,
        ...(toolName === undefined ? {} : { toolName }),
        ...(awaitingBlockId === undefined ? {} : { awaitingBlockId }),
    }
}

describe("tool outcome classification", () => {
    it("matches the criteria the fact-level tool totals already use", () => {
        expect(toolOutcomeOf(block("completed"))).toBe("completed")
        // The awaited block is the tool whose result ends the turn.
        expect(toolOutcomeOf(block("executing", "read_file", "read_file"))).toBe("completed")
        // A rejected block settled without a result, which the totals report as failed.
        expect(toolOutcomeOf(block("failed"))).toBe("failed")
        expect(toolOutcomeOf(block("rejected"))).toBe("failed")
        // Everything that never produced a result is a cancellation.
        expect(toolOutcomeOf(block("skipped"))).toBe("cancelled")
        expect(toolOutcomeOf(block("cancelled"))).toBe("cancelled")
        expect(toolOutcomeOf(block("pending"))).toBe("cancelled")
    })
})

describe("tool counter projection", () => {
    it("groups blocks by name and conserves every settlement", () => {
        const counters = projectToolCounters({
            factKey: "task\u0000anthropic\u0000opus\u00000",
            blocks: [
                block("completed", "read_file"),
                block("completed", "read_file"),
                block("failed", "execute_command"),
                block("cancelled", "web_fetch"),
            ],
        })

        expect(counters.byName).toEqual({
            execute_command: { completed: 0, failed: 1, cancelled: 0 },
            read_file: { completed: 2, failed: 0, cancelled: 0 },
            web_fetch: { completed: 0, failed: 0, cancelled: 1 },
        })
        expect(counters.unlisted).toEqual({ completed: 0, failed: 0, cancelled: 0 })
        expect(counters.totals).toEqual({ completed: 2, failed: 1, cancelled: 1 })
        expect(toolCountersConserve(counters)).toBe(true)
    })

    it("counts an unresolvable name as unlisted instead of dropping the settlement", () => {
        const counters = projectToolCounters({
            factKey: "fact-a",
            blocks: [block("completed", "read_file"), block("completed"), block("failed", "unknown_plugin_tool")],
        })

        expect(counters.byName).toEqual({ read_file: { completed: 1, failed: 0, cancelled: 0 } })
        expect(counters.unlisted).toEqual({ completed: 1, failed: 1, cancelled: 0 })
        expect(counters.totals).toEqual({ completed: 2, failed: 1, cancelled: 0 })
        expect(toolCountersConserve(counters)).toBe(true)
    })

    it("folds names beyond the bound into unlisted while keeping the totals", () => {
        const names = [
            "read_file",
            "write_to_file",
            "apply_patch",
            "execute_command",
            "web_fetch",
            "web_search",
            "browser_action",
            "list_files",
            "search_files",
        ]
        const counters = projectToolCounters({
            factKey: "fact-a",
            blocks: names.map((name) => block("completed", name)),
            limit: 8,
        })

        expect(Object.keys(counters.byName)).toHaveLength(8)
        expect(counters.unlisted).toEqual({ completed: 1, failed: 0, cancelled: 0 })
        expect(counters.totals).toEqual({ completed: 9, failed: 0, cancelled: 0 })
        expect(toolCountersConserve(counters)).toBe(true)
    })

    it("reports nothing when no block settled", () => {
        const counters = projectToolCounters({ factKey: "fact-a", blocks: [] })

        expect(isEmptyToolCounters(counters)).toBe(true)
        expect(toolCountersConserve(counters)).toBe(true)
    })

    it("folds an MCP server name into one category rather than exposing it", () => {
        const counters = projectToolCounters({
            factKey: "fact-a",
            blocks: [block("completed", "mcp__private-crm__lookup"), block("completed", "mcp__other-server__send")],
        })

        expect(Object.keys(counters.byName)).toEqual(["mcp.remote"])
        expect(counters.byName["mcp.remote"]).toEqual({ completed: 2, failed: 0, cancelled: 0 })
    })
})
