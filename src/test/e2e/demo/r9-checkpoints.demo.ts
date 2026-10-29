import { access } from "node:fs/promises"
import path from "node:path"
import { expect } from "@playwright/test"
import { E2ETestHelper } from "../utils/helpers"
import { demo } from "./utils/demo-fixture"
import { dismissDemoNotifications, finalizeDemoPng } from "./utils/png-asset"
import { WINDOW_RECORDING } from "./utils/recording-presets"

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

demo(
    "R9",
    async ({
        captureScreenshot,
        finishRecording,
        focusCamera,
        helper,
        pace,
        page,
        registerRecording,
        server,
        sidebar,
        userDataDir,
        workspaceDir,
    }) => {
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

        // The task itself is not the subject of this demo; run it before recording so the
        // GIF budget goes to comparing and restoring a checkpoint.
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
        const completion = sidebar.getByText(COMPLETION_TEXT, { exact: false }).last()
        await expect(completion).toBeVisible({ timeout: 60_000 })

        const checkpointLabels = sidebar.getByText("Checkpoint", { exact: true })
        await expect.poll(() => checkpointLabels.count(), { timeout: 30_000 }).toBeGreaterThanOrEqual(2)
        const checkpointLabel = checkpointLabels.first()
        const checkpointControl = checkpointLabel.locator("..").locator("..")

        await registerRecording("r9-checkpoints", WINDOW_RECORDING)
        await focusCamera([checkpointControl, completion])
        await checkpointControl.hover()
        const compareButton = checkpointControl.getByRole("button", { name: "Compare", exact: true })
        await expect(compareButton).toBeVisible()
        await pace(1_000)
        await compareButton.click()
        await expect(page.getByRole("tab", { name: /Changes since snapshot/ })).toBeVisible({ timeout: 30_000 })
        await expect
            .poll(async () => (await E2ETestHelper.readDlineOutput(userDataDir)).includes("presentMultifileDiff"), {
                timeout: 30_000,
            })
            .toBe(true)
        // Show the multi-file diff beside the checkpoint it was computed from.
        await focusCamera([checkpointControl, page.locator(".part.editor")])
        await pace(2_000)

        await checkpointControl.hover()
        const restoreButton = checkpointControl.getByRole("button", { name: "Restore", exact: true })
        await restoreButton.click()
        const restoreAllButton = sidebar.getByRole("button", { name: "Restore Files & Task", exact: true })
        await expect(restoreAllButton).toBeVisible()
        await expect(sidebar.getByText("Revert files and clear messages after this point", { exact: false })).toBeVisible()
        await focusCamera([checkpointControl, restoreAllButton])
        await pace(1_200)

        const asset = await finalizeDemoPng(await captureScreenshot("r9-checkpoints"))
        expect(asset.width).toBe(1_200)
        expect(asset.bytes).toBeLessThanOrEqual(500_000)

        await restoreAllButton.click()
        await expect(restoreAllButton).toBeHidden()
        // Restoring an earlier checkpoint reverts the later write and clears the messages after it.
        await expect.poll(() => pathExists(secondFilePath), { timeout: 30_000 }).toBe(false)
        await expect(completion).toBeHidden({ timeout: 30_000 })
        // The label switches to "Checkpoint (restored)" once the workspace is checked out.
        const restoredCheckpoint = sidebar.getByText(/^Checkpoint( \(restored\))?$/).first()
        await focusCamera([restoredCheckpoint, input])
        await pace(1_600)
        await finishRecording()

        const consumptions = server.getMockConsumptions("openai-compatible-chat")
        expect(consumptions.map(({ toolName }) => toolName)).toEqual(["write_to_file", "write_to_file", "attempt_completion"])
        expect(consumptions.every(({ contractError }) => contractError === undefined)).toBe(true)
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
    },
)
