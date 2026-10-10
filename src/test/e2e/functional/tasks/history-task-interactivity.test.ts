import { readdir, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import {
    type HistoryInteractivityReport,
    readHistoryInteractivityProbe,
    startHistoryInteractivityProbe,
    stopHistoryInteractivityProbe,
} from "@e2e/utils/history-interactivity-probe"
import {
    createLargeRealProjectFixture,
    inspectLargeRealProjectGit,
    LARGE_PROJECT_TOTAL_TRACKED_FILES,
    type LargeRealProjectFixture,
} from "@e2e/utils/large-real-project-fixture"
import { readHistoryDisplay, rewriteTaskActivities, rewriteTaskUiMessages } from "@e2e/utils/task-instance-store"
import { expect, type Frame, type Page, type TestInfo } from "@playwright/test"
import type { TaskActivityRecord } from "@shared/task-activity"
import type { ElectronApplication } from "playwright"

const HISTORY_INTERACTIVE_BUDGET_MS = 5_000
const TASK_SURFACE_DEAD_WINDOW_BUDGET_MS = 2_000
const INTERRUPTED_TASK_TEXT = "E2E_LARGE_HISTORY_RESUME_INTERACTIVITY_TASK"
const INTERRUPTED_COMPLETION = "E2E_LARGE_HISTORY_RESUME_INTERACTIVITY_DONE"
const INTERRUPTED_DRAFT = "E2E_LARGE_HISTORY_RESUME_DRAFT"
const LEGACY_COMPLETION_TASK_TEXT = "E2E_LEGACY_COMPLETION_INTERACTIVITY_TASK"
const LEGACY_COMPLETION_TEXT = "E2E_LEGACY_COMPLETION_INTERACTIVITY_DONE"
const LEGACY_COMPLETION_ASK = "resume_completed_task"

interface StoredInteractionSnapshot {
    anchor?: { interactionId?: string; uiMessageTs?: number }
    completion?: { completionId?: string }
    interaction?: {
        anchor?: { messageTs?: number; messageType?: string }
        interactionId?: string
        kind?: string
        status?: string
    }
    phase?: string
    revision?: number
    taskId?: string
}

interface InteractivityEvidence {
    fixture: LargeRealProjectFixture
    gitAfter: Awaited<ReturnType<typeof inspectLargeRealProjectGit>>
    probe?: HistoryInteractivityReport
    snapshot?: StoredInteractionSnapshot
    snapshotTiming?: {
        observedAtMs: number
        toExpectedMs?: number
        toProbeStopMs: number
    }
    uiTail: Array<Record<string, unknown>>
}

async function openSidebar(app: ElectronApplication, helper: E2ETestHelper): Promise<{ page: Page; sidebar: Frame }> {
    const page = await app.firstWindow()
    await E2ETestHelper.openClineSidebar(page)
    const sidebar = await helper.getSidebar(page)
    await E2ETestHelper.dismissWhatsNewModal(sidebar)
    await helper.signin(sidebar)
    return { page, sidebar }
}

async function setAutoApproveRead(sidebar: Frame): Promise<void> {
    await sidebar.getByLabel("Open auto-approve settings").click()
    const checkbox = sidebar.locator("vscode-checkbox").filter({ hasText: "Read project files" })
    await expect(checkbox).toHaveCount(1)
    const checked = () => checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))
    if (!(await checked())) await sidebar.getByText("Read project files", { exact: true }).click()
    await expect.poll(checked).toBe(true)
    await sidebar.getByLabel("Close auto-approve settings").click()
}

async function sendTask(sidebar: Frame, text: string): Promise<void> {
    const input = sidebar.getByTestId("chat-input")
    await input.fill(text)
    await sidebar.getByTestId("send-button").click()
    await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

async function closeCurrentTask(sidebar: Frame): Promise<void> {
    const closeButton = sidebar.getByRole("button", { name: "Close Task", exact: true })
    await expect(closeButton).toBeVisible({ timeout: 30_000 })
    await closeButton.click()
    await expect(closeButton).toHaveCount(0, { timeout: 60_000 })
    await expect(sidebar.getByTestId("chat-input")).toBeVisible()
    await E2ETestHelper.dismissWhatsNewModal(sidebar)
}

async function onlyTaskId(dlineDocsDir: string): Promise<string> {
    return await E2ETestHelper.waitForValue(async () => {
        const entries = await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true }).catch(() => [])
        const ids = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
        return ids.length === 1 ? ids[0] : undefined
    }, 30_000)
}

