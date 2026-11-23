import { mkdir, writeFile } from "node:fs/promises"
import path from "node:path"
import { expect } from "@playwright/test"
import { E2ETestHelper } from "../utils/helpers"
import { demo } from "./utils/demo-fixture"
import { dismissDemoNotifications } from "./utils/png-asset"
import { SIDEBAR_RECORDING, STEP_SETTLE_MS } from "./utils/recording-presets"

const TASK = "Use release-tools to read the project's release checklist."
const CHECKLIST = "Release checklist\n- Review the changelog.\n- Run the project tests.\n- Inspect the packaged extension."
const COMPLETION = "The MCP server returned the release checklist. Review the changelog, run the tests, and inspect the package."

// The model is deterministic, but the tool reads a real file through a real local MCP process.
demo(
    "docs MCP tool call",
    async ({
        dlineDocsDir,
        helper,
        sidebar,
        server,
        page,
        workspaceDir,
        userDataDir,
        registerRecording,
        focusCamera,
        pace,
        finishRecording,
    }) => {
        const checklistPath = path.join(workspaceDir, "release-checklist.txt")
        const settingsDir = path.join(dlineDocsDir, "settings")
        await mkdir(settingsDir, { recursive: true })
        await writeFile(checklistPath, CHECKLIST, "utf8")
        await writeFile(
            path.join(settingsDir, "mcp_settings.json"),
            JSON.stringify({
                mcpServers: {
                    "release-tools": {
                        type: "stdio",
                        command: process.execPath,
                        args: [
                            path.join(E2ETestHelper.E2E_TESTS_DIR, "demo", "fixtures", "mcp-release-server.mjs"),
                            checklistPath,
                        ],
                    },
                },
            }),
            "utf8",
        )
        await helper.signin(sidebar)
        await dismissDemoNotifications(page)

        await sidebar.getByLabel("Open auto-approve settings").click()
        const approval = sidebar.locator("vscode-checkbox").filter({ hasText: "Use MCP servers" })
        if (await approval.evaluate((element) => Boolean((element as HTMLInputElement).checked))) {
            await sidebar.getByText("Use MCP servers", { exact: true }).click()
        }
        await expect.poll(() => approval.evaluate((element) => Boolean((element as HTMLInputElement).checked))).toBe(false)
        await sidebar.getByLabel("Close auto-approve settings").click()

        await sidebar.getByRole("button", { name: "Show MCP Servers", exact: true }).first().click()
        await sidebar.getByRole("button", { name: "Go to MCP server settings", exact: true }).click()
        const serverRow = sidebar.getByText("release-tools", { exact: true }).filter({ visible: true })
        await expect(serverRow).toHaveCount(1, { timeout: 30_000 })
        await serverRow.click()
        await expect(sidebar.getByText("Tools (1)", { exact: true })).toBeVisible()
        const tool = sidebar.getByText("read_release_checklist", { exact: true }).first()
        await expect(tool).toBeVisible()

        server.resetOpenAiMock()
        server.enqueueOpenAiResponses(
            {
                type: "tool",
                id: "call_demo_checklist",
                name: "use_mcp_tool",
                arguments: { server_name: "release-tools", tool_name: "read_release_checklist", arguments: "{}" },
                expectedRequestIncludes: [TASK, "read_release_checklist"],
                delayMs: 500,
            },
            {
                type: "tool",
                id: "call_demo_complete",
                name: "attempt_completion",
                arguments: { result: COMPLETION },
                expectedToolResults: [{ callId: "call_demo_checklist", contentIncludes: CHECKLIST }],
                delayMs: 500,
            },
        )

        await registerRecording("docs-mcp", SIDEBAR_RECORDING)
        await focusCamera(tool, STEP_SETTLE_MS)
        await pace(800)
        await sidebar.getByRole("button", { name: "Done", exact: true }).click()
        const input = sidebar.getByTestId("chat-input")
        await focusCamera(input, STEP_SETTLE_MS)
        await input.fill(TASK)
        await pace(600)
        await input.press("Enter")
        const approve = sidebar.getByRole("contentinfo").getByText("Approve", { exact: true })
        await expect(approve).toBeVisible({ timeout: 30_000 })
        await focusCamera(approve, STEP_SETTLE_MS)
        await pace(800)
        await approve.click()
        await expect(sidebar.getByText(COMPLETION, { exact: false }).last()).toBeVisible({ timeout: 30_000 })
        await sidebar.getByRole("button", { name: "Expand MCP call" }).click()
        const response = sidebar.getByTestId("mcp-response-card")
        await expect(response).toContainText("Review the changelog.")
        await expect(response).toContainText("Inspect the packaged extension.")
        await focusCamera(response, STEP_SETTLE_MS)
        await pace(2_000)
        await finishRecording()

        const consumed = server.getMockConsumptions("openai-compatible-chat")
        expect(consumed.map((entry) => entry.toolName)).toEqual(["use_mcp_tool", "attempt_completion"])
        expect(consumed.every((entry) => !entry.contractError)).toBe(true)
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
    },
)
