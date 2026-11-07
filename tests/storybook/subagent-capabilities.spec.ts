import { expect, type Page, test } from "@playwright/test"

const STORY = "capabilities-subagent-selection-preview"

async function openStory(page: Page, name: string, theme = "vs_dark") {
    await page.goto(`/iframe.html?id=${STORY}--${name}&viewMode=story&globals=theme:${theme}`)
    await expect(page.getByTestId("subagent-capabilities-preview")).toBeVisible()
}

async function tab(page: Page, name: string) {
    await page.getByRole("tab", { name: new RegExp(`^${name}`) }).click()
}

test("skills and workflows require their loaders and retain inactive choices", async ({ page }) => {
    await openStory(page, "missing-loaders")
    const skill = page.getByRole("checkbox", { name: "Use use-vitest", exact: true })
    await expect(skill).toBeDisabled()
    await expect(skill).toBeChecked()
    await expect(page.getByLabel("Active skills", { exact: true })).toHaveText("0")
    await page.getByRole("button", { name: "Enable load_skill", exact: true }).click()
    await expect(skill).toBeEnabled()
    await expect(page.getByLabel("Active skills", { exact: true })).toHaveText("1")
    await page.getByRole("checkbox", { name: "Use using-shared-network", exact: true }).check()
    await expect(page.getByLabel("Active skills", { exact: true })).toHaveText("2")

    await tab(page, "Workflows")
    const workflow = page.getByRole("checkbox", { name: "Use e2e-validation", exact: true })
    await expect(workflow).toBeDisabled()
    await page.getByRole("button", { name: "Enable load_workflow", exact: true }).click()
    await expect(workflow).toBeEnabled()
    await page.getByRole("checkbox", { name: "Use pr-review", exact: true }).check()
    await expect(page.getByLabel("Active workflows", { exact: true })).toHaveText("2")

    await tab(page, "Tools")
    await page.getByRole("checkbox", { name: "load_skill", exact: true }).uncheck()
    await expect(page.getByRole("checkbox", { name: /attempt_completion/ })).toBeDisabled()
    await tab(page, "Skills")
    await expect(skill).toBeChecked()
    await expect(skill).toBeDisabled()
    await expect(page.getByLabel("Active skills", { exact: true })).toHaveText("0")
    await expect(page.getByLabel("Active workflows", { exact: true })).toHaveText("2")
    await page.getByRole("button", { name: "Enable load_skill", exact: true }).click()
    await expect(page.getByLabel("Active skills", { exact: true })).toHaveText("2")
    await page.getByRole("searchbox", { name: "Search Skills" }).fill("no-such-skill")
    await expect(skill).toHaveCount(0)
    await expect(page.getByLabel("Active skills", { exact: true })).toHaveText("2")
    await page.getByRole("button", { name: "Reset preview" }).click()
    await expect(skill).toBeDisabled()
    await expect(skill).toBeChecked()
    await expect(page.getByLabel("Active workflows", { exact: true })).toHaveText("0")
})

test("rules compose the child system prompt independently from loader tools", async ({ page }) => {
    await openStory(page, "rules")
    const review = page.getByRole("checkbox", { name: "Use review-guidelines.md", exact: true })
    const evidence = page.getByRole("checkbox", { name: "Use test-evidence.md", exact: true })
    const system = page.getByRole("region", { name: "Subagent system prompt preview", exact: true })
    await expect(review).toBeEnabled()
    await expect(review).toBeChecked()
    await expect(system).toContainText("Explain each finding with a concrete input, observable effect and relevant file path.")
    await expect(system).not.toContainText("Run focused checks for every changed behavior.")
    await evidence.check()
    await expect(page.getByLabel("Injected rules", { exact: true })).toHaveText("2")
    await expect(system).toContainText("Run focused checks for every changed behavior. State which checks were not run.")
    await review.uncheck()
    await expect(system).not.toContainText("Explain each finding")
    await expect(system).toContainText("Run focused checks for every changed behavior.")
    await tab(page, "Skills")
    await expect(page.getByRole("checkbox", { name: "Use use-vitest", exact: true })).toBeDisabled()
    await expect(page.getByLabel("Injected rules", { exact: true })).toHaveText("1")
    await tab(page, "Rules")
    await expect(evidence).toBeEnabled()
    await expect(evidence).toBeChecked()
    await evidence.uncheck()
    await expect(system).not.toContainText("# Rule:")
    await expect(system).toContainText("You are reviewer, a code review subagent.")
})

