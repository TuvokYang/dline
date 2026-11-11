import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import * as path from "node:path"
import type { ClineApiServerMock, MockApiConsumption } from "@e2e/fixtures/server"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { e2e as base, E2ETestHelper } from "@e2e/utils/helpers"
import { showSubagentOutput, subagentCardByTask } from "@e2e/utils/subagent-card"
import { expect, type Frame, type Locator } from "@playwright/test"
import { parseTaskCapabilityToggles } from "@shared/TaskCapabilityToggles"
import { load as parseYaml } from "js-yaml"

const AGENT = "e2e-independent-capabilities"
const TASK = "E2E_WS126_ORIGINAL_CHILD_TASK inspect ws126-original.txt"
const RULE_FILE = "ws126-selected.md"
const RETRY_RULE_FILE = "ws126-retry.md"
const CONTEXT_RULE_FILE = "ws126-context-only.md"
const UNSELECTED_RULE_FILE = "ws126-unselected.md"
const PARENT_RULE_FILE = "ws126-parent-only.md"
const RULE = "E2E_WS126_SELECTED_RULE_BODY"
const RETRY_RULE = "E2E_WS126_RETRY_RULE_BODY"
const CONTEXT_RULE = "E2E_WS126_CONTEXT_ONLY_RULE_BODY"
const UNSELECTED_RULE = "E2E_WS126_UNSELECTED_RULE_BODY"
const PARENT_RULE = "E2E_WS126_PARENT_ONLY_RULE_BODY"
const SKILL = "e2e-ws126-selected-skill"
const OTHER_SKILL = "e2e-ws126-unselected-skill"
const SKILL_BODY = "E2E_WS126_SELECTED_SKILL_BODY"
const OTHER_SKILL_BODY = "E2E_WS126_UNSELECTED_SKILL_BODY"
const WORKFLOW = "e2e-ws126-selected-workflow"
const OTHER_WORKFLOW = "e2e-ws126-unselected-workflow"
const WORKFLOW_BODY = "E2E_WS126_SELECTED_WORKFLOW_BODY"
const OTHER_WORKFLOW_BODY = "E2E_WS126_UNSELECTED_WORKFLOW_BODY"
const MCP = "e2e-ws126-mcp"
const OTHER_MCP = "e2e-ws126-unselected-mcp"
const ECHO_TOOL = "e2e_workspace_echo"
const SUBAGENT_CALL = "call_ws126_subagent"
const CHILD_DONE = "E2E_WS126_CHILD_DONE"
const PARENT_DONE = "E2E_WS126_PARENT_DONE"
const COMMENT = "# E2E_WS126_COMMENT_MUST_SURVIVE"
const AGENT_BODY = "E2E_WS126_AGENT_BODY_MUST_SURVIVE. Inspect only the explicitly selected capabilities."
const CAPABILITY_FIELDS = ["rules", "skills", "workflows", "mcp"] as const

type Category = "Tools" | "Rules" | "Skills" | "Workflows" | "MCP"
interface AgentDocument {
    text: string
    frontmatter: string
    body: string
    data: Record<string, unknown>
}

const agentPath = (workspaceDir: string) => path.join(workspaceDir, ".agents", "subagents", `${AGENT}.yml`)
const rulePath = (workspaceDir: string, name: string) => path.join(workspaceDir, ".agents", "rules", name)

/** All authored resources live inside the project fixture's disposable workspace/data roots. */
const e2e = base.extend({
    dlineDir: async ({ dlineDir, workspaceDir }, use) => {
        const profilesPath = path.join(dlineDir, "data", "settings", "api_profiles.json")
        const profiles = JSON.parse(await readFile(profilesPath, "utf8"))
        const child = profiles.find((profile: { name: string }) => profile.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
        if (!child?.openai?.capabilities) throw new Error("Missing configurable child E2E Profile")
        // Standard supports the real loader tools; the parent stays on its separate Chat queue.
        child.modelId = "e2e-ws126-standard-model"
        child.openai.capabilities.contextWindow = 200_000
        child.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
        await writeFile(profilesPath, JSON.stringify(profiles))

        await Promise.all([
            mkdir(path.dirname(agentPath(workspaceDir)), { recursive: true }),
            mkdir(path.dirname(rulePath(workspaceDir, RULE_FILE)), { recursive: true }),
            mkdir(path.join(workspaceDir, ".agents", "workflows"), { recursive: true }),
            ...[SKILL, OTHER_SKILL].map((name) => mkdir(path.join(workspaceDir, ".agents", "skills", name), { recursive: true })),
        ])
        await Promise.all([
            writeFile(rulePath(workspaceDir, RULE_FILE), RULE),
            writeFile(rulePath(workspaceDir, RETRY_RULE_FILE), `---\npaths:\n  - ws126-original.txt\n---\n${RETRY_RULE}\n`),
            writeFile(
                rulePath(workspaceDir, CONTEXT_RULE_FILE),
                `---\npaths:\n  - ws126-context-only.txt\n---\n${CONTEXT_RULE}\n`,
            ),
            writeFile(rulePath(workspaceDir, UNSELECTED_RULE_FILE), UNSELECTED_RULE),
            writeFile(rulePath(workspaceDir, PARENT_RULE_FILE), PARENT_RULE),
            ...[
                [SKILL, SKILL_BODY],
                [OTHER_SKILL, OTHER_SKILL_BODY],
            ].map(([name, body]) =>
                writeFile(
                    path.join(workspaceDir, ".agents", "skills", name, "SKILL.md"),
                    `---\nname: ${name}\ndescription: Focused WS-126 skill ${name}\n---\n${body}\n`,
                ),
            ),
            ...[
                [WORKFLOW, WORKFLOW_BODY],
                [OTHER_WORKFLOW, OTHER_WORKFLOW_BODY],
            ].map(([name, body]) =>
                writeFile(
                    path.join(workspaceDir, ".agents", "workflows", `${name}.md`),
                    `---\nname: ${name}\ndescription: Focused WS-126 workflow ${name}\n---\n${body}\n`,
                ),
            ),
            writeFile(
                agentPath(workspaceDir),
                `---
name: ${AGENT}
description: Focused independent subagent capability selection
${COMMENT}
profile: ${E2E_PROFILE_NAMES.mockOpenAiResponses}
tools:
  - read_file
  - load_skill
  - load_workflow
  - load_mcp
  - use_mcp_tool
  - access_mcp_resource
  - attempt_completion
x-e2e-preserve:
  nested: E2E_WS126_UNKNOWN_FIELD
---

${AGENT_BODY}\n`,
            ),
        ])
        await use(dlineDir)
    },
})

e2e.use({ installVsix: false, trace: "retain-on-failure" })
e2e.afterEach(async ({ server, userDataDir, workspaceDir, dlineDir }, testInfo) => {
    const diagnosticsPath = testInfo.outputPath("ws126-provider-diagnostics.json")
    const names: readonly string[] = [E2E_PROFILE_NAMES.mockOpenAi, E2E_PROFILE_NAMES.mockOpenAiResponses]
    const profiles = JSON.parse(await readFile(path.join(dlineDir, "data", "settings", "api_profiles.json"), "utf8"))
    await writeFile(
        diagnosticsPath,
        JSON.stringify(
            {
                mockBaseUrl: server.baseUrl,
                profiles: profiles
                    .filter((p: { name: string }) => names.includes(p.name))
                    .map(
                        (p: {
                            id: string
                            name: string
                            provider: string
                            modelId: string
                            openai?: { baseUrl?: string; apiFormat?: string }
                        }) => ({
                            id: p.id,
                            name: p.name,
                            provider: p.provider,
                            modelId: p.modelId,
                            baseUrl: p.openai?.baseUrl,
                            apiFormat: p.openai?.apiFormat,
                        }),
                    ),
                parent: server.getMockConsumptions("openai-compatible-chat"),
                child: server.getMockConsumptions("openai-compatible-responses"),
            },
            null,
            2,
        ),
    )
    await testInfo.attach("ws126-provider-requests-and-tool-results", {
        path: diagnosticsPath,
        contentType: "application/json",
    })
    await testInfo.attach("ws126-subagent-yaml", {
        body: await readFile(agentPath(workspaceDir), "utf8"),
        contentType: "text/plain",
    })
    await testInfo.attach("ws126-dline-output", {
        body: E2ETestHelper.readDlineOutputIfPresent(userDataDir) ?? "Dline Output log unavailable.",
        contentType: "text/plain",
    })
})

async function readAgent(workspaceDir: string): Promise<AgentDocument> {
    const text = await readFile(agentPath(workspaceDir), "utf8")
    const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)([\s\S]*)$/.exec(text)
    if (!match) throw new Error("Saved subagent is not a frontmatter document")
    const data = parseYaml(match[1])
    if (!data || typeof data !== "object" || Array.isArray(data)) throw new Error("Saved subagent YAML is not a mapping")
    return { text, frontmatter: match[1], body: match[2], data: data as Record<string, unknown> }
}

