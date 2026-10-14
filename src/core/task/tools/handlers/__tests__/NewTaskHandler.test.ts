import type { ToolUse } from "@core/assistant-message"
import { parseNewTaskAsk } from "@shared/new-task-ask"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NEW_TASK_FEEDBACK_CONTINUATION_MARKER } from "../../../new-task/new-task-continuation"
import { DefaultToolHandlerState } from "../../state/ToolHandlerState"
import type { TaskConfig } from "../../types/TaskConfig"
import { NewTaskHandler } from "../NewTaskHandler"

vi.mock("@core/prompts/i18n", () => ({
    getPrompt: vi.fn(() => "New task confirmed"),
}))

vi.mock("@core/prompts/responses", () => ({
    formatResponse: {
        toolResult: vi.fn((text: string, images?: string[], fileContent?: string) =>
            images || fileContent
                ? [{ type: "text", text }, ...(images ?? []).map((image) => ({ type: "image", source: image }))]
                : text,
        ),
        newTaskDeclinedFeedback: vi.fn(
            (feedback: string) =>
                `The user provided feedback instead of creating a new task:\n<feedback>\n${feedback}\n</feedback>`,
        ),
    },
}))

vi.mock("@integrations/notifications", () => ({
    showSystemNotification: vi.fn(),
}))

vi.mock("../../utils/UserFeedbackUtils", () => ({
    sayFeedbackOnce: vi.fn(async () => undefined),
    // PDFs become native documents; every other file is inlined as text.
    attachToolFeedbackFiles: vi.fn(async (files?: string[]) => ({
        text: (files ?? []).filter((file) => !file.endsWith(".pdf")).join(","),
        documents: (files ?? [])
            .filter((file) => file.endsWith(".pdf"))
            .map((file) => ({ type: "document", source: { type: "base64", media_type: "application/pdf", data: file } })),
    })),
}))

interface InteractionResult {
    actionId: "approve" | "reject"
    text?: string
    images?: string[]
    files?: string[]
}

/** Create a minimal handler configuration with one causal interaction result. */
function createConfig(result: InteractionResult): TaskConfig {
    return {
        taskId: "task-new",
        ulid: "ulid-new",
        cwd: "/workspace",
        mode: "act",
        taskState: new DefaultToolHandlerState(),
        autoApprovalSettings: { enableNotifications: false },
        interactions: {
            open: vi.fn(async () => ({
                actionId: result.actionId,
                draft: {
                    text: result.text ?? "",
                    images: result.images ?? [],
                    files: result.files ?? [],
                },
            })),
        },
        callbacks: {
            sayAndCreateMissingParamError: vi.fn(async (_tool: string, param: string) => `missing ${param}`),
        } as unknown as TaskConfig["callbacks"],
    } as unknown as TaskConfig
}

/** Create one new_task tool block with canonical identity. */
function createBlock(params: { task?: string; context?: string }, partial = false): ToolUse {
    return {
        type: "tool_use",
        name: "new_task",
        dline_tid: "tid-new-task",
        function_id: "function-new-task",
        ts: 100,
        params,
        partial,
    } as ToolUse
}

const SUCCESSOR = { task: "Finish the migration", context: "Successor task context" }

describe("NewTaskHandler", () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it("executes an externally approved handoff without opening a second interaction", async () => {
        const config = createConfig({ actionId: "approve" })

        const result = await new NewTaskHandler().execute(config, createBlock(SUCCESSOR))

        expect(config.interactions.open).not.toHaveBeenCalled()
        expect(result).toEqual({
            response: "New task confirmed",
            postCommit: {
                type: "start_successor_task",
                task: SUCCESSOR.task,
                context: SUCCESSOR.context,
                functionId: "function-new-task",
                dlineTid: "tid-new-task",
            },
        })
    })

    it("describes an external rejection with the continuation marker", async () => {
        const handler = new NewTaskHandler()
        const denial = await handler.describeDenial(createConfig({ actionId: "reject" }), createBlock(SUCCESSOR))

        expect(denial).toBe(
            `${NEW_TASK_FEEDBACK_CONTINUATION_MARKER}\nThe user provided feedback instead of creating a new task:\n<feedback>\n\n</feedback>`,
        )
    })

    it.each([
        ["task", { context: "Successor task context" }],
        ["context", { task: "Finish the migration" }],
    ] as const)("refuses a handoff without a %s before asking the user", async (missing, params) => {
        const config = createConfig({ actionId: "approve" })

        const result = await new NewTaskHandler().execute(config, createBlock(params))

        expect(result).toBe(`missing ${missing}`)
        expect(config.callbacks.sayAndCreateMissingParamError).toHaveBeenCalledWith("new_task", missing, undefined, 100)
        expect(config.interactions.open).not.toHaveBeenCalled()
    })

    it("streams both halves of the handoff into the partial preview", async () => {
        const ask = vi.fn(async (_tool: string, _text: string, _partial: boolean, _options: { existingTs: number }) => undefined)
        const uiHelpers = { removeClosingTag: (_block: ToolUse, _tag: string, text?: string) => text ?? "", ask }

        await new NewTaskHandler().handlePartialBlock(createBlock({ task: "Finish the" }, true), uiHelpers as never)

        expect(ask).toHaveBeenCalledWith("new_task", expect.any(String), true, { existingTs: 100 })
        expect(parseNewTaskAsk(ask.mock.calls[0][1])).toEqual({ task: "Finish the", context: "" })
    })
})
