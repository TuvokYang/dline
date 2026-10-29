import type { AggressiveRenderingLevel } from "@shared/AggressiveRendering"
import type { UiMessage } from "@shared/ExtensionMessage"
import { describe, expect, it } from "vitest"
import { classifyFoldRow, type FoldOptions, foldActivity, STANDARD_FOLD } from "./activityFolds"
import { isActivityFold } from "./chatRowKinds"
import { buildFoldContext } from "./foldContext"
import { groupChatRows, indexRequestRounds } from "./messageUtils"
import { rowIdentity } from "./rowCoordinate"

type ChatRow = UiMessage | UiMessage[]
/** A row as drawn: a single message by ts, another group by identity, a fold by its children. */
type Layout = number | string | { fold: Layout[] }

const say = (ts: number, kind: UiMessage["say"], extra: Partial<UiMessage> = {}): UiMessage => ({
    ts,
    type: "say",
    say: kind,
    ...extra,
})
const ask = (ts: number, kind: UiMessage["ask"], extra: Partial<UiMessage> = {}): UiMessage => ({
    ts,
    type: "ask",
    ask: kind,
    ...extra,
})

const task = (ts: number) => say(ts, "task", { text: "Fix the build" })
const feedback = (ts: number) => say(ts, "user_feedback", { text: "Also update the docs" })
const request = (ts: number, info: object = { request: "…", cost: 0.01 }) =>
    say(ts, "api_req_started", { text: JSON.stringify(info) })
const reasoning = (ts: number) => say(ts, "reasoning", { text: "Looking at the failing step" })
const assistantText = (ts: number) => say(ts, "text", { text: "The build fails in the lint step." })
const checkpoint = (ts: number, extra: Partial<UiMessage> = {}) =>
    say(ts, "checkpoint_created", {
        lastCheckpointHash: [`hash-${ts}`],
        checkpointSource: { kind: "round_start", turnId: `turn-${ts}` },
        ...extra,
    })
const tool = (ts: number, payload: object, extra: Partial<UiMessage> = {}) =>
    say(ts, "tool", { text: JSON.stringify(payload), ...extra })
const readFile = (ts: number, extra: Partial<UiMessage> = {}) => tool(ts, { tool: "readFile", path: `src/file-${ts}.ts` }, extra)
const command = (ts: number, extra: Partial<UiMessage> = { commandStatus: "completed", exitCode: 0 }) =>
    ask(ts, "command", { text: "npm run lint", ...extra })
const edit = (ts: number, extra: object = {}) =>
    tool(ts, { tool: "editedExistingFile", path: "src/a.ts", diff: "-a\n+b", ...extra })
const completion = (ts: number, extra: Partial<UiMessage> = {}) => ask(ts, "completion_result", { text: "Fixed.", ...extra })

function layoutOf(row: ChatRow): Layout {
    if (isActivityFold(row)) return { fold: row._children.map(layoutOf) }
    if (Array.isArray(row)) return `group:${rowIdentity(row)}`
    return row.ts
}

function rowsAt(messages: UiMessage[], level: AggressiveRenderingLevel, extra: Partial<FoldOptions> = {}): ChatRow[] {
    return groupChatRows(messages, undefined, { level, ...extra })
}

function layoutAt(messages: UiMessage[], level: AggressiveRenderingLevel, extra: Partial<FoldOptions> = {}): Layout[] {
    return rowsAt(messages, level, extra).map(layoutOf)
}

/** U1 C1 R1 T1 G1 C2 X1 C3 E1 T2 C4 X2 F1 from the spec, with the request rows that open each round. */
const workedExample: UiMessage[] = [
    task(1),
    checkpoint(2),
    request(3),
    reasoning(4),
    assistantText(5),
    readFile(6),
    readFile(7),
    checkpoint(8),
    request(9),
    command(10),
    checkpoint(11),
    request(12),
    edit(13),
    assistantText(14),
    checkpoint(15),
    request(16),
    command(17),
    request(18),
    completion(19),
]

describe("foldActivity on the spec worked example", () => {
    it("draws today's rows at standard", () => {
        expect(layoutAt(workedExample, "standard")).toEqual([1, 2, 4, 5, "group:tool:6", 8, 10, 11, 13, 14, 15, 17, 19])
    })

    it("folds activity runs between readable rows at activity", () => {
        expect(layoutAt(workedExample, "activity")).toEqual([
            1,
            { fold: [2, 4] },
            5,
            { fold: ["group:tool:6", 8, 10, 11, 13] },
            14,
            { fold: [15, 17] },
            19,
        ])
    })

    it("folds everything between the user row and the turn end at turn", () => {
        expect(layoutAt(workedExample, "turn")).toEqual([1, { fold: [2, 4, 5, "group:tool:6", 8, 10, 11, 13, 14, 15, 17] }, 19])
    })
})

