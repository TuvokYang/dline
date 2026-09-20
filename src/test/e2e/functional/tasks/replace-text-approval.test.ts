import { readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

async function setAutoApproveAction(sidebar: Frame, label: string, enabled: boolean): Promise<void> {
	await sidebar.getByLabel("Open auto-approve settings").click()
	const checkbox = sidebar.locator("vscode-checkbox").filter({ hasText: label })
	await expect(checkbox).toHaveCount(1)
	const isChecked = () => checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))
	if ((await isChecked()) !== enabled) {
		await sidebar.getByText(label, { exact: true }).click()
	}
	await expect.poll(isChecked).toBe(enabled)
	await sidebar.getByLabel("Close auto-approve settings").click()
}

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

e2e(
	"Tools - manual replace_text approval executes instead of rejecting the runtime event",
	async ({ helper, server, sidebar, userDataDir, workspaceDir }) => {
		e2e.setTimeout(120_000)
		const relativePath = "replace-text-manual-approval.txt"
		const absolutePath = path.join(workspaceDir, relativePath)
		await writeFile(absolutePath, "E2E_REPLACE_TEXT_MANUAL_BEFORE\n", "utf8")

		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Edit project files", false)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_replace_text_manual",
				name: "replace_text",
				arguments: {
					file_pattern: relativePath,
					find: "E2E_REPLACE_TEXT_MANUAL_BEFORE",
					replace: "E2E_REPLACE_TEXT_MANUAL_AFTER",
					literal: true,
					dry_run: false,
				},
			},
			{
				type: "tool",
				id: "call_replace_text_manual_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_REPLACE_TEXT_MANUAL_APPROVAL_OK" },
				expectedToolResults: [{ callId: "call_replace_text_manual", contentIncludes: "E2E_REPLACE_TEXT_MANUAL_AFTER" }],
			},
		)

		await sendTask(sidebar, "Replace the manual marker after explicit approval.")
		const approveButton = sidebar.getByText("Approve", { exact: true })
		await expect(approveButton).toBeVisible({ timeout: 60_000 })
		await expect(sidebar.getByText("Reject", { exact: true })).toBeVisible()
		await approveButton.click()

		await expect(sidebar.getByText("Interaction was not accepted", { exact: false })).toHaveCount(0)
		await expect(sidebar.getByText("E2E_REPLACE_TEXT_MANUAL_APPROVAL_OK", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => readFile(absolutePath, "utf8")).toContain("E2E_REPLACE_TEXT_MANUAL_AFTER")
		const continuation = server.getMockConsumptions("openai-compatible-chat")[1]
		expect(continuation.contractError).toBeUndefined()
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Tools - project replace_text follows Edit project files auto-approval",
	async ({ helper, server, sidebar, userDataDir, workspaceDir }) => {
		e2e.setTimeout(120_000)
		const relativePath = "replace-text-project-auto-approval.txt"
		const absolutePath = path.join(workspaceDir, relativePath)
		await writeFile(absolutePath, "E2E_REPLACE_TEXT_AUTO_BEFORE\n", "utf8")

		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Edit project files", true)
		await setAutoApproveAction(sidebar, "Edit all files", false)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_replace_text_auto",
				name: "replace_text",
				arguments: {
					file_pattern: relativePath,
					find: "E2E_REPLACE_TEXT_AUTO_BEFORE",
					replace: "E2E_REPLACE_TEXT_AUTO_AFTER",
					literal: true,
					dry_run: false,
				},
			},
			{
				type: "tool",
				id: "call_replace_text_auto_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_REPLACE_TEXT_PROJECT_AUTO_APPROVAL_OK" },
				expectedToolResults: [{ callId: "call_replace_text_auto", contentIncludes: "E2E_REPLACE_TEXT_AUTO_AFTER" }],
			},
		)

		await sendTask(sidebar, "Replace the project marker under project-edit auto-approval.")
		await expect(sidebar.getByText("E2E_REPLACE_TEXT_PROJECT_AUTO_APPROVAL_OK", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect(sidebar.getByText("Approve", { exact: true })).toHaveCount(0)
		await expect(sidebar.getByText("Reject", { exact: true })).toHaveCount(0)
		await expect.poll(() => readFile(absolutePath, "utf8")).toContain("E2E_REPLACE_TEXT_AUTO_AFTER")
		const continuation = server.getMockConsumptions("openai-compatible-chat")[1]
		expect(continuation.contractError).toBeUndefined()
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)
