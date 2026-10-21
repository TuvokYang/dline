import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { expectComposerText } from "@e2e/utils/composer"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { readTaskUiMessages, rewriteTaskUiMessages } from "@e2e/utils/task-instance-store"
import { expect, type Frame, type TestInfo } from "@playwright/test"
import type { UiMessage } from "@shared/ExtensionMessage"
import type { ElectronApplication } from "playwright"

const TASK_TEXT = "E2E_CHECKPOINT_COMPACTION_TASK"
const READY_MARKER = "E2E_CHECKPOINT_COMPACTION_READY"
const CONTINUATION_TEXT = "E2E_CHECKPOINT_COMPACTION_CONTINUE"
const SUMMARY_MARKER = "E2E_CHECKPOINT_COMPACTION_SUMMARY"
const COMPLETION_MARKER = "E2E_CHECKPOINT_COMPACTION_DONE"
const NOTE_FILE = "checkpoint-compaction-note.txt"
const NOTE_MARKER = "E2E_CHECKPOINT_COMPACTION_NOTE"
/** A reply without tool calls: the chat draws nothing for it, and the kernel continues with another round. */
const TOOLLESS_REPLY_TEXT = "E2E_CHECKPOINT_COMPACTION_PLAN I will read the note next."
const REQUEST_FAILURE_MESSAGE = "E2E_CHECKPOINT_COMPACTION_REQUEST_FAILURE"

interface StoredProfile {
    name: string
    modelId?: string
    webToolsMode?: "WEB_TOOLS_MODE_FORCE_OFF"
    openai?: { capabilities?: { contextWindow?: number } }
}

const profilesPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "api_profiles.json")
const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")

/** A small context window and a low trigger, so one large reported usage compacts before the next request. */
async function configureAutoCompactionWithCheckpoints(dlineDir: string): Promise<void> {
    const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
    const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
    if (!profile?.openai?.capabilities) throw new Error("Missing configurable OpenAI Responses E2E profile")
    profile.modelId = "gpt-5.6-sol"
    profile.openai.capabilities.contextWindow = 131_072
    profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
    await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

    const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
    const next = {
        ...settings,
        actModeProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
        planModeProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
        enableCheckpointsSetting: true,
        useAutoCondense: true,
        autoCondenseTriggerPercent: 60,
        autoCondenseMaxContextTokens: 100_000,
    }
    await writeFile(settingsPath(dlineDir), `${JSON.stringify(next, null, 2)}\n`, "utf8")
}

async function openSidebar(app: ElectronApplication, helper: E2ETestHelper): Promise<Frame> {
    const page = await app.firstWindow()
    await E2ETestHelper.openClineSidebar(page)
    const sidebar = await helper.getSidebar(page)
    await E2ETestHelper.dismissWhatsNewModal(sidebar)
    await helper.signin(sidebar)
    return sidebar
}

async function setAutoApproveAction(sidebar: Frame, label: string, enabled: boolean): Promise<void> {
    await sidebar.getByLabel("Open auto-approve settings").click()
    const checkbox = sidebar.locator("vscode-checkbox").filter({ hasText: label })
    await expect(checkbox).toHaveCount(1)
    const isChecked = () => checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))
    if ((await isChecked()) !== enabled) {
        await sidebar.getByText(label, { exact: true }).click()
    }
    await expect.poll(isChecked).toBe(enabled)
    await sidebar.getByLabel("Close auto-approve settings").click()
}

async function sendMessage(sidebar: Frame, text: string): Promise<void> {
    const input = sidebar.getByTestId("chat-input")
    await expect(input).toBeEnabled()
    await input.fill(text)
    await input.press("Enter")
    await expectComposerText(input, "")
    await expect(sidebar.getByText(text, { exact: true }).last()).toBeVisible()
}

async function onlyTaskId(dlineDocsDir: string): Promise<string> {
    return await E2ETestHelper.waitForValue(async () => {
        const entries = await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true }).catch(() => [])
        const taskIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
        return taskIds.length === 1 ? taskIds[0] : undefined
    }, 30_000)
}

/**
 * The chat as the user sees it, in document order: the condense card, standalone
 * checkpoint rows, and folded exploration runs with the checkpoints drawn inside them.
 */