describe("standard level", () => {
    it("returns the very same array from foldActivity", () => {
        const rows = groupChatRows(workedExample)
        const context = buildFoldContext(workedExample, indexRequestRounds(workedExample))
        expect(foldActivity(rows, STANDARD_FOLD, context)).toBe(rows)
    })

    it("groups exactly as when no fold options are given", () => {
        const withOptions = groupChatRows(workedExample, undefined, { level: "standard" })
        const withoutOptions = groupChatRows(workedExample)
        expect(withOptions.map(layoutOf)).toEqual(withoutOptions.map(layoutOf))
        expect(withOptions.some((row) => Array.isArray(row) && isActivityFold(row))).toBe(false)
    })
})

describe("assistant updates at the activity level", () => {
    it.each([
        ["working_respond", "actModeRespond"],
        ["phase_report", "statusUpdate"],
    ])("keeps a %s row visible between two folds", (_name, toolName) => {
        const messages = [
            task(1),
            command(10),
            command(11),
            tool(50, { tool: toolName, content: "Next" }),
            command(20),
            command(21),
            completion(99),
        ]
        expect(layoutAt(messages, "activity")).toEqual([1, { fold: [10, 11] }, 50, { fold: [20, 21] }, 99])
        expect(layoutAt(messages, "turn")).toEqual([1, { fold: [10, 11, 50, 20, 21] }, 99])
    })
})

const image = (status: string) => ({
    tool: "generateImage",
    imageGeneration: { schemaVersion: 1, status, requestId: "image-1", prompt: "a cat", count: 1 },
})
const webFetch = (status: string, extra: object = {}) => ({
    tool: "webFetch",
    webFetch: { schemaVersion: 1, status, url: "https://example.com", ...extra },
})
const webSearch = (status: string, extra: object = {}) => ({
    tool: "webSearch",
    webSearch: { schemaVersion: 1, status, query: "fold rows", ...extra },
})
const codeExecution = (status: string, extra: object = {}) => ({
    tool: "codeExecution",
    codeExecution: { schemaVersion: 1, config: "{}", status, ...extra },
})
const hook = (status: string) => say(50, "hook_status", { text: JSON.stringify({ hookName: "PreToolUse", status }) })
const explanation = (status: string) =>
    say(50, "generate_explanation", { text: JSON.stringify({ title: "changes", fromRef: "a", toRef: "b", status }) })
const compaction = (status: string) => tool(50, { tool: "summarizeTask", compactionStatus: status })
const loadCapability = (status: string, nested: boolean) => {
    const payload = { tool: "loadCapability", kind: "skill", status, name: "use-vitest" }
    return tool(50, nested ? { tool: "loadCapability", loadCapability: payload } : payload)
}

