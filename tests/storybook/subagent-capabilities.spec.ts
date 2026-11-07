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
