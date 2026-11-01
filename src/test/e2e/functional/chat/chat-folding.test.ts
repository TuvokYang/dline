import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { expectComposerText } from "@e2e/utils/composer"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { rewriteTaskUiMessages, waitForTaskRelease } from "@e2e/utils/task-instance-store"
import { trajectoryRail } from "@e2e/utils/trajectory-rail"
import { expect, type Frame, type Page } from "@playwright/test"
import type { UiMessage } from "@shared/ExtensionMessage"
import type { ElectronApplication } from "playwright"

const LABELS = {
    none: "Standard (no folding)",
    message_segment: "Fold activity between messages",
    user_turn: "Fold the whole turn into one block",
} as const
type Level = keyof typeof LABELS

async function openSidebar(app: ElectronApplication, helper: E2ETestHelper) {
    const page = await app.firstWindow()
    await E2ETestHelper.openClineSidebar(page)
    const sidebar = await helper.getSidebar(page)
    await E2ETestHelper.dismissWhatsNewModal(sidebar)
    await helper.signin(sidebar)
    return { page, sidebar }
}

async function storedLevel(dlineDir: string) {
    const settings = JSON.parse(await readFile(path.join(dlineDir, "data/settings/settings.json"), "utf8"))
    return settings.aggressiveRendering
}

async function chooseLevel(page: Page, sidebar: Frame, dlineDir: string, level: Level) {
    await page.getByRole("button", { name: "Settings", exact: true }).click()
    await sidebar.getByTestId("tab-general").click()
    const dropdown = sidebar.locator("#aggressive-rendering")
    await dropdown.click()
    await sidebar.getByRole("option", { name: LABELS[level], exact: true }).click()
    await expect.poll(() => storedLevel(dlineDir)).toBe(level)
    await sidebar.getByRole("button", { name: "Done", exact: true }).click()
    await expect(sidebar.getByTestId("chat-input")).toBeVisible()
}

async function send(sidebar: Frame, text: string) {
    const input = sidebar.getByTestId("chat-input")
    await expect(input).toBeEnabled({ timeout: 30_000 })
    await input.fill(text)
    await input.press("Enter")
    await expectComposerText(input, "")
}

async function closeTask(sidebar: Frame, docs: string, taskId: string) {
    await sidebar.getByRole("button", { name: "Close Task", exact: true }).click()
    await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toHaveCount(0)
    await waitForTaskRelease(docs, taskId)
}

async function reopen(sidebar: Frame, task: string) {
    await E2ETestHelper.dismissWhatsNewModal(sidebar)
    await sidebar.getByText(task, { exact: true }).last().click()
    await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible({ timeout: 30_000 })
}

/** Requests are hidden notices; commands cross request boundaries before each communication boundary. */
function fixtureTurn(ts: number, prompt: string, first: boolean): UiMessage[] {
    const say = (offset: number, say: UiMessage["say"], text: string): UiMessage => ({ ts: ts + offset, type: "say", say, text })
    const request = (offset: number) => say(offset, "api_req_started", JSON.stringify({ request: "fixture", cost: 0.01 }))
    const command = (offset: number): UiMessage => ({
        ts: ts + offset,
        type: "ask",
        ask: "command",
        text: `echo folding-${offset}`,
        commandStatus: "completed",
        exitCode: 0,
    })
    return [
        say(0, first ? "task" : "user_feedback", prompt),
        request(1),
        command(2),
        request(3),
        command(4),
        say(5, "text", `FOLDING_TEXT_${ts}`),
        request(6),
        command(7),
        say(8, "tool", JSON.stringify({ tool: "actModeRespond", content: `FOLDING_REPLY_${ts}` })),
        request(9),
        command(10),
        request(11),
        say(12, "tool", JSON.stringify({ tool: "statusUpdate", content: `FOLDING_PHASE_${ts}` })),
        request(13),
        command(14),
        request(15),
        { ts: ts + 16, type: "ask", ask: "completion_result", text: `FOLDING_DONE_${ts}` },
    ]
}

async function taskIds(docs: string) {
    return readdir(path.join(docs, "tasks"), { withFileTypes: true })
        .then((entries) => entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name))
        .catch(() => [])
}

/** Read actual virtual rows across the viewport, not a second implementation of grouping. */
async function renderedOrder(sidebar: Frame) {
    const scroller = sidebar.locator('[data-virtuoso-scroller="true"]')
    await scroller.evaluate((element) => {
        element.scrollTop = 0
    })
    const seen = new Map<number, string>()
    for (let step = 0; step < 30; step += 1) {
        const rows = await scroller.locator("[data-index]").evaluateAll((elements) =>
            elements.map((element) => ({
                index: Number(element.getAttribute("data-index")),
                ts: element.querySelector("[data-row-ts]")?.getAttribute("data-row-ts") ?? "",
            })),
        )
        for (const row of rows) if (row.ts) seen.set(row.index, row.ts)
        const bottom = await scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop <= 2)
        if (bottom) break
        await scroller.evaluate((element) => {
            element.scrollTop += element.clientHeight / 2
        })
        await expect.poll(() => scroller.locator("[data-index]").count()).toBeGreaterThan(0)
    }
    return [...seen].sort(([left], [right]) => left - right).map(([, ts]) => ts)
}

