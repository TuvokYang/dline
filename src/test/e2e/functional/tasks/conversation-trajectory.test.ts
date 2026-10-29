import { readdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { expectComposerText } from "@e2e/utils/composer"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { readTaskUiMessages, rewriteTaskUiMessages } from "@e2e/utils/task-instance-store"
import { type TrajectoryTurnPreview, trajectoryRail } from "@e2e/utils/trajectory-rail"
import { expect, type Frame } from "@playwright/test"
import type { UiMessage } from "@shared/ExtensionMessage"
import type { ElectronApplication } from "playwright"

/**
 * WS-117 trajectory rail journeys against a real extension host.
 *
 * Each journey rewrites the chat through a path the rail must follow only
 * through the committed message log: a checkpoint restore that truncates the
 * chat, a compaction card landing and being restored on reopen, and a jump to
 * a turn the chat has not loaded.
 */

const COMPACT_INSTRUCTION_MARKER = "The current conversation is rapidly running out of context"

async function taskDirectoryIds(dlineDocsDir: string): Promise<string[]> {
    return readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true })
        .then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
        .catch(() => [])
}

async function waitForNewTaskId(dlineDocsDir: string, before: readonly string[]): Promise<string> {
    return E2ETestHelper.waitForValue(
        async () => (await taskDirectoryIds(dlineDocsDir)).find((id) => !before.includes(id)),
        30_000,
    )
}

async function sendMessage(sidebar: Frame, text: string): Promise<void> {
    const input = sidebar.getByTestId("chat-input")
    await expect(input).toBeEnabled({ timeout: 30_000 })
    await input.fill(text)
    await input.press("Enter")
    await expectComposerText(input, "")
    await expect(sidebar.getByText(text, { exact: true }).last()).toBeVisible()
}

