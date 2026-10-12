import type { ToolUse } from "@core/assistant-message"
import { parseNewTaskAsk } from "@shared/new-task-ask"
import { beforeEach, describe, expect, it, vi } from "vitest"
import { NEW_TASK_FEEDBACK_CONTINUATION_MARKER } from "../../../new-task/new-task-continuation"
import { DefaultToolHandlerState } from "../../state/ToolHandlerState"
import type { TaskConfig } from "../../types/TaskConfig"
import { sayFeedbackOnce } from "../../utils/UserFeedbackUtils"
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

    it("hands the successor exactly the task and context, ignoring any draft on approve", async () => {
        const config = createConfig({
            actionId: "approve",
            text: "This draft must not travel",
            images: ["data:image/png;base64,AAAA"],
            files: ["/workspace/notes.pdf"],
        })

        const result = await new NewTaskHandler().execute(config, createBlock(SUCCESSOR))

        expect(config.interactions.open).toHaveBeenCalledWith(
            expect.objectContaining({ kind: "new_task", interactionId: "tid-new-task", existingTs: 100 }),
        )
        const presentation = vi.mocked(config.interactions.open).mock.calls[0][0].presentation
        expect(parseNewTaskAsk(presentation)).toEqual(SUCCESSOR)
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
        expect(sayFeedbackOnce).not.toHaveBeenCalled()
    })

    it("returns Regenerate Context feedback to the model as a marked result instead of handing off", async () => {
        const config = createConfig({ actionId: "reject", text: "Narrow the scope", files: ["/workspace/a.md"] })

        const result = await new NewTaskHandler().execute(config, createBlock(SUCCESSOR))

        expect(result).not.toHaveProperty("postCommit")
        expect(result).toEqual([
            {
                type: "text",
                text: `${NEW_TASK_FEEDBACK_CONTINUATION_MARKER}\nThe user provided feedback instead of creating a new task:\n<feedback>\nNarrow the scope\n</feedback>`,
            },
        ])
        expect(sayFeedbackOnce).toHaveBeenCalledWith(
            config,
            "noButtonClicked",
            "Narrow the scope",
            [],
            ["/workspace/a.md"],
            expect.objectContaining({ actionId: "reject" }),
        )
    })

    it("keeps attached PDFs of the feedback as documents beside the current task's tool result", async () => {
        const config = createConfig({ actionId: "reject", text: "See the spec", files: ["/workspace/spec.pdf"] })

        const result = await new NewTaskHandler().execute(config, createBlock(SUCCESSOR))

        expect(result).not.toHaveProperty("postCommit")
        expect(result).toMatchObject({
            documents: [{ type: "document", source: { data: "/workspace/spec.pdf" } }],
        })
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