test("MCP tool and resource selections have independent prerequisites", async ({ page }) => {
    await openStory(page, "mcp-selection")
    const search = page.getByRole("checkbox", { name: "Use search_issues", exact: true })
    const resource = page.getByRole("checkbox", { name: "Use repository://instructions", exact: true })
    await expect(search).toBeDisabled()
    await expect(resource).toBeEnabled()
    await resource.check()
    await expect(page.getByLabel("Active MCP items", { exact: true })).toHaveText("1")
    await page.getByRole("button", { name: "Enable load_mcp", exact: true }).click()
    await expect(search).toBeDisabled()
    await page.getByRole("button", { name: "Enable use_mcp_tool", exact: true }).click()
    await expect(search).toBeEnabled()
    await expect(search).toBeChecked()
    await expect(page.getByLabel("Active MCP items", { exact: true })).toHaveText("2")
    await page.getByRole("checkbox", { name: "Use get_pull_request", exact: true }).check()
    await expect(page.getByRole("checkbox", { name: "Use query", exact: true })).toBeDisabled()
    await tab(page, "Tools")
    await page.getByRole("checkbox", { name: "access_mcp_resource", exact: true }).uncheck()
    await tab(page, "MCP")
    await expect(resource).toBeDisabled()
    await expect(resource).toBeChecked()
    await expect(search).toBeEnabled()
    await expect(page.getByLabel("Active MCP items", { exact: true })).toHaveText("2")
    await page.getByRole("button", { name: "Enable access_mcp_resource", exact: true }).click()
    await expect(page.getByLabel("Active MCP items", { exact: true })).toHaveText("3")
})

test("empty catalogs expose no selectable resources and tabs support keyboard navigation", async ({ page }) => {
    await openStory(page, "empty-catalog")
    await expect(page.getByTestId("capability-catalog").getByRole("checkbox")).toHaveCount(0)
    await expect(page.getByLabel("Active skills", { exact: true })).toHaveText("0")
    const skills = page.getByRole("tab", { name: /^Skills/ })
    await skills.focus()
    await skills.press("ArrowRight")
    await expect(page.getByRole("tab", { name: /^Workflows/ })).toBeFocused()
    await expect(page.getByRole("tab", { name: /^Workflows/ })).toHaveAttribute("aria-selected", "true")
    await page.getByRole("tab", { name: /^Workflows/ }).press("End")
    await expect(page.getByRole("tab", { name: /^MCP/ })).toBeFocused()
    await expect(page.getByTestId("capability-catalog").getByRole("checkbox")).toHaveCount(0)
})

