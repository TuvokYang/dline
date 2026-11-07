import { writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { expectComposerPlaceholder } from "@e2e/utils/composer"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { requestTaskHistoryControl } from "@e2e/utils/task-history-control-client"
import { expect, type Frame, type TestInfo } from "@playwright/test"

type SurfaceSample = {
    revision?: number
    patch: boolean
    taskId?: string
    taskInstanceId?: string
    titlePresent: boolean
    hasTaskField: boolean
}

type SurfaceProbeWindow = Window & { __closeSurfaceSamples?: SurfaceSample[] }

async function attachDiagnostic(testInfo: TestInfo, name: string, value: unknown): Promise<void> {
    const artifact = testInfo.outputPath(`${name}.json`)
    await writeFile(artifact, JSON.stringify(value, null, 2))
    await testInfo.attach(name, { path: artifact, contentType: "application/json" })
}

async function installSurfaceProbe(sidebar: Frame): Promise<void> {
    await sidebar.evaluate(() => {
        const scope = window as SurfaceProbeWindow
        scope.__closeSurfaceSamples = []
        window.addEventListener("message", (event) => {
            const stateJson = event.data?.grpc_response?.message?.stateJson
            if (typeof stateJson !== "string" || !stateJson) return
            const state = JSON.parse(stateJson)
            scope.__closeSurfaceSamples?.push({
                revision: state.stateRevision,
                patch: state.__dlineStatePatch === true,
                taskId: state.taskViewState?.taskId,
                taskInstanceId: state.taskViewState?.taskInstanceId,
                titlePresent: Boolean(state.taskTitleMessage),
                hasTaskField: Object.hasOwn(state, "taskViewState"),
            })
        })
    })
}

e2e(
    "Close Task resets the complete surface and allows the next task",
    async ({ helper, server, sidebar, userDataDir }, testInfo) => {
        e2e.setTimeout(180_000)
        await helper.signin(sidebar)
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses(
            { type: "tool", name: "qna_respond", arguments: { response: "CLOSE_SURFACE_WAITING" } },
            { type: "message", text: "CLOSE_SURFACE_STREAMING", afterChatContentDelayMs: 20_000 },
        )
        server.enqueueResponses("openai-compatible-responses", {
            type: "tool",
            name: "qna_respond",
            arguments: { response: "CLOSE_SURFACE_NEXT_TASK_ACCEPTED" },
        })
        await installSurfaceProbe(sidebar)
        const input = sidebar.getByTestId("chat-input")
        const close = sidebar.getByRole("button", { name: "Close Task", exact: true })
        const thinking = sidebar.getByRole("combobox", { name: "Task thinking override" })
        const observations: Array<Record<string, unknown>> = []
        try {
            for (const [index, taskText] of ["CLOSE_SURFACE_WAITING_TASK", "CLOSE_SURFACE_STREAMING_TASK"].entries()) {
                await expectComposerPlaceholder(input, "Type your task here...")
                await input.fill(taskText)
                await sidebar.getByTestId("send-button").click()
                await expect(sidebar.getByText(taskText, { exact: true }).first()).toBeVisible()
                await expect(thinking).toBeVisible()
                if (index === 0) {
                    await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(1)
                    await expect(sidebar.getByText("CLOSE_SURFACE_WAITING", { exact: true }).last()).toBeVisible({
                        timeout: 60_000,
                    })
                } else {
                    await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(2)
                }
                await close.click()
                await expect(close).toHaveCount(0, { timeout: 8_000 })
                await expectComposerPlaceholder(input, "Type your task here...")
                observations.push({
                    taskText,
                    thinkingCount: await thinking.count(),
                    providerRequests: server.openAiRequestCount,
                })
                await expect(thinking).toHaveCount(0)
                await expect(sidebar.getByRole("button", { name: "Task service tier" })).toHaveCount(0)
            }
            const modelSwitcher = sidebar.getByRole("button", { name: "Select model" })
            await modelSwitcher.click()
            const option = sidebar
                .getByRole("option")
                .filter({ has: sidebar.getByText(E2E_PROFILE_NAMES.mockOpenAiResponses, { exact: true }) })
            await expect(option).toHaveCount(1)
            await option.click()
            await expect(modelSwitcher).toHaveText(E2E_PROFILE_NAMES.mockOpenAiResponses)
            await input.fill("关闭后应该能够创建新的任务")
            await sidebar.getByTestId("send-button").click()
            await expect.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 60_000 }).toBe(1)
            await expect(sidebar.getByText("CLOSE_SURFACE_NEXT_TASK_ACCEPTED", { exact: false }).last()).toBeVisible({
                timeout: 60_000,
            })
            await expect(close).toBeVisible()
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [/Dline instance aborted/i])
        } finally {
            await attachDiagnostic(testInfo, "close-surface-observations", {
                observations,
                states: await sidebar.evaluate(() => (window as SurfaceProbeWindow).__closeSurfaceSamples),
                providerRequests: server.getMockConsumptions().map(({ target, responseType, abortedAtMs, contractError }) => ({
                    target,
                    responseType,
                    abortedAtMs,
                    contractError,
                })),
            })
            await sidebar.page().screenshot({ path: testInfo.outputPath("close-surface.png") })
        }
    },
)