async function visibleCheckpointLayout(sidebar: Frame): Promise<string[]> {
    return await sidebar.evaluate(() => {
        const tokens: string[] = []
        const isCheckpointLabel = (element: Element) =>
            element.childElementCount === 0 && element.textContent?.trim() === "Checkpoint"
        const visit = (element: Element) => {
            const testId = element.getAttribute("data-testid")
            if (testId === "compaction-pass") {
                tokens.push("card")
                return
            }
            if (testId === "exploration-run") {
                const inner = Array.from(element.querySelectorAll("*")).filter(isCheckpointLabel).length
                tokens.push(`run:${inner}`)
                return
            }
            if (isCheckpointLabel(element)) {
                tokens.push("checkpoint")
                return
            }
            for (const child of Array.from(element.children)) visit(child)
        }
        visit(document.body)
        return tokens
    })
}

/** The chat in document order as checkpoints and the given leaf texts, such as the paths of edit rows. */
async function visibleCheckpointsAround(sidebar: Frame, markers: readonly string[]): Promise<string[]> {
    return await sidebar.evaluate((leafTexts) => {
        const tokens: string[] = []
        const visit = (element: Element) => {
            const text = element.textContent?.trim() ?? ""
            // The innermost element that still contains a marker stands for that row.
            const marker = leafTexts.find(
                (candidate) =>
                    text.includes(candidate) &&
                    !Array.from(element.children).some((child) => child.textContent?.includes(candidate)),
            )
            if (marker !== undefined) {
                tokens.push(marker)
                return
            }
            if (element.childElementCount === 0 && text === "Checkpoint") {
                tokens.push("checkpoint")
                return
            }
            for (const child of Array.from(element.children)) visit(child)
        }
        visit(document.body)
        return tokens
    }, markers)
}

/** Checkpoints drawn between the first occurrence of `from` and the first occurrence of `to` after it. */
function checkpointsBetween(layout: readonly string[], from: string, to: string): number {
    const start = layout.indexOf(from)
    const end = layout.indexOf(to, start + 1)
    if (start === -1 || end === -1) throw new Error(`Missing ${from} or ${to} in layout: ${layout.join(", ")}`)
    return layout.slice(start + 1, end).filter((token) => token === "checkpoint").length
}

/** Checkpoints the user sees between the last condense card and the first folded run after it. */
function checkpointsShownAfterCard(layout: readonly string[]): number {
    const cardIndex = layout.lastIndexOf("card")
    if (cardIndex === -1) throw new Error(`No condense card in layout: ${layout.join(", ")}`)
    const afterCard = layout.slice(cardIndex + 1)
    const runIndex = afterCard.findIndex((token) => token.startsWith("run:"))
    const beforeRun = runIndex === -1 ? afterCard : afterCard.slice(0, runIndex)
    const runHeadCheckpoint = runIndex === -1 ? 0 : Math.min(Number(afterCard[runIndex].slice("run:".length)), 1)
    return beforeRun.filter((token) => token === "checkpoint").length + runHeadCheckpoint
}

/**
 * Put a chat-only copy of the first round checkpoint after the condense card right
 * before it: the stored shape of a round whose shadow commit failed and whose retry
 * wrote the file-backed row. The card is this task's first tool row.
 */
function insertChatOnlyRowBeforeFirstRoundAfterCard(messages: UiMessage[]): UiMessage[] {
    const cardIndex = messages.findIndex((message) => message.say === "tool")
    const roundIndex = messages.findIndex((message, index) => index > cardIndex && message.say === "checkpoint_created")
    if (cardIndex === -1 || roundIndex === -1) throw new Error("No round checkpoint after the condense card")
    const round = messages[roundIndex]
    const { lastCheckpointHash: _hash, ...chatOnly } = round
    return [...messages.slice(0, roundIndex), { ...chatOnly, ts: round.ts - 1 }, ...messages.slice(roundIndex)]
}

async function closeCurrentTask(sidebar: Frame): Promise<void> {
    const closeButton = sidebar.getByRole("button", { name: "Close Task", exact: true })
    await expect(closeButton).toBeVisible({ timeout: 30_000 })
    await closeButton.click()
    await expect(closeButton).toHaveCount(0, { timeout: 30_000 })
    await expect(sidebar.getByTestId("chat-input")).toBeVisible()
    await E2ETestHelper.dismissWhatsNewModal(sidebar)
}