function expectPreserved(document: AgentDocument): void {
    expect(document.text).toContain(COMMENT)
    expect(document.body).toBe(`\n${AGENT_BODY}\n`)
    expect(document.data["x-e2e-preserve"]).toEqual({ nested: "E2E_WS126_UNKNOWN_FIELD" })
    expect(document.data.description).toBe("Focused independent subagent capability selection")
}

async function expectSaved(workspaceDir: string, expected: Record<string, unknown>): Promise<AgentDocument> {
    await expect.poll(async () => (await readAgent(workspaceDir)).data).toMatchObject(expected)
    const document = await readAgent(workspaceDir)
    expectPreserved(document)
    for (const field of CAPABILITY_FIELDS) {
        if (expected[field] !== undefined) expect(document.frontmatter).toMatch(new RegExp(`^${field}:\\r?\\n[ \\t]+-`, "m"))
    }
    return document
}

function parentRow(sidebar: Frame, name: string): Locator {
    return sidebar.getByText(name, { exact: true }).locator("xpath=ancestor::div[contains(@class, 'mb-2.5')][1]")
}

async function setParentToggle(sidebar: Frame, name: string, enabled: boolean): Promise<void> {
    const toggle = parentRow(sidebar, name).getByRole("switch")
    await expect(toggle).toHaveCount(1)
    await expect(toggle).toHaveAttribute("data-state", /^(?:checked|unchecked)$/)
    if ((await toggle.getAttribute("data-state")) !== (enabled ? "checked" : "unchecked")) await toggle.click()
    await expect(toggle).toHaveAttribute("data-state", enabled ? "checked" : "unchecked")
}

async function openCapabilities(sidebar: Frame): Promise<void> {
    await sidebar.getByRole("button", { name: "Show Dline Rules & Workflows", exact: true }).first().click()
    await expect(sidebar.getByRole("button", { name: "Hide Dline Rules & Workflows", exact: true }).first()).toBeVisible()
}

async function closeCapabilities(sidebar: Frame): Promise<void> {
    await sidebar.getByRole("button", { name: "Hide Dline Rules & Workflows", exact: true }).first().click()
    await expect(sidebar.getByRole("button", { name: "Show Dline Rules & Workflows", exact: true }).first()).toBeVisible()
}

async function parentTab(sidebar: Frame, name: "Rules" | "Skills" | "Workflows" | "Subagents"): Promise<void> {
    const button = sidebar.getByRole("button", { name, exact: true })
    await button.click()
    await expect(button).toHaveAttribute("aria-pressed", "true")
}

async function openConfiguration(sidebar: Frame): Promise<Locator> {
    await openCapabilities(sidebar)
    await parentTab(sidebar, "Subagents")
    const button = sidebar.getByRole("button", { name: `Configure subagent ${AGENT}`, exact: true })
    await expect(button).toBeVisible({ timeout: 30_000 })
    await button.click()
    const configuration = sidebar.getByRole("region", { name: `${AGENT} configuration`, exact: true })
    await expect(configuration).toBeVisible()
    await expect(configuration.getByRole("combobox", { name: "Profile", exact: true })).toBeEnabled()
    return configuration
}

async function tab(configuration: Locator, name: Category): Promise<void> {
    const button = configuration.getByRole("tab", { name: new RegExp(`^${name} \\(`) })
    await button.click()
    await expect(button).toHaveAttribute("aria-selected", "true")
}

async function expectSaveIdle(configuration: Locator): Promise<void> {
    const row = configuration.locator("xpath=ancestor::div[contains(@class, 'mb-2.5')][1]")
    await expect(row.getByRole("status", { name: "Subagent configuration save status", exact: true })).toHaveText(
        "Subagent configuration saved.",
    )
}

async function choose(configuration: Locator, label: string, enabled: boolean): Promise<void> {
    const checkbox = configuration.getByRole("checkbox", { name: label, exact: true })
    await expect(checkbox).toBeEnabled()
    await checkbox.setChecked(enabled)
    await expect(checkbox).toBeChecked({ checked: enabled })
}