/** Stores 160 large running activities for the closed task and returns their serialized size. */
async function seedLargeTransientActivityHistory(dlineDocsDir: string, taskId: string): Promise<number> {
    const createdAt = Date.now()
    const detail = "E2E_HISTORY_INTERACTIVITY_ACTIVITY_DETAIL_".padEnd(64 * 1024, "x")
    const output = "E2E_HISTORY_INTERACTIVITY_ACTIVITY_OUTPUT_".padEnd(64 * 1024, "y")
    const activities = Array.from({ length: 160 }, (_, index) => ({
        schemaVersion: 1,
        activityId: `e2e-history-interactivity-${index}`,
        taskId,
        kind: "command",
        executionMode: "background",
        cancellationOwner: "task",
        status: "running",
        createdAt: createdAt + index,
        updatedAt: createdAt + index,
        title: `E2E_HISTORY_INTERACTIVITY_ACTIVITY_${index}`,
        detail,
        output,
        timeoutSeconds: 0,
        events: [],
    }))
    await rewriteTaskActivities(dlineDocsDir, taskId, () => activities as unknown as TaskActivityRecord[])
    return Buffer.byteLength(JSON.stringify(activities), "utf8")
}

async function readSnapshot(taskDirectory: string): Promise<StoredInteractionSnapshot | undefined> {
    const dlineDocsDir = path.dirname(path.dirname(taskDirectory))
    const taskId = path.basename(taskDirectory)
    // The History display writes nothing until it is answered; read what it renders.
    const { view, messages } = await readHistoryDisplay(dlineDocsDir, taskId)
    if (!view.phase) return undefined
    // state.json keeps no anchor; it is the ask row the dialog's reveal wrote.
    const row = messages.findLast((message) => message.type === "ask" && message.interactionId === view.interactionId)
    return {
        taskId,
        phase: view.phase,
        completion: view.completionId ? { completionId: view.completionId } : undefined,
        anchor: view.anchorInteractionId ? { interactionId: view.anchorInteractionId } : undefined,
        interaction: view.interactionId
            ? {
                  interactionId: view.interactionId,
                  kind: view.interactionKind,
                  status: view.interactionStatus,
                  anchor: row ? { messageTs: row.ts, messageType: row.type } : undefined,
              }
            : undefined,
    }
}

async function waitForSnapshotInteraction(
    taskDirectory: string,
    kind: "completion" | "resume",
): Promise<StoredInteractionSnapshot> {
    return await E2ETestHelper.waitForValue(async () => {
        const snapshot = await readSnapshot(taskDirectory)
        return snapshot?.interaction?.kind === kind && snapshot.interaction.status === "awaiting" ? snapshot : undefined
    }, 30_000)
}

/** The rows the History display renders, including an anchor row it synthesized and has not written. */
async function readUiMessages(dlineDocsDir: string, taskId: string): Promise<Array<Record<string, unknown>>> {
    return (await readHistoryDisplay(dlineDocsDir, taskId)).messages as unknown as Array<Record<string, unknown>>
}

async function rewriteCompletionAskAsLegacy(dlineDocsDir: string, taskId: string): Promise<Record<string, unknown>> {
    let rewritten: Record<string, unknown> | undefined
    await rewriteTaskUiMessages(dlineDocsDir, taskId, (messages) => {
        const records = messages as unknown as Array<Record<string, unknown>>
        for (let index = records.length - 1; index >= 0; index--) {
            const message = records[index]
            if (message?.type === "ask" && message.ask === "completion_result") {
                rewritten = { ...message, ask: LEGACY_COMPLETION_ASK }
                records[index] = rewritten
                break
            }
        }
        if (!rewritten) throw new Error("Canonical completion ask was not persisted")
        return messages
    })
    if (!rewritten) throw new Error("Canonical completion ask was not persisted")
    return rewritten
}

async function waitForExpectedProbe(sidebar: Frame, timeoutMs: number): Promise<void> {
    await E2ETestHelper.waitForValue(async () => (await readHistoryInteractivityProbe(sidebar))?.expectedAtMs, timeoutMs).catch(
        () => undefined,
    )
}

async function browserNow(sidebar: Frame): Promise<number> {
    return await sidebar.evaluate(() => performance.now())
}

function snapshotTiming(observedAtMs: number, probe: HistoryInteractivityReport | undefined) {
    return {
        observedAtMs,
        toExpectedMs: probe?.expectedAtMs === undefined ? undefined : probe.expectedAtMs - observedAtMs,
        toProbeStopMs: (probe?.observedAtMs ?? observedAtMs) - observedAtMs,
    }
}

async function attachEvidence(testInfo: TestInfo, name: string, evidence: InteractivityEvidence): Promise<void> {
    const reportPath = testInfo.outputPath(`${name}.json`)
    await writeFile(reportPath, `${JSON.stringify(evidence, null, 2)}\n`, "utf8")
    await testInfo.attach(`${name}.json`, { path: reportPath, contentType: "application/json" })
}