// Fault injection replays a valid delivery order through the real Extension Host sender.
// It does not claim that an ordinary Close always produces this order.
e2e(
    "A full home snapshot clears an intervening Task patch",
    async ({ dlineDir, helper, openVSCode, server, workspaceDir }, testInfo) => {
        e2e.setTimeout(150_000)
        const controlDirectory = path.join(dlineDir, "surface-replay-control")
        const app = await openVSCode(workspaceDir, { DLINE_E2E_TASK_HISTORY_CONTROL_DIR: controlDirectory })
        const commands: unknown[] = []
        try {
            const page = await app.firstWindow()
            await E2ETestHelper.openClineSidebar(page)
            const sidebar = await helper.getSidebar(page)
            await helper.signin(sidebar)
            await installSurfaceProbe(sidebar)
            server.resetOpenAiMock()
            server.enqueueOpenAiResponses(
                { type: "tool", name: "qna_respond", arguments: { response: "REPLAY_CAPTURED_TASK" } },
                { type: "tool", name: "qna_respond", arguments: { response: "REPLAY_NEXT_TASK_ACCEPTED" } },
            )
            const input = sidebar.getByTestId("chat-input")
            const thinking = sidebar.getByRole("combobox", { name: "Task thinking override" })
            await input.fill("REPLAY_ORIGINAL_TASK")
            await sidebar.getByTestId("send-button").click()
            await expect(sidebar.getByText("REPLAY_CAPTURED_TASK", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
            await expect(thinking).toBeVisible()
            const capture = await requestTaskHistoryControl(controlDirectory, { action: "capture-task-surface" })
            expect(capture.success, capture.error).toBe(true)
            await sidebar.getByRole("button", { name: "Close Task", exact: true }).click()
            await expectComposerPlaceholder(input, "Type your task here...")
            await expect(thinking).toHaveCount(0)
            const patch = await requestTaskHistoryControl(controlDirectory, { action: "replay-task-patch-on-home" })
            commands.push(patch)
            expect(patch.success, patch.error).toBe(true)
            await expect(thinking).toBeVisible()
            await page.screenshot({ path: testInfo.outputPath("injected-home-with-task-controls.png") })
            const restore = await requestTaskHistoryControl(controlDirectory, { action: "restore-home-surface" })
            commands.push(restore)
            expect(restore.success, restore.error).toBe(true)
            try {
                await expect(thinking).toHaveCount(0, { timeout: 5_000 })
                await expectComposerPlaceholder(input, "Type your task here...")
                await input.fill("重放清除之后可以创建新任务")
                await sidebar.getByTestId("send-button").click()
                await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(2)
                await expect(sidebar.getByText("REPLAY_NEXT_TASK_ACCEPTED", { exact: false }).last()).toBeVisible({
                    timeout: 60_000,
                })
            } finally {
                await page.screenshot({ path: testInfo.outputPath("replayed-home-result.png") })
                await attachDiagnostic(
                    testInfo,
                    "replay-state-revisions",
                    await sidebar.evaluate(() => (window as SurfaceProbeWindow).__closeSurfaceSamples),
                )
            }
        } finally {
            await attachDiagnostic(testInfo, "surface-replay-commands", commands)
            await app.close()
        }
    },
)