/** Rows that must stay outside every fold, each with what it adds to the layout. */
const splitterCases: Array<[string, UiMessage[], Layout[]]> = [
    ["a pending command", [command(50, { commandStatus: "pending" })], [50]],
    ["a running command", [command(50, { commandStatus: "running" })], [50]],
    ["a failed command", [command(50, { commandStatus: "failed" })], [50]],
    ["a cancelled command", [command(50, { commandStatus: "cancelled" })], [50]],
    ["an interrupted command", [command(50, { commandStatus: "interrupted" })], [50]],
    ["a completed command with a non-zero exit code", [command(50, { commandStatus: "completed", exitCode: 2 })], [50]],
    ["a command without status that exited non-zero", [command(50, { exitCode: 1 })], [50]],
    ["a running hook", [hook("running")], [50]],
    ["a failed hook", [hook("failed")], [50]],
    ["a cancelled hook", [hook("cancelled")], [50]],
    ["a running web fetch", [tool(50, webFetch("running"))], [50]],
    ["a deferred web fetch", [tool(50, webFetch("deferred"))], [50]],
    ["a failed web fetch", [tool(50, webFetch("failed"))], [50]],
    ["a completed web fetch with an error", [tool(50, webFetch("completed", { error: "403" }))], [50]],
    ["a running web search", [tool(50, webSearch("running"))], [50]],
    ["a deferred web search", [tool(50, webSearch("deferred"))], [50]],
    ["a failed web search", [tool(50, webSearch("failed"))], [50]],
    ["a completed web search with an error", [tool(50, webSearch("completed", { error: "quota" }))], [50]],
    ["a loading capability", [loadCapability("loading", true)], [50]],
    ["a failed capability", [loadCapability("failed", true)], [50]],
    ["a loading capability in the top-level payload", [loadCapability("loading", false)], [50]],
    ["a failed capability in the top-level payload", [loadCapability("failed", false)], [50]],
    ["a running code execution", [tool(50, codeExecution("running"))], [50]],
    ["a failed code execution", [tool(50, codeExecution("failed"))], [50]],
    ["a completed code execution with an error", [tool(50, codeExecution("completed", { error: "timeout" }))], [50]],
    ["an image awaiting approval", [tool(50, image("awaiting_approval"))], [50]],
    ["a queued image", [tool(50, image("queued"))], [50]],
    ["a started image", [tool(50, image("started"))], [50]],
    ["an image preview", [tool(50, image("preview"))], [50]],
    ["a failed image", [tool(50, image("failed"))], [50]],
    ["a rejected image", [tool(50, image("rejected"))], [50]],
    ["a generating explanation", [explanation("generating")], [50]],
    ["a failed explanation", [explanation("error")], [50]],
    ["an explanation without a readable payload", [say(50, "generate_explanation", { text: "not json" })], [50]],
    ["a preparing compaction", [compaction("preparing")], [50]],
    ["a waiting compaction", [compaction("waiting")], [50]],
    ["a receiving compaction", [compaction("receiving")], [50]],
    ["a running compaction", [compaction("running")], [50]],
    ["a retrying compaction", [compaction("retrying")], [50]],
    ["a failed compaction", [compaction("failed")], [50]],
    ["a partial row", [tool(50, { tool: "newFileCreated", path: "b.ts" }, { partial: true })], [50]],
    ["a subagent status row", [say(50, "subagent", { text: "{}" })], [50]],
    ["a kill-command row", [tool(50, { tool: "killCommand", activityId: "cmd-1" })], [50]],
    ["a request that failed in its own row", [request(50, { streamingFailedMessage: "connection reset" })], [50]],
    ["a request whose failure arrives as a separate ask", [request(50), ask(51, "api_req_failed", { text: "overloaded" })], [50]],
    ["an error row", [say(50, "error", { text: "boom" })], [50]],
    ["a diff error row", [say(50, "diff_error", { text: "no match" })], [50]],
    ["an ignore-file refusal", [say(50, "clineignore_error", { text: ".env" })], [50]],
    ["a mistake-limit ask", [ask(50, "mistake_limit_reached", { text: "stuck" })], [50]],
    [
        "an exhausted automatic retry",
        [say(50, "error_retry", { text: JSON.stringify({ attempt: 3, maxAttempts: 3, failed: true }) })],
        [50],
    ],
    ["an edit with a failed block", [edit(50, { blockErrors: [undefined, "SEARCH block not found"] })], [50]],
    ["a checked-out checkpoint", [checkpoint(50, { isCheckpointCheckedOut: true })], [50]],
    [
        "an edit that owns a checked-out pre-edit checkpoint",
        [
            say(49, "checkpoint_created", {
                lastCheckpointHash: ["pre-edit"],
                isCheckpointCheckedOut: true,
                checkpointSource: { kind: "pre_edit", toolTs: 50, toolName: "editedExistingFile" },
            }),
            edit(50),
        ],
        [50],
    ],
    ["a tool group holding a partial member", [readFile(50), readFile(51, { partial: true })], ["group:tool:50"]],
    [
        "a browser session that an error ended",
        [
            say(50, "browser_action_launch", { text: "https://example.com" }),
            say(51, "browser_action_result", { text: "{}" }),
            say(52, "error", { text: "browser crashed" }),
        ],
        ["group:browser:50", 52],
    ],
]

/** Rows of the same presentations that are finished work and fold like any other activity. */
const settledCases: Array<[string, UiMessage[]]> = [
    ["a completed command with exit code 0", [command(50)]],
    ["a skipped command", [command(50, { commandStatus: "skipped" })]],
    ["a command without status", [command(50, {})]],
    ["a completed hook", [hook("completed")]],
    ["a completed web fetch", [tool(50, webFetch("completed"))]],
    ["a completed web search", [tool(50, webSearch("completed"))]],
    ["a completed capability load", [loadCapability("completed", true)]],
    ["a completed code execution", [tool(50, codeExecution("completed"))]],
    ["a completed image", [tool(50, image("completed"))]],
    ["a cancelled image", [tool(50, image("cancelled"))]],
    ["a complete explanation", [explanation("complete")]],
    ["a completed compaction", [compaction("completed")]],
    ["a transient retry notice", [say(50, "error_retry", { text: JSON.stringify({ attempt: 1, maxAttempts: 3, delaySec: 5 }) })]],
    ["an edit without block errors", [edit(50, { blockErrors: [undefined, ""] })]],
    ["a checkpoint that is not checked out", [checkpoint(50)]],
]

