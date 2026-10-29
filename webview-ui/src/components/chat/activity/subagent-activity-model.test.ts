import type { TaskActivityEvent } from "@shared/proto/dline/task"
import { describe, expect, it } from "vitest"
import {
    buildSubagentActivityPresentation,
    buildSubagentRetryAttempts,
    buildSubagentToolSteps,
    normalizeSubagentDisplayText,
    normalizeSubagentToolSummary,
    parseSubagentActivityDetail,
} from "./subagent-activity-model"

function event(event: Partial<TaskActivityEvent>): TaskActivityEvent {
    return event as TaskActivityEvent
}

describe("subagent activity presentation model", () => {
    it("removes common multiline indentation while preserving relative indentation", () => {
        expect(normalizeSubagentDisplayText("\r\n    first\r\n      second\r\n    third\r\n")).toBe("first\n  second\nthird")
    })

    it("removes a duplicated tool name from the display summary", () => {
        expect(normalizeSubagentToolSummary("read_file", "read_file(path=README.md)")).toBe("(path=README.md)")
        expect(normalizeSubagentToolSummary("list_files", "list files")).toBe("list files")
    })

    it("merges tool lifecycle events and ignores metrics, status, and thinking events", () => {
        const steps = buildSubagentToolSteps([
            event({ sequence: 1, timestamp: 1, kind: "status", status: "running", text: "Activity started" }),
            event({ sequence: 2, timestamp: 2, kind: "thinking", phase: "delta", text: "Inspecting" }),
            event({
                sequence: 3,
                timestamp: 3,
                kind: "tool_call",
                toolCallId: "call-1",
                toolName: "read_file",
                toolStatus: "started",
                summary: "read_file(path=README.md)",
            }),
            event({
                sequence: 4,
                timestamp: 4,
                kind: "metrics",
                metrics: { toolCalls: 1 },
            }),
            event({
                sequence: 5,
                timestamp: 5,
                kind: "tool_result",
                toolCallId: "call-1",
                toolName: "read_file",
                text: "  file contents\n    nested line  ",
            }),
            event({
                sequence: 6,
                timestamp: 6,
                kind: "tool_call",
                toolCallId: "call-1",
                toolName: "read_file",
                toolStatus: "completed",
                summary: "read_file(path=README.md)",
                durationMs: 42,
            }),
        ])

        expect(steps).toEqual([
            {
                toolCallId: "call-1",
                toolName: "read_file",
                status: "completed",
                summary: "(path=README.md)",
                resultText: "file contents\n  nested line",
                durationMs: 42,
                sequence: 3,
            },
        ])
    })

    it("projects structured retry attempts and ignores incomplete retry events", () => {
        expect(
            buildSubagentRetryAttempts([
                event({
                    sequence: 2,
                    timestamp: 2,
                    kind: "retry",
                    retryAttempt: 2,
                    maxRetries: 5,
                    delayMs: 8_000,
                    cumulativeDelayMs: 13_000,
                }),
                event({ sequence: 1, timestamp: 1, kind: "retry", retryAttempt: 1, maxRetries: 5, delayMs: 5_000 }),
                event({
                    sequence: 3,
                    timestamp: 3,
                    kind: "retry",
                    retryAttempt: 3,
                    maxRetries: 5,
                    delayMs: 11_000,
                    cumulativeDelayMs: 24_000,
                }),
            ]),
        ).toEqual([
            { retryAttempt: 2, maxRetries: 5, delayMs: 8_000, cumulativeDelayMs: 13_000, sequence: 2 },
            { retryAttempt: 3, maxRetries: 5, delayMs: 11_000, cumulativeDelayMs: 24_000, sequence: 3 },
        ])
    })

    it("isolates tools and retries to the current attempt while preserving legacy fallback", () => {
        const events = [
            event({ sequence: 1, timestamp: 1, attempt: 1, kind: "tool_call", toolCallId: "old", toolName: "old_tool" }),
            event({
                sequence: 2,
                timestamp: 2,
                attempt: 1,
                kind: "retry",
                retryAttempt: 1,
                maxRetries: 2,
                delayMs: 10,
                cumulativeDelayMs: 10,
            }),
            event({ sequence: 3, timestamp: 3, attempt: 2, kind: "tool_call", toolCallId: "new", toolName: "new_tool" }),
            event({
                sequence: 4,
                timestamp: 4,
                attempt: 2,
                kind: "retry",
                retryAttempt: 1,
                maxRetries: 3,
                delayMs: 20,
                cumulativeDelayMs: 20,
            }),
        ]

        expect(buildSubagentActivityPresentation(events, 2)).toMatchObject({
            toolCount: 1,
            toolSteps: [{ toolCallId: "new", toolName: "new_tool" }],
            retryAttempts: [{ maxRetries: 3, sequence: 4 }],
        })
        expect(buildSubagentToolSteps(events)).toHaveLength(2)
        expect(buildSubagentRetryAttempts(events)).toHaveLength(2)
    })

    it("parses normalized Task and Context without exposing malformed detail", () => {
        expect(
            parseSubagentActivityDetail(
                "<task>\n    Review the implementation\n</task>\n<context>\n      Keep APIs stable\n</context>",
            ),
        ).toEqual({ task: "Review the implementation", context: "Keep APIs stable" })
        expect(parseSubagentActivityDetail("<task>missing close tag")).toEqual({})
    })

    it("keeps failed tool details expandable", () => {
        const steps = buildSubagentToolSteps([
            event({
                sequence: 1,
                timestamp: 1,
                kind: "tool_call",
                toolCallId: "call-1",
                toolName: "execute_command",
                toolStatus: "failed",
                summary: "execute_command(command=pnpm test)",
                error: "command failed",
            }),
        ])

        expect(steps[0]).toMatchObject({
            toolName: "execute_command",
            status: "failed",
            summary: "(command=pnpm test)",
            error: "command failed",
        })
    })
})
