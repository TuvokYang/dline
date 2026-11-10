import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { expectComposerText } from "@e2e/utils/composer"
import { E2ETestHelper } from "@e2e/utils/helpers"
import { pauseTaskBetweenTurns, readTaskUiMessagesText, seedTaskConversation } from "@e2e/utils/task-instance-store"
import { expect, type Frame, type Page } from "@playwright/test"
import type { ElectronApplication } from "playwright"
import { estimateTokens } from "./compaction-request-oracle"

export interface StoredCompactionProfile {
    name: string
    modelId?: string
    webToolsMode?: "WEB_TOOLS_MODE_FORCE_OFF"
    openai?: { capabilities?: { contextWindow?: number; maxTokens?: number } }
    anthropic?: { capabilities?: { contextWindow?: number; maxTokens?: number } }
    deepseek?: { capabilities?: { contextWindow?: number; maxTokens?: number } }
}

export const profilesPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "api_profiles.json")
export const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")

export async function configureAutoCompaction(dlineDir: string, profileName: string): Promise<void> {
    const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredCompactionProfile[]
    const profile = profiles.find((candidate) => candidate.name === profileName)
    if (!profile?.openai?.capabilities) throw new Error(`Missing configurable OpenAI E2E profile: ${profileName}`)
    profile.modelId = "gpt-5.6-sol"
    profile.openai.capabilities.contextWindow = 131_072
    profile.openai.capabilities.maxTokens = 8_192
    profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
    await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

    const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
    await writeFile(
        settingsPath(dlineDir),
        `${JSON.stringify(
            {
                ...settings,
                actModeProfile: profileName,
                planModeProfile: profileName,
                useAutoCondense: true,
                autoCondenseTriggerPercent: 60,
                autoCondenseMaxContextTokens: 100_000,
            },
            null,
            2,
        )}\n`,
        "utf8",
    )
}

export async function configureResponsesAutoCompaction(dlineDir: string): Promise<void> {
    await configureAutoCompaction(dlineDir, E2E_PROFILE_NAMES.mockOpenAiResponses)
}

export async function configureTriggerBoundary(
    dlineDir: string,
    contextWindow: number,
    maxContextTokens: number,
    minReserveTokens = 5_000,
    maxReserveTokens = 30_000,
    triggerPercent = 97,
): Promise<void> {
    const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredCompactionProfile[]
    const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
    if (!profile?.openai?.capabilities) throw new Error("Missing configurable OpenAI Responses E2E profile")
    profile.modelId = "gpt-5.6-sol"
    profile.openai.capabilities.contextWindow = contextWindow
    profile.openai.capabilities.maxTokens = 8_192
    profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
    await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

    const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
    await writeFile(
        settingsPath(dlineDir),
        `${JSON.stringify(
            {
                ...settings,
                actModeProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
                planModeProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
                useAutoCondense: true,
                autoCondenseTriggerPercent: triggerPercent,
                autoCondenseMinReserveTokens: minReserveTokens,
                autoCondenseMaxReserveTokens: maxReserveTokens,
                autoCondenseMaxContextTokens: maxContextTokens,
            },
            null,
            2,
        )}\n`,
        "utf8",
    )
}

export async function openSidebar(app: ElectronApplication, helper: E2ETestHelper): Promise<Frame> {
    const page = await app.firstWindow()
    await E2ETestHelper.openClineSidebar(page)
    const sidebar = await helper.getSidebar(page)
    await E2ETestHelper.dismissWhatsNewModal(sidebar)
    await helper.signin(sidebar)
    return sidebar
}

export async function submitTask(sidebar: Frame, text: string): Promise<void> {
    const input = sidebar.getByTestId("chat-input")
    await expect(input).toBeEnabled()
    await input.fill(text)
    await input.press("Enter")
    await expectComposerText(input, "")
}

export async function sendTask(sidebar: Frame, text: string): Promise<void> {
    await submitTask(sidebar, text)
    await expect(sidebar.getByText(text, { exact: true }).last()).toBeVisible()
}

export async function closeCurrentTask(sidebar: Frame): Promise<void> {
    const closeButton = sidebar.getByRole("button", { name: "Close Task", exact: true })
    await expect(closeButton).toBeVisible({ timeout: 30_000 })
    await closeButton.click()
    await expect(sidebar.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 })
    await E2ETestHelper.dismissWhatsNewModal(sidebar)
}

export async function reopenTask(page: Page, sidebar: Frame, taskText: string): Promise<void> {
    await page.getByRole("button", { name: "History", exact: true }).click()
    await E2ETestHelper.dismissWhatsNewModal(sidebar)
    const historyTask = sidebar.locator(".history-preview-item, .history-item").filter({ hasText: taskText })
    await expect(historyTask).toHaveCount(1, { timeout: 30_000 })
    await historyTask.click()
    await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(sidebar.getByText(taskText, { exact: true }).first()).toBeVisible({ timeout: 30_000 })
    // The message surface is published before resume preparation finishes, so wait until the task admits input.
    await expect(sidebar.getByTestId("send-button")).toHaveAttribute("data-action", /^(?:send|resume)$/, { timeout: 30_000 })
}

export async function onlyTaskId(dlineDocsDir: string): Promise<string> {
    const entries = await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true })
    const taskIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    if (taskIds.length !== 1 || !taskIds[0]) throw new Error(`Expected exactly one persisted task, found ${taskIds.length}`)
    return taskIds[0]
}

export async function seedLargeCompactionHistory(
    dlineDocsDir: string,
    taskId: string,
    turns: readonly { user: string; assistant: string }[],
): Promise<number> {
    const now = Date.now()
    const history = turns.flatMap((turn, index) => [
        { role: "user" as const, content: [{ type: "text" as const, text: turn.user }], ts: now + index * 2 },
        { role: "assistant" as const, content: [{ type: "text" as const, text: turn.assistant }], ts: now + index * 2 + 1 },
    ])
    // The runtime keeps the conversation in the task journal and its state in
    // state.json; the seeded history replaces the conversation, and the task
    // waits between turns for the next message.
    await seedTaskConversation(dlineDocsDir, taskId, history)
    await pauseTaskBetweenTurns(dlineDocsDir, taskId)
    return estimateTokens({ systemPrompt: "", messages: history, tools: [], serverTools: [] })
}

export async function readPersistedCompactionCards(
    dlineDocsDir: string,
    taskId: string,
): Promise<Array<Record<string, unknown>>> {
    const raw = await readTaskUiMessagesText(dlineDocsDir, taskId)
    return raw
        .split(/\r?\n/)
        .filter(Boolean)
        .flatMap((line) => {
            const message = JSON.parse(line) as { say?: string; text?: string; partial?: boolean }
            if (message.say !== "tool" || !message.text || message.partial === true) return []
            try {
                const tool = JSON.parse(message.text) as Record<string, unknown>
                return tool.tool === "summarizeTask" ? [tool] : []
            } catch {
                return []
            }
        })
}
