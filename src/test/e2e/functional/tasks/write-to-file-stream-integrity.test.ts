import { readFile } from "node:fs/promises"
import * as path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

async function selectProfile(sidebar: Frame, profileName: string): Promise<void> {
    const modelSwitcher = sidebar.getByRole("button", { name: "Select model" })
    if ((await modelSwitcher.innerText()).trim() === profileName) return

    await modelSwitcher.click()
    const profileOption = sidebar.getByRole("option").filter({ has: sidebar.getByText(profileName, { exact: true }) })
    await expect(profileOption).toHaveCount(1)
    await profileOption.click()
    await expect(modelSwitcher).toHaveText(profileName)
}

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
    "write_to_file - completed Responses argument snapshots do not duplicate file content",
    async ({ helper, server, sidebar, workspaceDir }) => {
        e2e.setTimeout(120_000)
        await helper.signin(sidebar)
        await selectProfile(sidebar, E2E_PROFILE_NAMES.mockOpenAiResponses)
        await setAutoApproveAction(sidebar, "Edit project files", true)

        const relativePath = "e2e-write-snapshot-integrity.txt"
        const absolutePath = path.join(workspaceDir, relativePath)
        const content = "snapshot content must appear exactly once\n"
        server.resetOpenAiMock()
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool-with-completion-snapshots",
                id: "call_write_snapshot_integrity",
                name: "write_to_file",
                arguments: { path: relativePath, content },
            },
            {
                type: "tool",
                id: "call_write_snapshot_completion",
                name: "attempt_completion",
                arguments: { result: "E2E_WRITE_SNAPSHOT_INTEGRITY_OK" },
                expectedToolResults: [{ callId: "call_write_snapshot_integrity", contentIncludes: "successfully saved" }],
            },
        )

        await sendTask(sidebar, "Write one file from a Responses stream with completion snapshots.")
        await expect(sidebar.getByText("E2E_WRITE_SNAPSHOT_INTEGRITY_OK", { exact: false }).last()).toBeVisible({
            timeout: 60_000,
        })
        await expect
            .poll(async () => (await readFile(absolutePath, "utf8")).replaceAll("\r\n", "\n").trimEnd())
            .toBe(content.trimEnd())
        expect(server.getMockConsumptions("openai-compatible-responses")).toHaveLength(2)
    },
)

e2e(
    "write_to_file - max_output_tokens truncation never finalizes or writes partial arguments",
    async ({ helper, server, sidebar, workspaceDir }) => {
        e2e.setTimeout(120_000)
        await helper.signin(sidebar)
        await selectProfile(sidebar, E2E_PROFILE_NAMES.mockOpenAiResponses)
        await setAutoApproveAction(sidebar, "Edit project files", true)

        const relativePath = "e2e-write-truncated-must-not-exist.txt"
        const absolutePath = path.join(workspaceDir, relativePath)
        const content = "partial provider output must never reach disk\n"
        const serializedArguments = JSON.stringify({ path: relativePath, content })
        server.resetOpenAiMock()
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "truncated-tool",
                id: "call_write_truncated",
                name: "write_to_file",
                arguments: { path: relativePath, content },
                truncateAfter: serializedArguments.length - 1,
            },
            {
                type: "error",
                status: 500,
                code: "unexpected_request_after_truncated_tool",
                message: "A truncated tool call must not be executed or continued",
            },
        )

        await sendTask(sidebar, "Attempt a write whose Responses tool arguments are truncated by the provider.")
        // An output limit the provider enforced is a final failure: replaying the
        // same request would only be cut off again, so it is reported for the user
        // to act on rather than retried automatically.
        // The canonical error interaction owns recovery; no legacy inline retry row
        // should compete with its Retry / Start New Task actions.
        await expect(sidebar.getByRole("button", { name: "Retry", exact: true }).last()).toBeVisible({ timeout: 60_000 })
        await expect(sidebar.getByRole("button", { name: "Start New Task", exact: true }).last()).toBeVisible()
        await expect(sidebar.getByTestId("error-retry-box")).toHaveCount(0)
        await expect
            .poll(
                () =>
                    readFile(absolutePath, "utf8")
                        .then(() => false)
                        .catch((error: NodeJS.ErrnoException) => error.code === "ENOENT"),
                { timeout: 30_000 },
            )
            .toBe(true)
        const consumptions = server.getMockConsumptions("openai-compatible-responses")
        expect(consumptions).toHaveLength(1)
        expect(consumptions.every((consumption) => consumption.requestToolResults.length === 0)).toBe(true)
    },
)
