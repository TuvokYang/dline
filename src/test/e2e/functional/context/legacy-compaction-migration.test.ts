import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Page } from "@playwright/test"

const TASK_ID = "1791540300001"
const TASK_TEXT = "E2E_LEGACY_COMPACTION_MIGRATION_TASK"
const OPENING = "E2E_LEGACY_COMPACTION_OPENING"
const FIRST_ANSWER = "E2E_LEGACY_COMPACTION_FIRST_ANSWER"
const COVERED_FOLLOW_UP = "E2E_LEGACY_COMPACTION_COVERED_FOLLOW_UP"
const COVERED_ANSWER = "E2E_LEGACY_COMPACTION_COVERED_ANSWER"
const KEPT_FOLLOW_UP = "E2E_LEGACY_COMPACTION_KEPT_FOLLOW_UP"
const KEPT_ANSWER = "E2E_LEGACY_COMPACTION_KEPT_ANSWER"
const SUMMARY = "E2E_LEGACY_COMPACTION_SUMMARY"
const RESUME_INPUT = "E2E_LEGACY_COMPACTION_RESUME_INPUT"
const COMPLETED = "E2E_LEGACY_COMPACTION_RESUMED"

const apiHistory = [
    { role: "user", content: [{ type: "text", text: OPENING }], ts: 1 },
    { role: "assistant", content: [{ type: "text", text: FIRST_ANSWER }], ts: 2 },
    { role: "user", content: [{ type: "text", text: COVERED_FOLLOW_UP }], ts: 3 },
    { role: "assistant", content: [{ type: "text", text: COVERED_ANSWER }], ts: 4 },
    { role: "user", content: [{ type: "text", text: KEPT_FOLLOW_UP }], ts: 5 },
    { role: "assistant", content: [{ type: "text", text: KEPT_ANSWER }], ts: 6 },
]

async function seedLegacyCompactedTask(dlineDocsDir: string): Promise<void> {
    const tasksDir = path.join(dlineDocsDir, "tasks")
    const taskDir = path.join(tasksDir, TASK_ID)
    await mkdir(taskDir, { recursive: true })
    const historyItem = {
        id: TASK_ID,
        ts: Number(TASK_ID),
        task: TASK_TEXT,
        tokensIn: 420_000,
        tokensOut: 8_000,
        cacheWrites: 0,
        cacheReads: 0,
        totalCost: 0,
        size: 1,
        isFavorited: false,
    }
    const compactionCard = {
        ts: Number(TASK_ID) + 10,
        type: "say",
        say: "tool",
        text: JSON.stringify({
            tool: "summarizeTask",
            content: SUMMARY,
            compactionStatus: "completed",
            compactionDurable: true,
        }),
        partial: false,
        conversationHistoryIndex: 3,
        compactionConversationRange: {
            logicalTurnRange: [0, 1],
            apiConversationRange: [0, 3],
            preCompactionApiEndIndex: 5,
        },
    }
    const uiMessages = [
        { ts: Number(TASK_ID), type: "say", say: "task", text: TASK_TEXT, partial: false },
        { ts: Number(TASK_ID) + 1, type: "say", say: "user_feedback", text: OPENING, conversationHistoryIndex: 0 },
        { ts: Number(TASK_ID) + 2, type: "say", say: "text", text: FIRST_ANSWER, conversationHistoryIndex: 1 },
        compactionCard,
        { ts: Number(TASK_ID) + 11, type: "say", say: "user_feedback", text: KEPT_FOLLOW_UP, conversationHistoryIndex: 4 },
        { ts: Number(TASK_ID) + 12, type: "say", say: "text", text: KEPT_ANSWER, conversationHistoryIndex: 5 },
    ]
    await Promise.all([
        writeFile(path.join(tasksDir, "taskHistory.jsonl"), `${JSON.stringify(historyItem)}\n`, "utf8"),
        writeFile(
            path.join(taskDir, "api_conversation_history.jsonl"),
            `${apiHistory.map((row) => JSON.stringify(row)).join("\n")}\n`,
            "utf8",
        ),
        writeFile(
            path.join(taskDir, "ui_messages.jsonl"),
            `${uiMessages.map((row) => JSON.stringify(row)).join("\n")}\n`,
            "utf8",
        ),
    ])
}

