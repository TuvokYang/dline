import { readdir } from "node:fs/promises"
import path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { rewriteTaskUiMessages, waitForTaskRelease } from "@e2e/utils/task-instance-store"
import { expect } from "@playwright/test"
import type { UiMessage } from "@shared/ExtensionMessage"

const TASK = "E2E_FLOATING_RENDER_DEPTH"

/** Capture renderer stacks before the host's diagnostic formatter truncates them. */
e2e(
    "Floating controls render-depth diagnostic retains the original renderer stack",
    async ({ dlineDocsDir, helper, openVSCode, server, workspaceDir }, testInfo) => {
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses({ type: "tool", name: "attempt_completion", arguments: { result: "FLOATING_DEPTH_READY" } })
        const app = await openVSCode(workspaceDir, { DLINE_EXPERIMENTAL_AGGRESSIVE_RENDERING: "true" })
        const page = await app.firstWindow()
        try {
            await page.setViewportSize({ width: 1200, height: 900 })
            await E2ETestHelper.openClineSidebar(page)
            const sidebar = await helper.getSidebar(page)
            await helper.signin(sidebar)
            await E2ETestHelper.dismissWhatsNewModal(sidebar)
            await sidebar.getByTestId("chat-input").fill(TASK)
            await sidebar.getByTestId("chat-input").press("Enter")
            await expect(sidebar.getByText("FLOATING_DEPTH_READY", { exact: false }).last()).toBeVisible()
            const taskId = await E2ETestHelper.waitForValue(async () => {
                const entries = await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true })
                return entries.find((entry) => entry.isDirectory())?.name
            })
            await sidebar.getByRole("button", { name: "Close Task", exact: true }).click()
            await waitForTaskRelease(dlineDocsDir, taskId)
            const base = Date.now()
            await rewriteTaskUiMessages(dlineDocsDir, taskId, () =>
                Array.from({ length: 40 }, (_, index): UiMessage[] => {
                    const ts = base + index * 10
                    return [
                        {
                            ts,
                            type: "say",
                            say: index === 0 ? "task" : "user_feedback",
                            text: index === 0 ? TASK : `DEPTH_TURN_${index}`,
                        },
                        {
                            ts: ts + 1,
                            type: "say",
                            say: "api_req_started",
                            text: JSON.stringify({ request: "fixture", cost: 0.01 }),
                        },
                        {
                            ts: ts + 2,
                            type: "ask",
                            ask: "command",
                            text: `echo turn-${index}`,
                            commandStatus: "completed",
                            exitCode: 0,
                        },
                        { ts: ts + 3, type: "say", say: "text", text: `DEPTH_REPLY_${index}` },
                        { ts: ts + 4, type: "ask", ask: "completion_result", text: `DEPTH_DONE_${index}` },
                    ]
                }).flat(),
            )
            await sidebar.getByText(TASK, { exact: true }).last().click()
            await page.getByRole("button", { name: "Settings", exact: true }).click()
            await sidebar.getByTestId("tab-general").click()
            await sidebar.locator("#aggressive-rendering").click()
            await sidebar.getByRole("option", { name: "Per user turn", exact: true }).click()
            await sidebar.getByRole("button", { name: "Done", exact: true }).click()
            await expect(sidebar.getByTestId("trajectory-turn")).toHaveCount(40)
            await sidebar.evaluate(() => {
                const diagnostic = window as Window & { floatingErrors?: string[] }
                diagnostic.floatingErrors = []
                const original = console.error.bind(console)
                console.error = (...args: unknown[]) => {
                    diagnostic.floatingErrors!.push(
                        args.map((arg) => (arg instanceof Error ? `${arg.message}\n${arg.stack}` : String(arg))).join("\n"),
                    )
                    original(...args)
                }
            })
            try {
                await sidebar.getByTestId("chat-input").click()
                await page.mouse.move(1100, 80)
                await sidebar.getByTestId("trajectory-turn").last().focus()
                await page.keyboard.press("Tab")
                await expect(sidebar.getByRole("button", { name: "Expand all activity", exact: true })).toBeFocused()
                await expect(sidebar.getByTestId("root-error-boundary")).toHaveCount(0)
            } finally {
                const errors = await sidebar.evaluate(
                    () => (window as Window & { floatingErrors?: string[] }).floatingErrors ?? [],
                )
                await testInfo.attach("floating-renderer-errors.json", {
                    body: JSON.stringify(errors, null, 2),
                    contentType: "application/json",
                })
                console.log("Floating renderer diagnostic:", JSON.stringify(errors))
            }
        } finally {
            await app.close()
        }
    },
)