async function reopenTask(sidebar: Frame, taskText: string): Promise<void> {
    const historyTask = sidebar.getByText(taskText, { exact: true }).last()
    await expect(historyTask).toBeVisible({ timeout: 30_000 })
    await historyTask.click()
    await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible({ timeout: 30_000 })
}

async function attachLayout(testInfo: TestInfo, name: string, layout: readonly string[], rows: readonly UiMessage[]) {
    await testInfo.attach(`checkpoint-layout-${name}.json`, {
        body: Buffer.from(`${JSON.stringify({ layout, rows: describeCheckpointRows(rows) }, null, 2)}\n`, "utf8"),
        contentType: "application/json",
    })
}

function describeCheckpointRows(messages: readonly UiMessage[]) {
    return messages.map((message, index) => ({
        index,
        ts: message.ts,
        type: message.type,
        kind: message.type === "say" ? message.say : message.ask,
        ...(message.say === "checkpoint_created"
            ? {
                  source: message.checkpointSource?.kind,
                  hasHash: Boolean(message.lastCheckpointHash?.length),
                  journalSeq: (message as unknown as { conversationJournalSeq?: number }).conversationJournalSeq,
              }
            : {}),
    }))
}

e2e(
    "Checkpoint - after automatic compaction the next round shows a single checkpoint",
    async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }, testInfo) => {
        e2e.setTimeout(240_000)
        await configureAutoCompactionWithCheckpoints(dlineDir)
        const notePath = path.join(workspaceDir, NOTE_FILE)
        await writeFile(notePath, `${NOTE_MARKER} before\n`, "utf8")

        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_checkpoint_compaction_ready",
                name: "qna_respond",
                arguments: { response: READY_MARKER },
                usage: { inputTokens: 125_000, outputTokens: 100 },
            },
            {
                type: "tool",
                id: "call_checkpoint_compaction_summary",
                name: "summarize_task",
                arguments: { context: `${SUMMARY_MARKER} keeps the note review going.` },
                expectedRequestIncludes: ["The current conversation is rapidly running out of context"],
            },
            {
                type: "tool",
                id: "call_checkpoint_compaction_read_first",
                name: "read_file",
                arguments: { path: NOTE_FILE },
                expectedRequestIncludes: [SUMMARY_MARKER],
            },
            {
                type: "tool",
                id: "call_checkpoint_compaction_search",
                name: "search_files",
                arguments: { path: ".", regex: NOTE_MARKER },
            },
            {
                type: "tool",
                id: "call_checkpoint_compaction_read_second",
                name: "read_file",
                arguments: { path: NOTE_FILE },
            },
            {
                type: "tool",
                id: "call_checkpoint_compaction_done",
                name: "attempt_completion",
                arguments: { result: COMPLETION_MARKER },
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await openSidebar(app, helper)
            await setAutoApproveAction(sidebar, "Read project files", true)
            await sendMessage(sidebar, TASK_TEXT)
            await expect(sidebar.getByText(READY_MARKER, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            const taskId = await onlyTaskId(dlineDocsDir)

            // The workspace moves on before the compacting turn, as it does in a real session.
            await writeFile(notePath, `${NOTE_MARKER} after\n`, "utf8")
            await sendMessage(sidebar, CONTINUATION_TEXT)
            await expect(sidebar.getByText(COMPLETION_MARKER, { exact: false }).last()).toBeVisible({ timeout: 90_000 })
            await expect(sidebar.getByTestId("compaction-pass").first()).toBeVisible()

            const stored = await readTaskUiMessages(dlineDocsDir, taskId)
            const liveLayout = await visibleCheckpointLayout(sidebar)
            await attachLayout(testInfo, "live", liveLayout, stored)
            expect(checkpointsShownAfterCard(liveLayout), `live layout: ${liveLayout.join(", ")}`).toBe(1)

            // The reported transcript: a round whose shadow commit failed wrote a chat-only
            // row, and its retry wrote the file-backed row, with nothing drawn in between.
            // Store that shape and reopen the task, as the user does.
            await closeCurrentTask(sidebar)
            await rewriteTaskUiMessages(dlineDocsDir, taskId, insertChatOnlyRowBeforeFirstRoundAfterCard)
            const seeded = await readTaskUiMessages(dlineDocsDir, taskId)
            expect(seeded.filter((message) => message.say === "checkpoint_created" && !message.lastCheckpointHash)).toHaveLength(
                1,
            )
            await reopenTask(sidebar, TASK_TEXT)
            await expect(sidebar.getByTestId("compaction-pass").first()).toBeVisible({ timeout: 30_000 })
            const reopenedLayout = await visibleCheckpointLayout(sidebar)
            await attachLayout(testInfo, "reopened", reopenedLayout, seeded)
            expect(checkpointsShownAfterCard(reopenedLayout), `reopened layout: ${reopenedLayout.join(", ")}`).toBe(1)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Checkpoint - a reply without tools after automatic compaction leaves a single checkpoint before the next round",
    async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }, testInfo) => {
        e2e.setTimeout(240_000)
        await configureAutoCompactionWithCheckpoints(dlineDir)
        const notePath = path.join(workspaceDir, NOTE_FILE)
        await writeFile(notePath, `${NOTE_MARKER} before\n`, "utf8")

        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_checkpoint_toolless_ready",
                name: "qna_respond",
                arguments: { response: READY_MARKER },
                usage: { inputTokens: 125_000, outputTokens: 100 },
            },
            {
                type: "tool",
                id: "call_checkpoint_toolless_summary",
                name: "summarize_task",
                arguments: { context: `${SUMMARY_MARKER} keeps the note review going.` },
                expectedRequestIncludes: ["The current conversation is rapidly running out of context"],
            },
            // The first request after the landed summary answers in prose only, as a model
            // recapping its plan does. Nothing of that round is drawn in the chat.
            {
                type: "message",
                text: TOOLLESS_REPLY_TEXT,
                expectedRequestIncludes: [SUMMARY_MARKER],
            },
            {
                type: "tool",
                id: "call_checkpoint_toolless_read_first",
                name: "read_file",
                arguments: { path: NOTE_FILE },
                expectedRequestIncludes: [SUMMARY_MARKER],
            },
            {
                type: "tool",
                id: "call_checkpoint_toolless_search",
                name: "search_files",
                arguments: { path: ".", regex: NOTE_MARKER },
            },
            {
                type: "tool",
                id: "call_checkpoint_toolless_read_second",
                name: "read_file",
                arguments: { path: NOTE_FILE },
            },
            {
                type: "tool",
                id: "call_checkpoint_toolless_done",
                name: "attempt_completion",
                arguments: { result: COMPLETION_MARKER },
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await openSidebar(app, helper)
            await setAutoApproveAction(sidebar, "Read project files", true)
            await sendMessage(sidebar, TASK_TEXT)
            await expect(sidebar.getByText(READY_MARKER, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            const taskId = await onlyTaskId(dlineDocsDir)

            await writeFile(notePath, `${NOTE_MARKER} after\n`, "utf8")
            await sendMessage(sidebar, CONTINUATION_TEXT)
            await expect(sidebar.getByText(COMPLETION_MARKER, { exact: false }).last()).toBeVisible({ timeout: 90_000 })
            await expect(sidebar.getByTestId("compaction-pass").first()).toBeVisible()

            // The prose-only round adds no row of its own, so whatever checkpoint it
            // leaves would sit directly beside the next round's checkpoint.
            const stored = await readTaskUiMessages(dlineDocsDir, taskId)
            const liveLayout = await visibleCheckpointLayout(sidebar)
            await attachLayout(testInfo, "toolless-live", liveLayout, stored)
            expect(checkpointsShownAfterCard(liveLayout), `live layout: ${liveLayout.join(", ")}`).toBe(1)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Checkpoint - a failed request after automatic compaction and its Retry leave a single checkpoint before the next round",
    async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, workspaceDir }, testInfo) => {
        e2e.setTimeout(240_000)
        await configureAutoCompactionWithCheckpoints(dlineDir)
        const notePath = path.join(workspaceDir, NOTE_FILE)
        await writeFile(notePath, `${NOTE_MARKER} before\n`, "utf8")

        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_checkpoint_retry_ready",
                name: "qna_respond",
                arguments: { response: READY_MARKER },
                usage: { inputTokens: 125_000, outputTokens: 100 },
            },
            {
                type: "tool",
                id: "call_checkpoint_retry_summary",
                name: "summarize_task",
                arguments: { context: `${SUMMARY_MARKER} keeps the note review going.` },
                expectedRequestIncludes: ["The current conversation is rapidly running out of context"],
            },
            // The first request after the landed summary fails for good, so the task
            // waits on its Retry; the failed request is no longer drawn once retried.
            {
                type: "error",
                status: 400,
                message: REQUEST_FAILURE_MESSAGE,
                expectedRequestIncludes: [SUMMARY_MARKER],
            },
            {
                type: "tool",
                id: "call_checkpoint_retry_read_first",
                name: "read_file",
                arguments: { path: NOTE_FILE },
                expectedRequestIncludes: [SUMMARY_MARKER],
            },
            {
                type: "tool",
                id: "call_checkpoint_retry_search",
                name: "search_files",
                arguments: { path: ".", regex: NOTE_MARKER },
            },
            {
                type: "tool",
                id: "call_checkpoint_retry_read_second",
                name: "read_file",
                arguments: { path: NOTE_FILE },
            },
            {
                type: "tool",
                id: "call_checkpoint_retry_done",
                name: "attempt_completion",
                arguments: { result: COMPLETION_MARKER },
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await openSidebar(app, helper)
            await setAutoApproveAction(sidebar, "Read project files", true)
            await sendMessage(sidebar, TASK_TEXT)
            await expect(sidebar.getByText(READY_MARKER, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            const taskId = await onlyTaskId(dlineDocsDir)

            await writeFile(notePath, `${NOTE_MARKER} after\n`, "utf8")
            await sendMessage(sidebar, CONTINUATION_TEXT)
            const retry = sidebar.getByRole("button", { name: "Retry", exact: true }).last()
            await expect(retry).toBeVisible({ timeout: 90_000 })
            await expect(sidebar.getByTestId("compaction-pass").first()).toBeVisible()
            await retry.click()
            await expect(sidebar.getByText(COMPLETION_MARKER, { exact: false }).last()).toBeVisible({ timeout: 90_000 })

            // The failed attempt is answered by its Retry and no longer drawn, so the
            // checkpoint each attempt wrote would sit directly beside the other.
            const stored = await readTaskUiMessages(dlineDocsDir, taskId)
            const liveLayout = await visibleCheckpointLayout(sidebar)
            await attachLayout(testInfo, "retry-live", liveLayout, stored)
            expect(checkpointsShownAfterCard(liveLayout), `live layout: ${liveLayout.join(", ")}`).toBe(1)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Checkpoint - Retry of a request that failed after a file edit leaves a single checkpoint before the next edit",
    async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, workspaceDir }, testInfo) => {
        e2e.setTimeout(240_000)
        await configureAutoCompactionWithCheckpoints(dlineDir)
        const firstEdit = "checkpoint-retry-first.txt"
        const secondEdit = "checkpoint-retry-second.txt"

        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_checkpoint_edit_first",
                name: "write_to_file",
                arguments: { path: firstEdit, content: `${NOTE_MARKER} first\n` },
            },
            // The request after the edit fails for good, as an exhausted balance does,
            // and the user answers it with Retry.
            {
                type: "error",
                status: 402,
                code: "insufficient_credits",
                message: REQUEST_FAILURE_MESSAGE,
                details: { current_balance: 0, message: "You have run out of credits." },
            },
            {
                type: "tool",
                id: "call_checkpoint_edit_second",
                name: "write_to_file",
                arguments: { path: secondEdit, content: `${NOTE_MARKER} second\n` },
            },
            {
                type: "tool",
                id: "call_checkpoint_edit_done",
                name: "attempt_completion",
                arguments: { result: COMPLETION_MARKER },
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await openSidebar(app, helper)
            await setAutoApproveAction(sidebar, "Edit project files", true)
            await sendMessage(sidebar, TASK_TEXT)
            const retry = sidebar.getByRole("button", { name: "Retry", exact: true }).last()
            await expect(retry).toBeVisible({ timeout: 90_000 })
            const taskId = await onlyTaskId(dlineDocsDir)
            await retry.click()
            await expect(sidebar.getByText(COMPLETION_MARKER, { exact: false }).last()).toBeVisible({ timeout: 90_000 })

            // The failed attempt is no longer drawn once retried, so the checkpoint of
            // the failed round and the one of its Retry would sit side by side.
            const stored = await readTaskUiMessages(dlineDocsDir, taskId)
            const layout = await visibleCheckpointsAround(sidebar, [firstEdit, secondEdit])
            await attachLayout(testInfo, "edit-retry-live", layout, stored)
            expect(checkpointsBetween(layout, firstEdit, secondEdit), `live layout: ${layout.join(", ")}`).toBe(1)
        } finally {
            await app.close()
        }
    },
)
