import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { expectComposerText } from "@e2e/utils/composer"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { readTaskUiMessages, rewriteTaskUiMessages, waitForTaskRelease } from "@e2e/utils/task-instance-store"
import { trajectoryRail } from "@e2e/utils/trajectory-rail"
import { expect, type Frame, type Page } from "@playwright/test"
import type { UiMessage } from "@shared/ExtensionMessage"
import type { ElectronApplication } from "playwright"

const LABELS = {
    none: "No folding",
    round: "Per request",
    message_segment: "Per message segment",
    user_turn: "Per user turn",
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

async function taskIds(docs: string): Promise<string[]> {
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
    "Folding - canonical settings, Standard expansion, reopening and hover-revealed trajectory",
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
            for (const level of ["round", "message_segment", "user_turn"] as const) {
                await chooseLevel(page, sidebar, dlineDir, level)
                // `round` keeps one block per request round that holds foldable
                // activity: the command rounds only. Its reply and phase-report
                // rounds cut at the assistant message and hold nothing to fold.
                const expectedCount = level === "message_segment" ? 4 : level === "round" ? 5 : 1
                await expect(sidebar.getByTestId("activity-fold-header")).toHaveCount(expectedCount)
                if (level === "message_segment") {
                    for (const offset of [5, 8, 12]) {
                        const row = sidebar.locator(`[data-row-ts="${base + offset}"]`)
                        await expect(row).toBeAttached()
                        expect(await row.evaluate((element) => element.closest("[data-fold-id]") === null)).toBe(true)
                    }
                } else if (level === "round") {
                    // Every block holds one request round, so prose and replies keep their own rows.
                    for (const offset of [5, 8, 12]) {
                        const row = sidebar.locator(`[data-row-ts="${base + offset}"]`)
                        await expect(row).toBeAttached()
                        expect(await row.evaluate((element) => element.closest("[data-fold-id]") === null)).toBe(true)
                    }
                } else await expect(sidebar.locator(`[data-message-ts="${base + 5}"]`)).toHaveCount(0)
                await sidebar.locator('[data-virtuoso-scroller="true"]').hover({ position: { x: 2, y: 100 } })
                await sidebar.getByRole("button", { name: "Expand all activity", exact: true }).click()
                // Every block keeps its row and header while open, so the reader
                // can close it again with the same control.
                await expect(sidebar.locator("[data-fold-id]")).toHaveCount(expectedCount)
                await expect(sidebar.getByTestId("activity-fold-header")).toHaveCount(expectedCount)
                for (const header of await sidebar.getByTestId("activity-fold-header").all())
                    await expect(header).toHaveAttribute("aria-expanded", "true")
                // Every block draws its members; they are not promoted to top-level rows,
                // which is why the header stays available to close them again.
                await expect(sidebar.locator('[data-testid="activity-fold-children"]')).toHaveCount(expectedCount)
                await sidebar.getByRole("button", { name: "Collapse all activity", exact: true }).click()
                await expect(sidebar.getByTestId("activity-fold-header")).toHaveCount(expectedCount)
                for (const header of await sidebar.getByTestId("activity-fold-header").all())
                    await expect(header).toHaveAttribute("aria-expanded", "false")
                await expect(sidebar.locator('[data-testid="activity-fold-children"]')).toHaveCount(0)
            }
            // Reopening clears ephemeral expansion, but the canonical user choice persists.
            await sidebar.getByRole("button", { name: "Expand all activity", exact: true }).click()
            await closeTask(sidebar, dlineDocsDir, taskId)
            await reopen(sidebar, task)
            // Reopening streams the transcript in; wait for a real row before
            // reading the block structure, or an empty chat reads as "no blocks".
            await expect(sidebar.locator("[data-row-ts]").first()).toBeAttached({ timeout: 30_000 })
            await expect(sidebar.getByTestId("activity-fold-header")).toHaveCount(1, { timeout: 30_000 })
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
                await sidebar.getByTestId("chat-input").click()
                await page.mouse.move(1100, 80)
                await expect(rail.rail).toHaveCSS("opacity", "0")
                const oldTop = await scroller.evaluate((element) => element.scrollTop)
                await scroller.hover({ position: { x: 2, y: 100 } })
                await expect(rail.rail).toHaveCSS("opacity", "1")
                await expect(rail.rail).toHaveCSS("pointer-events", "auto")
                expect(await scroller.evaluate((element) => element.scrollTop)).toBe(oldTop)
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
            // An empty chat would satisfy "no blocks" for the wrong reason.
            await expect(sidebar.locator("[data-row-ts]").first()).toBeAttached({ timeout: 30_000 })
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

/**
 * The reviewed block behaviour: a header is drawn whether its block is open or
 * closed, so the same control closes what it opened. Before the fix the header
 * left the list with the block, and only the bulk control could close anything.
 */
e2e(
    "Folding - one header opens its block and closes it again",
    async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(180_000)
        const task = "E2E_FOLDING_TOGGLE"
        const before = await taskIds(dlineDocsDir)
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses({ type: "tool", name: "attempt_completion", arguments: { result: "FOLDING_TOGGLE_SEED" } })
        const app = await openVSCode(workspaceDir, { DLINE_EXPERIMENTAL_AGGRESSIVE_RENDERING: "true" })
        try {
            const { page, sidebar } = await openSidebar(app, helper)
            await send(sidebar, task)
            await expect(sidebar.getByText("FOLDING_TOGGLE_SEED", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            const taskId = await E2ETestHelper.waitForValue(
                async () => (await taskIds(dlineDocsDir)).find((id) => !before.includes(id)),
                30_000,
            )
            await closeTask(sidebar, dlineDocsDir, taskId)
            const base = Date.now()
            await rewriteTaskUiMessages(dlineDocsDir, taskId, () => fixtureTurn(base, task, true))
            await reopen(sidebar, task)
            await chooseLevel(page, sidebar, dlineDir, "user_turn")

            const header = sidebar.getByTestId("activity-fold-header")
            await expect(header).toHaveCount(1)
            const closedLabel = await header.textContent()

            await header.click()
            // The block is open: its members are drawn beneath the header.
            await expect(header).toHaveCount(1)
            await expect(header).toHaveAttribute("aria-expanded", "true")
            await expect(sidebar.locator(`[data-message-ts="${base + 5}"]`)).toBeVisible({ timeout: 30_000 })

            await header.click()
            // The same control closes it and the header keeps stating what it holds.
            await expect(header).toHaveCount(1)
            await expect(header).toHaveAttribute("aria-expanded", "false")
            await expect(sidebar.locator(`[data-message-ts="${base + 5}"]`)).toHaveCount(0)
            expect(await header.textContent()).toBe(closedLabel)
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
            const header = sidebar.getByTestId("activity-fold-header").filter({ hasText: "1 cmd failed" })
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

// Admission rejects malformed calls before command execution creates a card.
// The refusal must remain visible and terminal without inventing completed work.
e2e(
    "Folding - a rejected command call displays the admission error without an execution card",
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

            const refusal = sidebar.getByTestId("error-message-box")
            await expect(refusal).toBeVisible()
            await expect(refusal).toContainText("requires_approval")
            await expect(refusal).toContainText("execute_command")
            await expect(sidebar.getByTestId("command-card")).toHaveCount(0)
            const requests = server.getMockConsumptions()
            expect(requests).toHaveLength(2)
            expect(requests.every(({ contractError, requestToolPairing }) => !contractError && requestToolPairing.complete)).toBe(
                true,
            )
            const results = requests[1].requestToolResults.filter(({ callId }) => callId === "call_folding_rejected_command")
            expect(results).toHaveLength(1)
            const errorBody = /<error>([\s\S]*?)<\/error>/.exec(results[0].content)?.[1]
            expect(errorBody).toContain("requires_approval")
            expect(errorBody).not.toContain("FOLDING_REJECTED_COMMAND_NEVER_RUNS")
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "Folding - approval remains visible and a real checkpoint restore updates chat and trajectory",
    async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
        e2e.setTimeout(180_000)
        const task = "E2E_FOLDING_RESTORE"
        const followup = "E2E_FOLDING_FOLLOWUP"
        const before = await taskIds(dlineDocsDir)
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
            const taskId = await E2ETestHelper.waitForValue(
                async () => (await taskIds(dlineDocsDir)).find((id) => !before.includes(id)),
                30_000,
            )
            const target = (await readTaskUiMessages(dlineDocsDir, taskId)).find(
                (message) => message.say === "checkpoint_created" && message.checkpointSource?.kind === "round_start",
            )
            if (!target) throw new Error("Expected the task's persisted round-start checkpoint")
            const rail = trajectoryRail(sidebar)
            await expect.poll(() => rail.prompts()).toEqual([[task], [followup]])
            // A checkpoint-only finished turn folds too. Locate the actual marker,
            // not a count of standalone labels that depends on its presentation.
            await sidebar.getByTestId("activity-fold-header").first().hover()
            await sidebar.getByRole("button", { name: "Expand all activity", exact: true }).click()
            const checkpoint = sidebar.locator(`[data-message-ts="${target.ts}"]`)
            await expect(checkpoint).toBeVisible()
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
