import { readFileSync } from "node:fs"
import path from "node:path"
import { DlineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import {
    hasDeclaredLaneAssignment,
    LANE_BROWSER_SESSION,
    LANE_DIFF_EDITOR,
    LANE_FILE_READ_ACCOUNTING,
    LANE_FOREGROUND_TERMINAL,
    LANE_MCP_NOTIFICATIONS,
    LANE_SUBAGENT_EXECUTION,
    LANE_USER_INTERACTION,
    lanesAreCompatible,
    MCP_SCOPED_TOOLS,
    mcpServerLane,
    resolveToolLanes,
    UNRESTRICTED_TOOLS,
    writePathLane,
} from "../tool-lanes"

/**
 * Tool identities the coordinator actually routes, read from its source.
 *
 * Reading the registry rather than restating it is deliberate. A second literal
 * list is exactly how the subagent selection UI drifted from execution, and a
 * coverage check built on a hand-written list proves only that the list matches
 * itself.
 */
function registeredToolNames(): string[] {
    const coordinatorPath = path.resolve(__dirname, "../../../tools/ToolExecutorCoordinator.ts")
    const source = readFileSync(coordinatorPath, "utf8")

    const mapStart = source.indexOf("toolHandlersMap")
    expect(mapStart, "ToolExecutorCoordinator no longer declares toolHandlersMap").toBeGreaterThan(-1)
    const mapEnd = source.indexOf("\n\t}", mapStart)
    expect(mapEnd, "could not bound the toolHandlersMap literal").toBeGreaterThan(mapStart)

    const body = source.slice(mapStart, mapEnd)
    const names: string[] = []
    for (const match of body.matchAll(/\[DlineDefaultTool\.([A-Z_]+)\]:/g)) {
        const key = match[1] as keyof typeof DlineDefaultTool
        const value = DlineDefaultTool[key]
        if (value) names.push(value)
    }
    return names
}

describe("tool lanes", () => {
    describe("coverage against the real registry", () => {
        it("reads a non-trivial registry", () => {
            // Guards the parser itself: a regex that silently matched nothing
            // would make every coverage assertion below vacuous.
            expect(registeredToolNames().length).toBeGreaterThan(20)
        })

        it("classifies every registered tool", () => {
            const unclassified = registeredToolNames().filter((name) => !hasDeclaredLaneAssignment(name))

            expect(unclassified, "every registered tool must declare its lanes or be explicitly unrestricted").toEqual([])
        })

        it("resolves at least one lane for every tool that is not declared unrestricted", () => {
            const contextByTool: Record<string, { mcpServerName?: string }> = Object.fromEntries(
                Array.from(MCP_SCOPED_TOOLS).map((tool) => [tool, { mcpServerName: "server-a" }]),
            )

            const missing = registeredToolNames().filter((name) => {
                const lanes = resolveToolLanes(name, contextByTool[name] ?? {})
                return lanes.length === 0 && !UNRESTRICTED_TOOLS.has(name as DlineDefaultTool)
            })

            expect(missing).toEqual([])
        })
    })

    describe("shared resource lanes", () => {
        it("puts two file-writing tools on the diff-editor lane even for different paths", () => {
            const write = resolveToolLanes(DlineDefaultTool.FILE_NEW, { canonicalWritePaths: ["/repo/a.ts"] })
            const edit = resolveToolLanes(DlineDefaultTool.FILE_EDIT, { canonicalWritePaths: ["/repo/b.ts"] })

            expect(write).toContain(LANE_DIFF_EDITOR)
            expect(edit).toContain(LANE_DIFF_EDITOR)
            // The editor is one Task-level instance whose open() overwrites
            // shared edit state, so different paths are not enough to separate.
            expect(lanesAreCompatible(write, edit)).toBe(false)
        })

        it("separates two edits of the same path by write path as well", () => {
            const first = resolveToolLanes(DlineDefaultTool.FILE_EDIT, { canonicalWritePaths: ["/repo/a.ts"] })
            const second = resolveToolLanes(DlineDefaultTool.APPLY_PATCH, { canonicalWritePaths: ["/repo/a.ts"] })

            expect(first).toContain(writePathLane("/repo/a.ts"))
            expect(second).toContain(writePathLane("/repo/a.ts"))
            expect(lanesAreCompatible(first, second)).toBe(false)
        })

        it("claims a lane for every path a multi-file write touches", () => {
            // apply_patch, replace_text and rename each modify several files in
            // one invocation, so a single path would leave the second and later
            // files unprotected.
            const patch = resolveToolLanes(DlineDefaultTool.APPLY_PATCH, {
                canonicalWritePaths: ["/repo/a.ts", "/repo/b.ts"],
            })

            expect(patch).toContain(writePathLane("/repo/a.ts"))
            expect(patch).toContain(writePathLane("/repo/b.ts"))

            const overlapsSecondFileOnly = resolveToolLanes(DlineDefaultTool.REPLACE_TEXT, {
                canonicalWritePaths: ["/repo/b.ts"],
            })
            expect(lanesAreCompatible(patch, overlapsSecondFileOnly)).toBe(false)
        })

        it("keeps subagent entry points off each other, because both own one flag", () => {
            const single = resolveToolLanes(DlineDefaultTool.USE_SUBAGENT)
            const batch = resolveToolLanes(DlineDefaultTool.USE_SUBAGENTS)

            expect(single).toContain(LANE_SUBAGENT_EXECUTION)
            expect(batch).toContain(LANE_SUBAGENT_EXECUTION)
            // The first to finish clears taskState.isExecutingSubagent while the
            // second is still running, so they cannot overlap.
            expect(lanesAreCompatible(single, batch)).toBe(false)
        })

        it("serialises file reads because they share the read accounting cache", () => {
            const first = resolveToolLanes(DlineDefaultTool.FILE_READ)
            const second = resolveToolLanes(DlineDefaultTool.FILE_READ)

            expect(first).toEqual([LANE_FILE_READ_ACCOUNTING])
            expect(lanesAreCompatible(first, second)).toBe(false)
            // A search is unaffected; it does not touch that cache.
            expect(lanesAreCompatible(first, resolveToolLanes(DlineDefaultTool.SEARCH))).toBe(true)
        })

        it("shares a browser lane that excludes unrelated tools", () => {
            const browser = resolveToolLanes(DlineDefaultTool.BROWSER)
            const otherBrowser = resolveToolLanes(DlineDefaultTool.BROWSER)
            const read = resolveToolLanes(DlineDefaultTool.FILE_READ)

            expect(browser).toEqual([LANE_BROWSER_SESSION])
            expect(lanesAreCompatible(browser, otherBrowser)).toBe(false)
            expect(lanesAreCompatible(browser, read)).toBe(true)
        })

        it("separates commands by the foreground terminal", () => {
            const run = resolveToolLanes(DlineDefaultTool.BASH)
            const kill = resolveToolLanes(DlineDefaultTool.KILL_COMMAND)

            expect(run).toContain(LANE_FOREGROUND_TERMINAL)
            expect(lanesAreCompatible(run, kill)).toBe(false)
        })

        it("separates MCP calls per server", () => {
            const serverA = resolveToolLanes(DlineDefaultTool.MCP_ACCESS, { mcpServerName: "alpha" })
            const alsoServerA = resolveToolLanes(DlineDefaultTool.MCP_ACCESS, { mcpServerName: "alpha" })
            const serverB = resolveToolLanes(DlineDefaultTool.MCP_ACCESS, { mcpServerName: "beta" })

            expect(serverA).toEqual([mcpServerLane("alpha")])
            expect(lanesAreCompatible(serverA, alsoServerA)).toBe(false)
            // Resource access does not drain the notification queue, so two
            // different servers may still overlap.
            expect(lanesAreCompatible(serverA, serverB)).toBe(true)
        })

        it("serialises notification-draining MCP calls across different servers", () => {
            const serverA = resolveToolLanes(DlineDefaultTool.MCP_USE, { mcpServerName: "alpha" })
            const serverB = resolveToolLanes(DlineDefaultTool.MCP_USE, { mcpServerName: "beta" })

            expect(serverA).toContain(LANE_MCP_NOTIFICATIONS)
            expect(serverA).toContain(mcpServerLane("alpha"))
            // getPendingNotifications() copies and clears one hub-wide array, so
            // a call to alpha would otherwise consume beta's notifications.
            expect(lanesAreCompatible(serverA, serverB)).toBe(false)
        })

        it("serialises tools that speak to the user", () => {
            const attempt = resolveToolLanes(DlineDefaultTool.ATTEMPT)
            const ask = resolveToolLanes(DlineDefaultTool.ASK)

            expect(attempt).toEqual([LANE_USER_INTERACTION])
            expect(lanesAreCompatible(attempt, ask)).toBe(false)
        })
    })

    describe("free concurrency", () => {
        it("gives read-only tools no lane", () => {
            for (const tool of [
                DlineDefaultTool.SEARCH,
                DlineDefaultTool.LIST_FILES,
                DlineDefaultTool.LIST_CODE_DEF,
                DlineDefaultTool.FIND_REFERENCES,
            ]) {
                expect(resolveToolLanes(tool), `${tool} should be unrestricted`).toEqual([])
            }
        })

        it("treats an empty lane set as compatible with anything", () => {
            expect(lanesAreCompatible([], [LANE_DIFF_EDITOR])).toBe(true)
            expect(lanesAreCompatible([LANE_DIFF_EDITOR], [])).toBe(true)
        })
    })

    describe("purity", () => {
        it("returns an equal lane set for the same input", () => {
            const context = { canonicalWritePaths: ["/repo/a.ts"] }
            expect(resolveToolLanes(DlineDefaultTool.FILE_EDIT, context)).toEqual(
                resolveToolLanes(DlineDefaultTool.FILE_EDIT, context),
            )
        })

        it("does not mutate the supplied context", () => {
            const context = { mcpServerName: "alpha", canonicalWritePaths: ["/repo/a.ts"] }
            const snapshot = { mcpServerName: "alpha", canonicalWritePaths: ["/repo/a.ts"] }
            resolveToolLanes(DlineDefaultTool.MCP_USE, context)
            expect(context).toEqual(snapshot)
        })

        it("returns no lane for an unknown tool rather than throwing", () => {
            expect(resolveToolLanes("not_a_registered_tool")).toEqual([])
            expect(hasDeclaredLaneAssignment("not_a_registered_tool")).toBe(false)
        })
    })
})
