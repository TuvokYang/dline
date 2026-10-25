import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import {
    expectWorkMessageVisible,
    openWorkActivities,
    openWorkTab,
    prepareWorkSession,
    sendWorkMessage,
    setWorkAutoApproveAction,
} from "@e2e/utils/work/session"
import { expect, type Frame, type Locator, type Page } from "@playwright/test"

const PARENT_TARGET = "openai-compatible-chat" as const
const CHILD_TARGET = "openai-compatible-responses" as const
const AGENT_NAME = "work-daily-observer"
const TASK_TEXT = "WORK_DAILY_BACKGROUND_SUBAGENTS_TASK"
const TERMINAL_CAPTURE_REQUEST = "WORK_VSCODE_TERMINAL_CAPTURE_REQUEST"
const TERMINAL_REUSE_REQUEST = "WORK_VSCODE_TERMINAL_REUSE_REQUEST"
const FOREGROUND_COMMAND_REQUEST = "WORK_FOREGROUND_COMMAND_REQUEST"
const HANDOFF_COMMAND_REQUEST = "WORK_HANDOFF_COMMAND_REQUEST"
const DURING_COMMAND_INPUT = "WORK_DURING_BACKGROUND_COMMAND_INPUT"
const COLLECT_COMMAND_INPUT = "WORK_COLLECT_BACKGROUND_COMMAND_RESULT"
const FOREGROUND_SUBAGENT_REQUEST = "WORK_FOREGROUND_SUBAGENT_REQUEST"
const BACKGROUND_SUBAGENT_REQUEST = "WORK_BACKGROUND_SUBAGENT_REQUEST"
const DURING_SUBAGENT_INPUT = "WORK_DURING_BACKGROUND_SUBAGENT_INPUT"
const COLLECT_SUBAGENT_INPUT = "WORK_COLLECT_BACKGROUND_SUBAGENT_RESULT"
const FOREGROUND_CHILD_TASK = "WORK_FOREGROUND_SUBAGENT_CHILD_TASK"
const FOREGROUND_CHILD_CONTEXT = "Read README.md and return the foreground observation."
const FOREGROUND_CHILD_RESULT = "WORK_FOREGROUND_SUBAGENT_CHILD_OK"
const BACKGROUND_CHILD_TASK = "WORK_BACKGROUND_SUBAGENT_CHILD_TASK"
const BACKGROUND_CHILD_CONTEXT = "Read README.md, remain active briefly, and return the background observation."
const BACKGROUND_CHILD_RESULT = "WORK_BACKGROUND_SUBAGENT_CHILD_OK"
const BACKGROUND_CHILD_GATE = "work-background-child-complete"
const COMPLETE = "WORK_DAILY_BACKGROUND_SUBAGENTS_COMPLETE"
const TERMINAL_CAPTURE_MARKER = "WORK_VSCODE_TERMINAL_CAPTURE"
const TERMINAL_REUSE_MARKER = "WORK_VSCODE_TERMINAL_REUSE"
const FOREGROUND_COMMAND = `node -e "console.log('WORK_FOREGROUND_COMMAND_START'); console.log('WORK_FOREGROUND_COMMAND_END')"`
const BACKGROUND_COMMAND = `node -e "console.log('WORK_BACKGROUND_COMMAND_START'); setTimeout(()=>console.log('WORK_BACKGROUND_COMMAND_END'),30000)"`

interface TerminalPoolEvent {
    readonly index: number
    readonly terminalId: number
}

function terminalCommand(marker: string, exitCode: number): string {
    if (process.platform === "win32") {
        return `Write-Output "${marker}"; & $env:ComSpec /d /c "exit ${exitCode}"`
    }
    return `printf '${marker}\\n'; (exit ${exitCode})`
}