/** A settled turn with foldable control rows on both sides of the rows under test. */
function settledTurnAround(rows: UiMessage[]): UiMessage[] {
    return [task(1), command(10), command(11), ...rows, command(20), command(21), completion(99)]
}

describe("splitters inside the settled region", () => {
    it.each(splitterCases)("never folds %s", (_name, rows, drawn) => {
        const messages = settledTurnAround(rows)
        const expected: Layout[] = [1, { fold: [10, 11] }, ...drawn, { fold: [20, 21] }, 99]
        expect(layoutAt(messages, "activity")).toEqual(expected)
        expect(layoutAt(messages, "turn")).toEqual(expected)
    })

    it.each(settledCases)("folds %s with its neighbours", (_name, rows) => {
        const messages = settledTurnAround(rows)
        const expected: Layout[] = [1, { fold: [10, 11, 50, 20, 21] }, 99]
        expect(layoutAt(messages, "activity")).toEqual(expected)
        expect(layoutAt(messages, "turn")).toEqual(expected)
    })

    it("keeps the active interaction's ask out of a fold", () => {
        const messages = settledTurnAround([command(50)])
        expect(layoutAt(messages, "turn", { activeAskTs: 50 })).toEqual([1, { fold: [10, 11] }, 50, { fold: [20, 21] }, 99])
    })

    it("treats an ask that is the window's last row as a splitter", () => {
        const pendingTool = ask(50, "tool", { text: JSON.stringify({ tool: "readFile", path: "a.ts" }) })
        const context = buildFoldContext([task(1), pendingTool], indexRequestRounds([task(1), pendingTool]))
        expect(classifyFoldRow(pendingTool, true, { level: "turn" }, context)).toBe("splitter")
        expect(classifyFoldRow(pendingTool, false, { level: "turn" }, context)).toBe("activity")
    })
})

describe("the open tail after the last settled turn end", () => {
    const levels: AggressiveRenderingLevel[] = ["activity", "turn"]
    const openTails: Array<[string, UiMessage[], UiMessage[]]> = [
        [
            "a non-partial running web fetch followed by a running hook (REVIEW-100 D1)",
            [feedback(1), reasoning(2), tool(3, webFetch("running")), hook("running")],
            [
                feedback(1),
                reasoning(2),
                tool(3, webFetch("completed")),
                say(50, "hook_status", { text: JSON.stringify({ hookName: "PostToolUse", status: "completed" }) }),
                completion(99),
            ],
        ],
        [
            "a non-partial running web search followed by a running hook (REVIEW-100 D1)",
            [feedback(1), reasoning(2), tool(3, webSearch("running")), hook("running")],
            [
                feedback(1),
                reasoning(2),
                tool(3, webSearch("completed")),
                say(50, "hook_status", { text: JSON.stringify({ hookName: "PostToolUse", status: "completed" }) }),
                completion(99),
            ],
        ],
        [
            "a non-partial MCP call followed by a running hook (REVIEW-101 E1)",
            [task(1), reasoning(2), ask(3, "use_mcp_server", { text: "{}" }), hook("running")],
            [
                task(1),
                reasoning(2),
                ask(3, "use_mcp_server", { text: "{}" }),
                say(50, "hook_status", { text: JSON.stringify({ hookName: "PostToolUse", status: "completed" }) }),
                completion(99),
            ],
        ],
    ]

    it.each(openTails)("leaves %s unfolded until a settled completion follows", (_name, open, settled) => {
        for (const level of levels) {
            expect(layoutAt(open, level)).toEqual(open.map((message) => message.ts))
            const [opener, ...rest] = layoutAt(settled, level)
            expect(opener).toBe(settled[0].ts)
            expect(rest).toEqual([{ fold: settled.slice(1, -1).map((message) => message.ts) }, 99])
        }
    })

    it("does not let an approval note close a running MCP call (REVIEW-102 F1)", () => {
        const open = [task(1), reasoning(2), ask(3, "use_mcp_server", { text: "{}" }), feedback(4)]
        for (const level of levels) expect(layoutAt(open, level)).toEqual([1, 2, 3, 4])

        const settled = [...open, completion(99)]
        for (const level of levels) expect(layoutAt(settled, level)).toEqual([1, { fold: [2, 3] }, 4, 99])
    })

    it("does not let new_task set the cutoff (REVIEW-103 G1)", () => {
        const open = [
            task(1),
            reasoning(2),
            ask(3, "use_mcp_server", { text: "{}" }),
            ask(4, "new_task", { text: "Spin off" }),
            feedback(5),
        ]
        for (const level of levels) expect(layoutAt(open, level)).toEqual([1, 2, 3, 4, 5])

        const settled = [...open, completion(99)]
        for (const level of levels) expect(layoutAt(settled, level)).toEqual([1, { fold: [2, 3] }, 4, 5, 99])
    })

    it("leaves a stopped tail without a turn end unfolded", () => {
        const stopped = [task(1), reasoning(2), command(3), command(4, { commandStatus: "completed", exitCode: 0 })]
        for (const level of levels) expect(layoutAt(stopped, level)).toEqual([1, 2, 3, 4])
    })

    it("does not count a partial turn end as settled", () => {
        const streaming = [task(1), command(2), command(3), completion(99, { partial: true })]
        for (const level of levels) expect(layoutAt(streaming, level)).toEqual([1, 2, 3, 99])
    })
})

