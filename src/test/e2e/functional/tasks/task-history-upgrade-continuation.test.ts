import { copyFile, mkdir } from "node:fs/promises"
import * as path from "node:path"
import { expectComposerText } from "@e2e/utils/composer"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Page } from "@playwright/test"

// A task written by a Dline build that predates the journal runtime: a task-history row, chat rows and the
// conversation file, with no journal and no state.json.
const TASK_ID = "1790708947870"
const TASK_TEXT = "E2E_HISTORY_TASK_1790708947870"
const SAVED_TURNS = [
    "E2E_HISTORY_1790708947870_ORIGINAL_REQUEST",
    "E2E_HISTORY_1790708947870_FIRST_ASSISTANT_TURN",
    "E2E_HISTORY_1790708947870_FOLLOWUP",
    "E2E_HISTORY_1790708947870_CURRENT_OPENING_BODY",
]
const RESTORED_SESSION = "The previous task session was closed and has now been restored."
const FIRST_FOLLOW_UP = "E2E_UPGRADE_CONTINUATION_FIRST_FOLLOW_UP"
const FIRST_REPLY = "E2E_UPGRADE_CONTINUATION_FIRST_REPLY"
const SECOND_FOLLOW_UP = "E2E_UPGRADE_CONTINUATION_SECOND_FOLLOW_UP"
const SECOND_REPLY = "E2E_UPGRADE_CONTINUATION_SECOND_REPLY"
const FIXTURE_DIRECTORY = path.join(
    E2ETestHelper.CODEBASE_ROOT_DIR,
    "src",
    "test",
    "e2e",
    "fixtures",
    "history-task-1790708947870",
)

async function seedEarlierVersionTask(dlineDocsDir: string): Promise<void> {
    const tasksDirectory = path.join(dlineDocsDir, "tasks")
    const taskDirectory = path.join(tasksDirectory, TASK_ID)
    await mkdir(taskDirectory, { recursive: true })
    await Promise.all([
        copyFile(path.join(FIXTURE_DIRECTORY, "taskHistory.jsonl"), path.join(tasksDirectory, "taskHistory.jsonl")),
        copyFile(path.join(FIXTURE_DIRECTORY, "ui_messages.jsonl"), path.join(taskDirectory, "ui_messages.jsonl")),
        copyFile(
            path.join(FIXTURE_DIRECTORY, "api_conversation_history.jsonl"),
            path.join(taskDirectory, "api_conversation_history.jsonl"),
        ),
    ])
}

async function openHistoryTask(page: Page, sidebar: Frame): Promise<void> {
    await page.getByRole("button", { name: "History", exact: true }).click()
    await E2ETestHelper.dismissWhatsNewModal(sidebar)
    const allTasks = sidebar.getByRole("button", { name: "All", exact: true })
    if (await allTasks.isVisible()) await allTasks.click()
    const historyTask = sidebar.locator(".history-item").filter({ hasText: TASK_TEXT })
    await expect(historyTask).toHaveCount(1, { timeout: 30_000 })
    await historyTask.click()
    await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible({ timeout: 30_000 })
}

/** Every text the request sent, in order, so the position of the migrated turns can be checked. */
function requestTexts(requestBody: unknown): string {
    return JSON.stringify((requestBody as { messages?: unknown }).messages ?? [])
}

function occurrences(haystack: string, needle: string): number {
    return haystack.split(needle).length - 1
}

/** The migrated turns appear once, in their original order, before everything the user sent after the upgrade. */
function expectMigratedConversationFirst(body: string, laterTexts: readonly string[]): void {
    let cursor = -1
    for (const turn of SAVED_TURNS) {
        expect(occurrences(body, turn), `${turn} must be sent exactly once`).toBe(1)
        const index = body.indexOf(turn)
        expect(index, `${turn} must follow the previous migrated turn`).toBeGreaterThan(cursor)
        cursor = index
    }
    for (const text of laterTexts) expect(body.indexOf(text)).toBeGreaterThan(cursor)
}

e2e(
    "History upgrade - a conversation from an older Dline build continues with its history after Resume",
    async ({ dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(240_000)
        await seedEarlierVersionTask(dlineDocsDir)
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses(
            {
                type: "tool",
                id: "call_upgrade_continuation_first",
                name: "attempt_completion",
                arguments: { result: FIRST_REPLY },
                expectedRequestIncludes: [...SAVED_TURNS, RESTORED_SESSION, FIRST_FOLLOW_UP],
            },
            {
                type: "tool",
                id: "call_upgrade_continuation_second",
                name: "attempt_completion",
                arguments: { result: SECOND_REPLY },
                expectedRequestIncludes: [...SAVED_TURNS, FIRST_FOLLOW_UP, SECOND_FOLLOW_UP],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const page = await app.firstWindow()
            await E2ETestHelper.openClineSidebar(page)
            const sidebar = await helper.getSidebar(page)
            await helper.signin(sidebar)
            await openHistoryTask(page, sidebar)

            const resume = sidebar.getByRole("contentinfo").locator('[data-testid="send-button"][data-action="resume"]')
            await expect(resume).toHaveAttribute("aria-disabled", "false", { timeout: 30_000 })
            const input = sidebar.getByTestId("chat-input")
            await input.fill(FIRST_FOLLOW_UP)
            await resume.click()
            await expectComposerText(input, "")
            await expect(sidebar.getByText(FIRST_REPLY, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await expect.poll(() => server.openAiRequestCount, { timeout: 30_000 }).toBe(1)

            const [resumed] = server.getMockConsumptions("openai-compatible-chat")
            expect(resumed.contractError).toBeUndefined()
            expectMigratedConversationFirst(requestTexts(resumed.requestBody), [FIRST_FOLLOW_UP])

            // A second turn proves the migrated history now lives in the task, not only in the first request.
            await input.fill(SECOND_FOLLOW_UP)
            await sidebar.getByTestId("send-button").click()
            await expect(sidebar.getByText(SECOND_REPLY, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await expect.poll(() => server.openAiRequestCount, { timeout: 30_000 }).toBe(2)

            const continued = server.getMockConsumptions("openai-compatible-chat")[1]
            expect(continued.contractError).toBeUndefined()
            expectMigratedConversationFirst(requestTexts(continued.requestBody), [FIRST_FOLLOW_UP, SECOND_FOLLOW_UP])
            await expect(sidebar.getByText("API Request Failed", { exact: true })).toHaveCount(0)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)
