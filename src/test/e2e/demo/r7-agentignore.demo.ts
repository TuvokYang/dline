import { access, writeFile } from "node:fs/promises"
import path from "node:path"
import { expect } from "@playwright/test"
import { E2ETestHelper } from "../utils/helpers"
import { setWorkAutoApproveAction } from "../utils/work/session"
import { activeEditorLines, openWorkspaceFile } from "../utils/workbench"
import { demo } from "./utils/demo-fixture"
import { dismissDemoNotifications, finalizeDemoPng } from "./utils/png-asset"
import { WINDOW_RECORDING } from "./utils/recording-presets"

const TASK_TEXT = "Try to update vendor/dependency.ts. Respect .agentignore; if the write is denied, report why and stop."
const RULE_FILE = ".agentignore"
const READ_ONLY_RULE = "vendor/ -w"
const DENIED_RELATIVE_PATH = "vendor/dependency.ts"
const DENIED_CONTENT = "export const patchedByAgent = true\n"
const COMPLETION_TEXT = "The write was refused by .agentignore, so the vendor source remains unchanged."
const RULE_CONTENT = [
    "# Agent workspace permissions",
    "# Vendor sources remain readable, but agent writes are disabled.",
    READ_ONLY_RULE,
    "",
].join("\n")

async function pathExists(filePath: string): Promise<boolean> {
    return access(filePath)
        .then(() => true)
        .catch(() => false)
}

demo(
    "R7",
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
        demo.setTimeout(150_000)
        await writeFile(path.join(workspaceDir, RULE_FILE), RULE_CONTENT, "utf8")
        await helper.signin(sidebar)
        // Edits are admitted before the handler checks .agentignore, so a manual approval
        // card would otherwise stand in front of the refusal this demo is meant to show.
        await setWorkAutoApproveAction(sidebar, "Edit project files", true)
        await openWorkspaceFile(page, RULE_FILE)
        await expect(activeEditorLines(page)).toContainText(READ_ONLY_RULE)

        server.resetOpenAiMock()
        server.enqueueOpenAiResponses(
            {
                type: "tool",
                id: "call_r7_denied_write",
                name: "write_to_file",
                arguments: { path: DENIED_RELATIVE_PATH, content: DENIED_CONTENT },
                expectedRequestIncludes: [TASK_TEXT],
            },
            {
                type: "tool",
                id: "call_r7_complete",
                name: "attempt_completion",
                arguments: { result: COMPLETION_TEXT },
                expectedToolResults: [{ callId: "call_r7_denied_write", contentIncludes: RULE_FILE }],
            },
        )

        const input = sidebar.getByTestId("chat-input")
        await input.fill(TASK_TEXT)
        await pace(500)
        await registerRecording("r7-agentignore", WINDOW_RECORDING)
        const ruleLine = page.locator(".part.editor .view-line").filter({ hasText: READ_ONLY_RULE })
        const send = sidebar.getByTestId("send-button")
        await focusCamera([ruleLine, input, send])
        await pace(1_400)
        await send.click()

        const denialCards = sidebar.getByText(/Dline tried to access/, { exact: false })
        await expect(denialCards).toHaveCount(1, { timeout: 60_000 })
        const denialCard = denialCards.first()
        await expect(denialCard).toContainText(DENIED_RELATIVE_PATH)
        await expect(denialCard).toContainText(RULE_FILE)
        await denialCard.scrollIntoViewIfNeeded()
        // Frame the refusal next to the rule that caused it.
        await focusCamera([denialCard, ruleLine])
        await pace(2_000)

        const completion = sidebar.getByText(COMPLETION_TEXT, { exact: false }).last()
        await expect(completion).toBeVisible({ timeout: 60_000 })
        await focusCamera([denialCard, completion])
        await pace(1_600)
        await finishRecording()

        await expect(sidebar.getByText("Start New Task", { exact: true })).toBeVisible({ timeout: 30_000 })
        await expect.poll(() => pathExists(path.join(workspaceDir, DENIED_RELATIVE_PATH))).toBe(false)
        await dismissDemoNotifications(page)
        const asset = await finalizeDemoPng(await captureScreenshot("r7-agentignore"))
        expect(asset.width).toBe(1_200)
        expect(asset.bytes).toBeLessThanOrEqual(500_000)

        const consumptions = server.getMockConsumptions("openai-compatible-chat")
        expect(consumptions.map(({ toolName }) => toolName)).toEqual(["write_to_file", "attempt_completion"])
        expect(consumptions.every(({ contractError }) => contractError === undefined)).toBe(true)
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [/Error fetching OpenRouter models/])
    },
)
