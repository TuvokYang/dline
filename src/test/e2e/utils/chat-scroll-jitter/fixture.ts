import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { E2ETestHelper } from "@e2e/utils/helpers"
import { seedLegacyTaskHistory } from "@e2e/utils/task-history-store"
import { expect, type Frame } from "@playwright/test"
import { COMMAND_OUTPUT_STRING } from "@shared/combineCommandSequences"
import type { HistoryItem } from "@shared/HistoryItem"
import type { ElectronApplication } from "playwright"

export const TASK_ID = "e2e-chat-virtual-scroll-jitter"
export const TASK_TEXT = "E2E_CHAT_SCROLL_JITTER_TASK"
export const BODY_MESSAGE_COUNT = 1_200
export const BROWSE_TARGET_INDEX = 620
const COMMAND_CARD_INTERVAL = 7
const CODE_BLOCK_INTERVAL = 11
const FILE_EDIT_INTERVAL = 5
const REASONING_INTERVAL = 9
const TOOL_GROUP_INTERVAL = 13
const PROGRESS_UPDATE_INTERVAL = 17
const SKILL_LOAD_INTERVAL = 23
export const SETTLE_SAMPLE_COUNT = 90
export const SETTLE_SAMPLE_INTERVAL_MS = 16
export const STREAM_CONTINUATION = "E2E_JITTER_STREAM_CONTINUATION"
export const STREAM_PARTIAL_MARKER = "E2E_JITTER_STREAM_PARTIAL"
export const STREAM_COMPLETION_MARKER = "E2E_JITTER_STREAM_COMPLETE"
export const STREAM_REASONING_LINES = Array.from(
    { length: 16 },
    (_, line) => `streaming reasoning step ${line + 1} about the seeded conversation`,
).join("\n")
export const STREAM_WRITE_PATH = "e2e-jitter-streamed-file.ts"
export const STREAM_WRITE_CONTENT = `${Array.from({ length: 40 }, (_, line) => `export const streamedValue${line} = ${line} * 2`).join("\n")}\n`
export const STREAM_REPLACE_DIFF = [
    "------- SEARCH",
    "export const streamedValue0 = 0 * 2",
    "=======",
    "export const streamedValue0 = 0 * 2 // adjusted while streaming",
    "+++++++ REPLACE",
].join("\n")

export function bodyMarker(index: number): string {
    return `E2E_JITTER_MESSAGE_${String(index).padStart(4, "0")}`
}

// Command output, code, edits and reasoning retain their original dynamic heights.
function seededMessage(baseTimestamp: number, index: number): Record<string, unknown> {
    const ts = baseTimestamp + index
    if (index % COMMAND_CARD_INTERVAL === 0) {
        const outputLines = Array.from(
            { length: 40 + (index % 30) },
            (_, line) => `${bodyMarker(index)} output line ${line + 1} with enough width to wrap on a narrow sidebar`,
        ).join("\n")
        return {
            ts,
            type: "ask",
            ask: "command",
            text: `echo ${bodyMarker(index)}${COMMAND_OUTPUT_STRING}${outputLines}`,
            partial: false,
        }
    }
    if (index % CODE_BLOCK_INTERVAL === 0) {
        const code = Array.from({ length: 18 }, (_, line) => `  const value_${line} = ${index} * ${line + 1}`).join("\n")
        return { ts, type: "say", say: "text", text: `${bodyMarker(index)}\n\`\`\`ts\n${code}\n\`\`\`` }
    }
    if (index % FILE_EDIT_INTERVAL === 0) {
        const patch = Array.from({ length: 12 }, (_, line) => `+ added line ${line + 1} for ${bodyMarker(index)}`).join("\n")
        return {
            ts,
            type: "say",
            say: "tool",
            text: JSON.stringify({
                tool: "editedExistingFile",
                path: `src/integrations/terminal/module_${index}/CommandExecutor.ts`,
                content: patch,
            }),
        }
    }
    if (index % REASONING_INTERVAL === 0) {
        const thought = Array.from({ length: 14 }, (_, line) => `reasoning step ${line + 1} for ${bodyMarker(index)}`).join("\n")
        return { ts, type: "say", say: "reasoning", text: thought }
    }
    if (index % TOOL_GROUP_INTERVAL === 0) {
        return {
            ts,
            type: "say",
            say: "tool",
            text: JSON.stringify({
                tool: "readFile",
                path: `src/core/task/tools/handlers/Handler_${index}.ts`,
                content: `${bodyMarker(index)} file body`,
            }),
        }
    }
    if (index % PROGRESS_UPDATE_INTERVAL === 0) {
        return {
            ts,
            type: "say",
            say: "tool",
            text: JSON.stringify({
                tool: "actModeRespond",
                content: `${bodyMarker(index)} progress update spanning enough words to wrap across several lines in a narrow sidebar`,
            }),
        }
    }
    if (index % SKILL_LOAD_INTERVAL === 0) {
        return { ts, type: "say", say: "load_mcp_documentation", text: `${bodyMarker(index)} loaded capability documentation` }
    }
    const detailCount = (index % 4) + 1
    const details = Array.from({ length: detailCount }, (_, line) => `detail-${index}-${line + 1}`).join("\n")
    return { ts, type: "say", say: "text", text: `${bodyMarker(index)}\n${details}` }
}

function lastPlainTextIndex(): number {
    for (let index = BODY_MESSAGE_COUNT; index > 0; index--) {
        if (
            index % COMMAND_CARD_INTERVAL !== 0 &&
            index % CODE_BLOCK_INTERVAL !== 0 &&
            index % FILE_EDIT_INTERVAL !== 0 &&
            index % REASONING_INTERVAL !== 0 &&
            index % TOOL_GROUP_INTERVAL !== 0 &&
            index % PROGRESS_UPDATE_INTERVAL !== 0 &&
            index % SKILL_LOAD_INTERVAL !== 0
        )
            return index
    }
    throw new Error("the fixture must contain at least one plain text row")
}
export const TAIL_TEXT_INDEX = lastPlainTextIndex()

