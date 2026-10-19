import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Page } from "@playwright/test"
import { createWorkspaceMcpScopeHash } from "@services/mcp/WorkspaceMcpRegistry"

const FIXTURE_SERVER = path.join(E2ETestHelper.E2E_TESTS_DIR, "fixtures", "workspace-mcp-server.mjs")

const VARIABLE_MCP_NAME = "e2e-variable-mcp"
// Unique so the extension host never finds it in its own process environment.
const VARIABLE = "DLINE_E2E_MCP_ROW_TOKEN"
const VARIABLE_PROMPT_TITLE = `MCP server "${VARIABLE_MCP_NAME}" needs ${VARIABLE}`
const DECLINED_ERROR = `Not connected: no value was provided for \${env:${VARIABLE}}. Restart the server to enter it.`

const WORKSPACE_MCP_NAME = "e2e-switch-mcp"

function countSpawns(output: string, connectionName: string): number {
    return output.split(/\r?\n/).filter((line) => line.includes(`[MCP ${connectionName}] spawning:`)).length
}

async function spawnsIn(userDataDir: string, connectionName: string): Promise<number> {
    return countSpawns(await E2ETestHelper.readDlineOutput(userDataDir), connectionName)
}

async function writeVariableServerSettings(dlineDocsDir: string): Promise<void> {
    const settingsPath = path.join(dlineDocsDir, "settings", "mcp_settings.json")
    await mkdir(path.dirname(settingsPath), { recursive: true })
    const server = {
        disabled: false,
        timeout: 60,
        type: "stdio",
        command: process.execPath,
        args: [FIXTURE_SERVER],
        env: { E2E_ROW_TOKEN: `\${env:${VARIABLE}}` },
    }
    await writeFile(settingsPath, `${JSON.stringify({ mcpServers: { [VARIABLE_MCP_NAME]: server } }, null, 2)}\n`, "utf8")
}

/** The values saved for the settings server, read from the store file the extension writes. */
async function readSavedVariables(dlineDir: string): Promise<Record<string, string> | undefined> {
    try {
        const document = JSON.parse(await readFile(path.join(dlineDir, "data", "secrets", "mcp_variables.json"), "utf8"))
        return document[`settings:${VARIABLE_MCP_NAME}`]
    } catch {
        return undefined
    }
}

async function writeWorkspaceDescriptor(workspaceDir: string): Promise<{ path: string; text: string }> {
    const descriptorDir = path.join(workspaceDir, ".agents", "mcp")
    await mkdir(descriptorDir, { recursive: true })
    const descriptorPath = path.join(descriptorDir, `${WORKSPACE_MCP_NAME}.json`)
    const text = `${JSON.stringify(
        {
            name: WORKSPACE_MCP_NAME,
            description: "Workspace MCP server switched from the settings list",
            type: "stdio",
            command: process.execPath,
            args: [FIXTURE_SERVER],
        },
        null,
        2,
    )}\n`
    await writeFile(descriptorPath, text, "utf8")
    return { path: descriptorPath, text }
}

/** The workspace-level MCP switches from Dline's local workspace state, not from the repository. */
async function readWorkspaceMcpToggles(dlineDir: string): Promise<Record<string, boolean> | undefined> {
    const workspacesRoot = path.join(dlineDir, "data", "workspaces")
    const entries = await readdir(workspacesRoot).catch(() => [] as string[])
    for (const entry of entries) {
        try {
            const document = JSON.parse(await readFile(path.join(workspacesRoot, entry, "workspaceState.json"), "utf8"))
            if (document.mcpServersToggles) return document.mcpServersToggles as Record<string, boolean>
        } catch {
            // A workspace directory without a state document has no switches yet.
        }
    }
    return undefined
}

async function openDline(page: Page, helper: E2ETestHelper): Promise<Frame> {
    await E2ETestHelper.openClineSidebar(page)
    const sidebar = await helper.getSidebar(page)
    await E2ETestHelper.dismissWhatsNewModal(sidebar)
    await helper.signin(sidebar)
    return sidebar
}

async function openMcpConfigure(sidebar: Frame): Promise<void> {
    await expect(sidebar.getByRole("button", { name: "Show MCP Servers", exact: true })).toBeVisible({ timeout: 60_000 })
    await sidebar.getByRole("button", { name: "Show MCP Servers", exact: true }).click()
    await sidebar.getByRole("button", { name: "Go to MCP server settings", exact: true }).click()
    await expect(sidebar.getByRole("heading", { name: "MCP Servers", exact: true })).toBeVisible()
    await expect(sidebar.getByText("Configure MCP Servers", { exact: true })).toBeVisible()
}

function serverRow(sidebar: Frame, displayName: string) {
    return sidebar.getByText(displayName, { exact: true }).locator("xpath=ancestor::div[contains(@class, 'mb-2.5')][1]")
}