/** Parent-only instructions are a positive control; child-selected resources are explicitly off for the parent. */
async function deselectParentPromptResources(sidebar: Frame): Promise<void> {
    await openCapabilities(sidebar)
    await parentTab(sidebar, "Rules")
    for (const name of [RULE_FILE, RETRY_RULE_FILE, CONTEXT_RULE_FILE, UNSELECTED_RULE_FILE]) {
        await setParentToggle(sidebar, name, false)
    }
    await setParentToggle(sidebar, PARENT_RULE_FILE, true)
    await parentTab(sidebar, "Skills")
    for (const name of [SKILL, OTHER_SKILL]) await setParentToggle(sidebar, name, false)
    await parentTab(sidebar, "Workflows")
    for (const name of [WORKFLOW, OTHER_WORKFLOW]) await setParentToggle(sidebar, `${name}.md`, false)
    await closeCapabilities(sidebar)
}

async function send(sidebar: Frame, text: string): Promise<void> {
    const input = sidebar.getByTestId("chat-input")
    await expect(input).toBeEnabled()
    await input.fill(text)
    await sidebar.getByTestId("send-button").click()
}

async function approveSubagent(sidebar: Frame): Promise<void> {
    const approve = sidebar.getByText("Approve", { exact: true })
    await expect(approve.or(subagentCardByTask(sidebar, TASK))).toBeVisible({ timeout: 30_000 })
    if (await approve.isVisible()) await approve.click()
}

function enqueueDelegation(server: ClineApiServerMock, result = CHILD_DONE): void {
    server.enqueueOpenAiResponses(
        {
            type: "tool",
            id: SUBAGENT_CALL,
            name: "use_subagent",
            arguments: { agent_name: AGENT, task: TASK, context: "Validate the explicit child capability choices.", timeout: 60 },
            requireCompleteToolPairing: true,
        },
        {
            type: "tool",
            id: "call_ws126_parent_done",
            name: "attempt_completion",
            arguments: { result: PARENT_DONE },
            expectedToolResults: [{ callId: SUBAGENT_CALL, contentIncludes: result }],
            requireCompleteToolPairing: true,
        },
    )
}

function expectRequests(requests: readonly MockApiConsumption[], count: number): void {
    expect(requests).toHaveLength(count)
    for (const request of requests) {
        expect(request.contractError).toBeUndefined()
        expect(request.requestToolPairing.complete).toBe(true)
    }
}

function systemText(request: MockApiConsumption): string {
    const body = request.requestBody as {
        instructions?: string
        input?: { role?: string; content?: unknown }[]
        messages?: { role?: string; content?: unknown }[]
    }
    const messages = body.input ?? body.messages
    expect(Array.isArray(messages)).toBe(true)
    return JSON.stringify({
        instructions: body.instructions,
        messages: messages?.filter((message) => message.role === "system" || message.role === "developer"),
    })
}

function expectChildRules(requests: readonly MockApiConsumption[], marker = RULE): void {
    const systems = requests.map((request) => {
        const system = systemText(request)
        expect(system.split(marker)).toHaveLength(2)
        for (const excluded of [PARENT_RULE, UNSELECTED_RULE, CONTEXT_RULE, OTHER_SKILL, OTHER_WORKFLOW]) {
            expect(system).not.toContain(excluded)
        }
        const fullRequest = JSON.stringify(request.requestBody)
        expect(fullRequest.split(marker)).toHaveLength(2)
        for (const excluded of [PARENT_RULE, UNSELECTED_RULE, CONTEXT_RULE, OTHER_SKILL_BODY, OTHER_WORKFLOW_BODY]) {
            expect(fullRequest).not.toContain(excluded)
        }
        return system
    })
    expect(new Set(systems).size).toBe(1)
}

function observedResult(requests: readonly MockApiConsumption[], callId: string): string {
    const result = requests.flatMap((request) => request.requestToolResults).find((result) => result.callId === callId)
    expect(result, `Provider never received tool output for ${callId}`).toBeDefined()
    return result?.content ?? ""
}

