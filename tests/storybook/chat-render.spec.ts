import { expect, type Page, test } from "@playwright/test"

const ACTIVE_CHAT_STORIES = [
    "active-conversation",
    "streaming-response",
    "long-conversation",
    "error-state",
    "auto-approval-enabled",
    "plan-mode",
    "browser-automation",
    "tool-approval",
    "tool-save",
    "command-execution",
    "command-output",
    "command-foreground-log-link",
    "api-request-failed",
    "mistake-limit-reached",
    "completion-result",
    "browser-action-launch",
    "mcp-server-usage",
    "followup",
    "resume-task",
    "new-task-with-context",
    "api-request-active",
    "make-plan-response",
    "condense-conversation",
    "report-bug",
    "resume-completed-task",
    "shell-integration-warning-with-suggestion",
    "shell-integration-warning-background-enabled",
    "shell-integration-warning",
    "error-retry-in-progress",
    "error-retry-failed",
    "generate-explanation-in-progress",
    "generate-explanation-complete",
    "generate-explanation-error",
    "generate-explanation-cancelled",
    "diff-edit-new-format",
    "diff-edit-new-format-streaming",
    "diff-edit-replace-diff-format",
    "diff-edit-replace-diff-format-streaming",
    "diff-edit-mixed-formats",
] as const

const ACTION_EXPECTATIONS = [
    { story: "tool-approval", actions: ["Approve", "Reject"] },
    { story: "tool-save", actions: ["Approve", "Reject"] },
    { story: "command-execution", actions: ["Approve", "Reject"] },
    { story: "api-request-failed", actions: ["Retry", "Start New Task"] },
    { story: "mistake-limit-reached", actions: ["Process Anyway", "Start New Task"] },
    { story: "completion-result", actions: ["Start New Task"] },
    { story: "browser-action-launch", actions: ["Approve", "Reject"] },
    { story: "mcp-server-usage", actions: ["Approve", "Reject"] },
    { story: "resume-task", actions: ["Resume"] },
    { story: "new-task-with-context", actions: ["Start New Task", "Regenerate Context"] },
    { story: "condense-conversation", actions: ["Condense Conversation", "Regenerate Summary"] },
    { story: "report-bug", actions: ["Report Bug"] },
    { story: "resume-completed-task", actions: ["Start New Task"] },
] as const

async function openChatStory(page: Page, story: string, rootTimeout = 60_000): Promise<string[]> {
    const pageErrors: string[] = []
    page.on("pageerror", (error) => {
        if (error.message !== "The user aborted a request.") {
            pageErrors.push(error.message)
        }
    })
    const response = await page.goto(`/iframe.html?id=views-chat--${story}&viewMode=story`, {
        waitUntil: "domcontentloaded",
    })
    expect(response?.ok()).toBe(true)
    await expect(page.locator("#storybook-root")).not.toBeEmpty({ timeout: rootTimeout })
    return pageErrors
}

// Warm the heavy Chat story module once before applying normal per-scenario timeouts.
test.describe.configure({ mode: "serial" })
test.beforeAll(async ({ browser }) => {
    test.setTimeout(180_000)
    const page = await browser.newPage()
    try {
        const pageErrors = await openChatStory(page, "active-conversation", 150_000)
        expect(pageErrors).toEqual([])
    } finally {
        await page.close()
    }
})

test.describe("Views/Chat active task rendering", () => {
    for (const story of ACTIVE_CHAT_STORIES) {
        test(`${story} renders the active ChatArea instead of Welcome`, async ({ page }) => {
            const pageErrors = await openChatStory(page, story)

            await expect(page.getByPlaceholder("Type a message...")).toBeVisible()
            await expect(page.getByPlaceholder("Type your task here...")).toHaveCount(0)
            await expect(page.getByText("Task interaction state is unavailable", { exact: true })).toHaveCount(0)
            expect(pageErrors).toEqual([])
        })
    }
})

test.describe("Views/Chat interaction actions", () => {
    for (const expectation of ACTION_EXPECTATIONS) {
        test(`${expectation.story} projects its interaction actions`, async ({ page }) => {
            const pageErrors = await openChatStory(page, expectation.story)

            for (const action of expectation.actions) {
                await expect(page.locator(`vscode-button[aria-label="${action}"]`)).toBeVisible()
            }
            expect(pageErrors).toEqual([])
        })
    }
})

test("foreground large-output command exposes a clickable log link", async ({ page }) => {
    const pageErrors = await openChatStory(page, "command-foreground-log-link")

    // The command card starts collapsed; expand it to reach the output region.
    await page.getByRole("button", { name: "python -m tests.random.cli run --suite pyiri --workers 6" }).click()

    const logLink = page.getByRole("button", { name: "Open log file command_1788858026082_162.log" })
    await expect(logLink).toBeVisible()
    await expect(logLink).toHaveAttribute(
        "title",
        "Click to open: C:\\Users\\yyk\\AppData\\Local\\Temp\\dline\\command_1788858026082_162.log",
    )
    // The raw notice text must be replaced by the link, not rendered as plain output.
    await expect(page.getByText("Output is large", { exact: false })).toHaveCount(0)
    await expect(page.getByText("shard [396, 397] done", { exact: false }).first()).toBeVisible()
    expect(pageErrors).toEqual([])
})

test("representative timeline cards render their scenario content", async ({ page }) => {
    const pageErrors = await openChatStory(page, "diff-edit-new-format")

    await expect(page.getByText("src/auth/types.ts", { exact: false }).first()).toBeVisible()
    await expect(page.getByText("src/auth/login.ts", { exact: false }).first()).toBeVisible()
    expect(pageErrors).toEqual([])
})