export async function seedUniformHeightTask(dlineDocsDir: string, workspaceDir: string): Promise<void> {
    const taskDir = path.join(dlineDocsDir, "tasks", TASK_ID)
    await mkdir(taskDir, { recursive: true })
    const baseTimestamp = Date.now() - 120_000
    const historyItem: HistoryItem = {
        id: TASK_ID,
        ts: baseTimestamp,
        task: TASK_TEXT,
        tokensIn: 0,
        tokensOut: 0,
        totalCost: 0,
        cwdOnTaskInitialization: workspaceDir,
    }
    const messages = [
        { ts: baseTimestamp, type: "say", say: "task", text: TASK_TEXT },
        ...Array.from({ length: BODY_MESSAGE_COUNT }, (_, offset) => ({
            ts: baseTimestamp + offset + 1,
            type: "say" as const,
            say: "text" as const,
            text: `uniform row ${offset + 1}`,
        })),
    ]
    await Promise.all([
        seedLegacyTaskHistory(dlineDocsDir, [historyItem]),
        writeFile(
            path.join(taskDir, "ui_messages.jsonl"),
            `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
            "utf8",
        ),
        writeFile(path.join(taskDir, "api_conversation_history.jsonl"), "", "utf8"),
        writeFile(
            path.join(taskDir, ".lock"),
            JSON.stringify({ held_by: "e2e-chat-jitter-other-instance", locked_at: Date.now(), pid: 4343 }),
            "utf8",
        ),
    ])
}

export async function seedJitterTask(dlineDocsDir: string, workspaceDir: string): Promise<void> {
    const taskDir = path.join(dlineDocsDir, "tasks", TASK_ID)
    await mkdir(taskDir, { recursive: true })
    const baseTimestamp = Date.now() - 120_000
    const historyItem: HistoryItem = {
        id: TASK_ID,
        ts: baseTimestamp,
        task: TASK_TEXT,
        tokensIn: 0,
        tokensOut: 0,
        totalCost: 0,
        cwdOnTaskInitialization: workspaceDir,
    }
    const messages = [
        { ts: baseTimestamp, type: "say", say: "task", text: TASK_TEXT },
        ...Array.from({ length: BODY_MESSAGE_COUNT }, (_, offset) => seededMessage(baseTimestamp, offset + 1)),
    ]
    await Promise.all([
        seedLegacyTaskHistory(dlineDocsDir, [historyItem]),
        writeFile(
            path.join(taskDir, "ui_messages.jsonl"),
            `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
            "utf8",
        ),
        writeFile(path.join(taskDir, "api_conversation_history.jsonl"), "", "utf8"),
        writeFile(
            path.join(taskDir, ".lock"),
            JSON.stringify({ held_by: "e2e-chat-jitter-other-instance", locked_at: Date.now(), pid: 4343 }),
            "utf8",
        ),
    ])
}

export async function setAutoApproveAction(sidebar: Frame, label: string, enabled: boolean): Promise<void> {
    await sidebar.getByLabel("Open auto-approve settings").click()
    const checkbox = sidebar.locator("vscode-checkbox").filter({ hasText: label })
    const isChecked = async () => (await checkbox.getAttribute("current-checked")) === "true"
    if ((await isChecked()) !== enabled) await checkbox.click()
    await expect.poll(isChecked).toBe(enabled)
    await sidebar.getByLabel("Close auto-approve settings").click()
}

export async function unlockAndContinueTask(sidebar: Frame, text: string): Promise<void> {
    const unlockButton = sidebar.getByRole("button", { name: "Unlock", exact: true })
    await expect(unlockButton).toBeVisible({ timeout: 30_000 })
    await unlockButton.click()
    await expect(sidebar.getByText("Unlock Task", { exact: true })).toBeVisible({ timeout: 10_000 })
    await sidebar.getByRole("button", { name: "Confirm", exact: true }).click()
    await expect(unlockButton).toBeHidden({ timeout: 15_000 })
    const input = sidebar.getByTestId("chat-input")
    const sendButton = sidebar.getByTestId("send-button")
    const resumeButton = sidebar.getByRole("contentinfo").locator('[data-testid="send-button"][data-action="resume"]')
    await expect(input).toBeEnabled({ timeout: 30_000 })
    await expect
        .poll(
            async () => (await resumeButton.isVisible().catch(() => false)) || (await sendButton.isEnabled().catch(() => false)),
            { timeout: 30_000 },
        )
        .toBe(true)
    await input.fill(text)
    if (await resumeButton.isVisible().catch(() => false)) await resumeButton.click()
    else await sendButton.click()
    await expect(sidebar.getByText(text, { exact: true }).last()).toBeVisible({ timeout: 30_000 })
}

export async function openSeededTask(
    app: ElectronApplication,
    helper: E2ETestHelper,
): Promise<{ page: Awaited<ReturnType<ElectronApplication["firstWindow"]>>; sidebar: Frame }> {
    const page = await app.firstWindow()
    await E2ETestHelper.openClineSidebar(page)
    const sidebar = await helper.getSidebar(page)
    await helper.signin(sidebar)
    await page.getByRole("button", { name: "History", exact: true }).click()
    await E2ETestHelper.dismissWhatsNewModal(sidebar)
    const historyTask = sidebar.locator(".history-item").filter({ hasText: TASK_TEXT })
    await expect(historyTask).toHaveCount(1)
    await historyTask.click()
    await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible({ timeout: 30_000 })
    return { page, sidebar }
}