e2e(
    "WS-126 - real UI saves, clears and reopens independent choices; child Rules and loaders use them",
    async ({ helper, server, sidebar, userDataDir, workspaceDir }) => {
        await helper.signin(sidebar)
        await deselectParentPromptResources(sidebar)
        let configuration = await openConfiguration(sidebar)
        await expect(configuration.getByRole("tab")).toHaveCount(5)
        await tab(configuration, "Rules")
        await choose(configuration, `Use rule workspace/${RULE_FILE}`, true)
        await tab(configuration, "Skills")
        await choose(configuration, `Use skill ${SKILL}`, true)
        await tab(configuration, "Workflows")
        await choose(configuration, `Use workflow ${WORKFLOW}`, true)
        // Adjacent Profile/Tools saves must not overwrite the just-selected capability fields.
        await configuration.getByRole("combobox", { name: "Profile", exact: true }).selectOption("")
        await tab(configuration, "Tools")
        await choose(configuration, "Use list_files", true)
        await configuration
            .getByRole("combobox", { name: "Profile", exact: true })
            .selectOption(E2E_PROFILE_NAMES.mockOpenAiResponses)
        const selected = {
            rules: [{ scope: "workspace", path: RULE_FILE }],
            skills: [SKILL],
            workflows: [WORKFLOW],
            profile: E2E_PROFILE_NAMES.mockOpenAiResponses,
        }
        await expectSaveIdle(configuration)
        const saved = await expectSaved(workspaceDir, selected)
        expect(saved.data.tools).toEqual(expect.arrayContaining(["list_files", "load_skill", "load_workflow"]))
        expect(saved.data).not.toHaveProperty("mcp")
        await closeCapabilities(sidebar)
        configuration = await openConfiguration(sidebar)
        for (const [category, label] of [
            ["Rules", `Use rule workspace/${RULE_FILE}`],
            ["Skills", `Use skill ${SKILL}`],
            ["Workflows", `Use workflow ${WORKFLOW}`],
        ] as const) {
            await tab(configuration, category)
            await expect(configuration.getByRole("checkbox", { name: label, exact: true })).toBeChecked()
            await choose(configuration, label, false)
        }
        await expect
            .poll(async () => {
                const { data } = await readAgent(workspaceDir)
                return CAPABILITY_FIELDS.filter((field) => Object.hasOwn(data, field))
            })
            .toEqual([])
        await expectSaveIdle(configuration)
        expectPreserved(await readAgent(workspaceDir))
        await closeCapabilities(sidebar)
        configuration = await openConfiguration(sidebar)
        for (const [category, label] of [
            ["Rules", `Use rule workspace/${RULE_FILE}`],
            ["Skills", `Use skill ${SKILL}`],
            ["Workflows", `Use workflow ${WORKFLOW}`],
        ] as const) {
            await tab(configuration, category)
            await expect(configuration.getByRole("checkbox", { name: label, exact: true })).not.toBeChecked()
            await choose(configuration, label, true)
        }
        // Loader gates preserve intent, but the disabled loader cannot make the selection active.
        await tab(configuration, "Tools")
        await choose(configuration, "Use load_skill", false)
        await tab(configuration, "Skills")
        const skillChoice = configuration.getByRole("checkbox", { name: `Use skill ${SKILL}`, exact: true })
        await expect(skillChoice).toBeChecked()
        await expect(skillChoice).toBeDisabled()
        await expect(configuration.getByLabel("Active skills", { exact: true })).toHaveText("0")
        await expectSaveIdle(configuration)
        expect((await expectSaved(workspaceDir, selected)).data.tools).not.toContain("load_skill")
        await tab(configuration, "Tools")
        await choose(configuration, "Use load_skill", true)
        await expect(configuration.getByLabel("Active skills", { exact: true })).toHaveText("1")
        await expectSaveIdle(configuration)
        expect((await expectSaved(workspaceDir, selected)).data.tools).toContain("load_skill")
        await closeCapabilities(sidebar)

        server.resetOpenAiMock()
        enqueueDelegation(server)
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_ws126_skill",
                name: "load_skill",
                arguments: { name: SKILL },
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: "call_ws126_workflow",
                name: "load_workflow",
                arguments: { name: WORKFLOW },
                expectedToolResults: [{ callId: "call_ws126_skill", contentIncludes: SKILL_BODY }],
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: "call_ws126_denied_skill",
                name: "load_skill",
                arguments: { name: OTHER_SKILL },
                expectedToolResults: [{ callId: "call_ws126_workflow", contentIncludes: WORKFLOW_BODY }],
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: "call_ws126_denied_workflow",
                name: "load_workflow",
                arguments: { name: OTHER_WORKFLOW },
                expectedToolResults: [
                    { callId: "call_ws126_denied_skill", contentIncludes: `Unknown or disabled skill '${OTHER_SKILL}'` },
                ],
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: "call_ws126_child_done",
                name: "attempt_completion",
                arguments: { result: CHILD_DONE },
                expectedToolResults: [
                    { callId: "call_ws126_denied_workflow", contentIncludes: `Unknown or disabled workflow '${OTHER_WORKFLOW}'` },
                ],
                requireCompleteToolPairing: true,
            },
        )
        await send(sidebar, "Delegate the focused independent capability check.")
        await approveSubagent(sidebar)
        await expect(sidebar.getByText(PARENT_DONE, { exact: false }).last()).toBeVisible({ timeout: 30_000 })
        await expect(await showSubagentOutput(subagentCardByTask(sidebar, TASK))).toContainText(CHILD_DONE)
        const child = server.getMockConsumptions("openai-compatible-responses")
        const parent = server.getMockConsumptions("openai-compatible-chat")
        expectRequests(child, 5)
        expectRequests(parent, 2)
        expectChildRules(child)
        expect(systemText(child[0])).toContain(SKILL)
        expect(systemText(child[0])).toContain(WORKFLOW)
        expect(systemText(parent[0])).toContain(PARENT_RULE)
        for (const excluded of [RULE, UNSELECTED_RULE, SKILL, WORKFLOW]) expect(systemText(parent[0])).not.toContain(excluded)
        expect(observedResult(child, "call_ws126_skill")).toContain(SKILL_BODY)
        expect(observedResult(child, "call_ws126_workflow")).toContain(WORKFLOW_BODY)
        expect(observedResult(child, "call_ws126_denied_skill")).not.toContain(OTHER_SKILL_BODY)
        expect(observedResult(child, "call_ws126_denied_workflow")).not.toContain(OTHER_WORKFLOW_BODY)
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
    },
)

/** Reuse the repository's local MCP executable unchanged; no external transport or installation. */
const mcpE2e = e2e.extend({
    dlineDir: async ({ dlineDir, workspaceDir }, use) => {
        const directory = path.join(workspaceDir, ".agents", "mcp")
        await mkdir(directory, { recursive: true })
        for (const name of [MCP, OTHER_MCP]) {
            await writeFile(
                path.join(directory, `${name}.json`),
                JSON.stringify({
                    name,
                    description: "WS-126 owner-scoped local echo server",
                    type: "stdio",
                    command: process.execPath,
                    args: [path.join(E2ETestHelper.E2E_TESTS_DIR, "fixtures", "workspace-mcp-server.mjs")],
                }),
            )
        }
        await use(dlineDir)
    },
})

async function waitForMcpTools(sidebar: Frame): Promise<void> {
    await sidebar.getByRole("button", { name: "Show MCP Servers", exact: true }).first().click()
    await sidebar.getByRole("button", { name: "Go to MCP server settings", exact: true }).click()
    for (const name of [MCP, OTHER_MCP]) {
        const label = sidebar.getByText(name, { exact: true })
        await expect(label).toBeVisible({ timeout: 30_000 })
        await label.click()
        await expect(sidebar.getByText("Tools (1)", { exact: true })).toBeVisible({ timeout: 30_000 })
        await label.click()
    }
    await sidebar.getByRole("button", { name: "Done", exact: true }).click()
    await expect(sidebar.getByTestId("chat-input")).toBeVisible()
}

async function waitForParentMcpOff(dlineDocsDir: string, names: readonly string[]): Promise<void> {
    await expect
        .poll(async () => {
            try {
                const entries = await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true })
                const ids = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
                expect(ids).toHaveLength(1)
                const settings = JSON.parse(await readFile(path.join(dlineDocsDir, "tasks", ids[0], "settings.json"), "utf8"))
                const toggles = parseTaskCapabilityToggles(settings.taskCapabilityToggles)
                return names.map((name) => toggles?.mcpServers[name])
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
                throw error
            }
        })
        .toEqual(names.map(() => false))
}