async function closeCurrentTask(sidebar: Frame): Promise<void> {
    const closeButton = sidebar.getByRole("button", { name: "Close Task", exact: true })
    await expect(closeButton).toBeVisible()
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

function isToolRow(message: UiMessage): boolean {
    return message.ask === "tool" || message.say === "tool"
}

/** The tool a stored generic tool row names, as the chat persisted it. */
function storedToolName(message: UiMessage): string {
    return (JSON.parse(message.text ?? "{}") as { tool?: string }).tool ?? ""
}

/**
 * The preview a chat holding exactly one turn must show: every model round and
 * every generic tool row it still stores. Valid only while the task has a
 * single turn, so no turn boundary has to be decided here.
 */
function previewOfSingleTurnChat(messages: readonly UiMessage[]): TrajectoryTurnPreview {
    const counts = new Map<string, number>()
    for (const message of messages) {
        if (message.partial === true || !isToolRow(message)) continue
        const tool = storedToolName(message)
        counts.set(tool, (counts.get(tool) ?? 0) + 1)
    }
    return {
        rounds: messages.filter((message) => message.partial !== true && message.say === "api_req_started").length,
        tools: sortedTools([...counts].map(([tool, count]) => ({ tool, count }))),
    }
}

function sortedTools(tools: TrajectoryTurnPreview["tools"]): TrajectoryTurnPreview["tools"] {
    return [...tools].sort((left, right) => left.tool.localeCompare(right.tool))
}

async function sortedPreview(rail: ReturnType<typeof trajectoryRail>, prompt: string): Promise<TrajectoryTurnPreview> {
    const preview = await rail.preview(prompt)
    return { rounds: preview.rounds, tools: sortedTools(preview.tools) }
}

interface StoredProfile {
    name: string
    modelId?: string
    webToolsMode?: "WEB_TOOLS_MODE_FORCE_OFF"
    openai?: { capabilities?: { contextWindow?: number } }
}

/** Selects the Responses mock with a 131K window and automatic compaction, before VS Code starts. */
async function configureAutoCompact(dlineDir: string): Promise<void> {
    const profilesPath = path.join(dlineDir, "data", "settings", "api_profiles.json")
    const settingsPath = path.join(dlineDir, "data", "settings", "settings.json")
    const profiles = JSON.parse(await readFile(profilesPath, "utf8")) as StoredProfile[]
    const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
    if (!profile?.openai?.capabilities) throw new Error("Missing configurable OpenAI Responses E2E profile")
    profile.modelId = "gpt-5.4-mini"
    profile.openai.capabilities.contextWindow = 131_072
    profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
    await writeFile(profilesPath, `${JSON.stringify(profiles, null, 2)}\n`, "utf8")
    const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>
    const next = {
        ...settings,
        actModeProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
        planModeProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
        useAutoCondense: true,
    }
    await writeFile(settingsPath, `${JSON.stringify(next, null, 2)}\n`, "utf8")
}

async function openSidebar(app: ElectronApplication, helper: E2ETestHelper): Promise<Frame> {
    const page = await app.firstWindow()
    await E2ETestHelper.openClineSidebar(page)
    const sidebar = await helper.getSidebar(page)
    await E2ETestHelper.dismissWhatsNewModal(sidebar)
    await helper.signin(sidebar)
    return sidebar
}

e2e(
    "Trajectory - a checkpoint restore keeps exactly the remaining turns and their counts",
    async ({ dlineDocsDir, helper, sidebar, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(240_000)
        const task = "E2E_TRAJECTORY_RESTORE_TASK"
        const followUp = "E2E_TRAJECTORY_RESTORE_FOLLOW_UP"
        await helper.signin(sidebar)
        const before = await taskDirectoryIds(dlineDocsDir)
        await writeFile(path.join(workspaceDir, "trajectory-e2e.txt"), "before trajectory replace\n", "utf8")
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses(
            {
                type: "tool",
                name: "replace_in_file",
                arguments: {
                    path: "trajectory-e2e.txt",
                    diff: "------- SEARCH\nbefore trajectory replace\n=======\nafter trajectory replace\n+++++++ REPLACE",
                },
            },
            { type: "tool", name: "attempt_completion", arguments: { result: "E2E_TRAJECTORY_RESTORE_FIRST_DONE" } },
            { type: "tool", name: "attempt_completion", arguments: { result: "E2E_TRAJECTORY_RESTORE_SECOND_DONE" } },
        )

        await sendMessage(sidebar, task)
        const taskId = await waitForNewTaskId(dlineDocsDir, before)
        await sidebar.getByText("Approve", { exact: true }).click()
        await expect(sidebar.getByText("E2E_TRAJECTORY_RESTORE_FIRST_DONE", { exact: false }).last()).toBeVisible({
            timeout: 60_000,
        })
        await sendMessage(sidebar, followUp)
        await expect(sidebar.getByText("E2E_TRAJECTORY_RESTORE_SECOND_DONE", { exact: false }).last()).toBeVisible({
            timeout: 60_000,
        })
        expect(server.openAiRequestCount).toBe(3)

        // A completed turn closes its attempt, so each turn draws its own attempt band.
        const rail = trajectoryRail(sidebar)
        await expect.poll(() => rail.prompts(), { timeout: 30_000 }).toEqual([[task], [followUp]])

        // The first round's restore point is stored ahead of the tool row it guards.
        await expect
            .poll(async () =>
                (await readTaskUiMessages(dlineDocsDir, taskId)).some(
                    (message) => message.say === "checkpoint_created" && Boolean(message.lastCheckpointHash),
                ),
            )
            .toBe(true)
        const stored = await readTaskUiMessages(dlineDocsDir, taskId)
        const checkpointIndex = stored.findIndex((message) => message.say === "checkpoint_created")
        const toolIndex = stored.findIndex(isToolRow)
        expect(checkpointIndex).toBeGreaterThanOrEqual(0)
        expect(checkpointIndex).toBeLessThan(toolIndex)

        // Two provider requests ran in the first turn and one replace call; no checkpoint row is counted.
        expect(await sortedPreview(rail, task)).toEqual({
            rounds: 2,
            tools: [{ tool: storedToolName(stored[toolIndex]), count: 1 }],
        })
        expect(await sortedPreview(rail, followUp)).toEqual({ rounds: 1, tools: [] })

        const checkpointLabels = sidebar.getByText("Checkpoint", { exact: true })
        await expect.poll(() => checkpointLabels.count()).toBeGreaterThan(0)
        const firstCheckpoint = checkpointLabels.first().locator("..").locator("..")
        await firstCheckpoint.hover()
        await firstCheckpoint.getByRole("button", { name: "Restore", exact: true }).click()
        await sidebar.getByRole("button", { name: "Restore Files & Task", exact: true }).click()
        await expect(sidebar.locator('[data-testid="send-button"][data-action="resume"]')).toBeVisible({ timeout: 30_000 })

        // The restore truncated the chat before the follow-up; the rail keeps only what remains.
        await expect
            .poll(async () => (await readTaskUiMessages(dlineDocsDir, taskId)).some((message) => message.text === followUp))
            .toBe(false)
        await expect.poll(() => rail.prompts(), { timeout: 30_000 }).toEqual([[task]])
        const remaining = await readTaskUiMessages(dlineDocsDir, taskId)
        expect(await sortedPreview(rail, task)).toEqual(previewOfSingleTurnChat(remaining))
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
    },
)

e2e(
    "Trajectory - a landed compaction card keeps turn boundaries and counts, also after reopening the task",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(240_000)
        await configureAutoCompact(dlineDir)
        const task = "E2E_TRAJECTORY_COMPACT_TASK"
        const second = "E2E_TRAJECTORY_COMPACT_SECOND"
        const trigger = "E2E_TRAJECTORY_COMPACT_TRIGGER"
        const summary = "E2E_TRAJECTORY_COMPACT_SUMMARY preserves the first two turns."
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_trajectory_compact_first",
                name: "attempt_completion",
                arguments: { result: "E2E_TRAJECTORY_COMPACT_FIRST_DONE" },
            },
            {
                type: "tool",
                id: "call_trajectory_compact_second",
                name: "attempt_completion",
                arguments: { result: "E2E_TRAJECTORY_COMPACT_SECOND_DONE" },
                usage: { inputTokens: 125_000, outputTokens: 100 },
            },
            {
                type: "tool",
                id: "call_trajectory_compact_summary",
                name: "summarize_task",
                arguments: { context: summary },
                expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER],
            },
            {
                type: "tool",
                id: "call_trajectory_compact_third",
                name: "attempt_completion",
                arguments: { result: "E2E_TRAJECTORY_COMPACT_THIRD_DONE" },
                expectedRequestIncludes: [summary, trigger],
                expectedRequestExcludes: [COMPACT_INSTRUCTION_MARKER],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const sidebar = await openSidebar(app, helper)
            const rail = trajectoryRail(sidebar)
            await sendMessage(sidebar, task)
            await expect(sidebar.getByText("E2E_TRAJECTORY_COMPACT_FIRST_DONE", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await sendMessage(sidebar, second)
            await expect(sidebar.getByText("E2E_TRAJECTORY_COMPACT_SECOND_DONE", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await expect.poll(() => rail.prompts(), { timeout: 30_000 }).toEqual([[task], [second]])
            const beforeCompaction = await rail.attempts()
            const firstPreview = await sortedPreview(rail, task)
            const secondPreview = await sortedPreview(rail, second)
            expect(firstPreview).toEqual({ rounds: 1, tools: [] })
            expect(secondPreview).toEqual({ rounds: 1, tools: [] })

            await sendMessage(sidebar, trigger)
            const landedCard = sidebar.getByTestId("compaction-pass").filter({ hasText: summary })
            await expect(landedCard).toHaveAttribute("data-compaction-status", "completed", { timeout: 60_000 })
            await expect(sidebar.getByText("E2E_TRAJECTORY_COMPACT_THIRD_DONE", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await expect.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 60_000 }).toBe(4)
            const requests = server.getMockConsumptions("openai-compatible-responses")
            expect(requests[2]).toMatchObject({ responseType: "tool", toolName: "summarize_task" })
            for (const request of requests) expect(request.contractError).toBeUndefined()

            // The card lands without moving a boundary or adding to any count: earlier turns are
            // unchanged, and the triggering turn shows only its one ordinary round.
            await expect.poll(() => rail.prompts(), { timeout: 30_000 }).toEqual([[task], [second], [trigger]])
            const afterCompaction = await rail.attempts()
            expect(afterCompaction.slice(0, 2)).toEqual(beforeCompaction)
            expect(await sortedPreview(rail, task)).toEqual(firstPreview)
            expect(await sortedPreview(rail, second)).toEqual(secondPreview)
            const triggerPreview = await sortedPreview(rail, trigger)
            expect(triggerPreview).toEqual({ rounds: 1, tools: [] })

            // Reopening restores the compaction card through its owner; the rail must not change.
            await closeCurrentTask(sidebar)
            await reopenTask(sidebar, task)
            await expect(landedCard).toHaveAttribute("data-compaction-status", "completed", { timeout: 30_000 })
            await expect.poll(() => rail.attempts(), { timeout: 30_000 }).toEqual(afterCompaction)
            expect(await sortedPreview(rail, second)).toEqual(secondPreview)
            expect(await sortedPreview(rail, trigger)).toEqual(triggerPreview)
            expect(server.getRequestCount("openai-compatible-responses")).toBe(4)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Trajectory - clicking a turn outside the loaded window scrolls the chat to its user message",
    async ({ dlineDocsDir, helper, sidebar, server, userDataDir }) => {
        e2e.setTimeout(180_000)
        const task = "E2E_TRAJECTORY_JUMP_TASK"
        const middle = "E2E_TRAJECTORY_JUMP_MIDDLE"
        const latest = "E2E_TRAJECTORY_JUMP_LATEST"
        await helper.signin(sidebar)
        const before = await taskDirectoryIds(dlineDocsDir)
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses({
            type: "tool",
            name: "attempt_completion",
            arguments: { result: "E2E_TRAJECTORY_JUMP_FIRST_DONE" },
        })
        await sendMessage(sidebar, task)
        const taskId = await waitForNewTaskId(dlineDocsDir, before)
        await expect(sidebar.getByText("E2E_TRAJECTORY_JUMP_FIRST_DONE", { exact: false }).last()).toBeVisible({
            timeout: 60_000,
        })

        // The middle turn is followed by far more rows than the latest message window holds,
        // so reopening loads only the tail and the middle user message is not in the chat.
        await closeCurrentTask(sidebar)
        await rewriteTaskUiMessages(dlineDocsDir, taskId, (messages) => {
            const start = messages.reduce((max, message) => Math.max(max, message.ts), 0) + 1
            // Three tail pages: the reopened chat and its first older page both stop well short of the middle turn.
            const filler: UiMessage[] = Array.from({ length: 600 }, (_, index) => ({
                ts: start + 1 + index,
                type: "say",
                say: "text",
                text: `E2E_TRAJECTORY_JUMP_FILLER_${index + 1}`,
            }))
            const tailStart = start + 1 + filler.length
            return [
                ...messages,
                { ts: start, type: "say", say: "user_feedback", text: middle },
                ...filler,
                { ts: tailStart, type: "say", say: "user_feedback", text: latest },
                { ts: tailStart + 1, type: "say", say: "text", text: "E2E_TRAJECTORY_JUMP_LATEST_ANSWER" },
            ]
        })
        await reopenTask(sidebar, task)

        const timeline = sidebar.getByTestId("virtuoso-item-list")
        await expect(timeline.getByText(latest, { exact: true })).toBeVisible({ timeout: 30_000 })
        const rail = trajectoryRail(sidebar)
        // Only a completed turn closes an attempt, so the two later turns share one band.
        await expect.poll(() => rail.prompts(), { timeout: 30_000 }).toEqual([[task], [middle, latest]])
        await expect(timeline.getByText(middle, { exact: true })).toHaveCount(0)

        await rail.jumpTo(middle)
        await expect(timeline.getByText(middle, { exact: true })).toBeVisible({ timeout: 30_000 })
        await expect(rail.bar(middle)).toHaveAttribute("aria-current", "location", { timeout: 30_000 })
        expect(server.openAiRequestCount).toBe(1)
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
    },
)