function assertInteractivityTiming(report: HistoryInteractivityReport | undefined, expectedLabel: string): void {
    expect(report, "History interactivity probe was not available").toBeDefined()
    if (!report) return
    expect(report.clickAtMs, "History click was not observed by the probe").toBeDefined()
    expect(report.taskSurfaceAtMs, "Task surface did not become visible").toBeDefined()
    expect(report.expectedAtMs, `${expectedLabel} never became available; final=${JSON.stringify(report.current)}`).toBeDefined()
    if (report.historyClickToExpectedMs !== undefined) {
        expect(
            report.historyClickToExpectedMs,
            `${expectedLabel} must appear within ${HISTORY_INTERACTIVE_BUDGET_MS}ms`,
        ).toBeLessThan(HISTORY_INTERACTIVE_BUDGET_MS)
    }
    if (report.taskSurfaceToExpectedMs !== undefined) {
        expect(
            report.taskSurfaceToExpectedMs,
            `Task surface must not remain non-interactive for ${TASK_SURFACE_DEAD_WINDOW_BUDGET_MS}ms`,
        ).toBeLessThan(TASK_SURFACE_DEAD_WINDOW_BUDGET_MS)
    }
}

async function clickHistoryPreview(sidebar: Frame, taskText: string): Promise<void> {
    const historyTask = sidebar.locator(".history-preview-item").filter({ hasText: taskText })
    await expect(historyTask).toHaveCount(1, { timeout: 30_000 })
    await historyTask.click()
}

