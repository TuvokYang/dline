import { mkdir, rename, stat, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

/**
 * A directory holding a file a task read must stay renamable while the task is open.
 *
 * Dline tracks every file a task reads so it can report outside edits. Each
 * tracked file used to get its own watcher, and on Windows a watcher pins its
 * directory: renaming or deleting `.memory-bank/<workstream>/` then failed with
 * "in use" for as long as the task lived. Workspace watches are now served from
 * VS Code's own recursive watch, which only holds the workspace folder itself.
 */
const TRACKED_DIRECTORY = path.join(".memory-bank", "ws-rename")
const RENAMED_DIRECTORY = path.join(".memory-bank", "ws-renamed")
const TRACKED_FILE = "notes.md"
const TRACKED_CONTENT_MARKER = "E2E_TRACKED_NOTES"

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

e2e(
    "a directory holding a file the task read can be renamed while the task is open",
    async ({ helper, server, sidebar, workspaceDir }) => {
        e2e.setTimeout(120_000)
        const trackedDirectory = path.join(workspaceDir, TRACKED_DIRECTORY)
        await mkdir(trackedDirectory, { recursive: true })
        await writeFile(path.join(trackedDirectory, TRACKED_FILE), `# ${TRACKED_CONTENT_MARKER}\n`, "utf8")

        await helper.signin(sidebar)
        await setAutoApproveAction(sidebar, "Read project files", true)

        server.resetOpenAiMock()
        server.enqueueOpenAiResponses(
            {
                type: "tool",
                id: "call_read_tracked",
                name: "read_file",
                arguments: { path: path.join(TRACKED_DIRECTORY, TRACKED_FILE).split(path.sep).join("/") },
            },
            {
                type: "tool",
                id: "call_read_tracked_completion",
                name: "attempt_completion",
                arguments: { result: "E2E_TRACKED_FILE_READ" },
                expectedToolResults: [{ callId: "call_read_tracked", contentIncludes: TRACKED_CONTENT_MARKER }],
            },
        )

        const input = sidebar.getByTestId("chat-input")
        await input.fill("Read the workstream notes.")
        await sidebar.getByTestId("send-button").click()
        await expect(sidebar.getByText("E2E_TRACKED_FILE_READ", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
        expect(server.getMockConsumptions("openai-compatible-chat")[1]?.contractError).toBeUndefined()

        // The task is still open and still tracks the file it read.
        const renamedDirectory = path.join(workspaceDir, RENAMED_DIRECTORY)
        await rename(trackedDirectory, renamedDirectory)

        expect((await stat(path.join(renamedDirectory, TRACKED_FILE))).isFile()).toBe(true)
    },
)
