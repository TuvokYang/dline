import assert from "node:assert/strict"
import type { ClineAskResponse } from "@shared/WebviewMessage"
import { describe, it } from "vitest"
import { formatUnroutedAskResponse } from "../index"

/**
 * A response that reaches the task with no ask listening used to leave a log
 * that named the symptom and nothing else. Locating the cause then required
 * inferring the conversation position and runtime phase from surrounding
 * timestamps, which is exactly what a multi-hour hang makes impossible.
 *
 * These tests pin the fields the diagnostic must carry, and pin that the
 * diagnostic survives a task whose state is not fully reportable. The path is
 * already anomalous; a formatter that threw would replace the report with its
 * own failure and destroy the evidence it exists to preserve.
 */
describe("unrouted ask response diagnostics", () => {
    const baseContext = {
        taskId: "task-4711",
        response: "messageResponse" as ClineAskResponse,
        messageCount: 42,
        phase: "streaming",
    }

    it("names the task, the response kind and the conversation position", () => {
        const log = formatUnroutedAskResponse(baseContext)

        assert.match(log, /\[Task task-4711\]/)
        assert.match(log, /response=messageResponse/)
        assert.match(log, /messages=42/)
        assert.match(log, /phase=streaming/)
    })

    /**
     * The distinction that matters when reading the log is whether the user
     * actually supplied content. A bare approval and a typed answer arriving at
     * the wrong moment have different causes, so the payload shape has to be
     * visible without echoing the text itself into the log.
     */
    it("reports payload shape without echoing the response text", () => {
        const log = formatUnroutedAskResponse({
            ...baseContext,
            text: "a decision the user typed",
            images: ["img-a", "img-b"],
            files: ["notes.md"],
        })

        assert.match(log, /hasText=true/)
        assert.match(log, /images=2/)
        assert.match(log, /files=1/)
        assert.ok(!log.includes("a decision the user typed"), "the diagnostic must not copy user content into the log")
    })

    it("reports an absent payload as empty rather than omitting the fields", () => {
        const log = formatUnroutedAskResponse(baseContext)

        assert.match(log, /hasText=false/)
        assert.match(log, /images=0/)
        assert.match(log, /files=0/)
    })

    /**
     * The caller reads message count and phase defensively, so the formatter has
     * to render the resulting placeholders as legible values. `messages=-1` and
     * `phase=unknown` state that the task could not report the fact, which is
     * itself diagnostic; blank or `undefined` would read as a formatting bug.
     */
    it("renders unavailable task state as explicit placeholders", () => {
        const log = formatUnroutedAskResponse({
            ...baseContext,
            messageCount: -1,
            phase: "unknown",
        })

        assert.match(log, /messages=-1/)
        assert.match(log, /phase=unknown/)
        assert.ok(!log.includes("undefined"), "unavailable state must not render as undefined")
    })

    /**
     * Distinct asks produce distinct diagnostics. Concurrent tasks share the log
     * stream, so a line that could belong to any of them is not actionable.
     */
    it("distinguishes concurrent tasks by id", () => {
        const first = formatUnroutedAskResponse({ ...baseContext, taskId: "task-1" })
        const second = formatUnroutedAskResponse({ ...baseContext, taskId: "task-2" })

        assert.notEqual(first, second)
        assert.match(first, /\[Task task-1\]/)
        assert.match(second, /\[Task task-2\]/)
    })

    /**
     * The response is held for the ask it belongs to rather than dropped. The
     * wording has to say so, otherwise a reader who finds this line while
     * investigating a hang will conclude the answer was lost and look for the
     * wrong defect.
     */
    it("states that the response was held rather than discarded", () => {
        const log = formatUnroutedAskResponse(baseContext)

        assert.match(log, /refused/)
        assert.match(log, /no ask was listening/)
    })
})
