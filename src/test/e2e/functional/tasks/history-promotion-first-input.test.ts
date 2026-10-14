import { expectComposerText } from "@e2e/utils/composer"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

/**
 * The first message sent on a Task opened from History promotes the read-only
 * history surface into a running Task. That promotion must continue the same
 * view: the message is delivered and shown once, and the conversation already
 * on screen is never cleared and reloaded while it happens.
 */

const CHAT_TARGET = "openai-compatible-chat"

async function sendTask(sidebar: Frame, text: string): Promise<void> {
    const input = sidebar.getByTestId("chat-input")
    await input.fill(text)
    await sidebar.getByTestId("send-button").click()
    await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

async function closeCurrentTask(sidebar: Frame): Promise<void> {
    const closeButton = sidebar.getByRole("button", { name: "Close Task", exact: true })
    await expect(closeButton).toBeVisible()
    await closeButton.click()
    await expect(sidebar.getByTestId("chat-input")).toBeVisible()
    await E2ETestHelper.dismissWhatsNewModal(sidebar)
}

async function reopenTask(sidebar: Frame, taskText: string): Promise<void> {
    const historyTask = sidebar.getByText(taskText, { exact: true }).last()
    await expect(historyTask).toBeVisible({ timeout: 30_000 })
    await historyTask.click()
    await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible({ timeout: 30_000 })
}

function userFeedback(sidebar: Frame, text: string) {
    return sidebar.getByTestId(/^(?:user|queued)-input-markdown-scroll$/).filter({ hasText: text })
}

/**
 * Record whether the task's opening message ever leaves the chat. A promotion
 * that replaces the view identity empties the message window before refetching
 * it, which is the flash the user sees; a MutationObserver catches that
 * intermediate commit even when the refetch restores the rows quickly.
 */
interface ChatContinuity {
    readonly cleared: boolean
    /** Every change of the opening row's presence, with the user-input row count and footer action. */
    readonly timeline: readonly string[]
}

type ChatContinuityScope = typeof window & {
    __dlineChatContinuity?: { cleared: boolean; timeline: string[]; last: string }
    __dlineChatObserver?: MutationObserver
}

async function startChatContinuityObserver(sidebar: Frame, taskText: string): Promise<void> {
    // History publishes Resume before its first message window arrives, so the
    // observation starts only once the opening row is actually on screen.
    await expect(sidebar.getByTestId("direct-user-input").filter({ hasText: taskText })).toBeVisible({ timeout: 30_000 })
    await sidebar.evaluate((text) => {
        const scope = window as ChatContinuityScope
        scope.__dlineChatObserver?.disconnect()
        const continuity = { cleared: false, timeline: [] as string[], last: "" }
        scope.__dlineChatContinuity = continuity
        const startedAt = performance.now()
        const check = () => {
            const rows = Array.from(document.querySelectorAll('[data-testid="direct-user-input"]'))
            const shown = rows.some((element) => element.textContent?.includes(text))
            if (!shown) continuity.cleared = true
            const action = document.querySelector('[data-testid="send-button"]')?.getAttribute("data-action") ?? "none"
            const entry = `shown=${shown} rows=${rows.length} action=${action}`
            if (entry === continuity.last) return
            continuity.last = entry
            continuity.timeline.push(`+${Math.round(performance.now() - startedAt)}ms ${entry}`)
        }
        check()
        const observer = new MutationObserver(check)
        observer.observe(document.body, { childList: true, characterData: true, subtree: true, attributes: true })
        scope.__dlineChatObserver = observer
    }, taskText)
}

async function stopChatContinuityObserver(sidebar: Frame): Promise<ChatContinuity> {
    return sidebar.evaluate(() => {
        const scope = window as ChatContinuityScope
        scope.__dlineChatObserver?.disconnect()
        const continuity = scope.__dlineChatContinuity
        delete scope.__dlineChatObserver
        delete scope.__dlineChatContinuity
        return { cleared: continuity?.cleared === true, timeline: continuity?.timeline ?? [] }
    })
}

async function expectChatNeverCleared(sidebar: Frame): Promise<void> {
    const continuity = await stopChatContinuityObserver(sidebar)
    expect(
        continuity.cleared,
        `the chat must not be cleared while the task is promoted:\n${continuity.timeline.join("\n")}`,
    ).toBe(false)
}

/** Type the message and send it with Enter, then wait for its own chat row. */
async function sendFirstInputWithEnter(sidebar: Frame, text: string): Promise<void> {
    const input = sidebar.getByTestId("chat-input")
    await expect(input).toBeEnabled()
    await input.fill(text)
    await input.press("Enter")
    await expect(userFeedback(sidebar, text)).toHaveCount(1, { timeout: 30_000 })
    await expectComposerText(input, "")
}

e2e(
    "History promotion - the first Enter on a reopened completed task is delivered without reloading the chat",
    async ({ helper, server, sidebar, userDataDir }) => {
        e2e.setTimeout(180_000)
        await helper.signin(sidebar)
        server.resetOpenAiMock()
        const taskText = "E2E_PROMOTION_COMPLETED_TASK"
        const replyText = "E2E_PROMOTION_COMPLETED_FIRST_INPUT"
        server.enqueueOpenAiResponses(
            {
                type: "tool",
                id: "call_promotion_completed",
                name: "attempt_completion",
                arguments: { result: "E2E_PROMOTION_COMPLETED_RESULT" },
                expectedRequestIncludes: [taskText],
            },
            {
                type: "tool",
                id: "call_promotion_completed_reply",
                name: "attempt_completion",
                arguments: { result: "E2E_PROMOTION_COMPLETED_REPLY_OK" },
                // Keeps the answer off screen while the continuity observer runs.
                delayMs: 2_000,
                expectedRequestIncludes: [replyText],
            },
        )

        await sendTask(sidebar, taskText)
        await expect(sidebar.getByText("E2E_PROMOTION_COMPLETED_RESULT", { exact: false }).last()).toBeVisible({
            timeout: 60_000,
        })
        await closeCurrentTask(sidebar)
        await reopenTask(sidebar, taskText)
        await expect(sidebar.getByText("E2E_PROMOTION_COMPLETED_RESULT", { exact: false }).last()).toBeVisible({
            timeout: 30_000,
        })

        await startChatContinuityObserver(sidebar, taskText)
        await sendFirstInputWithEnter(sidebar, replyText)
        await expectChatNeverCleared(sidebar)

        await expect(sidebar.getByText("E2E_PROMOTION_COMPLETED_REPLY_OK", { exact: false }).last()).toBeVisible({
            timeout: 60_000,
        })
        await expect(userFeedback(sidebar, replyText)).toHaveCount(1)
        expect(server.getRequestCount(CHAT_TARGET)).toBe(2)
        expect(server.getMockConsumptions(CHAT_TARGET).every((entry) => entry.contractError === undefined)).toBe(true)
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
    },
)

e2e(
    "History promotion - the first Enter on a reopened interrupted task resumes with it without reloading the chat",
    async ({ helper, server, sidebar, userDataDir }) => {
        e2e.setTimeout(180_000)
        await helper.signin(sidebar)
        server.resetOpenAiMock()
        const taskText = "E2E_PROMOTION_INTERRUPTED_TASK"
        const resumeText = "E2E_PROMOTION_INTERRUPTED_FIRST_INPUT"
        server.enqueueOpenAiResponses(
            {
                type: "tool",
                id: "call_promotion_interrupted",
                name: "attempt_completion",
                arguments: { result: "E2E_PROMOTION_INTERRUPTED_MUST_NOT_RENDER" },
                delayMs: 30_000,
                expectedRequestIncludes: [taskText],
            },
            {
                type: "tool",
                id: "call_promotion_interrupted_resumed",
                name: "attempt_completion",
                arguments: { result: "E2E_PROMOTION_INTERRUPTED_RESUMED_OK" },
                delayMs: 2_000,
                expectedRequestIncludes: [resumeText],
            },
        )

        await sendTask(sidebar, taskText)
        await expect.poll(() => server.getRequestCount(CHAT_TARGET), { timeout: 60_000 }).toBe(1)
        await closeCurrentTask(sidebar)
        await expect.poll(() => server.getMockConsumptions(CHAT_TARGET)[0]?.abortedAtMs, { timeout: 30_000 }).not.toBeUndefined()

        await reopenTask(sidebar, taskText)
        await expect(sidebar.getByRole("contentinfo").locator('[data-testid="send-button"][data-action="resume"]')).toBeVisible({
            timeout: 30_000,
        })

        await startChatContinuityObserver(sidebar, taskText)
        await sendFirstInputWithEnter(sidebar, resumeText)
        await expectChatNeverCleared(sidebar)

        await expect(sidebar.getByText("E2E_PROMOTION_INTERRUPTED_RESUMED_OK", { exact: false }).last()).toBeVisible({
            timeout: 60_000,
        })
        await expect(userFeedback(sidebar, resumeText)).toHaveCount(1)
        await expect(sidebar.getByText("E2E_PROMOTION_INTERRUPTED_MUST_NOT_RENDER", { exact: false })).toHaveCount(0)
        expect(server.getRequestCount(CHAT_TARGET)).toBe(2)
        expect(server.getMockConsumptions(CHAT_TARGET)[1]?.contractError).toBeUndefined()
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
    },
)