function parseTerminalEvents(output: string, operation: "acquire" | "release" | "warm"): TerminalPoolEvent[] {
    const suffix = operation === "acquire" ? "policy=reusable" : operation === "release" ? "disposition=reusable" : "state=ready"
    return [
        ...output.matchAll(
            new RegExp(`\\[TerminalPool\\] operation=${operation} partition=[a-f0-9]+ terminalId=(\\d+) ${suffix}`, "g"),
        ),
    ].map((match) => ({ index: match.index, terminalId: Number(match[1]) }))
}

async function writeWorkSubagent(workspaceDir: string): Promise<void> {
    const directory = path.join(workspaceDir, ".agents", "subagents")
    await mkdir(directory, { recursive: true })
    await writeFile(
        path.join(directory, `${AGENT_NAME}.yml`),
        `---
name: ${AGENT_NAME}
description: Observe the work test workspace and report concise findings.
profile: ${E2E_PROFILE_NAMES.mockOpenAiResponses}
tools:
  - read_file
  - attempt_completion
---

Read the requested workspace file, then finish through attempt_completion.`,
        "utf8",
    )
}

async function openTerminalSettings(page: Page, sidebar: Frame): Promise<Locator> {
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    await expect(sidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible({ timeout: 60_000 })
    await sidebar.getByTestId("tab-terminal").click()
    return sidebar.locator("#terminal-execution-mode")
}

async function configureTerminalHandoff(page: Page, sidebar: Frame): Promise<void> {
    const executionMode = await openTerminalSettings(page, sidebar)
    await executionMode.click()
    await sidebar.getByRole("option", { name: "VS Code Terminal", exact: true }).click()
    await expect.poll(() => executionMode.evaluate((element) => (element as HTMLSelectElement).value)).toBe("vscodeTerminal")
    const shellIntegrationTimeout = sidebar
        .getByText("Shell integration timeout (seconds)", { exact: true })
        .locator("..")
        .locator("vscode-text-field input")
    await shellIntegrationTimeout.fill("4")
    await shellIntegrationTimeout.blur()
    await expect(shellIntegrationTimeout).toHaveValue("4")
    const handoffSeconds = sidebar.locator("#terminal-command-handoff input")
    await handoffSeconds.fill("1")
    await handoffSeconds.blur()
    await expect(handoffSeconds).toHaveValue("1")
    await sidebar.getByRole("button", { name: "Done", exact: true }).click()
    await expect(sidebar.getByTestId("chat-input")).toBeVisible()
}

async function switchToBackgroundExec(page: Page, sidebar: Frame): Promise<void> {
    const executionMode = await openTerminalSettings(page, sidebar)
    await executionMode.click()
    await sidebar.getByRole("option", { name: "Background Exec", exact: true }).click()
    await expect.poll(() => executionMode.evaluate((element) => (element as HTMLSelectElement).value)).toBe("backgroundExec")
    await sidebar.getByRole("button", { name: "Done", exact: true }).click()
    await expect(sidebar.getByTestId("chat-input")).toBeVisible()
}

async function approveSubagentIfRequested(sidebar: Frame, task: string): Promise<void> {
    const approve = sidebar.getByRole("contentinfo").getByText("Approve", { exact: true })
    const taskHeading = sidebar.getByRole("heading", { name: task, exact: true }).last()
    await expect(approve.or(taskHeading)).toBeVisible({ timeout: 60_000 })
    if (await approve.isVisible()) await approve.click()
}

/** Height of the sticky user message that covers the top of the chat list, plus a margin. */
const STICKY_USER_MESSAGE_CLEARANCE_PX = 48
const REVEAL_MARGIN_PX = 24
const MAX_REVEAL_WHEELS = 20
/** Only an upward wheel hands the viewport to the reader; a programmatic or downward scroll keeps following the tail. */
const TAKE_OVER_WHEEL_PX = -40
const REVEAL_SETTLE_MS = 150
const REVEAL_CLICK_TIMEOUT_MS = 3_000
const REVEAL_AND_CLICK_TIMEOUT_MS = 45_000
const RETURN_TO_TAIL_WHEEL_PX = 2_400
const RETURN_TO_TAIL_TIMEOUT_MS = 30_000
const FLOATING_BUTTON_SETTLE_TIMEOUT_MS = 500

/**
 * Bring a control inside a chat row into the readable part of the list the way a reader does.
 *
 * Playwright's own scroll-into-view is a programmatic scroll. While the list still follows
 * the end of the conversation, rows that re-measure as they enter the viewport make it
 * return to the bottom, and the control lands under the sticky user message again on every
 * retry. A wheel over the list hands the viewport to the reader first, which is how a person
 * reaches an earlier row.
 */
async function revealInChat(sidebar: Frame, control: Locator): Promise<void> {
    const page = sidebar.page()
    const scroller = sidebar.locator('[data-virtuoso-scroller="true"]')
    const initialList = await scroller.boundingBox()
    if (!initialList) throw new Error("The chat list has no layout box")
    // Take the viewport first even when the control already looks readable: while the
    // list still follows the tail, the rows that settle after completion move it again.
    await page.mouse.move(initialList.x + initialList.width / 2, initialList.y + initialList.height / 2)
    await page.mouse.wheel(0, TAKE_OVER_WHEEL_PX)
    await page.waitForTimeout(REVEAL_SETTLE_MS)

    let settledTop: number | undefined
    for (let wheel = 0; wheel < MAX_REVEAL_WHEELS; wheel++) {
        const [list, target] = await Promise.all([scroller.boundingBox(), control.boundingBox()])
        if (!list || !target) throw new Error("The chat list or the control has no layout box")
        const readableTop = list.y + STICKY_USER_MESSAGE_CLEARANCE_PX
        const readableBottom = list.y + list.height
        if (target.y >= readableTop && target.y + target.height <= readableBottom) {
            // Two equal samples prove the row stopped moving before the click.
            if (settledTop !== undefined && Math.abs(target.y - settledTop) < 1) return
            settledTop = target.y
            await page.waitForTimeout(REVEAL_SETTLE_MS)
            continue
        }
        settledTop = undefined
        const delta =
            target.y < readableTop
                ? target.y - readableTop - REVEAL_MARGIN_PX
                : target.y + target.height - readableBottom + REVEAL_MARGIN_PX
        await page.mouse.move(list.x + list.width / 2, list.y + list.height / 2)
        await page.mouse.wheel(0, delta)
        await page.waitForTimeout(REVEAL_SETTLE_MS)
    }
    throw new Error("The chat control did not settle inside the readable part of the list")
}

/**
 * Hand the viewport back to the live tail after revealing an earlier row.
 *
 * Revealing takes the viewport from the list, which then stops following new rows,
 * and a message sent while the reader is away from the bottom deliberately keeps the
 * reader's position. Without this step a reply that lands below a tall card is never
 * rendered. Like a reader, wheel down and use the floating button that the downward
 * wheel turns into "Scroll to bottom"; reaching the end by wheel alone removes it.
 */
async function returnToLiveTail(sidebar: Frame): Promise<void> {
    const page = sidebar.page()
    const scroller = sidebar.locator('[data-virtuoso-scroller="true"]')
    const scrollToBottom = sidebar.getByRole("button", { name: "Scroll to bottom", exact: true })
    const floatingScrollButton = sidebar.getByRole("button", { name: /^Scroll to (bottom|top)$/ })
    await expect(async () => {
        const list = await scroller.boundingBox()
        if (!list) throw new Error("The chat list has no layout box")
        // Low in the list: the sticky user message covers its top.
        await page.mouse.move(list.x + list.width / 2, list.y + list.height - REVEAL_MARGIN_PX)
        await page.mouse.wheel(0, RETURN_TO_TAIL_WHEEL_PX)
        await page.waitForTimeout(REVEAL_SETTLE_MS)
        if (await scrollToBottom.isVisible()) {
            await scrollToBottom.click({ timeout: REVEAL_CLICK_TIMEOUT_MS })
            return
        }
        await expect(floatingScrollButton).toHaveCount(0, { timeout: FLOATING_BUTTON_SETTLE_TIMEOUT_MS })
    }).toPass({ timeout: RETURN_TO_TAIL_TIMEOUT_MS })
}

/** Reveal and click as one bounded step, so a row that moves between the two is revealed again. */
async function revealAndClickInChat(sidebar: Frame, control: Locator): Promise<void> {
    await expect(async () => {
        await revealInChat(sidebar, control)
        await control.click({ timeout: REVEAL_CLICK_TIMEOUT_MS })
    }).toPass({ timeout: REVEAL_AND_CLICK_TIMEOUT_MS })
}

async function expectCompletedSubagentCard(
    sidebar: Frame,
    task: string,
    contextMarker: string,
    result: string,
    executionMode: "Foreground" | "Background",
): Promise<Locator> {
    const taskHeading = sidebar.getByRole("heading", { name: task, exact: true }).last()
    await expect(taskHeading).toBeVisible({ timeout: 60_000 })
    const card = taskHeading.locator("xpath=ancestor::*[@data-testid='subagent-item'][1]")
    await expect(card.getByTestId("subagent-name")).toHaveText(AGENT_NAME)
    await expect(card.getByTestId("subagent-execution-mode")).toHaveText(executionMode)
    await expect(card.getByTestId("subagent-context-content")).toContainText(contextMarker)
    await expect(card.getByTestId("subagent-tool-step-name")).toHaveText(["read_file", "attempt_completion"])
    const showOutput = card.getByRole("button", { name: "Show subagent output", exact: true })
    const revealed = await showOutput.isVisible()
    if (revealed) {
        await revealAndClickInChat(sidebar, showOutput)
    }
    await expect(card.getByTestId("subagent-output")).toContainText(result)
    if (revealed) {
        await returnToLiveTail(sidebar)
    }
    return card
}

e2e(
    "daily background commands and subagents keep Activities and chat usable through foreground and background work",
    async ({ helper, page, server, sidebar, userDataDir, workspaceDir }) => {
        e2e.setTimeout(600_000)
        await writeWorkSubagent(workspaceDir)
        await prepareWorkSession(sidebar, helper)
        await configureTerminalHandoff(page, sidebar)
        await setWorkAutoApproveAction(sidebar, "Execute safe commands", true)

        server.resetOpenAiMock()
        server.enqueueResponses(
            PARENT_TARGET,
            {
                type: "tool",
                id: "call_work_background_ready",
                name: "qna_respond",
                arguments: { response: "WORK_DAILY_BACKGROUND_READY" },
                expectedRequestIncludes: [TASK_TEXT],
            },
            {
                type: "tool",
                id: "call_work_terminal_capture",
                name: "execute_command",
                arguments: {
                    command: terminalCommand(TERMINAL_CAPTURE_MARKER, 7),
                    workdirectory: ".",
                    requires_approval: false,
                    synchronous: true,
                    timeout: 60,
                },
                expectedRequestIncludes: [TERMINAL_CAPTURE_REQUEST],
            },
            {
                type: "tool",
                id: "call_work_terminal_capture_done",
                name: "qna_respond",
                arguments: { response: "WORK_VSCODE_TERMINAL_CAPTURE_OK" },
                expectedToolResults: [
                    {
                        callId: "call_work_terminal_capture",
                        contentIncludes: [TERMINAL_CAPTURE_MARKER, "Command failed with exit code 7."],
                    },
                ],
            },
            {
                type: "tool",
                id: "call_work_terminal_reuse",
                name: "execute_command",
                arguments: {
                    command: terminalCommand(TERMINAL_REUSE_MARKER, 0),
                    workdirectory: ".",
                    requires_approval: false,
                    synchronous: true,
                    timeout: 60,
                },
                expectedRequestIncludes: [TERMINAL_REUSE_REQUEST],
            },
            {
                type: "tool",
                id: "call_work_terminal_reuse_done",
                name: "qna_respond",
                arguments: { response: "WORK_VSCODE_TERMINAL_REUSE_OK" },
                expectedToolResults: [
                    {
                        callId: "call_work_terminal_reuse",
                        contentIncludes: [TERMINAL_REUSE_MARKER, "Command executed successfully (exit code 0)."],
                    },
                ],
            },
            {
                type: "tool",
                id: "call_work_foreground_command",
                name: "execute_command",
                arguments: {
                    command: FOREGROUND_COMMAND,
                    workdirectory: ".",
                    requires_approval: false,
                    synchronous: true,
                    timeout: 60,
                },
                expectedRequestIncludes: [FOREGROUND_COMMAND_REQUEST],
            },
            {
                type: "tool",
                id: "call_work_foreground_command_done",
                name: "qna_respond",
                arguments: { response: "WORK_FOREGROUND_COMMAND_OK" },
                expectedToolResults: [
                    {
                        callId: "call_work_foreground_command",
                        contentIncludes: ["WORK_FOREGROUND_COMMAND_START", "WORK_FOREGROUND_COMMAND_END"],
                    },
                ],
            },
            {
                type: "tool",
                id: "call_work_handoff_command",
                name: "execute_command",
                arguments: {
                    command: BACKGROUND_COMMAND,
                    workdirectory: ".",
                    requires_approval: false,
                    synchronous: true,
                    timeout: 60,
                },
                expectedRequestIncludes: [HANDOFF_COMMAND_REQUEST],
            },
            {
                type: "tool",
                id: "call_work_handoff_ready",
                name: "qna_respond",
                arguments: { response: "WORK_BACKGROUND_COMMAND_HANDED_OFF" },
                expectedToolResults: [
                    {
                        callId: "call_work_handoff_command",
                        contentIncludes: [
                            "Command is running in the background",
                            "Its final status will be available only in a later model request.",
                        ],
                    },
                ],
            },
            {
                type: "tool",
                id: "call_work_during_background_command",
                name: "qna_respond",
                arguments: { response: "WORK_DURING_BACKGROUND_COMMAND_OK" },
                expectedRequestIncludes: [DURING_COMMAND_INPUT],
            },
            {
                type: "tool",
                id: "call_work_background_command_result",
                name: "qna_respond",
                arguments: { response: "WORK_BACKGROUND_COMMAND_RESULT_OK" },
                expectedRequestIncludes: [
                    COLLECT_COMMAND_INPUT,
                    "# Background Results",
                    "## Background Command Results",
                    "WORK_BACKGROUND_COMMAND_START",
                    "WORK_BACKGROUND_COMMAND_END",
                ],
            },
            {
                type: "tool",
                id: "call_work_foreground_subagent",
                name: "use_subagent",
                arguments: {
                    agent_name: AGENT_NAME,
                    task: FOREGROUND_CHILD_TASK,
                    context: FOREGROUND_CHILD_CONTEXT,
                    timeout: 60,
                },
                expectedRequestIncludes: [FOREGROUND_SUBAGENT_REQUEST],
            },
            {
                type: "tool",
                id: "call_work_foreground_subagent_done",
                name: "qna_respond",
                arguments: { response: "WORK_FOREGROUND_SUBAGENT_OK" },
                expectedToolResults: [{ callId: "call_work_foreground_subagent", contentIncludes: FOREGROUND_CHILD_RESULT }],
            },
            {
                type: "tool",
                id: "call_work_background_subagent",
                name: "use_subagent",
                arguments: {
                    agent_name: AGENT_NAME,
                    task: BACKGROUND_CHILD_TASK,
                    context: BACKGROUND_CHILD_CONTEXT,
                    background: true,
                    timeout: 60,
                },
                expectedRequestIncludes: [BACKGROUND_SUBAGENT_REQUEST],
            },
            {
                type: "tool",
                id: "call_work_background_subagent_started",
                name: "qna_respond",
                arguments: { response: "WORK_BACKGROUND_SUBAGENT_STARTED" },
                expectedToolResults: [
                    {
                        callId: "call_work_background_subagent",
                        contentIncludes: [
                            "Started background subagent job: subagent_",
                            "Its final result will be available only in a later model request.",
                        ],
                    },
                ],
            },
            {
                type: "tool",
                id: "call_work_during_background_subagent",
                name: "qna_respond",
                arguments: { response: "WORK_DURING_BACKGROUND_SUBAGENT_OK" },
                expectedRequestIncludes: [DURING_SUBAGENT_INPUT, "# Background Subagents", BACKGROUND_CHILD_TASK],
            },
            {
                type: "tool",
                id: "call_work_background_subagent_complete",
                name: "attempt_completion",
                arguments: { result: COMPLETE },
                expectedRequestIncludes: [
                    COLLECT_SUBAGENT_INPUT,
                    "# Background Results",
                    "## Background Subagent Results",
                    BACKGROUND_CHILD_RESULT,
                ],
            },
            {
                type: "error",
                status: 500,
                code: "unexpected_additional_request",
                message: "Unexpected request after daily background/subagents completion",
            },
        )
        server.enqueueResponses(
            CHILD_TARGET,
            {
                type: "tool",
                id: "call_work_foreground_child_read",
                name: "read_file",
                arguments: { path: "README.md" },
                expectedRequestIncludes: [FOREGROUND_CHILD_TASK, FOREGROUND_CHILD_CONTEXT],
            },
            {
                type: "tool",
                id: "call_work_foreground_child_complete",
                name: "attempt_completion",
                arguments: { result: FOREGROUND_CHILD_RESULT },
                expectedToolResults: [{ callId: "call_work_foreground_child_read", contentIncludes: "# Test Workspace" }],
            },
            {
                type: "tool",
                id: "call_work_background_child_read",
                name: "read_file",
                arguments: { path: "README.md" },
                expectedRequestIncludes: [BACKGROUND_CHILD_TASK, BACKGROUND_CHILD_CONTEXT],
            },
            {
                type: "tool",
                id: "call_work_background_child_complete",
                name: "attempt_completion",
                arguments: { result: BACKGROUND_CHILD_RESULT },
                // Keep the child running until the running-state assertions are done; a fixed delay
                // raced slow runners and let the child finish before Activities was opened.
                holdUntilReleased: BACKGROUND_CHILD_GATE,
                expectedToolResults: [{ callId: "call_work_background_child_read", contentIncludes: "# Test Workspace" }],
            },
        )

        let taskStarted = false
        try {
            await sendWorkMessage(sidebar, TASK_TEXT)
            taskStarted = true
            await expect(sidebar.getByText("WORK_DAILY_BACKGROUND_READY", { exact: true })).toBeVisible({ timeout: 60_000 })

            await sendWorkMessage(sidebar, TERMINAL_CAPTURE_REQUEST)
            await expectWorkMessageVisible(sidebar, "WORK_VSCODE_TERMINAL_CAPTURE_OK", { timeout: 60_000 })
            await sendWorkMessage(sidebar, TERMINAL_REUSE_REQUEST)
            await expectWorkMessageVisible(sidebar, "WORK_VSCODE_TERMINAL_REUSE_OK", { timeout: 60_000 })
            let terminalOutput = ""
            await expect
                .poll(
                    async () => {
                        terminalOutput = await E2ETestHelper.readDlineOutput(userDataDir)
                        return (
                            parseTerminalEvents(terminalOutput, "acquire").length >= 2 &&
                            parseTerminalEvents(terminalOutput, "release").length >= 2
                        )
                    },
                    { timeout: 30_000 },
                )
                .toBe(true)
            const terminalAcquires = parseTerminalEvents(terminalOutput, "acquire").slice(-2)
            expect(terminalAcquires).toHaveLength(2)
            expect(new Set(terminalAcquires.map((event) => event.terminalId)).size).toBe(1)
            expect(
                parseTerminalEvents(terminalOutput, "warm").filter((event) => event.index > terminalAcquires[0].index),
                "sequential reusable Daily commands must not create replacement terminals",
            ).toEqual([])
            expect(terminalOutput).not.toContain("[TerminalPool] operation=fallback")
            expect(terminalOutput).not.toContain("[TerminalPerf] phase=capability_failure")
            await switchToBackgroundExec(page, sidebar)

            await sendWorkMessage(sidebar, FOREGROUND_COMMAND_REQUEST)
            await expect(sidebar.getByText("WORK_FOREGROUND_COMMAND_OK", { exact: true })).toBeVisible({ timeout: 60_000 })
            const foregroundCard = sidebar.getByTestId("command-card").last()
            await expect(foregroundCard.getByTestId("command-execution-mode")).toHaveText("Foreground")
            await foregroundCard.getByRole("button", { name: FOREGROUND_COMMAND, exact: true }).click()
            await expect(foregroundCard.getByTestId("command-output-scroll")).toContainText("WORK_FOREGROUND_COMMAND_END")

            await sendWorkMessage(sidebar, HANDOFF_COMMAND_REQUEST)
            const footer = sidebar.getByRole("contentinfo")
            const continueInBackground = footer.locator('vscode-button[aria-label="Continue in Background"]')
            // TaskView is the interaction authority and may lead the persisted message window in packaged mode.
            await expect(continueInBackground).toBeVisible({ timeout: 40_000 })
            await continueInBackground.click()

            let activities = await openWorkActivities(sidebar)
            const commandActivity = activities.filter({ hasText: BACKGROUND_COMMAND })
            await expect(commandActivity).toHaveCount(1, { timeout: 60_000 })
            await expect(commandActivity).toHaveAttribute("data-activity-status", "running")
            await openWorkTab(sidebar)
            // A running card is expanded and has no command-name button; that button only exists
            // once the card collapses after completion, which is too late to observe the handoff
            // while the command is still running.
            const handoffCard = sidebar.getByTestId("command-card").filter({ hasText: BACKGROUND_COMMAND })
            await expect(handoffCard.getByTestId("command-execution-mode")).toHaveText("Background", { timeout: 60_000 })
            await sendWorkMessage(sidebar, DURING_COMMAND_INPUT)
            await expectWorkMessageVisible(sidebar, "WORK_DURING_BACKGROUND_COMMAND_OK", { timeout: 60_000 })

            activities = await openWorkActivities(sidebar)
            await expect(commandActivity).toHaveAttribute("data-activity-status", "completed", { timeout: 60_000 })
            await openWorkTab(sidebar)
            await sendWorkMessage(sidebar, COLLECT_COMMAND_INPUT)
            await expectWorkMessageVisible(sidebar, "WORK_BACKGROUND_COMMAND_RESULT_OK", { timeout: 60_000 })

            await sendWorkMessage(sidebar, FOREGROUND_SUBAGENT_REQUEST)
            await approveSubagentIfRequested(sidebar, FOREGROUND_CHILD_TASK)
            await expectWorkMessageVisible(sidebar, "WORK_FOREGROUND_SUBAGENT_OK", { timeout: 60_000 })
            await expectCompletedSubagentCard(
                sidebar,
                FOREGROUND_CHILD_TASK,
                "Read README.md",
                FOREGROUND_CHILD_RESULT,
                "Foreground",
            )

            await sendWorkMessage(sidebar, BACKGROUND_SUBAGENT_REQUEST)
            await approveSubagentIfRequested(sidebar, BACKGROUND_CHILD_TASK)
            await expectWorkMessageVisible(sidebar, "WORK_BACKGROUND_SUBAGENT_STARTED", { timeout: 60_000 })
            const backgroundTaskHeading = sidebar.getByRole("heading", { name: BACKGROUND_CHILD_TASK, exact: true }).last()
            await expect(backgroundTaskHeading).toBeVisible()
            const backgroundCard = backgroundTaskHeading.locator("xpath=ancestor::*[@data-testid='subagent-item'][1]")
            await expect(backgroundCard.getByTestId("subagent-execution-mode")).toHaveText("Background")

            activities = await openWorkActivities(sidebar)
            const runningSubagentActivity = sidebar
                .locator('[data-testid="activity-item"][data-activity-status="running"]')
                .filter({ hasText: AGENT_NAME })
            await expect(runningSubagentActivity).toHaveCount(1, { timeout: 60_000 })
            await expect(runningSubagentActivity.getByTestId("activity-execution-mode")).toHaveText("Background")
            const subagentActivityId = await runningSubagentActivity.getAttribute("data-activity-id")
            if (!subagentActivityId) throw new Error("Running background subagent Activity did not expose an id")
            const subagentActivity = sidebar.locator(`[data-testid="activity-item"][data-activity-id="${subagentActivityId}"]`)
            await openWorkTab(sidebar)
            await sendWorkMessage(sidebar, DURING_SUBAGENT_INPUT)
            await expectWorkMessageVisible(sidebar, "WORK_DURING_BACKGROUND_SUBAGENT_OK", { timeout: 60_000 })
            server.releaseResponseGate(BACKGROUND_CHILD_GATE)

            activities = await openWorkActivities(sidebar)
            await expect(subagentActivity).toHaveAttribute("data-activity-status", "completed", { timeout: 60_000 })
            await openWorkTab(sidebar)
            await sendWorkMessage(sidebar, COLLECT_SUBAGENT_INPUT)
            await expectWorkMessageVisible(sidebar, COMPLETE, { exact: false, timeout: 60_000 })
            await expectCompletedSubagentCard(
                sidebar,
                BACKGROUND_CHILD_TASK,
                "Read README.md",
                BACKGROUND_CHILD_RESULT,
                "Background",
            )

            activities = await openWorkActivities(sidebar)
            await expect(activities.locator('[data-activity-status="running"]')).toHaveCount(0)
            await openWorkTab(sidebar)
            await expect.poll(() => server.getRequestCount(PARENT_TARGET)).toBe(17)
            await expect.poll(() => server.getRequestCount(CHILD_TARGET)).toBe(4)
            const parentConsumptions = server.getMockConsumptions(PARENT_TARGET)
            expect(parentConsumptions.map((entry) => entry.toolName)).toEqual([
                "qna_respond",
                "execute_command",
                "qna_respond",
                "execute_command",
                "qna_respond",
                "execute_command",
                "qna_respond",
                "execute_command",
                "qna_respond",
                "qna_respond",
                "qna_respond",
                "use_subagent",
                "qna_respond",
                "use_subagent",
                "qna_respond",
                "qna_respond",
                "attempt_completion",
            ])
            const childConsumptions = server.getMockConsumptions(CHILD_TARGET)
            expect(childConsumptions.map((entry) => entry.toolName)).toEqual([
                "read_file",
                "attempt_completion",
                "read_file",
                "attempt_completion",
            ])
            expect([...parentConsumptions, ...childConsumptions].every((entry) => entry.contractError === undefined)).toBe(true)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            if (taskStarted) {
                const closeTask = sidebar.getByRole("button", { name: "Close Task", exact: true })
                if (await closeTask.isVisible().catch(() => false)) await closeTask.click().catch(() => undefined)
            }
        }
    },
)
