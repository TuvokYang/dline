import { describe, expect, it } from "vitest"
import {
    askKindAfter,
    isContextIgnored,
    isCountedRound,
    isSuccessfulCompletion,
    isTurnStart,
    TOOL_DIALOG_ASKS,
    trajectoryToolKey,
} from "../TurnRules"
import { ProducerRows } from "./fixtures/producerRows"

const afterSay = { lastAskKind: null }

// Independent reply-role cases, not generated from the classification table.
const toolDialogAsks = [
    "followup",
    "make_plan",
    "act_mode_respond",
    "qna_respond",
    "generate_report",
    "command",
    "command_output",
    "tool",
    "browser_action_launch",
    "use_mcp_server",
    "new_task",
    "spawn_task",
    "condense",
    "change_todo_list",
    "summarize_task",
    "report_bug",
    "use_subagents",
    "status_acknowledgment",
] as const

const instructionAsks = [
    "completion_result",
    "resume_task",
    "resume_completed_task",
    "api_req_failed",
    "mistake_limit_reached",
] as const

const ignoredSays = [
    "checkpoint_created",
    "hook_status",
    "hook_output_stream",
    "info",
    "task_progress",
    "state_snapshot",
    "conditional_rules_applied",
    "subagent_usage",
    "api_req_finished",
    "api_req_retried",
    "deleted_api_reqs",
    "error_retry",
] as const

describe("isTurnStart", () => {
    it("opens turns for producer-shaped task, direct input and one-row queued batch", () => {
        const p = new ProducerRows()
        const task = p.task("build it")
        const direct = p.directInput("also add tests")
        const queued = p.queuedBatch(["one", "two"])
        expect(task).toMatchObject({ type: "say", say: "task", text: "build it", conversationHistoryIndex: 0 })
        expect(direct).toMatchObject({ type: "say", say: "user_feedback", text: "also add tests" })
        expect(direct.userInputKind).toBeUndefined()
        expect(direct.interactionId).toBeDefined()
        expect(queued).toMatchObject({ text: "one\n\ntwo", userInputKind: "queued", queuedInputMode: "queued" })
        expect(p.rows).toHaveLength(3)
        for (const row of [task, direct, queued]) {
            expect(isTurnStart(row, afterSay)).toBe(true)
            expect(isTurnStart(row, { lastAskKind: "followup" })).toBe(true)
        }
    })

    it.each([
        "reply:7",
        "command:7:2",
        "tool-feedback:9",
    ])("does not open a turn for feedback tagged as the interaction answer %s", (interactionId) => {
        const p = new ProducerRows()
        const row = { ...p.consumedReply("yes"), interactionId }
        expect(isTurnStart(row, afterSay)).toBe(false)
        expect(isTurnStart(row, { lastAskKind: "completion_result" })).toBe(false)
    })

    it.each(["direct", "queued"] as const)("honors explicit %s input over contextual or reply-id evidence", (userInputKind) => {
        const p = new ProducerRows()
        const row = { ...p.consumedReply("new instruction"), userInputKind }
        expect(isTurnStart(row, { lastAskKind: "followup" })).toBe(true)
        expect(isTurnStart({ ...row, partial: true }, afterSay)).toBe(false)
    })

    it.each(toolDialogAsks)("keeps an untagged sayFeedbackOnce answer to %s in the same turn", async (ask) => {
        const p = new ProducerRows()
        const reply = await p.toolReply("my answer")
        expect(p.rows).toHaveLength(1)
        expect(reply).toMatchObject({ type: "say", say: "user_feedback", text: "my answer" })
        expect(reply.interactionId).toBeUndefined()
        expect(reply.userInputKind).toBeUndefined()
        expect(isTurnStart(reply, { lastAskKind: ask })).toBe(false)
        expect(TOOL_DIALOG_ASKS.has(ask)).toBe(true)
    })

    it("keeps a structured sayUserReply answer untagged as well", async () => {
        const p = new ProducerRows()
        const reply = await p.toolReply("resolved answer", {
            draft: {
                text: "resolved answer",
                images: [],
                files: [],
                semanticInput: {
                    schemaVersion: 1,
                    parserVersion: "test",
                    catalogRevision: "test",
                    documentId: "reply-document",
                    rawText: "typed answer",
                    nodes: [{ kind: "text", text: "typed answer" }],
                    resources: [],
                },
            },
        })
        expect(p.rows).toHaveLength(1)
        expect(reply).toMatchObject({
            text: "typed answer",
            submittedInputs: [{ segments: [{ text: "typed answer", role: "text", active: false }] }],
        })
        expect(reply.interactionId).toBeUndefined()
        expect(reply.userInputKind).toBeUndefined()
        expect(isTurnStart(reply, { lastAskKind: "make_plan" })).toBe(false)
    })

    it.each(instructionAsks)("opens a turn for an untagged instruction after %s", async (ask) => {
        const p = new ProducerRows()
        const reply = await p.toolReply("next thing")
        expect(isTurnStart(reply, { lastAskKind: ask })).toBe(true)
        expect(TOOL_DIALOG_ASKS.has(ask)).toBe(false)
    })

    it("opens a legacy untagged instruction after a meaningful say or no preceding row", async () => {
        const p = new ProducerRows()
        expect(isTurnStart(await p.toolReply("next thing"), afterSay)).toBe(true)
    })

    it("never opens a turn from a partial task, partial feedback or a non-user row", () => {
        const p = new ProducerRows()
        expect(isTurnStart({ ...p.task("draft task"), partial: true }, afterSay)).toBe(false)
        expect(isTurnStart({ ...p.directInput("draft input"), partial: true }, afterSay)).toBe(false)
        expect(isTurnStart({ ...p.queuedBatch(["draft"]), partial: true }, afterSay)).toBe(false)
        expect(isTurnStart(p.say("text", "model words"), afterSay)).toBe(false)
        expect(isTurnStart(p.ask("followup", "?"), afterSay)).toBe(false)
    })
})

