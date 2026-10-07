import { access, writeFile } from "node:fs/promises"
import path from "node:path"
import { expect, type Page } from "@playwright/test"
import { E2ETestHelper } from "../utils/helpers"
import { setWorkAutoApproveAction } from "../utils/work/session"
import { demo } from "./utils/demo-fixture"
import { dismissDemoNotifications, finalizeDemoPng } from "./utils/png-asset"

const TASK_TEXT = "Try to update vendor/dependency.ts. Respect .agentignore; if the write is denied, report why and stop."
const RULE_FILE = ".agentignore"
const DENIED_RELATIVE_PATH = "vendor/dependency.ts"
const DENIED_CONTENT = "export const patchedByAgent = true\n"
const COMPLETION_TEXT = "The write was refused by .agentignore, so the vendor source remains unchanged."
const RULE_CONTENT = [
	"# Agent workspace permissions",
	"# Vendor sources remain readable, but agent writes are disabled.",
	"vendor/ -w",
	"",
].join("\n")

async function pathExists(filePath: string): Promise<boolean> {
	return access(filePath)
		.then(() => true)
		.catch(() => false)
}

async function openWorkspaceFile(page: Page, fileName: string): Promise<void> {
	await page.keyboard.press("ControlOrMeta+p")
	const quickInput = page.locator(".quick-input-widget input").last()
	await expect(quickInput).toBeVisible()
	await quickInput.fill(fileName)

	const fileOption = page.locator(".quick-input-widget .monaco-list-row").filter({ hasText: fileName }).first()
	await expect(fileOption).toBeVisible()
	await fileOption.click()

	await expect(page.getByRole("tab", { name: fileName, exact: true })).toBeVisible()
	await expect(page.locator(".part.editor .view-lines").last()).toContainText("vendor/ -w")
}

demo("R7", async ({ captureScreenshot, helper, page, server, sidebar, userDataDir, workspaceDir }) => {
	demo.setTimeout(150_000)
	await writeFile(path.join(workspaceDir, RULE_FILE), RULE_CONTENT, "utf8")
	await helper.signin(sidebar)
	// Edits are admitted before the handler checks .agentignore, so a manual approval
	// card would otherwise stand in front of the refusal this still is meant to show.
	await setWorkAutoApproveAction(sidebar, "Edit project files", true)
	await openWorkspaceFile(page, RULE_FILE)

	server.resetOpenAiMock()
	server.enqueueOpenAiResponses(
		{
			type: "tool",
			id: "call_r7_denied_write",
			name: "write_to_file",
			arguments: { path: DENIED_RELATIVE_PATH, content: DENIED_CONTENT },
			afterChatContentDelayMs: 10_000,
			expectedRequestIncludes: [TASK_TEXT],
		},
		{
			type: "tool",
			id: "call_r7_complete",
			name: "attempt_completion",
			arguments: { result: COMPLETION_TEXT },
			expectedToolResults: [{ callId: "call_r7_denied_write", contentIncludes: ".agentignore" }],
		},
	)

	await dismissDemoNotifications(page)
	const input = sidebar.getByTestId("chat-input")
	await input.fill(TASK_TEXT)
	await sidebar.getByTestId("send-button").click()

	const denialCards = sidebar.getByText(/Dline tried to access/, { exact: false })
	await expect(denialCards).toHaveCount(1, { timeout: 60_000 })
	const denialCard = denialCards.first()
	await expect(denialCard).toContainText(DENIED_RELATIVE_PATH)
	await expect(denialCard).toContainText(".agentignore")
	await expect.poll(() => pathExists(path.join(workspaceDir, DENIED_RELATIVE_PATH))).toBe(false)

	await denialCard.scrollIntoViewIfNeeded()
	await expect(page.getByRole("tab", { name: RULE_FILE, exact: true })).toBeVisible()
	await expect(page.locator(".part.editor .view-lines").last()).toContainText("vendor/ -w")
	await dismissDemoNotifications(page)

	const screenshotPath = await captureScreenshot("r7-agentignore")
	const asset = await finalizeDemoPng(screenshotPath)
	expect(asset.width).toBe(1_200)
	expect(asset.bytes).toBeLessThanOrEqual(500_000)

	await expect(sidebar.getByText(COMPLETION_TEXT, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
	await expect(sidebar.getByText("Start New Task", { exact: true })).toBeVisible({ timeout: 30_000 })
	await expect.poll(() => pathExists(path.join(workspaceDir, DENIED_RELATIVE_PATH))).toBe(false)

	const consumptions = server.getMockConsumptions("openai-compatible-chat")
	expect(consumptions.map(({ toolName }) => toolName)).toEqual(["write_to_file", "attempt_completion"])
	expect(consumptions.every(({ contractError }) => contractError === undefined)).toBe(true)
	await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [/Error fetching OpenRouter models/])
})