mcpE2e(
    "WS-126 - workspace MCP uses the selected internal server/tool while parent selection and guesses grant nothing",
    async ({ dlineDocsDir, helper, server, sidebar, userDataDir, workspaceDir }) => {
        await helper.signin(sidebar)
        await waitForMcpTools(sidebar)
        let configuration = await openConfiguration(sidebar)
        await tab(configuration, "MCP")
        const selectedTool = configuration.getByRole("checkbox", { name: new RegExp(`^Use MCP tool ${MCP}@[^/]+/${ECHO_TOOL}$`) })
        const otherTool = configuration.getByRole("checkbox", {
            name: new RegExp(`^Use MCP tool ${OTHER_MCP}@[^/]+/${ECHO_TOOL}$`),
        })
        await expect(selectedTool).toBeEnabled()
        await expect(otherTool).toBeEnabled()
        const selectedLabel = await selectedTool.getAttribute("aria-label")
        const otherLabel = await otherTool.getAttribute("aria-label")
        if (!selectedLabel || !otherLabel)
            throw new Error("MCP candidates did not expose their exact internal server/tool identities")
        const internalName = selectedLabel.slice("Use MCP tool ".length, -`/${ECHO_TOOL}`.length)
        const otherInternalName = otherLabel.slice("Use MCP tool ".length, -`/${ECHO_TOOL}`.length)
        expect(internalName).not.toBe(MCP)
        await selectedTool.check()
        await expectSaveIdle(configuration)
        await expectSaved(workspaceDir, { mcp: [{ server: internalName, tools: [ECHO_TOOL] }] })
        await selectedTool.uncheck()
        await expect.poll(async () => Object.hasOwn((await readAgent(workspaceDir)).data, "mcp")).toBe(false)
        await expectSaveIdle(configuration)
        await closeCapabilities(sidebar)
        configuration = await openConfiguration(sidebar)
        await tab(configuration, "MCP")
        await expect(configuration.getByRole("checkbox", { name: selectedLabel, exact: true })).not.toBeChecked()
        await choose(configuration, selectedLabel, true)
        await expectSaveIdle(configuration)
        const document = await expectSaved(workspaceDir, { mcp: [{ server: internalName, tools: [ECHO_TOOL] }] })
        expect(document.data.mcp).toEqual([{ server: internalName, tools: [ECHO_TOOL] }])
        expect(document.frontmatter).toMatch(/^[ \t]+tools:\r?\n[ \t]+- e2e_workspace_echo$/m)
        await closeCapabilities(sidebar)

        server.resetOpenAiMock()
        server.enqueueOpenAiResponses({
            type: "tool",
            id: "call_ws126_mcp_ready",
            name: "qna_respond",
            arguments: { response: "E2E_WS126_MCP_TASK_READY" },
        })
        await send(sidebar, "Prepare one task for the child MCP selection check.")
        await expect(sidebar.getByText("E2E_WS126_MCP_TASK_READY", { exact: true })).toBeVisible({ timeout: 30_000 })
        // This is task scope, not the workspace server's connection/enable switch.
        await sidebar.getByRole("button", { name: "Show MCP Servers", exact: true }).first().click()
        for (const name of [MCP, OTHER_MCP]) await setParentToggle(sidebar, name, false)
        await sidebar.getByRole("button", { name: "Hide MCP Servers", exact: true }).first().click()
        await waitForParentMcpOff(dlineDocsDir, [internalName, otherInternalName])

        enqueueDelegation(server)
        const echo = "E2E_WS126_REAL_LOCAL_MCP_ECHO"
        const denied = "not enabled for this task"
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_ws126_mcp_load",
                name: "load_mcp",
                arguments: { name: `${internalName}.${ECHO_TOOL}` },
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: "call_ws126_mcp_echo",
                name: "use_mcp_tool",
                arguments: { server_name: internalName, tool_name: ECHO_TOOL, arguments: JSON.stringify({ value: echo }) },
                expectedToolResults: [
                    { callId: "call_ws126_mcp_load", contentIncludes: [internalName, ECHO_TOOL, "Input schema"] },
                ],
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: "call_ws126_mcp_other",
                name: "use_mcp_tool",
                arguments: {
                    server_name: otherInternalName,
                    tool_name: ECHO_TOOL,
                    arguments: JSON.stringify({ value: "E2E_WS126_OTHER_SERVER_MUST_NOT_ECHO" }),
                },
                expectedToolResults: [{ callId: "call_ws126_mcp_echo", contentIncludes: echo }],
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: "call_ws126_mcp_guess",
                name: "use_mcp_tool",
                arguments: {
                    server_name: internalName,
                    tool_name: `${ECHO_TOOL}_unselected`,
                    arguments: JSON.stringify({ value: "E2E_WS126_GUESSED_TOOL" }),
                },
                expectedToolResults: [{ callId: "call_ws126_mcp_other", contentIncludes: denied }],
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: "call_ws126_mcp_uri",
                name: "access_mcp_resource",
                arguments: { server_name: internalName, uri: "workspace://ws126/unselected" },
                expectedToolResults: [{ callId: "call_ws126_mcp_guess", contentIncludes: denied }],
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: "call_ws126_mcp_done",
                name: "attempt_completion",
                arguments: { result: CHILD_DONE },
                expectedToolResults: [{ callId: "call_ws126_mcp_uri", contentIncludes: denied }],
                requireCompleteToolPairing: true,
            },
        )
        await send(sidebar, "Now delegate the MCP check, keeping both servers off for the parent task.")
        await approveSubagent(sidebar)
        await expect(sidebar.getByText(PARENT_DONE, { exact: false }).last()).toBeVisible({ timeout: 30_000 })
        await expect(await showSubagentOutput(subagentCardByTask(sidebar, TASK))).toContainText(CHILD_DONE)
        const child = server.getMockConsumptions("openai-compatible-responses")
        expectRequests(child, 6)
        expectRequests(server.getMockConsumptions("openai-compatible-chat"), 3)
        expect(systemText(child[0])).toContain(`${internalName}.${ECHO_TOOL}`)
        expect(systemText(child[0])).not.toContain(otherInternalName)
        expect(observedResult(child, "call_ws126_mcp_echo")).toContain(echo)
        expect(observedResult(child, "call_ws126_mcp_other")).toContain(denied)
        expect(observedResult(child, "call_ws126_mcp_other")).not.toContain("E2E_WS126_OTHER_SERVER_MUST_NOT_ECHO")
        expect(observedResult(child, "call_ws126_mcp_guess")).toContain(denied)
        expect(observedResult(child, "call_ws126_mcp_uri")).toContain(denied)
        // The unchanged fixture has no resources: this test does NOT claim a successful URI read
        // or advertised-but-unselected tool isolation within the same server.
        await waitForParentMcpOff(dlineDocsDir, [internalName, otherInternalName])
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
    },
)