describe("reply context", () => {
    it.each(ignoredSays)("ignores final %s rows without counting them", (say) => {
        const p = new ProducerRows()
        const row = p.say(say, "{}")
        expect(isContextIgnored(row)).toBe(true)
        expect(isCountedRound(row)).toBe(false)
        expect(trajectoryToolKey(row)).toBeUndefined()
    })

    it("ignores compaction and every partial shape, but not meaningful asks or says", () => {
        const p = new ProducerRows()
        expect(isContextIgnored(p.compactionCard())).toBe(true)
        expect(isContextIgnored({ ...p.ask("completion_result"), partial: true })).toBe(true)
        expect(isContextIgnored({ ...p.task("draft"), partial: true })).toBe(true)
        expect(isContextIgnored(p.ask("followup"))).toBe(false)
        expect(isContextIgnored(p.tool("readFile"))).toBe(false)
        expect(isContextIgnored(p.apiRequest())).toBe(false)
        expect(isContextIgnored(p.say("text", "model words"))).toBe(false)
    })

    it("leaves only the nearest meaningful ask kind as context", () => {
        const p = new ProducerRows()
        expect(askKindAfter(p.ask("followup"))).toBe("followup")
        expect(askKindAfter(p.ask("completion_result"))).toBe("completion_result")
        expect(askKindAfter(p.say("text", "model words"))).toBeNull()
        expect(askKindAfter(p.tool("readFile"))).toBeNull()
    })
})

describe("isSuccessfulCompletion", () => {
    it("accepts presented and nonempty say completions, but not refused or partial completions", () => {
        const p = new ProducerRows()
        expect(isSuccessfulCompletion(p.acceptedCompletion())).toBe(true)
        expect(isSuccessfulCompletion(p.say("completion_result", "result text"))).toBe(true)
        expect(isSuccessfulCompletion(p.refusedCompletion())).toBe(false)
        expect(isSuccessfulCompletion(p.say("completion_result", " \n\t"))).toBe(false)
        expect(isSuccessfulCompletion({ ...p.acceptedCompletion(), partial: true })).toBe(false)
        expect(isSuccessfulCompletion({ ...p.say("completion_result", "draft"), partial: true })).toBe(false)
        expect(isSuccessfulCompletion(p.ask("followup", "done?"))).toBe(false)
    })
})

describe("row aggregation keys", () => {
    it("counts only final api_req_started rows as rounds", () => {
        const p = new ProducerRows()
        expect(isCountedRound(p.apiRequest())).toBe(true)
        expect(isCountedRound({ ...p.apiRequest(), partial: true })).toBe(false)
        expect(isCountedRound(p.say("api_req_finished"))).toBe(false)
        expect(isCountedRound(p.say("api_req_retried"))).toBe(false)
        expect(isCountedRound(p.say("deleted_api_reqs"))).toBe(false)
        expect(isCountedRound(p.say("error_retry"))).toBe(false)
    })

    it.each([
        ["command", "execute_command"],
        ["use_mcp_server", "use_mcp_tool"],
        ["browser_action_launch", "browser_action"],
        ["use_subagents", "use_subagents"],
        ["followup", "ask_followup_question"],
        ["make_plan", "make_plan"],
        ["generate_report", "generate_report"],
        ["new_task", "new_task"],
        ["spawn_task", "spawn_task"],
        ["change_todo_list", "change_todo_list"],
    ] as const)("counts a final %s ask under %s", (ask, tool) => {
        const p = new ProducerRows()
        const row = p.ask(ask, "{}")
        expect(trajectoryToolKey(row)).toBe(tool)
        expect(trajectoryToolKey({ ...row, partial: true })).toBeUndefined()
    })

    it("keys generic and dedicated say tools while excluding infrastructure and helper output", () => {
        const p = new ProducerRows()
        expect(trajectoryToolKey(p.tool("readFile"))).toBe("readFile")
        expect(trajectoryToolKey(p.say("command", "npm test"))).toBe("execute_command")
        expect(trajectoryToolKey(p.say("load_mcp_documentation", "{}"))).toBe("load_mcp_documentation")
        expect(trajectoryToolKey(p.checkpoint("abc"))).toBeUndefined()
        expect(trajectoryToolKey(p.compactionCard())).toBeUndefined()
        expect(trajectoryToolKey(p.say("command_output", "ok"))).toBeUndefined()
        expect(trajectoryToolKey(p.say("mcp_server_response", "ok"))).toBeUndefined()
        expect(trajectoryToolKey(p.say("browser_action_result", "ok"))).toBeUndefined()
        expect(trajectoryToolKey(p.say("deleted_api_reqs", "{}"))).toBeUndefined()
        expect(trajectoryToolKey({ ...p.tool("readFile"), partial: true })).toBeUndefined()
    })

    it.each([
        "not json",
        "null",
        "[]",
        '"readFile"',
        "{}",
        '{"tool":7}',
        '{"tool":""}',
    ])("does not count a generic tool row without a declared tool name: %s", (text) => {
        const p = new ProducerRows()
        expect(trajectoryToolKey(p.say("tool", text))).toBeUndefined()
    })

    it("counts former row keys under the renamed tool's current name", () => {
        const p = new ProducerRows()
        expect(trajectoryToolKey(p.tool("actModeRespond"))).toBe("working_respond")
        expect(trajectoryToolKey(p.tool("statusUpdate"))).toBe("phase_report")
    })
})
