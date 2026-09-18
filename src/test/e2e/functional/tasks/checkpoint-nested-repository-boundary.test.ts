import { access, mkdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

async function pathExists(filePath: string): Promise<boolean> {
	return access(filePath)
		.then(() => true)
		.catch(() => false)
}

/** Approve writes automatically so the run exercises checkpointing, not the approval UI. */
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

/**
 * Create a directory that Git treats as a separate repository boundary.
 *
 * A linked worktree stores `.git` as a file pointing at the parent repository.
 * Reproducing that shape is enough for the checkpoint boundary detector and for
 * Git's own gitlink handling, and it avoids depending on a real `git worktree
 * add` inside the E2E workspace.
 */
async function createNestedRepositoryMarker(nestedRepositoryPath: string): Promise<void> {
	await mkdir(nestedRepositoryPath, { recursive: true })
	await writeFile(path.join(nestedRepositoryPath, ".git"), "gitdir: ../.git/worktrees/e2e-nested\n", "utf8")
}

/**
 * Regression guard for BUGFIX-033.
 *
 * A nested repository created while a task is running used to poison the tracked
 * file set: the whole `git add` batch failed on its pathspec, every other file in
 * the same batch was discarded, and the failed set was replayed on every later
 * checkpoint, so the task produced no further restore points and said nothing
 * about it. The task must instead keep checkpointing the files it owns.
 */
e2e(
	"Checkpoint - a repository created mid-task excludes only its own files and keeps checkpointing the rest",
	async ({ helper, server, sidebar, userDataDir, workspaceDir }) => {
		const nestedRepositoryPath = path.join(workspaceDir, "nested-worktree")
		const rootRelativePath = "root-owned.txt"
		const nestedRelativePath = path.posix.join("nested-worktree", "nested-owned.txt")
		const rootPath = path.join(workspaceDir, rootRelativePath)
		const nestedPath = path.join(nestedRepositoryPath, "nested-owned.txt")

		// The repository boundary appears before the task starts editing, which is
		// exactly the case the startup topology snapshot could not see.
		await createNestedRepositoryMarker(nestedRepositoryPath)

		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_write_nested",
				name: "write_to_file",
				arguments: { path: nestedRelativePath, content: "nested repository content\n" },
			},
			{
				type: "tool",
				id: "call_write_root",
				name: "write_to_file",
				arguments: { path: rootRelativePath, content: "root repository content\n" },
				expectedToolResults: [
					{
						callId: "call_write_nested",
						contentIncludes: "The content was successfully saved",
					},
				],
			},
			{
				type: "tool",
				id: "call_write_root_again",
				name: "write_to_file",
				arguments: { path: rootRelativePath, content: "root repository content updated\n" },
				expectedToolResults: [
					{
						callId: "call_write_root",
						contentIncludes: "The content was successfully saved",
					},
				],
			},
			{
				type: "tool",
				id: "call_boundary_complete",
				name: "attempt_completion",
				arguments: { result: "E2E_NESTED_BOUNDARY_COMPLETE" },
				expectedToolResults: [
					{
						callId: "call_write_root_again",
						contentIncludes: "The content was successfully saved",
					},
				],
			},
		)

		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Edit project files", true)
		await sendTask(sidebar, "Write into the nested repository and the root workspace, then finish.")

		await expect(sidebar.getByText("E2E_NESTED_BOUNDARY_COMPLETE", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})

		await expect.poll(() => pathExists(nestedPath)).toBe(true)
		await expect.poll(() => pathExists(rootPath)).toBe(true)
		expect((await readFile(rootPath, "utf8")).replaceAll("\r\n", "\n")).toBe("root repository content updated\n")

		const output = await E2ETestHelper.readDlineOutput(userDataDir)

		// The boundary is recognised even though it did not exist when the shadow
		// repository was initialised.
		expect(output).toMatch(/Checkpoint add excluded \d+ nested repository file\(s\)/i)

		// The nested pathspec never reaches Git, so the failure that used to abort
		// the whole batch cannot occur.
		expect(output).not.toMatch(/is in submodule/i)

		// Root-owned files keep producing checkpoints after the nested write.
		expect(output).toMatch(/Checkpoint add operation: staged \d+ tracked file\(s\)/i)

		// The permanent-failure signature is a repeated identical staging failure.
		const stagingFailures = output.match(/Failed to stage \d+ tracked file\(s\)/gi) ?? []
		expect(stagingFailures).toHaveLength(0)

		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)
