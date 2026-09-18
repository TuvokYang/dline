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
	"write_to_file creates a sibling external file before external-edit approval",
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

		await expect
			.poll(() =>
				readFile(externalPath, "utf8")
					.then((content) => ({ exists: true, content }))
					.catch(() => ({ exists: false, content: undefined })),
			)
			.toEqual({ exists: true, content: "" })

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
	"write_to_file follows a project junction to a sibling external directory without external-edit approval",
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
					content: "E2E_JUNCTION_EXTERNAL_WRITE_BYPASSED_APPROVAL\n",
				},
			},
			{
				type: "tool",
				id: "call_junction_external_write_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_JUNCTION_EXTERNAL_WRITE_COMPLETE" },
				expectedToolResults: [
					{
						callId: "call_junction_external_write",
						contentIncludes: "The content was successfully saved",
					},
				],
			},
		)

		await sendTask(sidebar, "Write through the requested project path and finish.")
		await expect(sidebar.getByText("E2E_JUNCTION_EXTERNAL_WRITE_COMPLETE", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect(sidebar.getByText("Approve", { exact: true })).toHaveCount(0)
		await expect(sidebar.getByText("Reject", { exact: true })).toHaveCount(0)
		await expect
			.poll(async () => (await readFile(externalPath, "utf8")).replaceAll("\r\n", "\n"))
			.toBe("E2E_JUNCTION_EXTERNAL_WRITE_BYPASSED_APPROVAL\n")
		const output = await E2ETestHelper.readDlineOutput(userDataDir)
		expect(output).toMatch(/Checkpoint add rejected a tracked path outside/i)
		expect(output).toMatch(/Failed to stage 1 tracked file\(s\).*Skipping commit/i)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [
			/Checkpoint add rejected a tracked path outside/i,
			/Failed to stage 1 tracked file\(s\).*Skipping commit/i,
		])
	},
)
