import { writeFile } from "node:fs/promises"
import { expectComposerText } from "@e2e/utils/composer"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type TestInfo } from "@playwright/test"

const WAITING = "E2E_INPUT_RENDER_WAITING"
const HISTORY = `${Array.from(
    { length: 32 },
    (_, index) =>
        `### Earlier result ${index}\n\n${"Earlier work stays readable while the user reviews the conversation. ".repeat(4)}`,
).join("\n\n")}\n\n${WAITING}`

async function send(sidebar: Frame, text: string): Promise<void> {
    const input = sidebar.getByTestId("chat-input")
    await expect(input).toBeEnabled()
    await input.fill(text)
    await expect(sidebar.getByTestId("send-button")).toHaveAttribute("data-action", "send")
    await input.press("Enter")
}

/** Observe delivery independently of what Virtuoso currently renders. */
async function installProbe(sidebar: Frame): Promise<void> {
    await sidebar.evaluate(() => {
        const frames: unknown[] = []
        const scope = window as typeof window & { __inputFrames?: unknown[] }
        scope.__inputFrames = frames
        window.addEventListener("message", (event) => {
            const response = event.data?.grpc_response
            if (event.data?.type !== "grpc_response" || !response) return
            const payload = response.message
            if (payload?.stateJson) {
                const state = JSON.parse(payload.stateJson)
                frames.push({
                    revision: state.stateRevision,
                    total: state.totalMessageCount,
                    task: state.taskViewState?.taskInstanceId,
                    phase: state.taskViewState?.phase,
                    input: state.taskViewState?.input,
                    queue: state.inputQueue?.map((entry: { id: string; mode: string }) => ({ id: entry.id, mode: entry.mode })),
                })
            } else if (payload?.ts) {
                frames.push({
                    ts: payload.ts,
                    say: payload.say,
                    ask: payload.ask,
                    text: String(payload.text ?? "").slice(-160),
                    partial: payload.partial,
                })
            } else if (payload?.accepted !== undefined || response.error) {
                frames.push({ accepted: payload?.accepted, result: payload?.result, error: response.error })
            }
        })
    })
}

async function browseEarlier(sidebar: Frame): Promise<void> {
    const scroller = sidebar.locator('[data-virtuoso-scroller="true"]').first()
    await expect.poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight)).toBeGreaterThan(250)
    const bounds = await scroller.boundingBox()
    if (!bounds) throw new Error("Chat scroller is not visible")
    // The outer edge avoids the nested markdown scroller consuming the gesture.
    await sidebar.page().mouse.move(bounds.x + bounds.width - 3, bounds.y + bounds.height / 2)
    await sidebar.page().mouse.wheel(0, -1_200)
    await expect
        .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
        .toBeGreaterThan(200)
}

async function attachProbe(sidebar: Frame, testInfo: TestInfo, consumptions: unknown): Promise<void> {
    const observed = await sidebar.evaluate(() => {
        const element = document.querySelector('[data-virtuoso-scroller="true"]')
        return {
            frames: (window as typeof window & { __inputFrames?: unknown[] }).__inputFrames,
            visibility: document.visibilityState,
            scroll: element ? { top: element.scrollTop, height: element.scrollHeight, viewport: element.clientHeight } : null,
            rows: Array.from(document.querySelectorAll("[data-row-ts]")).map((row) => ({
                ts: row.getAttribute("data-row-ts"),
                text: row.textContent?.slice(-200),
            })),
        }
    })
    const file = testInfo.outputPath("input-render-observations.json")
    await writeFile(file, JSON.stringify({ observed, consumptions }, null, 2), "utf8")
    await testInfo.attach("input-render-observations", { path: file, contentType: "application/json" })
}

e2e(
    "Turn-end reply reveals new input and response after browsing earlier work",
    async ({ helper, server, sidebar, userDataDir }, testInfo) => {
        e2e.setTimeout(120_000)
        await helper.signin(sidebar)
        await installProbe(sidebar)
        server.resetOpenAiMock()
        const feedback = "E2E_TURN_END_VISIBLE_REPLY 继续处理"
        server.enqueueOpenAiResponses(
            { type: "tool", name: "qna_respond", arguments: { response: HISTORY } },
            {
                type: "tool",
                name: "qna_respond",
                arguments: { response: "E2E_TURN_END_VISIBLE_RESULT" },
                delayMs: 1_500,
                expectedRequestIncludes: [feedback],
            },
        )
        try {
            await send(sidebar, "E2E_TURN_END_RENDER_TASK")
            await expect(sidebar.getByText(WAITING, { exact: true })).toBeVisible({ timeout: 30_000 })
            await browseEarlier(sidebar)
            await send(sidebar, feedback)
            await expect.poll(() => server.openAiRequestCount, { timeout: 30_000 }).toBe(2)
            expect(server.getMockConsumptions().at(-1)?.contractError).toBeUndefined()
            await expect(sidebar.getByTestId("direct-user-input").filter({ hasText: feedback })).toBeInViewport({
                timeout: 10_000,
            })
            await expect(sidebar.getByText("E2E_TURN_END_VISIBLE_RESULT", { exact: true })).toBeInViewport({ timeout: 10_000 })
            await expectComposerText(sidebar.getByTestId("chat-input"), "")
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await attachProbe(
                sidebar,
                testInfo,
                server
                    .getMockConsumptions()
                    .map(({ responseType, toolName, contractError }) => ({ responseType, toolName, contractError })),
            )
        }
    },
)

e2e(
    "Steering shortcut reveals consumed input and response after browsing earlier work",
    async ({ helper, server, sidebar, userDataDir }, testInfo) => {
        e2e.setTimeout(120_000)
        await helper.signin(sidebar)
        await installProbe(sidebar)
        server.resetOpenAiMock()
        const steering = "E2E_STEERING_VISIBLE_REPLY 先检查界面"
        server.enqueueOpenAiResponses(
            { type: "tool", name: "qna_respond", arguments: { response: HISTORY } },
            { type: "tool", name: "list_files", arguments: { path: ".", recursive: "false" }, delayMs: 12_000 },
            {
                type: "tool",
                name: "qna_respond",
                arguments: { response: "E2E_STEERING_VISIBLE_RESULT" },
                delayMs: 1_500,
                expectedRequestIncludes: [steering],
            },
        )
        try {
            await send(sidebar, "E2E_STEERING_RENDER_TASK")
            await expect(sidebar.getByText(WAITING, { exact: true })).toBeVisible({ timeout: 30_000 })
            await send(sidebar, "E2E_START_ORDINARY_WORK")
            await expect.poll(() => server.openAiRequestCount, { timeout: 30_000 }).toBe(2)
            await expect(sidebar.locator('[data-testid="send-button"][data-action="cancel"]')).toBeVisible()
            await browseEarlier(sidebar)
            const input = sidebar.getByTestId("chat-input")
            await input.fill(steering)
            await input.press("Control+Alt+KeyS")
            await expect(sidebar.getByTestId("input-queue-toggle")).toContainText("Queue 1")
            await expectComposerText(input, "")
            await expect.poll(() => server.openAiRequestCount, { timeout: 30_000 }).toBe(3)
            expect(server.getMockConsumptions().at(-1)?.contractError).toBeUndefined()
            const row = sidebar.getByTestId("queued-user-input").filter({ hasText: steering })
            await expect(row).toHaveAttribute("data-queued-input-mode", "steering")
            await expect(row).toBeInViewport({ timeout: 10_000 })
            await expect(sidebar.getByText("E2E_STEERING_VISIBLE_RESULT", { exact: true })).toBeInViewport({ timeout: 10_000 })
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await attachProbe(
                sidebar,
                testInfo,
                server
                    .getMockConsumptions()
                    .map(({ responseType, toolName, contractError }) => ({ responseType, toolName, contractError })),
            )
        }
    },
)