const liteE2e = e2e.extend({
    dlineDir: async ({ dlineDir }, use) => {
        const profilesPath = path.join(dlineDir, "data", "settings", "api_profiles.json")
        const profiles = JSON.parse(await readFile(profilesPath, "utf8"))
        const child = profiles.find((profile: { name: string }) => profile.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
        if (!child?.openai?.capabilities) throw new Error("Missing configurable child E2E Profile")
        // The existing o1 family contract selects Lite without changing parent or global settings.
        child.modelId = "o1-e2e-ws126-lite-model"
        await writeFile(profilesPath, JSON.stringify(profiles))
        await use(dlineDir)
    },
})

liteE2e(
    "WS-126 - a missing selected Rule fails only the child; Lite Activity Retry reads new Rules and original task",
    async ({ helper, page, server, sidebar, userDataDir, workspaceDir }) => {
        await helper.signin(sidebar)
        await deselectParentPromptResources(sidebar)
        let configuration = await openConfiguration(sidebar)
        await tab(configuration, "Rules")
        await choose(configuration, `Use rule workspace/${RULE_FILE}`, true)
        await tab(configuration, "Tools")
        for (const tool of ["load_skill", "load_workflow", "load_mcp"]) await choose(configuration, `Use ${tool}`, false)
        await expectSaveIdle(configuration)
        await expectSaved(workspaceDir, { rules: [{ scope: "workspace", path: RULE_FILE }] })
        await closeCapabilities(sidebar)
        await rm(rulePath(workspaceDir, RULE_FILE))

        server.resetOpenAiMock()
        server.enqueueOpenAiResponses(
            {
                type: "tool",
                id: SUBAGENT_CALL,
                name: "use_subagent",
                arguments: {
                    agent_name: AGENT,
                    task: TASK,
                    context: "Parent-only path evidence: ws126-context-only.txt. Keep the original task on Retry.",
                    timeout: 60,
                },
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: "call_ws126_rule_failure_ready",
                name: "qna_respond",
                arguments: { response: "E2E_WS126_RULE_FAILURE_PARENT_ALIVE" },
                expectedToolResults: [{ callId: SUBAGENT_CALL, contentIncludes: AGENT }],
                requireCompleteToolPairing: true,
            },
        )
        await send(sidebar, "Delegate a check whose selected Rule has just disappeared.")
        await approveSubagent(sidebar)
        await expect(sidebar.getByText("E2E_WS126_RULE_FAILURE_PARENT_ALIVE", { exact: true })).toBeVisible({ timeout: 30_000 })
        expect(server.getMockConsumptions("openai-compatible-responses")).toHaveLength(0)
        await sidebar.getByRole("tab", { name: /^Activities(?: \d+)?$/ }).click()
        await sidebar.getByRole("button", { name: "All", exact: true }).first().click()
        const activity = sidebar.getByTestId("activity-item").filter({ hasText: AGENT })
        await expect(activity).toHaveCount(1)
        await expect(activity).toHaveAttribute("data-activity-status", "failed")
        await activity.getByTestId("activity-toggle").click()
        await expect(activity).toContainText(RULE_FILE)
        await expect(activity.getByRole("button", { name: "Retry", exact: true })).toBeVisible()
        await E2ETestHelper.dismissWorkbenchHover(page)
        await sidebar.getByRole("tab", { name: "Work", exact: true }).click()

        configuration = await openConfiguration(sidebar)
        await tab(configuration, "Rules")
        await expect(configuration.getByRole("checkbox", { name: `Use rule workspace/${RULE_FILE}`, exact: true })).toBeChecked()
        await configuration
            .getByRole("button", { name: `Remove unavailable selection: Use rule workspace/${RULE_FILE}`, exact: true })
            .click()
        await choose(configuration, `Use rule workspace/${RETRY_RULE_FILE}`, true)
        await choose(configuration, `Use rule workspace/${CONTEXT_RULE_FILE}`, true)
        await expectSaveIdle(configuration)
        await expectSaved(workspaceDir, {
            rules: [
                { scope: "workspace", path: RETRY_RULE_FILE },
                { scope: "workspace", path: CONTEXT_RULE_FILE },
            ],
        })
        await closeCapabilities(sidebar)
        const recovered = "E2E_WS126_RULE_RETRY_RECOVERED"
        server.enqueueResponses("openai-compatible-responses", {
            type: "tool",
            id: "call_ws126_rule_retry_done",
            name: "attempt_completion",
            arguments: { result: recovered },
            expectedRequestIncludes: [TASK, RETRY_RULE],
            expectedRequestExcludes: [RULE, PARENT_RULE, UNSELECTED_RULE, CONTEXT_RULE],
            requireCompleteToolPairing: true,
        })
        await sidebar.getByRole("tab", { name: /^Activities(?: \d+)?$/ }).click()
        await activity.getByRole("button", { name: "Retry", exact: true }).click()
        await expect(activity).toHaveAttribute("data-activity-status", "completed", { timeout: 30_000 })
        await expect(activity.getByRole("button", { name: "Retry", exact: true })).toHaveCount(0)
        const child = server.getMockConsumptions("openai-compatible-responses")
        expectRequests(child, 1)
        expectChildRules(child, RETRY_RULE)
        expect(JSON.stringify(child[0].requestBody).split(TASK)).toHaveLength(2)
        const toolNames = (child[0].requestBody as { tools: { name: string }[] }).tools.map((tool) => tool.name)
        expect(toolNames).toContain("attempt_completion")
        for (const loader of ["load_skill", "load_workflow", "load_mcp"]) expect(toolNames).not.toContain(loader)
        await E2ETestHelper.dismissWorkbenchHover(page)
        await sidebar.getByRole("tab", { name: "Work", exact: true }).click()
        server.enqueueOpenAiResponses({
            type: "tool",
            id: "call_ws126_rule_retry_parent_done",
            name: "attempt_completion",
            arguments: { result: PARENT_DONE },
            expectedRequestIncludes: [recovered],
            requireCompleteToolPairing: true,
        })
        await send(sidebar, "Report the recovered child result from this same task.")
        await expect(sidebar.getByText(PARENT_DONE, { exact: false }).last()).toBeVisible({ timeout: 30_000 })
        expectRequests(server.getMockConsumptions("openai-compatible-chat"), 3)
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [
            /\[SubagentRunner\] run failed.*Subagent rule workspace:ws126-selected\.md is unavailable/,
        ])
    },
)

