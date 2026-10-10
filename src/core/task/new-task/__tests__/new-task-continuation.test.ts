import type { ToolUse } from "@core/assistant-message"
import { ExplicitInstructionRegistry } from "@core/task/explicit-instructions/ExplicitInstructionRegistry"
import { ExplicitInstructionRequestScope } from "@core/task/explicit-instructions/ExplicitInstructionRequestScope"
import type { ClineContent, ClineStorageMessage, ClineUserToolResultContentBlock } from "@shared/messages/content"
import { ClineDefaultTool } from "@shared/tools"
import { describe, expect, it } from "vitest"
import {
    deriveNewTaskFeedbackContinuation,
    deriveNewTaskFeedbackContinuationFromConversation,
    NEW_TASK_FEEDBACK_CONTINUATION_MARKER,
} from "../new-task-continuation"

/** Create one complete assistant tool block with canonical identities. */
function newTaskTool(overrides: Partial<ToolUse> = {}): ToolUse {
    return {
        type: "tool_use",
        name: ClineDefaultTool.NEW_TASK,
        params: { context: "Candidate successor context" },
        partial: false,
        ts: 100,
        function_id: "function-new-task",
        dline_tid: "tid-new-task",
        ...overrides,
    }
}

/** Create one handler-owned feedback result paired to the assistant tool. */
function feedbackResult(overrides: Partial<ClineUserToolResultContentBlock> = {}): ClineUserToolResultContentBlock {
    return {
        type: "tool_result",
        function_id: "function-new-task",
        dline_tid: "tid-new-task",
        content: [
            { type: "text", text: NEW_TASK_FEEDBACK_CONTINUATION_MARKER },
            { type: "text", text: "The user requested a narrower migration context." },
        ],
        ...overrides,
    }
}

/** Derive from one current ordinary request fixture. */
function derive(userContent: readonly ClineContent[], assistantContent: readonly ToolUse[] = [newTaskTool()]) {
    return deriveNewTaskFeedbackContinuation({ userContent, assistantContent, persistedRequest: false })
}

/** One assistant turn that declared the given tools. */
function assistantTurn(...tools: ToolUse[]): ClineStorageMessage {
    return {
        role: "assistant",
        content: tools.map((tool) => ({
            type: "tool_use" as const,
            id: tool.function_id ?? "",
            name: tool.name,
            input: tool.params,
            function_id: tool.function_id ?? "",
            dline_tid: tool.dline_tid ?? "",
        })),
    } as ClineStorageMessage
}

/** One user message carrying the given content. */
function userTurn(...content: ClineContent[]): ClineStorageMessage {
    return { role: "user", content } as ClineStorageMessage
}

describe("New Task feedback continuation from the request conversation", () => {
    it("grants the round that answers a feedback result", () => {
        const declaration = deriveNewTaskFeedbackContinuationFromConversation([
            userTurn({ type: "text", text: "/newtask" }),
            assistantTurn(newTaskTool()),
            userTurn(feedbackResult()),
            userTurn({ type: "text", text: "<environment_details/>" }),
        ])

        expect(declaration).toMatchObject({ type: "new_task", source: "internal_continuation", targetTool: "new_task" })
    })

    it("grants nothing once a later assistant turn answered the feedback", () => {
        expect(
            deriveNewTaskFeedbackContinuationFromConversation([
                assistantTurn(newTaskTool()),
                userTurn(feedbackResult()),
                assistantTurn(newTaskTool({ function_id: "function-later", dline_tid: "tid-later" })),
                userTurn({ type: "text", text: "ordinary reply" }),
            ]),
        ).toBeUndefined()
    })

    it("grants nothing to a conversation without an assistant turn", () => {
        expect(deriveNewTaskFeedbackContinuationFromConversation([userTurn(feedbackResult())])).toBeUndefined()
    })
})

describe("New Task feedback continuation", () => {
    it("derives a fresh internal one-shot declaration from a canonical feedback pair", () => {
        const declaration = derive([feedbackResult()])

        expect(declaration).toEqual({
            type: "new_task",
            source: "internal_continuation",
            targetTool: ClineDefaultTool.NEW_TASK,
            operationId: "new-task-feedback:tid-new-task",
            metadata: {
                functionId: "function-new-task",
                dlineTid: "tid-new-task",
            },
        })

        const registry = new ExplicitInstructionRegistry()
        const scope = new ExplicitInstructionRequestScope(registry, { requestId: "request-2", attemptId: "attempt-1" })
        scope.register(declaration!)
        const port = scope.createConsumePort()

        expect(port.consumeTool(ClineDefaultTool.NEW_TASK)).toMatchObject({ ok: true })
        expect(port.consumeTool(ClineDefaultTool.NEW_TASK)).toEqual({
            ok: false,
            code: "explicit_instruction_already_consumed",
        })
    })

    it.each([
        {
            name: "ordinary user text",
            userContent: [{ type: "text", text: NEW_TASK_FEEDBACK_CONTINUATION_MARKER }] satisfies ClineContent[],
            assistantContent: [newTaskTool()],
            persistedRequest: false,
        },
        {
            name: "wrong assistant tool",
            userContent: [feedbackResult()],
            assistantContent: [newTaskTool({ name: ClineDefaultTool.QNA_RESPOND })],
            persistedRequest: false,
        },
        {
            name: "function identity mismatch",
            userContent: [feedbackResult({ function_id: "function-forged" })],
            assistantContent: [newTaskTool()],
            persistedRequest: false,
        },
        {
            name: "Dline lifecycle identity mismatch",
            userContent: [feedbackResult({ dline_tid: "tid-forged" })],
            assistantContent: [newTaskTool()],
            persistedRequest: false,
        },
        {
            name: "approve result without marker",
            userContent: [feedbackResult({ content: [{ type: "text", text: "New task confirmed" }] })],
            assistantContent: [newTaskTool()],
            persistedRequest: false,
        },
        {
            name: "error result",
            userContent: [feedbackResult({ is_error: true })],
            assistantContent: [newTaskTool()],
            persistedRequest: false,
        },
        {
            name: "duplicate feedback results",
            userContent: [feedbackResult(), feedbackResult()],
            assistantContent: [newTaskTool()],
            persistedRequest: false,
        },
        {
            name: "persisted request replay",
            userContent: [feedbackResult()],
            assistantContent: [newTaskTool()],
            persistedRequest: true,
        },
    ])("rejects $name", ({ userContent, assistantContent, persistedRequest }) => {
        expect(deriveNewTaskFeedbackContinuation({ userContent, assistantContent, persistedRequest })).toBeUndefined()
    })
})
