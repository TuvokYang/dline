import { mkdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

/**
 * An ignore denial must reach the model as an actionable tool result.
 *
 * A denied write previously pushed its refusal and then returned an empty
 * string, so the shared result store overwrote the refusal with the
 * "(tool did not return anything)" placeholder. The model then believed the
 * write had succeeded and kept building on a file that was never created.
 */
const DENIED_DIRECTORY = "e2e-denied"
const DENIED_RELATIVE_PATH = `${DENIED_DIRECTORY}/blocked-write.txt`
const READ_ONLY_DIRECTORY = "e2e-read-only"
const READ_ONLY_RELATIVE_PATH = `${READ_ONLY_DIRECTORY}/locked.txt`
const HIDDEN_DIRECTORY = "e2e-hidden"
const HIDDEN_RELATIVE_PATH = `${HIDDEN_DIRECTORY}/writable.txt`
const UNTRACKED_DIRECTORY = "e2e-untracked"
const UNTRACKED_RELATIVE_PATH = `${UNTRACKED_DIRECTORY}/notes.md`

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
	"write_to_file reports an agentignore denial to the model instead of an empty result",
	async ({ helper, server, sidebar, workspaceDir }) => {
		e2e.setTimeout(120_000)
		await writeFile(path.join(workspaceDir, ".agentignore"), `${DENIED_DIRECTORY}/\n`, "utf8")

		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Edit project files", true)

		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_denied_write",
				name: "write_to_file",
				arguments: { path: DENIED_RELATIVE_PATH, content: "must never be written\n" },
			},
			{
				type: "tool",
				id: "call_denied_write_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_IGNORE_DENIAL_REPORTED" },
				// The refusal must survive to the next request. Before the fix this
				// slot carried "(tool did not return anything)".
				expectedToolResults: [{ callId: "call_denied_write", contentIncludes: ".agentignore" }],
			},
		)

		await sendTask(sidebar, "Write the requested file and stop if the path is blocked.")
		await expect(sidebar.getByText("E2E_IGNORE_DENIAL_REPORTED", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})

		const consumptions = server.getMockConsumptions("openai-compatible-chat")
		expect(consumptions).toHaveLength(2)
		expect(consumptions[1]?.contractError).toBeUndefined()

		const deniedResult = consumptions[1]?.requestToolResults.find((entry) => entry.callId === "call_denied_write")
		expect(deniedResult?.content ?? "").not.toContain("(tool did not return anything)")
		expect(deniedResult?.content ?? "").toContain(".agentignore")
	},
)

e2e(
	"agentignore permission attributes separate hidden directories from read-only ones",
	async ({ helper, server, sidebar, workspaceDir }) => {
		e2e.setTimeout(120_000)
		await writeFile(path.join(workspaceDir, ".agentignore"), `${READ_ONLY_DIRECTORY}/ -w\n${HIDDEN_DIRECTORY}/ -s\n`, "utf8")

		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Edit project files", true)

		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_hidden_write",
				name: "write_to_file",
				arguments: { path: HIDDEN_RELATIVE_PATH, content: "hidden but writable\n" },
			},
			{
				type: "tool",
				id: "call_read_only_write",
				name: "write_to_file",
				arguments: { path: READ_ONLY_RELATIVE_PATH, content: "must never be written\n" },
				// Removing only the scan permission leaves writing intact.
				expectedToolResults: [{ callId: "call_hidden_write", contentIncludes: "successfully saved" }],
			},
			{
				type: "tool",
				id: "call_permission_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_IGNORE_PERMISSIONS_REPORTED" },
				expectedToolResults: [{ callId: "call_read_only_write", contentIncludes: ".agentignore" }],
			},
		)

		await sendTask(sidebar, "Write both requested files and report which one was refused.")
		await expect(sidebar.getByText("E2E_IGNORE_PERMISSIONS_REPORTED", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})

		const consumptions = server.getMockConsumptions("openai-compatible-chat")
		expect(consumptions).toHaveLength(3)
		expect(consumptions.every((entry) => entry.contractError === undefined)).toBe(true)

		// The hidden directory only lost its listing permission, so the file exists.
		expect(await readFile(path.join(workspaceDir, HIDDEN_RELATIVE_PATH), "utf8")).toContain("hidden but writable")
		await expect
			.poll(() =>
				readFile(path.join(workspaceDir, READ_ONLY_RELATIVE_PATH), "utf8")
					.then(() => true)
					.catch(() => false),
			)
			.toBe(false)
	},
)

e2e("a gitignored path stays readable and writable for the agent", async ({ helper, server, sidebar, workspaceDir }) => {
	e2e.setTimeout(120_000)
	const marker = "E2E_UNTRACKED_MARKER"
	await writeFile(path.join(workspaceDir, ".gitignore"), `${UNTRACKED_DIRECTORY}/\n`, "utf8")
	await mkdir(path.join(workspaceDir, UNTRACKED_DIRECTORY), { recursive: true })
	await writeFile(path.join(workspaceDir, UNTRACKED_RELATIVE_PATH), `${marker}\n`, "utf8")

	await helper.signin(sidebar)
	await setAutoApproveAction(sidebar, "Edit project files", true)

	server.resetOpenAiMock()
	server.enqueueOpenAiResponses(
		{
			type: "tool",
			id: "call_untracked_read",
			name: "read_file",
			arguments: { path: UNTRACKED_RELATIVE_PATH },
		},
		{
			type: "tool",
			id: "call_untracked_write",
			name: "write_to_file",
			arguments: { path: UNTRACKED_RELATIVE_PATH, content: `${marker}\nappended by the agent\n` },
			// Not tracking a path says nothing about whether opening it is allowed.
			expectedToolResults: [{ callId: "call_untracked_read", contentIncludes: marker }],
		},
		{
			type: "tool",
			id: "call_untracked_completion",
			name: "attempt_completion",
			arguments: { result: "E2E_GITIGNORE_STILL_USABLE" },
			expectedToolResults: [{ callId: "call_untracked_write", contentIncludes: "successfully saved" }],
		},
	)

	await sendTask(sidebar, "Read the untracked note and append one line to it.")
	await expect(sidebar.getByText("E2E_GITIGNORE_STILL_USABLE", { exact: false }).last()).toBeVisible({
		timeout: 60_000,
	})

	const consumptions = server.getMockConsumptions("openai-compatible-chat")
	expect(consumptions).toHaveLength(3)
	expect(consumptions.every((entry) => entry.contractError === undefined)).toBe(true)
	expect(await readFile(path.join(workspaceDir, UNTRACKED_RELATIVE_PATH), "utf8")).toContain("appended by the agent")
})
