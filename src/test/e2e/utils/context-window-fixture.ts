import { readdir } from "node:fs/promises"
import * as path from "node:path"
import type { MockApiConsumption } from "@e2e/fixtures/server"
import { expectComposerText } from "@e2e/utils/composer"
import { E2ETestHelper } from "@e2e/utils/helpers"
import { expect, type Frame, type Locator, type TestInfo } from "@playwright/test"
import type { ElectronApplication } from "playwright"

export const COMPACT_SIGNAL = "__dline_mode_switch_compact__"
export const COMPACT_INSTRUCTION_MARKER = "The current conversation is rapidly running out of context"
export const INTERNAL_MODE_RESPONSE = "PLAN_MODE_TOGGLE_RESPONSE"

export async function openSidebar(
    app: ElectronApplication,
    helper: E2ETestHelper,
): Promise<{ page: Awaited<ReturnType<ElectronApplication["firstWindow"]>>; sidebar: Frame }> {
    const page = await app.firstWindow()
    await E2ETestHelper.openClineSidebar(page)
    const sidebar = await helper.getSidebar(page)
    await E2ETestHelper.dismissWhatsNewModal(sidebar)
    await helper.signin(sidebar)
    return { page, sidebar }
}

export async function sendTask(sidebar: Frame, text: string, readinessTimeout = 60_000): Promise<void> {
    const input = sidebar.getByTestId("chat-input")
    await expect(input).toBeEnabled({ timeout: readinessTimeout })
    await input.fill(text)
    await expect(sidebar.getByTestId("send-button")).toHaveAttribute("data-action", /^(?:send|resume|queue)$/, {
        timeout: readinessTimeout,
    })
    await input.press("Enter")
    await expectComposerText(input, "")
    await expect(sidebar.getByText(text, { exact: true }).last()).toBeVisible()
}

export function requestToolNames(consumption: MockApiConsumption): string[] {
    const body = consumption.requestBody as {
        tools?: Array<{ name?: string; function?: { name?: string } }>
    }
    return (body.tools ?? [])
        .map((tool) => tool.name ?? tool.function?.name)
        .filter((name): name is string => typeof name === "string")
}

export async function expectNoInternalCompactionEcho(sidebar: Frame): Promise<void> {
    const visibleText = await sidebar.locator("body").innerText()
    expect(visibleText).not.toContain(COMPACT_SIGNAL)
    expect(visibleText).not.toContain(INTERNAL_MODE_RESPONSE)
    expect(visibleText).not.toContain("The current conversation is rapidly running out of context")
}

export async function expectCompactionSummary(sidebar: Frame, summary: string): Promise<void> {
    await expect(sidebar.getByText(summary, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
    await expectNoInternalCompactionEcho(sidebar)
}

const CONTEXT_WINDOW_SEGMENT_ORDER = ["durable", "active", "staged", "environment"] as const
const CONTEXT_WINDOW_SEGMENT_COLORS = [
    "var(--vscode-charts-green, #3fb950)",
    "var(--vscode-charts-blue, #58a6ff)",
    "var(--vscode-charts-orange, #d18616)",
    "var(--vscode-charts-purple, #bc8cff)",
] as const

export async function expandTaskHeader(sidebar: Frame): Promise<void> {
    const expandTaskHeader = sidebar.getByLabel("Expand task header")
    if (await expandTaskHeader.isVisible()) await expandTaskHeader.click()
    await expect(sidebar.getByTestId("context-window-indicator")).toBeVisible({ timeout: 60_000 })
}

export async function readContextWindowVisual(sidebar: Frame) {
    return sidebar.getByTestId("context-window-segmented-progress").evaluate((progress) => {
        const progressElement = progress as HTMLElement
        return {
            contextWindow: Number(progressElement.dataset.contextWindow ?? 0),
            epoch: Number(progressElement.dataset.epoch ?? 0),
            minorFactor: Number(progressElement.dataset.minorFactor ?? 1),
            mode: progressElement.dataset.mode,
            motion: progressElement.dataset.motion,
            phase: progressElement.dataset.phase,
            profileName: progressElement.dataset.profileName,
            revision: Number(progressElement.dataset.revision ?? 0),
            segments: Array.from(progressElement.querySelectorAll<HTMLElement>("[data-segment]")).map((segment) => ({
                active: segment.dataset.active,
                label: segment.getAttribute("aria-label")?.split(":", 1)[0],
                authoritativeTokens: Number(segment.dataset.authoritativeTokens ?? 0),
                computedColor: getComputedStyle(segment).backgroundColor,
                inlineColor: segment.style.backgroundColor,
                inlineWidth: segment.style.width,
                kind: segment.dataset.segment,
                tokens: Number(segment.dataset.tokens ?? 0),
                transitionSource: segment.dataset.transitionSource,
            })),
        }
    })
}

export function expectFourContextSegments(visual: Awaited<ReturnType<typeof readContextWindowVisual>>): void {
    expect(visual.segments.map((segment) => segment.kind)).toEqual(CONTEXT_WINDOW_SEGMENT_ORDER)
    const expectedColors: string[] = [...CONTEXT_WINDOW_SEGMENT_COLORS]
    if (visual.segments[1]?.label === "Receiving") {
        expectedColors[1] = "var(--vscode-charts-yellow, #d29922)"
    }
    expect(visual.segments.map((segment) => segment.inlineColor)).toEqual(expectedColors)
    expect(new Set(visual.segments.map((segment) => segment.computedColor)).size).toBe(4)
    expect(visual.segments.at(-1)?.kind).toBe("environment")
}

export function expectContextVisualAllocation(visual: Awaited<ReturnType<typeof readContextWindowVisual>>): void {
    expect(visual.minorFactor).toBeGreaterThanOrEqual(1)
    expect(visual.minorFactor).toBeLessThanOrEqual(3)
    const widths = visual.segments.map((segment) => Number.parseFloat(segment.inlineWidth || "0"))
    expect(widths.reduce((total, width) => total + width, 0)).toBeLessThanOrEqual(100.000_001)
    const authoritativeTotal = visual.segments.reduce((total, segment) => total + segment.authoritativeTokens, 0)
    const displayTotal = visual.segments.reduce((total, segment) => total + segment.tokens, 0)
    const denominator = Math.max(visual.contextWindow, authoritativeTotal, displayTotal)
    for (const segment of visual.segments.slice(1)) {
        const expectedWidth = denominator > 0 ? (segment.tokens * visual.minorFactor * 100) / denominator : 0
        expect(Number.parseFloat(segment.inlineWidth || "0")).toBeCloseTo(expectedWidth, 4)
    }
}

export async function captureLocatorEvidence(locator: Locator, testInfo: TestInfo, name: string): Promise<void> {
    await expect(locator).toBeVisible({ timeout: 60_000 })
    const screenshotPath = testInfo.outputPath(`${name}.png`)
    await locator.screenshot({ path: screenshotPath })
    await testInfo.attach(name, { path: screenshotPath, contentType: "image/png" })
}

export async function captureContextWindowEvidence(sidebar: Frame, testInfo: TestInfo, name: string): Promise<void> {
    await captureLocatorEvidence(sidebar.getByTestId("context-window-indicator"), testInfo, name)
}

export async function taskDirectoryIds(dlineDocsDir: string): Promise<string[]> {
    try {
        return (await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true }))
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
        throw error
    }
}
