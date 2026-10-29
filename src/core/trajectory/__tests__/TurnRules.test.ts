import { describe, expect, it } from "vitest"
import { isCountedRound, isSuccessfulCompletion, isTurnStart, TOOL_DIALOG_ASKS, trajectoryToolKey } from "../TurnRules"
import { ProducerRows } from "./fixtures/producerRows"

const afterSay = { lastAskKind: null }

describe("isTurnStart", () => {
    it("opens a turn for the task row, direct input and a queued batch", () => {
        const p = new ProducerRows()
        expect(isTurnStart(p.task("build it"), afterSay)).toBe(true)
        expect(isTurnStart(p.directInput("also add tests"), afterSay)).toBe(true)
        expect(isTurnStart(p.queuedBatch(["one", "two"]), afterSay)).toBe(true)
    })

    it("does not open a turn for replies tagged as interaction answers", () => {
        const p = new ProducerRows()
        expect(isTurnStart(p.consumedReply("yes"), afterSay)).toBe(false)
        const command = { ...p.consumedReply("x"), interactionId: "command:7" }
        const toolFeedback = { ...p.consumedReply("x"), interactionId: "tool-feedback:9" }
        expect(isTurnStart(command, afterSay)).toBe(false)
        expect(isTurnStart(toolFeedback, afterSay)).toBe(false)
    })

    it.each([
        "followup",
        "make_plan",
        "generate_report",
        "qna_respond",
        "tool",
        "command",
    ] as const)("treats an untagged sayFeedbackOnce reply after a %s ask as a tool reply", async (ask) => {
        const p = new ProducerRows()
        const reply = await p.toolReply("my answer")
        expect(reply.interactionId).toBeUndefined()
        expect(reply.userInputKind).toBeUndefined()
        expect(isTurnStart(reply, { lastAskKind: ask })).toBe(false)
    })

    it("treats an untagged reply after an accepted completion, a resume ask or a say row as a new turn", async () => {
        const p = new ProducerRows()
        const reply = await p.toolReply("next thing")
        expect(isTurnStart(reply, { lastAskKind: "completion_result" })).toBe(true)
        expect(isTurnStart(reply, { lastAskKind: "resume_task" })).toBe(true)
        expect(isTurnStart(reply, afterSay)).toBe(true)
    })

    it("never opens a turn from a partial row or a non-feedback row", () => {
        const p = new ProducerRows()
        expect(isTurnStart({ ...p.directInput("draft"), partial: true }, afterSay)).toBe(false)
        expect(isTurnStart(p.say("text", "model words"), afterSay)).toBe(false)
        expect(isTurnStart(p.ask("followup", "?"), afterSay)).toBe(false)
    })

    it("classifies the completion ask outside the tool-dialog set", () => {
        expect(TOOL_DIALOG_ASKS.has("completion_result")).toBe(false)
        expect(TOOL_DIALOG_ASKS.has("followup")).toBe(true)
    })
})

describe("isSuccessfulCompletion", () => {
    it("accepts a presented completion and a say completion with text, but not a refused empty one", () => {
        const p = new ProducerRows()
        expect(isSuccessfulCompletion(p.acceptedCompletion())).toBe(true)
        expect(isSuccessfulCompletion(p.say("completion_result", "result text"))).toBe(true)
        expect(isSuccessfulCompletion(p.refusedCompletion())).toBe(false)
        expect(isSuccessfulCompletion({ ...p.acceptedCompletion(), partial: true })).toBe(false)
    })
})

describe("row aggregation keys", () => {
    it("counts only final api_req_started rows as rounds", () => {
        const p = new ProducerRows()
        expect(isCountedRound(p.apiRequest())).toBe(true)
        expect(isCountedRound({ ...p.apiRequest(), partial: true })).toBe(false)
        expect(isCountedRound(p.say("api_req_finished"))).toBe(false)
        expect(isCountedRound(p.say("error_retry"))).toBe(false)
    })

    it("keys tool calls and excludes checkpoints, the compaction card and helper rows", () => {
        const p = new ProducerRows()
        expect(trajectoryToolKey(p.tool("readFile"))).toBe("readFile")
        expect(trajectoryToolKey(p.ask("command", "npm test"))).toBe("execute_command")
        expect(trajectoryToolKey(p.ask("followup", "{}"))).toBe("ask_followup_question")
        expect(trajectoryToolKey(p.checkpoint("abc"))).toBeUndefined()
        expect(trajectoryToolKey(p.compactionCard())).toBeUndefined()
        expect(trajectoryToolKey(p.say("command_output", "ok"))).toBeUndefined()
        expect(trajectoryToolKey(p.say("deleted_api_reqs", "{}"))).toBeUndefined()
        expect(trajectoryToolKey(p.say("tool", "not json"))).toBeUndefined()
        expect(trajectoryToolKey({ ...p.tool("readFile"), partial: true })).toBeUndefined()
    })

    it("counts rows still written under a renamed tool's former key under its current name", () => {
        const p = new ProducerRows()
        expect(trajectoryToolKey(p.tool("actModeRespond"))).toBe("working_respond")
        expect(trajectoryToolKey(p.tool("statusUpdate"))).toBe("phase_report")
    })
})