/** The private resource fixture advertises two tools and two case-distinct resources. */
const RESOURCE_MCP = "e2e-ws126-resources"
const RESOURCE_TOOL = "e2e_ws126_echo"
const UNSELECTED_TOOL = "e2e_ws126_unselected"
const UPPER_URI = "ws126-fixture://repo/Guide"
const LOWER_URI = "ws126-fixture://repo/guide"
const UPPER_RESOURCE_BODY = "E2E_WS126_UPPER_RESOURCE_BODY"
const LOWER_RESOURCE_SECRET = "E2E_WS126_LOWER_SECRET_RESOURCE_BODY"
const UNSELECTED_TOOL_SECRET = "E2E_WS126_SECRET_TOOL_BODY"
const MCP_DENIED = "not enabled for this task"
const RESOURCE_MCP_FIXTURE = path.join(E2ETestHelper.E2E_TESTS_DIR, "functional", "tasks", "subagent-capability-mcp.fixture.mjs")
const resourceLabel = (internalName: string, uri: string) => `Use MCP resource ${internalName}/${uri}`

/**
 * Own private owner-scoped server: the tool-only fixture above stays untouched, and the resource
 * fixture is the only server registered for these cases.
 */
const resourceE2e = e2e.extend({
    dlineDir: async ({ dlineDir, workspaceDir }, use) => {
        const directory = path.join(workspaceDir, ".agents", "mcp")
        await mkdir(directory, { recursive: true })
        await writeFile(
            path.join(directory, `${RESOURCE_MCP}.json`),
            JSON.stringify({
                name: RESOURCE_MCP,
                description: "WS-126 owner-scoped resource echo server",
                type: "stdio",
                command: process.execPath,
                args: [RESOURCE_MCP_FIXTURE],
            }),
        )
        await use(dlineDir)
    },
})

/** Wait for this fixture only; the shared helper's fixed Tools (1) cannot observe two tools. */
async function waitForMcpResources(sidebar: Frame): Promise<void> {
    await sidebar.getByRole("button", { name: "Show MCP Servers", exact: true }).first().click()
    await sidebar.getByRole("button", { name: "Go to MCP server settings", exact: true }).click()
    const label = sidebar.getByText(RESOURCE_MCP, { exact: true })
    await expect(label).toBeVisible({ timeout: 30_000 })
    await label.click()
    await expect(sidebar.getByText("Tools (2)", { exact: true })).toBeVisible({ timeout: 30_000 })
    await expect(sidebar.getByText("Resources (2)", { exact: true })).toBeVisible({ timeout: 30_000 })
    await sidebar.getByRole("button", { name: "Done", exact: true }).click()
    await expect(sidebar.getByTestId("chat-input")).toBeVisible()
}

/** The MCP tab exposes the exact owner-scoped identity; resource rows reuse the same server name. */
async function resolveInternalServer(configuration: Locator): Promise<string> {
    const tool = configuration.getByRole("checkbox", {
        name: new RegExp(`^Use MCP tool ${RESOURCE_MCP}@[^/]+/${RESOURCE_TOOL}$`),
    })
    await expect(tool).toBeEnabled()
    const label = await tool.getAttribute("aria-label")
    if (!label) throw new Error("MCP candidates did not expose their exact internal server/tool identities")
    const internalName = label.slice("Use MCP tool ".length, -`/${RESOURCE_TOOL}`.length)
    expect(internalName).not.toBe(RESOURCE_MCP)
    return internalName
}