async function openHistoryTask(page: Page, sidebar: Frame, taskText = TASK_TEXT): Promise<void> {
    await page.getByRole("button", { name: "History", exact: true }).click()
    await E2ETestHelper.dismissWhatsNewModal(sidebar)
    const allTasks = sidebar.getByRole("button", { name: "All", exact: true })
    if (await allTasks.isVisible()) await allTasks.click()
    const task = sidebar.locator(".history-item").filter({ hasText: taskText })
    await expect(task).toHaveCount(1, { timeout: 30_000 })
    await task.click()
    await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible({ timeout: 30_000 })
}

async function seedLegacyTruncatedToolTask(dlineDocsDir: string): Promise<{ taskId: string; taskText: string }> {
    const taskId = "1791540300002"
    const taskText = "E2E_LEGACY_TRUNCATED_TOOL_TASK"
    const tasksDir = path.join(dlineDocsDir, "tasks")
    const taskDir = path.join(tasksDir, taskId)
    await mkdir(taskDir, { recursive: true })
    const history = [
        { role: "user", content: [{ type: "text", text: "E2E_LEGACY_TRUNCATE_OPENING" }], ts: 1 },
        { role: "assistant", content: [{ type: "text", text: "E2E_LEGACY_TRUNCATE_FIRST_ANSWER" }], ts: 2 },
        { role: "user", content: [{ type: "text", text: "E2E_LEGACY_TRUNCATE_REMOVED_USER" }], ts: 3 },
        { role: "assistant", content: [{ type: "text", text: "E2E_LEGACY_TRUNCATE_REMOVED_ASSISTANT" }], ts: 4 },
        { role: "user", content: [{ type: "text", text: "E2E_LEGACY_TRUNCATE_KEPT_USER" }], ts: 5 },
        {
            role: "assistant",
            content: [
                {
                    type: "tool_use",
                    function_id: "call_legacy_truncate_read",
                    dline_tid: "tid_legacy_truncate_read",
                    name: "read_file",
                    input: { path: "E2E_LEGACY_TRUNCATE_TOOL_PATH" },
                },
            ],
            ts: 6,
        },
        {
            role: "user",
            content: [
                {
                    type: "tool_result",
                    function_id: "call_legacy_truncate_read",
                    dline_tid: "tid_legacy_truncate_read",
                    content: "E2E_LEGACY_TRUNCATE_TOOL_RESULT",
                },
            ],
            ts: 7,
        },
        { role: "assistant", content: [{ type: "text", text: "E2E_LEGACY_TRUNCATE_KEPT_ANSWER" }], ts: 8 },
    ]
    const historyItem = {
        id: taskId,
        ts: Number(taskId),
        task: taskText,
        tokensIn: 420_000,
        tokensOut: 8_000,
        cacheWrites: 0,
        cacheReads: 0,
        totalCost: 0,
        size: 1,
        isFavorited: false,
        conversationHistoryDeletedRange: [2, 3],
    }
    const uiMessages = [
        { ts: Number(taskId), type: "say", say: "task", text: taskText, partial: false },
        {
            ts: Number(taskId) + 1,
            type: "say",
            say: "text",
            text: "E2E_LEGACY_TRUNCATE_KEPT_ANSWER",
            conversationHistoryIndex: 7,
        },
    ]
    await Promise.all([
        writeFile(path.join(tasksDir, "taskHistory.jsonl"), `${JSON.stringify(historyItem)}\n`, "utf8"),
        writeFile(
            path.join(taskDir, "api_conversation_history.jsonl"),
            `${history.map((row) => JSON.stringify(row)).join("\n")}\n`,
            "utf8",
        ),
        writeFile(
            path.join(taskDir, "ui_messages.jsonl"),
            `${uiMessages.map((row) => JSON.stringify(row)).join("\n")}\n`,
            "utf8",
        ),
    ])
    return { taskId, taskText }
}

