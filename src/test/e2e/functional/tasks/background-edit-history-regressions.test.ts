import { mkdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

async function configureBackgroundEdit(dlineDir: string): Promise<void> {
    const settingsFile = path.join(dlineDir, "data", "settings", "settings.json")
    const settings = JSON.parse(await readFile(settingsFile, "utf8")) as Record<string, unknown>
    settings.backgroundEditEnabled = true
    await writeFile(settingsFile, `${JSON.stringify(settings, null, 2)}\n`, "utf8")
}

async function setAutoApproveProjectEdits(sidebar: Frame, enabled: boolean): Promise<void> {
    await sidebar.getByLabel("Open auto-approve settings").click()
    const checkbox = sidebar.locator("vscode-checkbox").filter({ hasText: "Edit project files" })
    await expect(checkbox).toHaveCount(1)
    const checked = () => checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))
    if ((await checked()) !== enabled) await sidebar.getByText("Edit project files", { exact: true }).click()
    await expect.poll(checked).toBe(enabled)
    await sidebar.getByLabel("Close auto-approve settings").click()
}

async function sendTask(sidebar: Frame, text: string): Promise<void> {
    const input = sidebar.getByTestId("chat-input")
    await input.fill(text)
    await sidebar.getByTestId("send-button").click()
    await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

e2e(
    "Background Edit saves through the host without opening or focusing an editor tab",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(180_000)
        await configureBackgroundEdit(dlineDir)
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses(
            {
                type: "tool",
                id: "call_background_edit_write",
                name: "write_to_file",
                arguments: { path: "background-edit-e2e.ts", content: "export const backgroundEdit = true\n" },
            },
            {
                type: "tool",
                id: "call_background_edit_done",
                name: "attempt_completion",
                arguments: { result: "E2E_BACKGROUND_EDIT_SAVED" },
                expectedToolResults: [{ callId: "call_background_edit_write", contentIncludes: "successfully saved" }],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const page = await app.firstWindow()
            await E2ETestHelper.openClineSidebar(page)
            const sidebar = await helper.getSidebar(page)
            await E2ETestHelper.dismissWhatsNewModal(sidebar)
            await helper.signin(sidebar)
            await setAutoApproveProjectEdits(sidebar, false)

            const editorTab = page.getByRole("tab", { name: /background-edit-e2e\.ts/ })
            await expect(editorTab).toHaveCount(0)
            await sendTask(sidebar, "Create the background edit fixture without opening an editor.")
            const approve = sidebar.getByText("Approve", { exact: true })
            await expect(approve).toBeVisible({ timeout: 60_000 })
            await approve.click()

            const filePath = path.join(workspaceDir, "background-edit-e2e.ts")
            await expect
                .poll(() => readFile(filePath, "utf8").catch(() => ""), { timeout: 30_000 })
                .toContain("export const backgroundEdit = true")
            await expect(sidebar.getByText("E2E_BACKGROUND_EDIT_SAVED", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await expect(editorTab).toHaveCount(0)
            await expect(sidebar.getByTestId("chat-input")).toBeVisible()
            expect(server.getMockConsumptions("openai-compatible-chat").every((entry) => entry.contractError === undefined)).toBe(
                true,
            )
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

const STALE_TASK_ID = "e2e-stale-history-lock"
const STALE_TASK_TEXT = "E2E_STALE_HISTORY_LOCK_TASK"

async function seedStaleLockedTask(dlineDocsDir: string, workspaceDir: string): Promise<string> {
    const tasksDir = path.join(dlineDocsDir, "tasks")
    const taskDir = path.join(tasksDir, STALE_TASK_ID)
    await mkdir(taskDir, { recursive: true })
    const timestamp = Date.now() - 10 * 60 * 1000
    const historyItem = {
        id: STALE_TASK_ID,
        ts: timestamp,
        task: STALE_TASK_TEXT,
        tokensIn: 0,
        tokensOut: 0,
        totalCost: 0,
        cwdOnTaskInitialization: workspaceDir,
    }
    await Promise.all([
        writeFile(path.join(tasksDir, "taskHistory.jsonl"), `${JSON.stringify(historyItem)}\n`, "utf8"),
        writeFile(
            path.join(taskDir, "ui_messages.jsonl"),
            `${JSON.stringify({ ts: timestamp, type: "say", say: "task", text: STALE_TASK_TEXT })}\n`,
            "utf8",
        ),
        writeFile(path.join(taskDir, "api_conversation_history.jsonl"), "", "utf8"),
        writeFile(
            path.join(taskDir, ".lock"),
            JSON.stringify({ held_by: "e2e-abandoned-instance", locked_at: timestamp, pid: 4242 }),
            "utf8",
        ),
    ])
    return path.join(taskDir, ".lock")
}

e2e(
    "History automatically recovers a stale task lock before Resume",
    async ({ dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(180_000)
        const lockPath = await seedStaleLockedTask(dlineDocsDir, workspaceDir)
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses({
            type: "tool",
            name: "attempt_completion",
            arguments: { result: "E2E_STALE_HISTORY_LOCK_RESUMED" },
            expectedRequestIncludes: ["The previous task session was closed and has now been restored."],
        })

        const app = await openVSCode(workspaceDir)
        try {
            const page = await app.firstWindow()
            await E2ETestHelper.openClineSidebar(page)
            const sidebar = await helper.getSidebar(page)
            await helper.signin(sidebar)
            await page.getByRole("button", { name: "History", exact: true }).click()
            await E2ETestHelper.dismissWhatsNewModal(sidebar)
            const historyTask = sidebar.locator(".history-item").filter({ hasText: STALE_TASK_TEXT })
            await expect(historyTask).toHaveCount(1)
            await historyTask.click()

            await expect(sidebar.getByRole("button", { name: "Unlock", exact: true })).toHaveCount(0)
            const resume = sidebar.getByText("Resume", { exact: true })
            await expect(resume).toBeVisible({ timeout: 30_000 })
            await resume.click()
            await expect(sidebar.getByText("E2E_STALE_HISTORY_LOCK_RESUMED", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await expect
                .poll(async () => JSON.parse(await readFile(lockPath, "utf8")) as { held_by?: string }, { timeout: 30_000 })
                .toMatchObject({ held_by: expect.stringMatching(/^vscode-[0-9a-f-]{36}$/) })
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Editing an older direct input restores chat and continues immediately with the edited text",
    async ({ helper, page, server, sidebar, userDataDir }) => {
        e2e.setTimeout(180_000)
        await helper.signin(sidebar)
        server.resetOpenAiMock()
        const initial = "E2E_OLD_INPUT_INITIAL_TASK"
        const original = "E2E_OLD_INPUT_ORIGINAL"
        const edited = "E2E_OLD_INPUT_EDITED_CONTINUATION"
        server.enqueueOpenAiResponses(
            { type: "tool", name: "attempt_completion", arguments: { result: "E2E_OLD_INPUT_INITIAL_DONE" } },
            {
                type: "tool",
                name: "attempt_completion",
                arguments: { result: "E2E_OLD_INPUT_FOLLOWUP_DONE" },
                expectedRequestIncludes: [original],
            },
            {
                type: "tool",
                name: "attempt_completion",
                arguments: { result: "E2E_OLD_INPUT_EDITED_DONE" },
                expectedRequestIncludes: [edited],
            },
        )

        await sendTask(sidebar, initial)
        await expect(sidebar.getByText("E2E_OLD_INPUT_INITIAL_DONE", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
        await expect(sidebar.getByRole("button", { name: "Start New Task", exact: true }).first()).toBeVisible({
            timeout: 30_000,
        })
        const input = sidebar.getByTestId("chat-input")
        await input.fill(original)
        await input.press("Enter")
        await expect(sidebar.getByText("E2E_OLD_INPUT_FOLLOWUP_DONE", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
        const originalRow = sidebar.getByTestId("direct-user-input").filter({ hasText: original })
        await expect(originalRow).toHaveCount(1)
        await originalRow.click()
        const editor = sidebar.getByTestId("direct-user-input").locator("textarea").last()
        await expect(editor).toBeVisible()
        await expect(editor).toHaveValue(original)
        await editor.fill(edited)
        await editor.press("Enter")

        await expect(sidebar.getByText("E2E_OLD_INPUT_EDITED_DONE", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
        await expect(sidebar.getByText("Resume", { exact: true })).toHaveCount(0)
        await expect.poll(() => server.openAiRequestCount).toBe(3)
        const continuedRequest = JSON.stringify(server.getMockConsumptions("openai-compatible-chat")[2]?.requestBody)
        expect(continuedRequest).toContain(edited)
        expect(continuedRequest).not.toContain(original)
        await page.waitForTimeout(250)
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
    },
)