e2e(
    "History Resume interactivity - a large real project publishes Resume without a long disabled dead window",
    async ({ dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }, testInfo) => {
        e2e.setTimeout(360_000)
        const fixture = await createLargeRealProjectFixture(workspaceDir, {
            subagentProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
        })
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses(
            {
                type: "tool",
                id: "call_history_interactivity_read",
                name: "read_file",
                arguments: { path: fixture.targetFilePath },
            },
            {
                type: "tool",
                id: "call_history_interactivity_interrupted",
                name: "attempt_completion",
                arguments: { result: "E2E_HISTORY_INTERACTIVITY_INTERRUPTED_MUST_NOT_RENDER" },
                delayMs: 30_000,
                expectedToolResults: [{ callId: "call_history_interactivity_read", contentIncludes: fixture.targetMarker }],
            },
            {
                type: "tool",
                id: "call_history_interactivity_resumed",
                name: "attempt_completion",
                arguments: { result: INTERRUPTED_COMPLETION },
                expectedToolResults: [{ callId: "call_history_interactivity_read", contentIncludes: fixture.targetMarker }],
                expectedRequestIncludes: ["The previous task session was closed and has now been restored.", INTERRUPTED_DRAFT],
            },
        )

        const app = await openVSCode(workspaceDir)
        try {
            const { sidebar } = await openSidebar(app, helper)
            await setAutoApproveRead(sidebar)
            await sendTask(sidebar, INTERRUPTED_TASK_TEXT)
            await expect(sidebar.getByText("Dline read 1 file:", { exact: true })).toBeVisible({ timeout: 120_000 })
            await expect.poll(() => server.getRequestCount("openai-compatible-chat"), { timeout: 120_000 }).toBe(2)
            await closeCurrentTask(sidebar)
            await expect
                .poll(() => server.getMockConsumptions("openai-compatible-chat")[1]?.abortedAtMs, { timeout: 30_000 })
                .not.toBeUndefined()

            const taskId = await onlyTaskId(dlineDocsDir)
            const taskDirectory = path.join(dlineDocsDir, "tasks", taskId)
            const activityBytes = await seedLargeTransientActivityHistory(dlineDocsDir, taskId)
            await startHistoryInteractivityProbe(sidebar, "resume")
            await clickHistoryPreview(sidebar, INTERRUPTED_TASK_TEXT)
            await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible({ timeout: 30_000 })
            const snapshot = await waitForSnapshotInteraction(taskDirectory, "resume")
            const snapshotObservedAtMs = await browserNow(sidebar)
            await waitForExpectedProbe(sidebar, 30_000)
            const probe = await stopHistoryInteractivityProbe(sidebar)
            const gitAfter = await inspectLargeRealProjectGit(workspaceDir)
            const uiTail = (await readUiMessages(dlineDocsDir, taskId)).slice(-12)
            await attachEvidence(testInfo, "history-resume-interactivity", {
                fixture,
                gitAfter,
                probe,
                snapshot,
                snapshotTiming: snapshotTiming(snapshotObservedAtMs, probe),
                uiTail: [...uiTail, { activityBytes }],
            })

            expect(snapshot).toMatchObject({ phase: "paused", interaction: { kind: "resume", status: "awaiting" } })
            expect(uiTail).toContainEqual(
                expect.objectContaining({ type: "ask", ask: "resume_task", interactionId: snapshot.interaction?.interactionId }),
            )
            expect(server.getRequestCount("openai-compatible-chat")).toBe(2)
            expect(gitAfter).toEqual({
                commitHash: fixture.gitCommitHash,
                status: "",
                trackedFileCount: LARGE_PROJECT_TOTAL_TRACKED_FILES,
            })
            if (probe?.expectedAtMs !== undefined) {
                const input = sidebar.getByTestId("chat-input")
                await expect(sidebar.getByTestId("send-button")).toHaveAttribute("aria-disabled", "false")
                await input.fill(INTERRUPTED_DRAFT)
                await sidebar.getByRole("contentinfo").locator('vscode-button[aria-label="Resume"]').click()
                await expect(sidebar.getByText(INTERRUPTED_COMPLETION, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
                await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(3)
                expect(server.getMockConsumptions("openai-compatible-chat")[2]?.contractError).toBeUndefined()
            }
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
            assertInteractivityTiming(probe, "Resume")
        } finally {
            await app.close()
        }
    },
)

e2e(
    "History turn-end interactivity - a legacy completion anchor still restores Start New Task and send input",
    async ({ dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }, testInfo) => {
        e2e.setTimeout(360_000)
        const fixture = await createLargeRealProjectFixture(workspaceDir, {
            subagentProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
        })
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses({ type: "tool", name: "attempt_completion", arguments: { result: LEGACY_COMPLETION_TEXT } })

        let app: ElectronApplication | undefined
        try {
            app = await openVSCode(workspaceDir)
            let opened = await openSidebar(app, helper)
            await sendTask(opened.sidebar, LEGACY_COMPLETION_TASK_TEXT)
            await expect(opened.sidebar.getByText(LEGACY_COMPLETION_TEXT, { exact: false }).last()).toBeVisible({
                timeout: 120_000,
            })
            await expect(
                opened.sidebar.getByRole("contentinfo").locator('vscode-button[aria-label="Start New Task"]'),
            ).toBeVisible()
            await closeCurrentTask(opened.sidebar)

            const taskId = await onlyTaskId(dlineDocsDir)
            const taskDirectory = path.join(dlineDocsDir, "tasks", taskId)
            const legacyAsk = await rewriteCompletionAskAsLegacy(dlineDocsDir, taskId)
            await app.close()
            helper.clearCachedFrame()
            app = undefined

            app = await openVSCode(workspaceDir)
            opened = await openSidebar(app, helper)
            await startHistoryInteractivityProbe(opened.sidebar, "start-new-task")
            await clickHistoryPreview(opened.sidebar, LEGACY_COMPLETION_TASK_TEXT)
            await expect(opened.sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible({ timeout: 30_000 })
            const snapshot = await waitForSnapshotInteraction(taskDirectory, "completion")
            const snapshotObservedAtMs = await browserNow(opened.sidebar)
            await waitForExpectedProbe(opened.sidebar, 10_000)
            const probe = await stopHistoryInteractivityProbe(opened.sidebar)
            const gitAfter = await inspectLargeRealProjectGit(workspaceDir)
            const uiTail = (await readUiMessages(dlineDocsDir, taskId)).slice(-12)
            await attachEvidence(testInfo, "history-legacy-completion-interactivity", {
                fixture,
                gitAfter,
                probe,
                snapshot,
                snapshotTiming: snapshotTiming(snapshotObservedAtMs, probe),
                uiTail: [...uiTail, { legacyAsk }],
            })

            expect(snapshot).toMatchObject({
                phase: "completed",
                interaction: {
                    interactionId: legacyAsk.interactionId,
                    kind: "completion",
                    status: "awaiting",
                    anchor: { messageTs: legacyAsk.ts, messageType: "ask" },
                },
            })
            expect(uiTail).toContainEqual(
                expect.objectContaining({
                    type: "ask",
                    ask: LEGACY_COMPLETION_ASK,
                    interactionId: snapshot.interaction?.interactionId,
                }),
            )
            expect(server.getRequestCount("openai-compatible-chat")).toBe(1)
            expect(gitAfter).toEqual({
                commitHash: fixture.gitCommitHash,
                status: "",
                trackedFileCount: LARGE_PROJECT_TOTAL_TRACKED_FILES,
            })
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
            assertInteractivityTiming(probe, "Start New Task and send input")
        } finally {
            await app?.close()
            helper.clearCachedFrame()
        }
    },
)
