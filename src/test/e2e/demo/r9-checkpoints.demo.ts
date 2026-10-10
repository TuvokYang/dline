import { access } from "node:fs/promises"
import path from "node:path"
import { expect } from "@playwright/test"
import { E2ETestHelper } from "../utils/helpers"
import { demo } from "./utils/demo-fixture"
import { dismissDemoNotifications, finalizeDemoPng } from "./utils/png-asset"

const TASK_TEXT = "Create a short checkpoint demo file so I can compare and safely restore the change."
const FIRST_RELATIVE_PATH = "checkpoint-demo.md"
const SECOND_RELATIVE_PATH = "release-note.md"
const FIRST_FILE_CONTENT = "# Checkpoint demo\n\nThis file demonstrates a reversible workspace change.\n"
const SECOND_FILE_CONTENT = "Release checkpoint: ready for comparison.\n"
const COMPLETION_TEXT = "Two checkpoint demo changes are ready to compare."

async function pathExists(filePath: string): Promise<boolean> {
    return access(filePath)
        .then(() => true)
        .catch(() => false)
}

demo("R9", async ({ captureScreenshot, helper, page, server, sidebar, userDataDir, workspaceDir }) => {
    demo.setTimeout(180_000)
    await helper.signin(sidebar)
    server.resetOpenAiMock()
    server.enqueueOpenAiResponses(
        {
            type: "tool",
            id: "call_r9_write_first",
            name: "write_to_file",
            arguments: { path: FIRST_RELATIVE_PATH, content: FIRST_FILE_CONTENT },
            expectedRequestIncludes: [TASK_TEXT],
        },
        {
            type: "tool",
            id: "call_r9_write_second",
            name: "write_to_file",
            arguments: { path: SECOND_RELATIVE_PATH, content: SECOND_FILE_CONTENT },
            expectedToolResults: [{ callId: "call_r9_write_first", contentIncludes: "successfully saved" }],
        },
        {
            type: "tool",
            id: "call_r9_complete",
            name: "attempt_completion",
            arguments: { result: COMPLETION_TEXT },
            expectedToolResults: [{ callId: "call_r9_write_second", contentIncludes: "successfully saved" }],
        },
    )

    await dismissDemoNotifications(page)
    const input = sidebar.getByTestId("chat-input")
    await input.fill(TASK_TEXT)
    await sidebar.getByTestId("send-button").click()
    const approveButton = sidebar.getByText("Approve", { exact: true })
    await approveButton.click()

    const firstFilePath = path.join(workspaceDir, FIRST_RELATIVE_PATH)
    await expect.poll(() => pathExists(firstFilePath), { timeout: 30_000 }).toBe(true)
    await expect(approveButton).toBeVisible({ timeout: 30_000 })
    await approveButton.click()
    const secondFilePath = path.join(workspaceDir, SECOND_RELATIVE_PATH)
    await expect.poll(() => pathExists(secondFilePath), { timeout: 30_000 }).toBe(true)
    await expect(sidebar.getByText(COMPLETION_TEXT, { exact: false }).last()).toBeVisible({ timeout: 60_000 })

    const checkpointLabels = sidebar.getByText("Checkpoint", { exact: true })
    await expect.poll(() => checkpointLabels.count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
    const checkpointControl = checkpointLabels.first().locator("..").locator("..")
    await checkpointControl.hover()

    const compareButton = checkpointControl.getByRole("button", { name: "Compare", exact: true })
    await expect(compareButton).toBeVisible()
    await compareButton.click()
    await expect(page.getByRole("tab", { name: /Changes since snapshot/ })).toBeVisible({ timeout: 30_000 })
    await expect
        .poll(async () => (await E2ETestHelper.readDlineOutput(userDataDir)).includes("presentMultifileDiff"), {
            timeout: 30_000,
        })
        .toBe(true)

    await checkpointControl.hover()
    const restoreButton = checkpointControl.getByRole("button", { name: "Restore", exact: true })
    await restoreButton.click()
    const restoreAllButton = sidebar.getByRole("button", { name: "Restore Files & Task", exact: true })
    await expect(restoreAllButton).toBeVisible()
    await expect(sidebar.getByText("Revert files and clear messages after this point", { exact: false })).toBeVisible()

    await dismissDemoNotifications(page)
    const screenshotPath = await captureScreenshot("r9-checkpoints")
    const asset = await finalizeDemoPng(screenshotPath)
    expect(asset.width).toBe(1_200)
    expect(asset.bytes).toBeLessThanOrEqual(500_000)

    const consumptions = server.getMockConsumptions("openai-compatible-chat")
    expect(consumptions.map(({ toolName }) => toolName)).toEqual(["write_to_file", "write_to_file", "attempt_completion"])
    expect(consumptions.every(({ contractError }) => contractError === undefined)).toBe(true)
    await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
})
