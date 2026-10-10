import { expect, type Frame } from "@playwright/test"
import { E2E_PROFILE_NAMES } from "../utils/api-profile"
import { E2ETestHelper } from "../utils/helpers"
import { demo } from "./utils/demo-fixture"
import { dismissDemoNotifications, finalizeDemoPng } from "./utils/png-asset"

const TASK_TEXT = "Show a compact mathematical result and the verified agent workflow."
const COMPLETION_TEXT = "Rich preview ready."
const FORMULA = String.raw`\textcolor{teal}{\int_{0}^{\infty}} e^{-x^{2}}\,dx = \frac{\sqrt{\pi}}{2}`
const RICH_MARKDOWN = [
    "### Gaussian integral",
    "",
    "```latex",
    FORMULA,
    "```",
    "",
    "### Verified agent workflow",
    "",
    "```mermaid",
    "flowchart LR",
    "  Task[Task] --> Plan[Plan] --> Tools[Tools] --> Result[Verified result]",
    "```",
].join("\n")

async function selectProfile(sidebar: Frame, profileName: string): Promise<void> {
    const modelSwitcher = sidebar.getByRole("button", { name: "Select model" })
    if ((await modelSwitcher.innerText()).trim() === profileName) return

    await modelSwitcher.press("Enter")
    const profileOption = sidebar.getByRole("option").filter({ has: sidebar.getByText(profileName, { exact: true }) })
    await expect(profileOption).toHaveCount(1)
    await profileOption.press("Enter")
    await expect(modelSwitcher).toHaveText(profileName)
}

demo("R10", async ({ captureScreenshot, helper, page, server, sidebar, userDataDir }) => {
    demo.setTimeout(150_000)
    await helper.signin(sidebar)
    await selectProfile(sidebar, E2E_PROFILE_NAMES.mockOpenAiResponses)

    server.resetOpenAiMock()
    server.enqueueResponses(
        "openai-compatible-responses",
        {
            type: "message",
            text: RICH_MARKDOWN,
            expectedRequestIncludes: [TASK_TEXT],
        },
        {
            type: "tool",
            id: "call_r10_complete",
            name: "attempt_completion",
            arguments: { result: COMPLETION_TEXT },
        },
    )

    await dismissDemoNotifications(page)
    const input = sidebar.getByTestId("chat-input")
    await input.fill(TASK_TEXT)
    await sidebar.getByTestId("send-button").click()
    await expect(sidebar.getByText(COMPLETION_TEXT, { exact: false }).last()).toBeVisible({ timeout: 90_000 })
    await expect(sidebar.getByText("Start New Task", { exact: true })).toBeVisible({ timeout: 30_000 })

    const latexBlock = sidebar.getByTestId("latex-block").first()
    await expect(latexBlock).toBeVisible({ timeout: 30_000 })
    await expect(latexBlock).toHaveAttribute("aria-label", FORMULA)
    const latexSvg = latexBlock.locator("svg").first()
    await expect(latexSvg).toBeVisible()
    expect(await latexSvg.locator("path").count()).toBeGreaterThan(0)

    const mermaidSvg = sidebar.locator('svg[id^="mermaid-"]').first()
    await expect(mermaidSvg).toBeVisible({ timeout: 30_000 })
    const mermaidBox = await mermaidSvg.boundingBox()
    expect(mermaidBox?.width ?? 0).toBeGreaterThan(0)
    expect(mermaidBox?.height ?? 0).toBeGreaterThan(0)
    await expect(sidebar.getByRole("button", { name: "Copy Code", exact: true })).toBeVisible()
    await expect(sidebar.getByText("Generating mermaid diagram...", { exact: true })).toHaveCount(0)
    await latexBlock.scrollIntoViewIfNeeded()
    await expect(mermaidSvg).toBeVisible()

    await dismissDemoNotifications(page)
    const screenshotPath = await captureScreenshot("r10-rich-rendering")
    const asset = await finalizeDemoPng(screenshotPath)
    expect(asset.width).toBe(1_200)
    expect(asset.bytes).toBeLessThanOrEqual(500_000)

    const consumptions = server.getMockConsumptions("openai-compatible-responses")
    expect(consumptions.map(({ responseType, toolName }) => [responseType, toolName])).toEqual([
        ["message", undefined],
        ["tool", "attempt_completion"],
    ])
    expect(consumptions.every(({ contractError }) => contractError === undefined)).toBe(true)
    await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [/Error fetching OpenRouter models/])
})