e2e(
    "MCP variables - the prompt waits until Dline opens and the server row clears the saved value",
    async ({ dlineDir, dlineDocsDir, helper, openVSCode, userDataDir, workspaceDir }) => {
        e2e.setTimeout(240_000)
        await writeVariableServerSettings(dlineDocsDir)

        const app = await openVSCode(workspaceDir)
        try {
            const page = await app.firstWindow()
            const prompt = page.locator(".quick-input-widget").getByText(VARIABLE_PROMPT_TITLE, { exact: true })

            // The extension is active and has reached the server, but nothing may ask the user yet.
            await expect
                .poll(
                    async () =>
                        (await E2ETestHelper.readDlineOutput(userDataDir)).includes(
                            `[MCP ${VARIABLE_MCP_NAME}] waiting for Dline to open`,
                        ),
                    {
                        timeout: 60_000,
                    },
                )
                .toBe(true)
            await expect(prompt).toBeHidden()
            expect(await spawnsIn(userDataDir, VARIABLE_MCP_NAME)).toBe(0)

            await E2ETestHelper.openClineSidebar(page)
            await expect(prompt).toBeVisible({ timeout: 30_000 })
            const input = page.locator(".quick-input-widget input").last()
            await input.fill("e2e-first-value")
            await input.press("Enter")
            await expect.poll(() => readSavedVariables(dlineDir)).toEqual({ [VARIABLE]: "e2e-first-value" })
            await expect.poll(() => spawnsIn(userDataDir, VARIABLE_MCP_NAME), { timeout: 60_000 }).toBe(1)

            const sidebar = await helper.getSidebar(page)
            await E2ETestHelper.dismissWhatsNewModal(sidebar)
            await helper.signin(sidebar)
            await openMcpConfigure(sidebar)

            // Clearing is reachable from the collapsed row of a connected server.
            const row = serverRow(sidebar, VARIABLE_MCP_NAME)
            await row.getByRole("button", { name: "Clear Saved Variables", exact: true }).click()
            await expect(prompt).toBeVisible({ timeout: 30_000 })
            await expect.poll(() => readSavedVariables(dlineDir)).toBeUndefined()

            await page.locator(".quick-input-widget input").last().press("Escape")
            await expect(row.getByText(DECLINED_ERROR, { exact: true })).toBeVisible({ timeout: 30_000 })
            expect(await spawnsIn(userDataDir, VARIABLE_MCP_NAME)).toBe(1)
            expect(await readSavedVariables(dlineDir)).toBeUndefined()
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await app.close()
        }
    },
)

e2e(
    "MCP workspace server switch - turning a project server off is kept in local workspace state across restarts",
    async ({ dlineDir, helper, openVSCode, userDataDir, workspaceDir }) => {
        e2e.setTimeout(300_000)
        const descriptor = await writeWorkspaceDescriptor(workspaceDir)
        const connectionName = `${WORKSPACE_MCP_NAME}@${createWorkspaceMcpScopeHash(workspaceDir)}`

        const firstSession = await openVSCode(workspaceDir)
        try {
            const page = await firstSession.firstWindow()
            const sidebar = await openDline(page, helper)
            await expect.poll(() => spawnsIn(userDataDir, connectionName), { timeout: 60_000 }).toBe(1)
            await openMcpConfigure(sidebar)

            const toggle = sidebar.getByRole("switch", { name: `Enable ${WORKSPACE_MCP_NAME}`, exact: true })
            await expect(toggle).toHaveAttribute("aria-checked", "true", { timeout: 60_000 })
            await toggle.click()
            await expect(toggle).toHaveAttribute("aria-checked", "false")
            await expect.poll(async () => (await readWorkspaceMcpToggles(dlineDir))?.[connectionName]).toBe(false)
            // The project file stays as the repository wrote it.
            expect(await readFile(descriptor.path, "utf8")).toBe(descriptor.text)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await firstSession.close()
        }

        const secondSession = await openVSCode(workspaceDir)
        try {
            const page = await secondSession.firstWindow()
            const sidebar = await openDline(page, helper)
            await openMcpConfigure(sidebar)

            // The switch is read back from the local workspace state after a restart.
            const toggle = sidebar.getByRole("switch", { name: `Enable ${WORKSPACE_MCP_NAME}`, exact: true })
            await expect(toggle).toHaveAttribute("aria-checked", "false", { timeout: 60_000 })

            await toggle.click()
            await expect(toggle).toHaveAttribute("aria-checked", "true")
            await expect.poll(async () => (await readWorkspaceMcpToggles(dlineDir))?.[connectionName]).toBe(true)
            expect(await readFile(descriptor.path, "utf8")).toBe(descriptor.text)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await secondSession.close()
        }
    },
)
