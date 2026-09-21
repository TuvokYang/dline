import { mkdir, readFile, symlink } from "node:fs/promises"
import path from "node:path"
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
	"write_to_file leaves a sibling external file untouched until external-edit approval",
	async ({ helper, server, sidebar, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Edit project files", true)
		await setAutoApproveAction(sidebar, "Edit all files", false)

		const siblingDirectory = path.join(path.dirname(workspaceDir), "u000workspace")
		const externalPath = path.join(siblingDirectory, "proof.txt")
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_external_write_before_approval",
				name: "write_to_file",
				arguments: {
					absolutePath: externalPath,
					content: "E2E_EXTERNAL_WRITE_MUST_WAIT_FOR_APPROVAL\n",
				},
			},
			{
				type: "tool",
				id: "call_external_write_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_EXTERNAL_WRITE_REJECTED" },
				expectedToolResults: [
					{
						callId: "call_external_write_before_approval",
						contentIncludes: "The user denied this operation.",
					},
				],
			},
		)

		await sendTask(sidebar, "Attempt one write to the requested sibling external path, then stop if rejected.")
		const approveButton = sidebar.getByText("Approve", { exact: true })
		const rejectButton = sidebar.getByText("Reject", { exact: true })
		await expect(approveButton).toBeVisible({ timeout: 60_000 })
		await expect(rejectButton).toBeVisible()

		// Admission classifies the call without touching its target, so an
		// external path must still be absent while its approval is pending.
		await expect
			.poll(() =>
				readFile(externalPath, "utf8")
					.then((content) => ({ exists: true, content }))
					.catch(() => ({ exists: false, content: undefined })),
			)
			.toEqual({ exists: false, content: undefined })

		await rejectButton.click()
		await expect(sidebar.getByText("E2E_EXTERNAL_WRITE_REJECTED", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		await expect
			.poll(() =>
				readFile(externalPath, "utf8")
					.then(() => true)
					.catch(() => false),
			)
			.toBe(false)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"write_to_file charges a project junction to external-edit approval by its canonical target",
	async ({ helper, server, sidebar, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Edit project files", true)
		await setAutoApproveAction(sidebar, "Edit all files", false)

		const siblingDirectory = path.join(path.dirname(workspaceDir), "u000workspace-junction")
		const linkedDirectory = path.join(workspaceDir, "linked-outside")
		const linkedPath = path.join(linkedDirectory, "proof.txt")
		const externalPath = path.join(siblingDirectory, "proof.txt")
		await mkdir(siblingDirectory)
		await symlink(siblingDirectory, linkedDirectory, process.platform === "win32" ? "junction" : "dir")

		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_junction_external_write",
				name: "write_to_file",
				arguments: {
					absolutePath: linkedPath,
					content: "E2E_JUNCTION_EXTERNAL_WRITE_MUST_WAIT_FOR_APPROVAL\n",
				},
			},
			{
				type: "tool",
				id: "call_junction_external_write_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_JUNCTION_EXTERNAL_WRITE_REJECTED" },
				expectedToolResults: [
					{
						callId: "call_junction_external_write",
						contentIncludes: "The user denied this operation.",
					},
				],
			},
		)

		await sendTask(sidebar, "Write through the requested project path and finish.")

		// The declared path is lexically inside the workspace, so only realpath
		// confirmation can charge it to the external scope it actually reaches.
		const rejectButton = sidebar.getByText("Reject", { exact: true })
		await expect(rejectButton).toBeVisible({ timeout: 60_000 })
		await expect(sidebar.getByText("Approve", { exact: true })).toBeVisible()
		await expect
			.poll(() =>
				readFile(externalPath, "utf8")
					.then(() => true)
					.catch(() => false),
			)
			.toBe(false)

		await rejectButton.click()
		await expect(sidebar.getByText("E2E_JUNCTION_EXTERNAL_WRITE_REJECTED", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect
			.poll(() =>
				readFile(externalPath, "utf8")
					.then(() => true)
					.catch(() => false),
			)
			.toBe(false)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)