e2e(
    "Folding - canonical settings, Standard expansion, reopening and scroll-revealed trajectory",
    async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }, testInfo) => {
        e2e.setTimeout(240_000)
        const task = "E2E_FOLDING_CANONICAL"
        const before = await taskIds(dlineDocsDir)
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses({ type: "tool", name: "attempt_completion", arguments: { result: "FOLDING_SEED_DONE" } })
        let app = await openVSCode(workspaceDir, { DLINE_EXPERIMENTAL_AGGRESSIVE_RENDERING: "true" })
        try {
            let { page, sidebar } = await openSidebar(app, helper)
            await send(sidebar, task)
            await expect(sidebar.getByText("FOLDING_SEED_DONE", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            const taskId = await E2ETestHelper.waitForValue(
                async () => (await taskIds(dlineDocsDir)).find((id) => !before.includes(id)),
                30_000,
            )
            await closeTask(sidebar, dlineDocsDir, taskId)
            const base = Date.now()
            await rewriteTaskUiMessages(dlineDocsDir, taskId, () => fixtureTurn(base, task, true))
            await reopen(sidebar, task)
            // Selecting an already-selected default emits no change; exercise a real round trip.
            await chooseLevel(page, sidebar, dlineDir, "message_segment")
            await chooseLevel(page, sidebar, dlineDir, "none")
            const baseline = [0, 2, 4, 5, 7, 8, 10, 12, 14, 16].map((offset) => String(base + offset))
            await expect.poll(() => renderedOrder(sidebar)).toEqual(baseline)
            for (const level of ["message_segment", "user_turn"] as const) {
                await chooseLevel(page, sidebar, dlineDir, level)
                const expectedCount = level === "message_segment" ? 4 : 1
                await expect(sidebar.getByTestId("activity-fold-header")).toHaveCount(expectedCount)
                if (level === "message_segment") {
                    for (const offset of [5, 8, 12]) {
                        const row = sidebar.locator(`[data-row-ts="${base + offset}"]`)
                        await expect(row).toBeAttached()
                        expect(await row.evaluate((element) => element.closest("[data-fold-id]") === null)).toBe(true)
                    }
                } else await expect(sidebar.locator(`[data-message-ts="${base + 5}"]`)).toHaveCount(0)
                await sidebar.getByRole("button", { name: "Expand all activity", exact: true }).click()
                await expect(sidebar.locator("[data-fold-id]")).toHaveCount(0)
                await expect.poll(() => renderedOrder(sidebar)).toEqual(baseline)
                await sidebar.getByRole("button", { name: "Collapse all activity", exact: true }).click()
                await expect(sidebar.getByTestId("activity-fold-header")).toHaveCount(expectedCount)
            }
            // Reopening clears ephemeral expansion, but the canonical user choice persists.
            await sidebar.getByRole("button", { name: "Expand all activity", exact: true }).click()
            await closeTask(sidebar, dlineDocsDir, taskId)
            await reopen(sidebar, task)
            await expect(sidebar.getByTestId("activity-fold-header")).toHaveCount(1)
            await closeTask(sidebar, dlineDocsDir, taskId)
            const turns = Array.from({ length: 12 }, (_, index) =>
                fixtureTurn(base + index * 100, index === 0 ? task : `E2E_FOLDING_TURN_${index}`, index === 0),
            ).flat()
            await rewriteTaskUiMessages(dlineDocsDir, taskId, () => turns)
            await reopen(sidebar, task)
            const rail = trajectoryRail(sidebar)
            await expect(rail.rail.getByTestId("trajectory-turn")).toHaveCount(12)
            const scroller = sidebar.locator('[data-virtuoso-scroller="true"]')
            for (const expanded of [false, true]) {
                if (expanded) await sidebar.getByRole("button", { name: "Expand all activity", exact: true }).click()
                await page.mouse.move(100, 100)
                await expect(rail.rail).toHaveCSS("opacity", "0")
                const oldTop = await scroller.evaluate((element) => element.scrollTop)
                await scroller.hover({ position: { x: 2, y: 100 } })
                await page.mouse.wheel(0, oldTop > 100 ? -450 : 450)
                await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).not.toBe(oldTop)
                await expect(rail.rail).toHaveCSS("opacity", "1")
                await expect(rail.rail).toHaveCSS("pointer-events", "auto")
                await rail.bar("E2E_FOLDING_TURN_1").click()
                await expect(sidebar.locator(`[data-message-ts="${base + 100}"]`)).toBeInViewport({ timeout: 30_000 })
                await expect(rail.bar("E2E_FOLDING_TURN_1")).toHaveAttribute("aria-current", "location")
                await testInfo.attach(`folding-trajectory-${expanded ? "expanded" : "collapsed"}`, {
                    body: await page.screenshot(),
                    contentType: "image/png",
                })
            }
            await closeTask(sidebar, dlineDocsDir, taskId)
            await app.close()
            app = await openVSCode(workspaceDir, { DLINE_EXPERIMENTAL_AGGRESSIVE_RENDERING: "false" })
            ;({ page, sidebar } = await openSidebar(app, helper))
            await reopen(sidebar, task)
            await expect(sidebar.locator("[data-fold-id]")).toHaveCount(0)
            expect(await storedLevel(dlineDir)).toBe("user_turn")
            await closeTask(sidebar, dlineDocsDir, taskId)
            await app.close()
            app = await openVSCode(workspaceDir, { DLINE_EXPERIMENTAL_AGGRESSIVE_RENDERING: "true" })
            ;({ sidebar } = await openSidebar(app, helper))
            await reopen(sidebar, task)
            await expect.poll(() => sidebar.getByTestId("activity-fold-header").count()).toBeGreaterThan(0)
            expect(await storedLevel(dlineDir)).toBe("user_turn")
            expect(server.openAiRequestCount).toBe(1)
            const consumptions = server.getMockConsumptions("openai-compatible-chat")
            expect(consumptions).toHaveLength(1)
            for (const consumption of consumptions) expect(consumption.contractError).toBeUndefined()
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Folding - a failed command is folded into the block and counted as a command error",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }, testInfo) => {
        e2e.setTimeout(180_000)
        const task = "E2E_FOLDING_FAILED_COMMAND"
        server.resetOpenAiMock()
        // A bare `exit 1` would end the shell before it prints the completion
        // marker Dline's foreground wrapper waits for, and a bare unknown name is
        // not fatal either, so neither reliably produces a finished failing
        // command. A failing child process keeps the wrapper alive to report the
        // real exit code; this is the same fixture `task-tools.test.ts` uses.
        const failedCommand = `node -e "console.error('E2E_FOLDING_COMMAND_FAILED'); process.exit(7)"`
        // `requires_approval` is a required parameter: without it the handler
        // rejects the call and the command never runs, which would test the
        // validation error rather than a failed command.
        server.enqueueOpenAiResponses(
            {
                type: "tool",
                id: "call_folding_failed_command",
                name: "execute_command",
                arguments: { command: failedCommand, requires_approval: false, synchronous: true },
            },
            {
                type: "tool",
                name: "attempt_completion",
                arguments: { result: "FOLDING_FAILED_COMMAND_DONE" },
                expectedToolResults: [{ callId: "call_folding_failed_command", contentIncludes: "E2E_FOLDING_COMMAND_FAILED" }],
            },
        )
        const app = await openVSCode(workspaceDir, { DLINE_EXPERIMENTAL_AGGRESSIVE_RENDERING: "true" })
        try {
            const { page, sidebar } = await openSidebar(app, helper)
            await chooseLevel(page, sidebar, dlineDir, "user_turn")
            await send(sidebar, task)
            // Safe Commands are auto-approved in this environment, and auto-approval
            // is the task's own contract, so only approve when the prompt appears.
            const approve = sidebar.getByText("Approve", { exact: true })
            if (await approve.isVisible().catch(() => false)) await approve.click()
            await expect(sidebar.getByText("FOLDING_FAILED_COMMAND_DONE", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })

            // The failed command is finished work inside the turn, so it is not
            // drawn on its own: it lives behind a block whose header states the
            // count. Assert the header that owns the failed row rather than the
            // number of blocks, because a turn may hold more than one block.
            const header = sidebar.getByTestId("activity-fold-header").filter({ hasText: "1 command error" })
            await expect(header).toHaveCount(1)
            await testInfo.attach("folding-failed-command", { body: await page.screenshot(), contentType: "image/png" })

            // Opening the block still shows the failed command itself.
            await header.click()
            await expect(sidebar.getByText("E2E_FOLDING_COMMAND_FAILED", { exact: false }).last()).toBeVisible({
                timeout: 30_000,
            })
            // The error tone itself is asserted in the component test, where the
            // rendered class is the contract; this journey stops at the behaviour:
            // the failed command is inside the block and stated in its header.
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

// The call never ran, so its streamed preview must not keep a completed card.
// Before the fix the row stayed partial, the chat drew it as `Completed`, and the
// folded block never counted it — the failure shown to the model was invisible.
e2e(
    "Folding - a rejected command call settles as a counted command error instead of a completed card",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(180_000)
        const task = "E2E_FOLDING_REJECTED_COMMAND"
        server.resetOpenAiMock()
        // `requires_approval` is required, so this call is rejected during
        // validation and never reaches the terminal.
        server.enqueueOpenAiResponses(
            {
                type: "tool",
                id: "call_folding_rejected_command",
                name: "execute_command",
                arguments: { command: "echo FOLDING_REJECTED_COMMAND_NEVER_RUNS" },
            },
            {
                type: "tool",
                name: "attempt_completion",
                arguments: { result: "FOLDING_REJECTED_COMMAND_DONE" },
                expectedToolResults: [{ callId: "call_folding_rejected_command", contentIncludes: "requires_approval" }],
            },
        )
        const app = await openVSCode(workspaceDir, { DLINE_EXPERIMENTAL_AGGRESSIVE_RENDERING: "true" })
        try {
            const { page, sidebar } = await openSidebar(app, helper)
            await chooseLevel(page, sidebar, dlineDir, "user_turn")
            await send(sidebar, task)
            await expect(sidebar.getByText("FOLDING_REJECTED_COMMAND_DONE", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })

            // The rejected call is finished work of a countable kind, so it belongs
            // in the block and its header states the error. Before the fix this
            // header could not appear: the row was still partial, so folding read it
            // as live work and left it outside every block.
            const header = sidebar.getByTestId("activity-fold-header").filter({ hasText: "1 command error" })
            await expect(header).toHaveCount(1)

            // Opening the block shows the rejected command, and its card states the
            // state the call actually reached rather than a completed one.
            await header.click()
            const rejectedCard = sidebar.getByTestId("command-card").filter({ hasText: "FOLDING_REJECTED_COMMAND_NEVER_RUNS" })
            await expect(rejectedCard).toHaveCount(1)
            await expect(rejectedCard.getByText("Failed", { exact: true })).toBeVisible({ timeout: 30_000 })
            await expect(rejectedCard.getByText("Completed", { exact: true })).toHaveCount(0)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Folding - approval remains visible and a real checkpoint restore updates chat and trajectory",
    async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(180_000)
        const task = "E2E_FOLDING_RESTORE"
        const followup = "E2E_FOLDING_FOLLOWUP"
        await writeFile(path.join(workspaceDir, "folding-restore.txt"), "before folding\n", "utf8")
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses(
            {
                type: "tool",
                name: "replace_in_file",
                arguments: {
                    path: "folding-restore.txt",
                    diff: "------- SEARCH\nbefore folding\n=======\nafter folding\n+++++++ REPLACE",
                },
            },
            { type: "tool", name: "attempt_completion", arguments: { result: "FOLDING_RESTORE_DONE" } },
            { type: "tool", name: "attempt_completion", arguments: { result: "FOLDING_FOLLOWUP_DONE" } },
        )
        const app = await openVSCode(workspaceDir, { DLINE_EXPERIMENTAL_AGGRESSIVE_RENDERING: "true" })
        try {
            const { page, sidebar } = await openSidebar(app, helper)
            await chooseLevel(page, sidebar, dlineDir, "user_turn")
            await send(sidebar, task)
            await expect(sidebar.getByText("Approve", { exact: true })).toBeVisible({ timeout: 60_000 })
            await expect(sidebar.getByTestId("activity-fold-header")).toHaveCount(0)
            await sidebar.getByText("Approve", { exact: true }).click()
            await expect(sidebar.getByText("FOLDING_RESTORE_DONE", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await send(sidebar, followup)
            await expect(sidebar.getByText("FOLDING_FOLLOWUP_DONE", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            // Both turns have a round-start checkpoint, including the completion-only follow-up.
            await expect(sidebar.getByTestId("activity-fold-header")).toHaveCount(2)
            const rail = trajectoryRail(sidebar)
            await expect.poll(() => rail.prompts()).toEqual([[task], [followup]])
            await sidebar.getByRole("button", { name: "Expand all activity", exact: true }).click()
            const checkpoint = sidebar.getByText("Checkpoint", { exact: true }).first().locator("..").locator("..")
            await checkpoint.hover()
            await checkpoint.getByRole("button", { name: "Restore", exact: true }).click()
            await sidebar.getByRole("button", { name: "Restore Files & Task", exact: true }).click()
            await expect(sidebar.locator('[data-testid="send-button"][data-action="resume"]')).toBeVisible({ timeout: 30_000 })
            await expect.poll(() => rail.prompts(), { timeout: 30_000 }).toEqual([[task]])
            expect(await readFile(path.join(workspaceDir, "folding-restore.txt"), "utf8")).toBe("before folding\n")
            expect(server.openAiRequestCount).toBe(3)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)