e2e(
    "Legacy compaction migration - Resume preserves the completed summary range instead of replaying covered JSONL turns",
    async ({ dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(240_000)
        await seedLegacyCompactedTask(dlineDocsDir)
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses({
            type: "tool",
            id: "call_legacy_compaction_resumed",
            name: "attempt_completion",
            arguments: { result: COMPLETED },
            expectedRequestIncludes: ["<previous_task_compaction_summary>", SUMMARY, KEPT_FOLLOW_UP, KEPT_ANSWER, RESUME_INPUT],
            expectedRequestExcludes: [OPENING, FIRST_ANSWER, COVERED_FOLLOW_UP, COVERED_ANSWER],
            matchRequestContract: true,
        })

        const app = await openVSCode(workspaceDir)
        try {
            const page = await app.firstWindow()
            await E2ETestHelper.openClineSidebar(page)
            const sidebar = await helper.getSidebar(page)
            await helper.signin(sidebar)
            await openHistoryTask(page, sidebar)

            const input = sidebar.getByTestId("chat-input")
            await input.fill(RESUME_INPUT)
            await sidebar.getByRole("contentinfo").locator('[data-testid="send-button"][data-action="resume"]').click()
            await expect(sidebar.getByText(COMPLETED, { exact: false }).last()).toBeVisible({ timeout: 60_000 })

            const [request] = server.getMockConsumptions("openai-compatible-chat")
            expect(request.contractError).toBeUndefined()
            const body = JSON.stringify(request.requestBody)
            for (const marker of [SUMMARY, KEPT_FOLLOW_UP, KEPT_ANSWER, RESUME_INPUT]) expect(body).toContain(marker)
            for (const marker of [OPENING, FIRST_ANSWER, COVERED_FOLLOW_UP, COVERED_ANSWER]) expect(body).not.toContain(marker)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Legacy truncation migration - Resume excludes the deleted range and keeps the surviving tool pair",
    async ({ dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(240_000)
        const { taskText } = await seedLegacyTruncatedToolTask(dlineDocsDir)
        const resumeInput = "E2E_LEGACY_TRUNCATE_RESUME_INPUT"
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses({
            type: "tool",
            id: "call_legacy_truncate_complete",
            name: "attempt_completion",
            arguments: { result: "E2E_LEGACY_TRUNCATE_RESUMED" },
            expectedRequestIncludes: [
                "E2E_LEGACY_TRUNCATE_OPENING",
                "E2E_LEGACY_TRUNCATE_FIRST_ANSWER",
                "E2E_LEGACY_TRUNCATE_KEPT_USER",
                "call_legacy_truncate_read",
                "E2E_LEGACY_TRUNCATE_TOOL_RESULT",
                "E2E_LEGACY_TRUNCATE_KEPT_ANSWER",
                resumeInput,
            ],
            expectedRequestExcludes: ["E2E_LEGACY_TRUNCATE_REMOVED_USER", "E2E_LEGACY_TRUNCATE_REMOVED_ASSISTANT"],
            matchRequestContract: true,
            requireCompleteToolPairing: true,
        })

        const app = await openVSCode(workspaceDir)
        try {
            const page = await app.firstWindow()
            await E2ETestHelper.openClineSidebar(page)
            const sidebar = await helper.getSidebar(page)
            await helper.signin(sidebar)
            await openHistoryTask(page, sidebar, taskText)
            await sidebar.getByTestId("chat-input").fill(resumeInput)
            await sidebar.getByRole("contentinfo").locator('[data-testid="send-button"][data-action="resume"]').click()
            await expect(sidebar.getByText("E2E_LEGACY_TRUNCATE_RESUMED", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            const [request] = server.getMockConsumptions("openai-compatible-chat")
            expect(request.contractError).toBeUndefined()
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)