for (const theme of ["vs_dark", "vs_light"]) {
    test(`narrow ${theme} preview renders without horizontal overflow or runtime errors`, async ({ page }) => {
        const errors: string[] = []
        page.on("pageerror", (error) => errors.push(error.message))
        await page.setViewportSize({ width: 390, height: 850 })
        await openStory(page, "narrow", theme)
        const preview = page.getByTestId("subagent-capabilities-preview")
        const catalog = page.getByTestId("capability-catalog")
        await expect.poll(() => preview.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
        await expect.poll(() => catalog.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
        await expect(page.getByRole("checkbox", { name: "Use search_issues", exact: true })).toBeEnabled()
        expect(errors).toEqual([])
        await test.info().attach(`subagent-capabilities-${theme}`, { body: await page.screenshot(), contentType: "image/png" })
    })
}

// ---------------------------------------------------------------------------
// Production editor
//
// The ProductionEditor story mounts the shipped SubagentRow against the
// in-memory fixture (storybook/SubagentRowStoryFixture.tsx). Every case starts
// with its own navigation so no fixture RPC state can leak between cases, and
// every expectation is derived from the fixture's documented input state and
// the real RPC patch the editor should produce for it.
// ---------------------------------------------------------------------------

interface RuleRef {
    scope: string
    path: string
}

interface McpRef {
    server: string
    tools: string[]
    resources: string[]
}

interface PatchView {
    subagentPath: string
    tools: string[]
    skills: string[]
    workflows: string[]
    rules: RuleRef[]
    mcp: McpRef[]
    profile: string | null
    replaceTools: boolean
    replaceSkills: boolean
    replaceWorkflows: boolean
    replaceRules: boolean
    replaceMcp: boolean
}

interface StoredAgentView {
    name: string
    path: string
    enabled: boolean
    tools: string[]
    skills: string[]
    workflows: string[]
    rules: RuleRef[]
    mcp: McpRef[]
    profile: string | null
}

interface FixtureSnapshot {
    patches: PatchView[]
    stored?: StoredAgentView
}

const FIXTURE_KEY = "__SUBAGENT_ROW_FIXTURE__"
const PRODUCTION_STORY = `${STORY}--production-editor`
const AGENT_NAME = "reviewer"
const AGENT_PATH = "/workspace/.agents/subagents/reviewer.yml"
// The fixture's stored reviewer, restated here so each expected patch is built
// from the input instead of from whatever the mock happens to return.
const AGENT_TOOLS = ["read_file", "search_files", "load_mcp", "use_mcp_tool"]
const AGENT_SKILLS = ["use-vitest", "gone"]
const AGENT_WORKFLOWS = ["e2e-validation"]
const AGENT_RULES: RuleRef[] = [{ scope: "workspace", path: "review.md" }]
const AGENT_MCP: McpRef[] = []
const REVIEW_RULE: RuleRef = { scope: "workspace", path: "review.md" }
const REQUIRED_RULE: RuleRef = { scope: "remote", path: "policy.md" }
const MCP_SERVER = "docs@ws"
const MCP_TOOL = "query"
const MCP_RESOURCE = "repository://instructions"

const addValue = (values: string[], value: string) => [...new Set([...values, value])]
const dropValue = (values: string[], value: string) => values.filter((item) => item !== value)

/** A field-only patch: untouched fields stay empty and their replace flag stays false. */
const patchWith = (overrides: Partial<PatchView> = {}): PatchView => ({
    subagentPath: AGENT_PATH,
    tools: [],
    skills: [],
    workflows: [],
    rules: [],
    mcp: [],
    profile: null,
    replaceTools: false,
    replaceSkills: false,
    replaceWorkflows: false,
    replaceRules: false,
    replaceMcp: false,
    ...overrides,
})

const configureButton = (page: Page) => page.getByRole("button", { name: `Configure subagent ${AGENT_NAME}`, exact: true })

async function openProduction(page: Page, theme = "vs_dark") {
    await page.goto(`/iframe.html?id=${PRODUCTION_STORY}&viewMode=story&globals=theme:${theme}`)
    await expect(page.getByTestId("subagent-row-fixture")).toBeVisible()
    await expect(configureButton(page)).toHaveAttribute("aria-expanded", "false")
}

async function expandEditor(page: Page) {
    await configureButton(page).click()
    await expect(configureButton(page)).toHaveAttribute("aria-expanded", "true")
    await expect(page.getByRole("region", { name: `${AGENT_NAME} configuration`, exact: true })).toBeVisible()
}

// The save status lives beside the editor, not inside its section.
const saveStatus = (page: Page) => page.getByRole("status", { name: "Subagent configuration save status", exact: true })

function readFixture(page: Page): Promise<FixtureSnapshot> {
    // The root TS project does not include the webview's window augmentation, so
    // the fixture bridge is narrowed locally inside the page context instead of
    // relying on the global declaration from SubagentRowStoryFixture.tsx.
    return page.evaluate((key) => {
        const scoped = window as Window & Record<string, unknown>
        const bridge = scoped[key] as
            | {
                  getPatches: () => PatchView[]
                  getStoredAgent: () => StoredAgentView | undefined
              }
            | undefined
        if (!bridge) throw new Error("SubagentRow story fixture bridge is not installed")
        return { patches: bridge.getPatches(), stored: bridge.getStoredAgent() }
    }, FIXTURE_KEY)
}

async function readPatches(page: Page): Promise<PatchView[]> {
    return (await readFixture(page)).patches
}

async function readStoredAgent(page: Page): Promise<StoredAgentView | undefined> {
    return (await readFixture(page)).stored
}

async function expectPatches(page: Page, expected: PatchView[]) {
    await expect
        .poll(async () => (await readPatches(page)).length, { message: `expected ${expected.length} saved patch(es)` })
        .toBe(expected.length)
    expect(await readPatches(page)).toEqual(expected)
}

test("production editor: rules need no loader while the required remote policy stays locked", async ({ page }) => {
    await openProduction(page)
    await expandEditor(page)
    await expect(saveStatus(page)).toHaveText("No unsaved changes.")

    await tab(page, "Rules")
    const review = page.getByRole("checkbox", { name: "Use rule workspace/review.md", exact: true })
    const policy = page.getByRole("checkbox", { name: "Use rule remote/policy.md", exact: true })
    await expect(review).toBeChecked()
    await expect(review).toBeEnabled()
    // Required rules are rendered in their own group, always checked, never editable.
    const required = page.getByRole("region", { name: "Required Rules", exact: true })
    await expect(required.getByRole("checkbox", { name: "Use rule remote/policy.md", exact: true })).toBeChecked()
    await expect(required.getByRole("checkbox", { name: "Use rule remote/policy.md", exact: true })).toBeDisabled()
    await expect(policy).toBeDisabled()
    // Rules are injected directly into the system prompt, so no loader is needed.
    await expect(page.getByRole("note")).toHaveCount(0)
    await expect(page.getByLabel("Active rules", { exact: true })).toHaveText("1")
    await expectPatches(page, [])

    // Toggling is possible without enabling any loader tool.
    await review.uncheck()
    const clearedRules = AGENT_RULES.filter((rule) => rule.path !== REVIEW_RULE.path)
    await expectPatches(page, [patchWith({ rules: clearedRules, replaceRules: true })])
    await expect(saveStatus(page)).toHaveText("Subagent configuration saved.")
    await expect(page.getByLabel("Active rules", { exact: true })).toHaveText("0")
    // The required remote policy is never persisted as an ordinary selection.
    const stored = await readStoredAgent(page)
    expect(stored?.rules).toEqual([])
    expect(stored?.rules).not.toContainEqual(REQUIRED_RULE)
    expect(stored?.tools).toEqual(AGENT_TOOLS)
})

test("production editor: skills follow load_skill and stale selections are removed explicitly", async ({ page }) => {
    await openProduction(page)
    await expandEditor(page)
    await tab(page, "Skills")

    const vitest = page.getByRole("checkbox", { name: "Use skill use-vitest", exact: true })
    const gone = page.getByRole("checkbox", { name: "Use skill gone", exact: true })
    // Saved skills stay selected but inactive until their loader exists.
    await expect(vitest).toBeChecked()
    await expect(vitest).toBeDisabled()
    await expect(gone).toBeChecked()
    await expect(gone).toBeDisabled()
    await expect(page.getByRole("note")).toHaveCount(1)
    await expect(page.getByRole("button", { name: "Enable load_skill", exact: true })).toBeVisible()
    await expect(page.getByLabel("Active skills", { exact: true })).toHaveText("0")

    await tab(page, "Tools")
    await page.getByRole("checkbox", { name: "Use load_skill", exact: true }).check()
    await expectPatches(page, [patchWith({ tools: addValue(AGENT_TOOLS, "load_skill"), replaceTools: true })])

    await tab(page, "Skills")
    await expect(page.getByRole("note")).toHaveCount(0)
    await expect(vitest).toBeEnabled()
    await expect(vitest).toBeChecked()
    await expect(page.getByLabel("Active skills", { exact: true })).toHaveText("1")
    // The disappeared skill is still not usable even with its loader enabled.
    await expect(gone).toBeDisabled()
    await expect(page.getByLabel("Active skills", { exact: true })).toHaveText("1")

    await page.getByRole("checkbox", { name: "Use skill review-checklist", exact: true }).check()
    await expectPatches(page, [
        patchWith({ tools: addValue(AGENT_TOOLS, "load_skill"), replaceTools: true }),
        patchWith({ skills: addValue(AGENT_SKILLS, "review-checklist"), replaceSkills: true }),
    ])
    await expect(page.getByLabel("Active skills", { exact: true })).toHaveText("2")

    // A stale selection is only dropped by the explicit remove control.
    await page.getByRole("button", { name: "Remove unavailable selection: Use skill gone", exact: true }).click()
    const keptSkills = [...AGENT_SKILLS.filter((skill) => skill !== "gone"), "review-checklist"]
    await expectPatches(page, [
        patchWith({ tools: addValue(AGENT_TOOLS, "load_skill"), replaceTools: true }),
        patchWith({ skills: addValue(AGENT_SKILLS, "review-checklist"), replaceSkills: true }),
        patchWith({ skills: keptSkills, replaceSkills: true }),
    ])
    await expect(page.getByLabel("Active skills", { exact: true })).toHaveText("2")
    const stored = await readStoredAgent(page)
    expect(stored?.skills).toEqual(keptSkills)
    expect(stored?.workflows).toEqual(AGENT_WORKFLOWS)
})

test("production editor: MCP tools and resources have independent prerequisites", async ({ page }) => {
    await openProduction(page)
    await expandEditor(page)
    await tab(page, "MCP")

    const tool = page.getByRole("checkbox", { name: `Use MCP tool ${MCP_SERVER}/${MCP_TOOL}`, exact: true })
    const resource = page.getByRole("checkbox", { name: `Use MCP resource ${MCP_SERVER}/${MCP_RESOURCE}`, exact: true })
    // load_mcp + use_mcp_tool exist, access_mcp_resource does not.
    await expect(tool).toBeEnabled()
    await expect(tool).not.toBeChecked()
    await expect(resource).toBeDisabled()
    await expect(resource).not.toBeChecked()

    await tool.check()
    const withTool: McpRef[] = [{ server: MCP_SERVER, tools: [MCP_TOOL], resources: [] }]
    await expectPatches(page, [patchWith({ mcp: withTool, replaceMcp: true })])

    await tab(page, "Tools")
    await page.getByRole("checkbox", { name: "Use load_mcp", exact: true }).uncheck()
    const withoutLoad = dropValue(AGENT_TOOLS, "load_mcp")
    await page.getByRole("checkbox", { name: "Use use_mcp_tool", exact: true }).uncheck()
    const withoutUse = dropValue(withoutLoad, "use_mcp_tool")
    await page.getByRole("checkbox", { name: "Use access_mcp_resource", exact: true }).check()
    const withAccess = addValue(withoutUse, "access_mcp_resource")
    await expectPatches(page, [
        patchWith({ mcp: withTool, replaceMcp: true }),
        patchWith({ tools: withoutLoad, replaceTools: true }),
        patchWith({ tools: withoutUse, replaceTools: true }),
        patchWith({ tools: withAccess, replaceTools: true }),
    ])

    await tab(page, "MCP")
    await expect(tool).toBeDisabled()
    // Selection is retained even while its prerequisites are gone.
    await expect(tool).toBeChecked()
    await expect(resource).toBeEnabled()
    await expect(page.getByLabel("Active MCP items", { exact: true })).toHaveText("0")

    await resource.check()
    const exact: McpRef[] = [{ server: MCP_SERVER, tools: [MCP_TOOL], resources: [MCP_RESOURCE] }]
    await expectPatches(page, [
        patchWith({ mcp: withTool, replaceMcp: true }),
        patchWith({ tools: withoutLoad, replaceTools: true }),
        patchWith({ tools: withoutUse, replaceTools: true }),
        patchWith({ tools: withAccess, replaceTools: true }),
        patchWith({ mcp: exact, replaceMcp: true }),
    ])
    await expect(page.getByLabel("Active MCP items", { exact: true })).toHaveText("1")
    const stored = await readStoredAgent(page)
    expect(stored?.mcp).toEqual(exact)
})

test("production editor: a held save flushes queued field patches without overwriting", async ({ page }) => {
    await openProduction(page)
    await expandEditor(page)
    const status = saveStatus(page)
    await page.getByRole("button", { name: "Hold next save", exact: true }).click()

    await tab(page, "Rules")
    await page.getByRole("checkbox", { name: "Use rule workspace/review.md", exact: true }).uncheck()
    await expect(status).toHaveText("Saving subagent configuration...")
    // Queue edits in other categories while the first write is still unacknowledged.
    await tab(page, "Tools")
    await page.getByRole("checkbox", { name: "Use load_skill", exact: true }).check()
    await page.getByRole("combobox", { name: "Profile", exact: true }).selectOption("review-profile")
    await tab(page, "Skills")
    await page.getByRole("checkbox", { name: "Use skill review-checklist", exact: true }).check()
    await expect(status).toHaveText("Saving subagent configuration...")
    await expectPatches(page, [])

    await page.getByRole("button", { name: "Release held save", exact: true }).click()
    await expectPatches(page, [
        patchWith({ rules: [], replaceRules: true }),
        patchWith({ tools: addValue(AGENT_TOOLS, "load_skill"), replaceTools: true }),
        patchWith({ profile: "review-profile" }),
        patchWith({ skills: addValue(AGENT_SKILLS, "review-checklist"), replaceSkills: true }),
    ])
    await expect(status).toHaveText("Subagent configuration saved.")
    const stored = await readStoredAgent(page)
    expect(stored?.rules).toEqual([])
    expect(stored?.tools).toEqual(addValue(AGENT_TOOLS, "load_skill"))
    expect(stored?.skills).toEqual(addValue(AGENT_SKILLS, "review-checklist"))
    expect(stored?.profile).toBe("review-profile")
    expect(stored?.workflows).toEqual(AGENT_WORKFLOWS)
    expect(stored?.mcp).toEqual(AGENT_MCP)
})

test("production editor: a failed save rolls back and later fields still save", async ({ page }) => {
    await openProduction(page)
    await expandEditor(page)
    const status = saveStatus(page)
    await tab(page, "Rules")
    const review = page.getByRole("checkbox", { name: "Use rule workspace/review.md", exact: true })

    await page.getByRole("button", { name: "Fail next save", exact: true }).click()
    await review.click()
    await expect(status).toHaveText("Some changes were not saved.")
    await expect(page.getByRole("alert")).toContainText("Could not save rules: Simulated save failure (story control)")
    // The rejected edit is rolled back to the acknowledged value and never stored.
    await expect(review).toBeChecked()
    await expect(page.getByLabel("Active rules", { exact: true })).toHaveText("1")
    await expectPatches(page, [])
    expect((await readStoredAgent(page))?.rules).toEqual(AGENT_RULES)

    await tab(page, "Tools")
    await page.getByRole("checkbox", { name: "Use load_skill", exact: true }).check()
    await expectPatches(page, [patchWith({ tools: addValue(AGENT_TOOLS, "load_skill"), replaceTools: true })])
    await expect(status).toHaveText("Subagent configuration saved.")
    await expect(page.getByRole("alert")).toHaveCount(0)
    const stored = await readStoredAgent(page)
    expect(stored?.rules).toEqual(AGENT_RULES)
    expect(stored?.tools).toEqual(addValue(AGENT_TOOLS, "load_skill"))
})

test("production editor: cleared selections stay empty after reopening the editor", async ({ page }) => {
    await openProduction(page)
    await expandEditor(page)
    await tab(page, "Rules")
    const review = page.getByRole("checkbox", { name: "Use rule workspace/review.md", exact: true })
    await review.uncheck()
    await expectPatches(page, [patchWith({ rules: [], replaceRules: true })])
    await expect(saveStatus(page)).toHaveText("Subagent configuration saved.")

    await page.getByRole("button", { name: "Reopen editor", exact: true }).click()
    await expect(configureButton(page)).toHaveAttribute("aria-expanded", "false")
    await expandEditor(page)
    await tab(page, "Rules")
    // The remounted editor reads the stored agent: the clear is not undone.
    await expect(review).not.toBeChecked()
    await expect(page.getByLabel("Active rules", { exact: true })).toHaveText("0")
    // The required remote policy is unaffected by the clear and stays checked.
    await expect(page.getByRole("checkbox", { name: "Use rule remote/policy.md", exact: true })).toBeChecked()
    // Reopening is a read, never another write.
    await expectPatches(page, [patchWith({ rules: [], replaceRules: true })])
    expect((await readStoredAgent(page))?.rules).toEqual([])
})

for (const theme of ["vs_dark", "vs_light"]) {
    test(`production editor: ${theme} at 390px has no horizontal overflow or runtime errors`, async ({ page }) => {
        const errors: string[] = []
        page.on("pageerror", (error) => errors.push(error.message))
        await page.setViewportSize({ width: 390, height: 900 })
        await openProduction(page, theme)
        await expandEditor(page)
        await tab(page, "MCP")
        await expect(page.getByRole("checkbox", { name: `Use MCP tool ${MCP_SERVER}/${MCP_TOOL}`, exact: true })).toBeEnabled()
        const fixture = page.getByTestId("subagent-row-fixture")
        const section = page.getByRole("region", { name: `${AGENT_NAME} configuration`, exact: true })
        await expect.poll(() => fixture.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
        await expect.poll(() => section.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true)
        expect(errors).toEqual([])
        await test.info().attach(`subagent-row-production-${theme}.json`, {
            body: JSON.stringify(
                await fixture.evaluate((element) => ({
                    clientWidth: element.clientWidth,
                    scrollWidth: element.scrollWidth,
                })),
                null,
                2,
            ),
            contentType: "application/json",
        })
        await test.info().attach(`subagent-row-production-${theme}`, {
            body: await page.screenshot({ fullPage: true }),
            contentType: "image/png",
        })
    })
}
