import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Page } from "@playwright/test"

// History renders a user's row from the facts fixed when it was submitted, never
// by reading its text against today's command catalog (WS-041 AC-20). Both tasks
// below name `/explain-changes`, a command the current catalog knows; only the
// facts decide whether it is drawn as one. The first task also ran a command the
// catalog has since withdrawn, which must still read as the command it was.

interface SeededTask {
    readonly id: string
    readonly text: string
    readonly submittedInputs?: unknown
}

const FACTS_TASK: SeededTask = {
    id: "1791780000001",
    text: "/retired-workflow E2E_SUBMITTED_FACTS_MARKER then /explain-changes",
    submittedInputs: [
        {
            segments: [
                // Ran when submitted; the current catalog no longer has it.
                { text: "/retired-workflow", role: "command", active: true },
                { text: " E2E_SUBMITTED_FACTS_MARKER then ", role: "text", active: false },
                // Known to today's catalog, but it was content when submitted.
                { text: "/explain-changes", role: "command", active: false },
            ],
        },
    ],
}

const LEGACY_TASK: SeededTask = {
    id: "1791780000002",
    text: "/explain-changes E2E_LEGACY_ROW_MARKER @/src/index.ts",
}

async function seedHistoryTask(dlineDocsDir: string, task: SeededTask): Promise<void> {
    const tasksDir = path.join(dlineDocsDir, "tasks")
    const taskDir = path.join(tasksDir, task.id)
    await mkdir(taskDir, { recursive: true })
    const historyItem = {
        id: task.id,
        ts: Number(task.id),
        task: task.text,
        tokensIn: 10,
        tokensOut: 10,
        cacheWrites: 0,
        cacheReads: 0,
        totalCost: 0,
        size: 1,
        isFavorited: false,
    }
    const apiHistory = [
        { role: "user", content: [{ type: "text", text: task.text }], ts: 1 },
        { role: "assistant", content: [{ type: "text", text: "E2E_SUBMITTED_FACTS_ANSWER" }], ts: 2 },
    ]
    const uiMessages = [
        {
            ts: Number(task.id),
            type: "say",
            say: "task",
            text: task.text,
            partial: false,
            ...(task.submittedInputs ? { submittedInputs: task.submittedInputs } : {}),
        },
        { ts: Number(task.id) + 1, type: "say", say: "text", text: "E2E_SUBMITTED_FACTS_ANSWER", conversationHistoryIndex: 1 },
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

async function openHistoryTask(page: Page, sidebar: Frame, marker: string): Promise<void> {
    await page.getByRole("button", { name: "History", exact: true }).click()
    await E2ETestHelper.dismissWhatsNewModal(sidebar)
    const allTasks = sidebar.getByRole("button", { name: "All", exact: true })
    if (await allTasks.isVisible()) await allTasks.click()
    const task = sidebar.locator(".history-item").filter({ hasText: marker })
    await expect(task).toHaveCount(1, { timeout: 30_000 })
    await task.click()
    await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible({ timeout: 30_000 })
}

/** The task header's text, which holds the highlighted entities the row was rendered with. */
function taskHeaderText(sidebar: Frame, marker: string) {
    return sidebar.locator(".ph-no-capture").filter({ hasText: marker }).first()
}

for (const scenario of [
    {
        title: "Submitted facts - history highlights only the command the submission ran",
        task: FACTS_TASK,
        marker: "E2E_SUBMITTED_FACTS_MARKER",
        highlighted: ["/retired-workflow"],
    },
    {
        title: "Submitted facts - a legacy row without facts is shown as typed, not re-read against the catalog",
        task: LEGACY_TASK,
        marker: "E2E_LEGACY_ROW_MARKER",
        highlighted: [] as string[],
    },
]) {
    e2e(scenario.title, async ({ dlineDocsDir, helper, openVSCode, userDataDir, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await seedHistoryTask(dlineDocsDir, scenario.task)

        const app = await openVSCode(workspaceDir)
        try {
            const page = await app.firstWindow()
            await E2ETestHelper.openClineSidebar(page)
            const sidebar = await helper.getSidebar(page)
            await helper.signin(sidebar)
            await openHistoryTask(page, sidebar, scenario.marker)

            const header = taskHeaderText(sidebar, scenario.marker)
            await expect(header).toBeVisible({ timeout: 30_000 })
            await expect(header).toContainText(scenario.task.text)
            await expect(header.locator(".mention-context-highlight")).toHaveText(scenario.highlighted)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    })
}