describe("fold eligibility", () => {
    it("leaves a single-row segment as it is", () => {
        const messages = [task(1), command(2), completion(99)]
        expect(layoutAt(messages, "activity")).toEqual([1, 2, 99])
        expect(layoutAt(messages, "turn")).toEqual([1, 2, 99])
    })

    it("never takes a user row into a fold", () => {
        const messages = [task(1), command(2), command(3), feedback(4), command(5), command(6), completion(99)]
        for (const level of ["activity", "turn"] as const) {
            expect(layoutAt(messages, level)).toEqual([1, { fold: [2, 3] }, 4, { fold: [5, 6] }, 99])
        }
    })

    it("does not fold a run whose request round starts outside the window (REVIEW-097 A8)", () => {
        const windowed = [assistantText(3), command(4), checkpoint(5), ask(6, "followup", { text: "Ship it?" })]
        expect(layoutAt(windowed, "activity")).toEqual([3, 4, 5, 6])
        expect(layoutAt(windowed, "turn")).toEqual([3, 4, 5, 6])

        const paged = [task(0), request(1), readFile(2), ...windowed]
        expect(layoutAt(paged, "activity")).toEqual([0, { fold: ["group:tool:2", 4, 5] }, 6])
        expect(layoutAt(paged, "turn")).toEqual([0, { fold: ["group:tool:2", 4, 5] }, 6])
    })

    it("expands back to the standard rows, each exactly once and in order", () => {
        const fixtures = [workedExample, ...splitterCases.map(([, rows]) => settledTurnAround(rows))]
        for (const messages of fixtures) {
            const rounds = indexRequestRounds(messages)
            const rows = groupChatRows(messages)
            for (const level of ["activity", "turn"] as const) {
                const folded = foldActivity(rows, { level }, buildFoldContext(messages, rounds))
                const expanded = folded.flatMap((row) => (Array.isArray(row) && isActivityFold(row) ? [...row._children] : [row]))
                expect(expanded).toHaveLength(rows.length)
                for (const [index, row] of expanded.entries()) expect(row).toBe(rows[index])
                for (const row of folded) {
                    if (!Array.isArray(row) || !isActivityFold(row)) continue
                    expect(row.some((member) => member.say === "task" || member.say === "user_feedback")).toBe(false)
                }
            }
        }
    })
})

describe("fold identity", () => {
    const foldIds = (rows: ChatRow[]) => rows.filter((row) => Array.isArray(row) && isActivityFold(row)).map(rowIdentity)

    it("is fold:<first member ts> and survives appended turns", () => {
        const firstTurn = [task(1), command(2), command(3), ask(4, "followup", { text: "Continue?" })]
        expect(foldIds(rowsAt(firstTurn, "turn"))).toEqual(["fold:2"])

        const secondTurn = [...firstTurn, feedback(5), command(6), command(7), completion(8)]
        expect(foldIds(rowsAt(secondTurn, "turn"))).toEqual(["fold:2", "fold:6"])
        expect(foldIds(rowsAt(secondTurn, "activity"))).toEqual(["fold:2", "fold:6"])
    })

    it("survives older rows being paged in ahead of a loaded round start", () => {
        const loaded = [feedback(10), request(11), command(12), command(13), completion(14)]
        expect(foldIds(rowsAt(loaded, "activity"))).toEqual(["fold:12"])

        const paged = [task(1), command(2), command(3), ask(4, "followup", { text: "Continue?" }), ...loaded]
        expect(foldIds(rowsAt(paged, "activity"))).toEqual(["fold:2", "fold:12"])
        expect(foldIds(rowsAt(paged, "turn"))).toEqual(["fold:2", "fold:12"])
    })
})