resourceE2e(
    "WS-126 - a selected MCP tool and its exact resource URI work for the child while the parent task stays off",
    async ({ dlineDocsDir, helper, server, sidebar, userDataDir, workspaceDir }) => {
        await helper.signin(sidebar)
        await waitForMcpResources(sidebar)
        const configuration = await openConfiguration(sidebar)
        await tab(configuration, "MCP")
        const internalName = await resolveInternalServer(configuration)
        await choose(configuration, `Use MCP tool ${internalName}/${RESOURCE_TOOL}`, true)
        await choose(configuration, resourceLabel(internalName, UPPER_URI), true)
        await expectSaveIdle(configuration)
        const saved = await expectSaved(workspaceDir, {
            mcp: [{ server: internalName, tools: [RESOURCE_TOOL], resources: [UPPER_URI] }],
        })
        expect(saved.data.mcp).toEqual([{ server: internalName, tools: [RESOURCE_TOOL], resources: [UPPER_URI] }])
        // Both sub-blocks belong to the one saved server entry, not to two sibling entries.
        expect(saved.frontmatter).toMatch(/^mcp:\r?\n[ \t]+- server: /m)
        expect(saved.frontmatter).toMatch(/^[ \t]+tools:\r?\n[ \t]+- e2e_ws126_echo$/m)
        expect(saved.frontmatter).toMatch(/^[ \t]+resources:\r?\n[ \t]+- "?ws126-fixture:\/\/repo\/Guide"?$/m)
        await closeCapabilities(sidebar)

        server.resetOpenAiMock()
        server.enqueueOpenAiResponses({
            type: "tool",
            id: "call_ws126_resource_task_ready",
            name: "qna_respond",
            arguments: { response: "E2E_WS126_RESOURCE_TASK_READY" },
        })
        await send(sidebar, "Prepare one task for the child MCP tool and resource check.")
        await expect(sidebar.getByText("E2E_WS126_RESOURCE_TASK_READY", { exact: true })).toBeVisible({ timeout: 30_000 })
        // Task scope only: the workspace server connection stays enabled for the child selection.
        await sidebar.getByRole("button", { name: "Show MCP Servers", exact: true }).first().click()
        await setParentToggle(sidebar, RESOURCE_MCP, false)
        await sidebar.getByRole("button", { name: "Hide MCP Servers", exact: true }).first().click()
        await waitForParentMcpOff(dlineDocsDir, [internalName])

        enqueueDelegation(server)
        const echo = "E2E_WS126_REAL_MCP_RESOURCE_ECHO"
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_ws126_resource_load",
                name: "load_mcp",
                arguments: { name: `${internalName}.${RESOURCE_TOOL}` },
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: "call_ws126_resource_echo",
                name: "use_mcp_tool",
                arguments: { server_name: internalName, tool_name: RESOURCE_TOOL, arguments: JSON.stringify({ value: echo }) },
                expectedToolResults: [
                    { callId: "call_ws126_resource_load", contentIncludes: [internalName, RESOURCE_TOOL, "Input schema"] },
                ],
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: "call_ws126_resource_read",
                name: "access_mcp_resource",
                arguments: { server_name: internalName, uri: UPPER_URI },
                expectedToolResults: [{ callId: "call_ws126_resource_echo", contentIncludes: echo }],
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: "call_ws126_resource_unselected_tool",
                name: "use_mcp_tool",
                arguments: { server_name: internalName, tool_name: UNSELECTED_TOOL, arguments: JSON.stringify({}) },
                expectedToolResults: [{ callId: "call_ws126_resource_read", contentIncludes: UPPER_RESOURCE_BODY }],
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: "call_ws126_resource_lower",
                name: "access_mcp_resource",
                arguments: { server_name: internalName, uri: LOWER_URI },
                expectedToolResults: [{ callId: "call_ws126_resource_unselected_tool", contentIncludes: MCP_DENIED }],
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: "call_ws126_resource_child_done",
                name: "attempt_completion",
                arguments: { result: CHILD_DONE },
                expectedToolResults: [{ callId: "call_ws126_resource_lower", contentIncludes: MCP_DENIED }],
                requireCompleteToolPairing: true,
            },
        )
        await send(sidebar, "Now delegate the MCP tool and resource check, keeping the server off for the parent task.")
        await approveSubagent(sidebar)
        await expect(sidebar.getByText(PARENT_DONE, { exact: false }).last()).toBeVisible({ timeout: 30_000 })
        await expect(await showSubagentOutput(subagentCardByTask(sidebar, TASK))).toContainText(CHILD_DONE)
        const child = server.getMockConsumptions("openai-compatible-responses")
        expectRequests(child, 6)
        expectRequests(server.getMockConsumptions("openai-compatible-chat"), 3)
        const system = systemText(child[0])
        expect(system).toContain(`${internalName}.${RESOURCE_TOOL}`)
        expect(system).toContain(UPPER_URI)
        expect(system).not.toContain(LOWER_URI)
        expect(system).not.toContain(`${internalName}.${UNSELECTED_TOOL}`)
        expect(observedResult(child, "call_ws126_resource_echo")).toContain(echo)
        expect(observedResult(child, "call_ws126_resource_read")).toContain(UPPER_RESOURCE_BODY)
        expect(observedResult(child, "call_ws126_resource_read")).not.toContain(LOWER_RESOURCE_SECRET)
        expect(observedResult(child, "call_ws126_resource_unselected_tool")).toContain(MCP_DENIED)
        expect(observedResult(child, "call_ws126_resource_unselected_tool")).not.toContain(UNSELECTED_TOOL_SECRET)
        expect(observedResult(child, "call_ws126_resource_lower")).toContain(MCP_DENIED)
        expect(observedResult(child, "call_ws126_resource_lower")).not.toContain(LOWER_RESOURCE_SECRET)
        await waitForParentMcpOff(dlineDocsDir, [internalName])
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
    },
)

resourceE2e(
    "WS-126 - an exact resource-only selection needs access_mcp_resource and never the MCP tool loaders",
    async ({ helper, server, sidebar, userDataDir, workspaceDir }) => {
        await helper.signin(sidebar)
        await waitForMcpResources(sidebar)
        const configuration = await openConfiguration(sidebar)
        await tab(configuration, "MCP")
        const internalName = await resolveInternalServer(configuration)
        await choose(configuration, resourceLabel(internalName, UPPER_URI), true)
        // Resources require only access_mcp_resource, so removing both tool loaders keeps this choice valid.
        await tab(configuration, "Tools")
        await choose(configuration, "Use load_mcp", false)
        await choose(configuration, "Use use_mcp_tool", false)
        await expect(configuration.getByRole("checkbox", { name: "Use access_mcp_resource", exact: true })).toBeChecked()
        await expectSaveIdle(configuration)
        const saved = await expectSaved(workspaceDir, { mcp: [{ server: internalName, resources: [UPPER_URI] }] })
        expect(saved.data.mcp).toEqual([{ server: internalName, resources: [UPPER_URI] }])
        // The saved entry keeps the resource URI and does not carry a tools sub-block.
        expect(JSON.stringify(saved.data.mcp)).not.toContain("tools")
        await closeCapabilities(sidebar)

        server.resetOpenAiMock()
        enqueueDelegation(server)
        server.enqueueResponses(
            "openai-compatible-responses",
            {
                type: "tool",
                id: "call_ws126_uri_only_read",
                name: "access_mcp_resource",
                arguments: { server_name: internalName, uri: UPPER_URI },
                requireCompleteToolPairing: true,
            },
            {
                type: "tool",
                id: "call_ws126_uri_only_child_done",
                name: "attempt_completion",
                arguments: { result: CHILD_DONE },
                expectedToolResults: [{ callId: "call_ws126_uri_only_read", contentIncludes: UPPER_RESOURCE_BODY }],
                requireCompleteToolPairing: true,
            },
        )
        await send(sidebar, "Delegate the resource-only check without the MCP tool loaders.")
        await approveSubagent(sidebar)
        await expect(sidebar.getByText(PARENT_DONE, { exact: false }).last()).toBeVisible({ timeout: 30_000 })
        await expect(await showSubagentOutput(subagentCardByTask(sidebar, TASK))).toContainText(CHILD_DONE)
        const child = server.getMockConsumptions("openai-compatible-responses")
        expectRequests(child, 2)
        expectRequests(server.getMockConsumptions("openai-compatible-chat"), 2)
        expect(observedResult(child, "call_ws126_uri_only_read")).toContain(UPPER_RESOURCE_BODY)
        expect(observedResult(child, "call_ws126_uri_only_read")).not.toContain(LOWER_RESOURCE_SECRET)
        const nativeTools = (child[0].requestBody as { tools: { name: string }[] }).tools.map((tool) => tool.name)
        expect(nativeTools).toContain("access_mcp_resource")
        expect(nativeTools).not.toContain("load_mcp")
        expect(nativeTools).not.toContain("use_mcp_tool")
        const system = systemText(child[0])
        expect(system).toContain(UPPER_URI)
        expect(system).not.toContain(LOWER_URI)
        await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
    },
)
