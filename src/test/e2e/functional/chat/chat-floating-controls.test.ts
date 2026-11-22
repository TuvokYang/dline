import { readdir } from "node:fs/promises"
import path from "node:path"
import { expectComposerText } from "@e2e/utils/composer"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { rewriteTaskUiMessages, waitForTaskRelease } from "@e2e/utils/task-instance-store"
import { trajectoryRail } from "@e2e/utils/trajectory-rail"
import { expect, type Frame, type Locator, type Page, type TestInfo } from "@playwright/test"
import type { UiMessage } from "@shared/ExtensionMessage"

const TASK = "E2E_FLOATING_CONTROLS"
const TURN_COUNT = 40
const prompt = (index: number) => (index === 0 ? TASK : `E2E_FLOATING_TURN_${index}`)

/** Enough real persisted turns to require internal rail scrolling in a short window; no history paging is needed. */
function transcript(base: number): UiMessage[] {
    return Array.from({ length: TURN_COUNT }, (_, index): UiMessage[] => {
        const ts = base + index * 10
        return [
            { ts, type: "say", say: index === 0 ? "task" : "user_feedback", text: prompt(index) },
            { ts: ts + 1, type: "say", say: "api_req_started", text: JSON.stringify({ request: "fixture", cost: 0.01 }) },
            { ts: ts + 2, type: "ask", ask: "command", text: `echo turn-${index}`, commandStatus: "completed", exitCode: 0 },
            { ts: ts + 3, type: "say", say: "text", text: `FLOATING_REPLY_${index}` },
            { ts: ts + 4, type: "ask", ask: "completion_result", text: `FLOATING_DONE_${index}` },
        ]
    }).flat()
}

interface FloatingChat {
    page: Page
    sidebar: Frame
    base: number
    requestCount: () => number
}

const floatingE2e = e2e.extend<{ chat: FloatingChat }>({
    chat: async ({ dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }, use, testInfo) => {
        server.resetOpenAiMock()
        server.enqueueOpenAiResponses({ type: "tool", name: "attempt_completion", arguments: { result: "FLOATING_SEED_DONE" } })
        const app = await openVSCode(workspaceDir, { DLINE_EXPERIMENTAL_AGGRESSIVE_RENDERING: "true" })
        const page = await app.firstWindow()
        try {
            await page.setViewportSize({ width: 1200, height: 900 })
            await E2ETestHelper.openClineSidebar(page)
            const sidebar = await helper.getSidebar(page)
            await E2ETestHelper.dismissWhatsNewModal(sidebar)
            await helper.signin(sidebar)
            const input = sidebar.getByTestId("chat-input")
            await input.fill(TASK)
            await input.press("Enter")
            await expectComposerText(input, "")
            await expect(sidebar.getByText("FLOATING_SEED_DONE", { exact: false }).last()).toBeVisible()
            const taskId = await E2ETestHelper.waitForValue(async () => {
                const entries = await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true })
                return entries.find((entry) => entry.isDirectory())?.name
            })
            await sidebar.getByRole("button", { name: "Close Task", exact: true }).click()
            await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toHaveCount(0)
            await waitForTaskRelease(dlineDocsDir, taskId)
            const base = Date.now()
            await rewriteTaskUiMessages(dlineDocsDir, taskId, () => transcript(base))
            await sidebar.getByText(TASK, { exact: true }).last().click()
            await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible()
            await page.getByRole("button", { name: "Settings", exact: true }).click()
            await sidebar.getByTestId("tab-general").click()
            await sidebar.locator("#aggressive-rendering").click()
            await sidebar.getByRole("option", { name: "Per user turn", exact: true }).click()
            await sidebar.getByRole("button", { name: "Done", exact: true }).click()
            await expect(trajectoryRail(sidebar).rail.getByTestId("trajectory-turn")).toHaveCount(TURN_COUNT)
            await expect(sidebar.getByRole("button", { name: "Expand all activity", exact: true })).toBeAttached()
            const consumptions = server.getMockConsumptions("openai-compatible-chat")
            await testInfo.attach("mock-consumptions", {
                body: JSON.stringify(consumptions, null, 2),
                contentType: "application/json",
            })
            expect(consumptions).toHaveLength(1)
            for (const consumption of consumptions) expect(consumption.contractError).toBeUndefined()
            await use({ page, sidebar, base, requestCount: () => server.openAiRequestCount })
            expect(server.openAiRequestCount).toBe(1)
            await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
        } finally {
            await page.screenshot({ path: testInfo.outputPath("floating-final.png") })
            await testInfo.attach("floating-final", { path: testInfo.outputPath("floating-final.png"), contentType: "image/png" })
            await app.close()
        }
    },
})

const chatScroller = (sidebar: Frame) => sidebar.locator('[data-virtuoso-scroller="true"]')
const foldButton = (sidebar: Frame) => sidebar.getByRole("button", { name: /^(Expand|Collapse) all activity$/ })
const scrollButton = (sidebar: Frame) => sidebar.getByRole("button", { name: /^(Scroll to top|Scroll to bottom)$/ })

async function pointerOutside(page: Page, sidebar: Frame) {
    await sidebar.getByTestId("chat-input").click()
    await page.mouse.move(1100, 80)
}

async function capture(sidebar: Frame, testInfo: TestInfo, name: string) {
    const metrics = await sidebar.evaluate(() => {
        const rail = document.querySelector<HTMLElement>('[data-testid="trajectory-rail"]')
        const list = document.querySelector<HTMLElement>('[data-virtuoso-scroller="true"]')
        const controls = Array.from(document.querySelectorAll<HTMLElement>("button")).filter((button) =>
            /^(Expand|Collapse) all activity$|^Scroll to (top|bottom)$/.test(button.getAttribute("aria-label") ?? ""),
        )
        const rect = (element: HTMLElement) => {
            const box = element.getBoundingClientRect()
            const hit = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2)
            return {
                label: element.getAttribute("aria-label"),
                box: box.toJSON(),
                opacity: getComputedStyle(element.parentElement ?? element).opacity,
                pointerEvents: getComputedStyle(element).pointerEvents,
                hit: hit?.outerHTML.slice(0, 400),
                hover: element.matches(":hover"),
                messagesHovered: element.closest(".group\\/messages")?.matches(":hover"),
            }
        }
        return {
            viewport: { width: innerWidth, height: innerHeight },
            rail: rail && { ...rect(rail), opacity: getComputedStyle(rail).opacity },
            railScroll: rail && {
                height: rail.firstElementChild?.clientHeight,
                scrollHeight: rail.firstElementChild?.scrollHeight,
            },
            list: list && { ...rect(list), scrollTop: list.scrollTop },
            controls: controls.map(rect),
        }
    })
    await testInfo.attach(`${name}-geometry`, { body: JSON.stringify(metrics, null, 2), contentType: "application/json" })
    await testInfo.attach(name, { body: await sidebar.page().screenshot(), contentType: "image/png" })
    return metrics
}

async function expectShown(sidebar: Frame) {
    await expect(trajectoryRail(sidebar).rail).toHaveCSS("opacity", "1")
    await expect(trajectoryRail(sidebar).rail).toHaveCSS("pointer-events", "auto")
    await expect(foldButton(sidebar).locator("..")).toHaveCSS("opacity", "1")
    if (await scrollButton(sidebar).count()) await expect(scrollButton(sidebar).locator("..")).toHaveCSS("opacity", "1")
}

async function expectHidden(sidebar: Frame) {
    for (const surface of [
        trajectoryRail(sidebar).rail,
        foldButton(sidebar).locator(".."),
        scrollButton(sidebar).locator(".."),
    ]) {
        if (!(await surface.count())) continue
        await expect(surface).toHaveCSS("opacity", "0")
        await expect(surface).toHaveCSS("pointer-events", "none")
    }
}

floatingE2e(
    "Floating controls - only scrolling reveals and message hover does not retain controls",
    async ({ chat }, testInfo) => {
        const { page, sidebar, requestCount } = chat
        const scroller = chatScroller(sidebar)
        await pointerOutside(page, sidebar)
        await expect(trajectoryRail(sidebar).rail).toHaveCSS("opacity", "0")
        const before = await scroller.evaluate((element) => ({
            top: element.scrollTop,
            rows: element.querySelectorAll("[data-index]").length,
        }))
        const requests = requestCount()
        await scroller.hover({ position: { x: 2, y: 100 } })
        await capture(sidebar, testInfo, "hover-without-scroll")
        await expectHidden(sidebar)
        await page.waitForTimeout(1300) // Samples idle hover beyond the hold and fade.
        await expectHidden(sidebar)
        expect(
            await scroller.evaluate((element) => ({
                top: element.scrollTop,
                rows: element.querySelectorAll("[data-index]").length,
            })),
        ).toEqual(before)
        expect(requestCount()).toBe(requests)
        const oldTop = await scroller.evaluate((element) => element.scrollTop)
        await page.mouse.wheel(0, -120)
        await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).not.toBe(oldTop)
        await expectShown(sidebar)
        // A stationary pointer in the messages no longer prevents the idle fade.
        await expectHidden(sidebar)
        await pointerOutside(page, sidebar)
        const beforeJump = await scroller.evaluate((element) => element.scrollTop)
        await scroller.evaluate((element) => {
            element.scrollTop = Math.max(0, element.scrollTop - 120)
        })
        await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).not.toBe(beforeJump)
        await expectShown(sidebar)
        await expectHidden(sidebar)
        // A hidden overlay does not win hit-testing in its former area.
        for (const surface of [trajectoryRail(sidebar).rail, foldButton(sidebar), scrollButton(sidebar)]) {
            if (!(await surface.count())) continue
            expect(
                await surface.evaluate((element) => {
                    const box = element.getBoundingClientRect()
                    return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
                }),
            ).toBe(false)
        }
        await scroller.hover({ position: { x: 2, y: 100 } })
        await expectHidden(sidebar)
        await page.mouse.wheel(0, 120)
        await expectShown(sidebar)
        expect(requestCount()).toBe(requests)
    },
)

async function expectDisjoint(sidebar: Frame, testInfo: TestInfo, name: string) {
    const metrics = await capture(sidebar, testInfo, name)
    expect(metrics.rail).not.toBeNull()
    expect(metrics.railScroll?.height, `${name}: at least one full bar remains usable`).toBeGreaterThanOrEqual(8)
    const rail = metrics.rail!.box
    expect(rail.top).toBeGreaterThanOrEqual(metrics.list!.box.top)
    for (const control of metrics.controls) {
        const horizontallyOverlapping = rail.left < control.box.right && rail.right > control.box.left
        expect(
            horizontallyOverlapping && rail.bottom + 4 > control.box.top && rail.top < control.box.bottom,
            `${name}: trajectory must leave at least 4px before ${control.label}; ${JSON.stringify(metrics)}`,
        ).toBe(false)
        expect(control.box.bottom).toBeLessThanOrEqual(metrics.list!.box.bottom)
    }
}

async function expectHit(button: Locator) {
    expect(
        await button.evaluate((element) => {
            const box = element.getBoundingClientRect()
            return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
        }),
    ).toBe(true)
}

floatingE2e(
    "Floating controls - short viewport and resize keep long trajectory separate and every control clickable",
    async ({ chat }, testInfo) => {
        const { page, sidebar, base } = chat
        const scroller = chatScroller(sidebar)
        const rail = trajectoryRail(sidebar)
        // Actual list scrolling reveals the controls and establishes the top-direction affordance.
        await scroller.hover({ position: { x: 2, y: 100 } })
        await page.mouse.wheel(0, -220)
        await expect(sidebar.getByRole("button", { name: "Scroll to top", exact: true })).toBeAttached()
        for (const height of [900, 600, 780]) {
            await page.setViewportSize({ width: 1200, height })
            await scroller.hover({ position: { x: 2, y: 60 } })
            await page.mouse.wheel(0, -40)
            await expectShown(sidebar)
            // Hold the revealed control during screenshot capture without changing the reveal trigger.
            await foldButton(sidebar).hover()
            await expectDisjoint(sidebar, testInfo, `layout-${height}-collapsed`)
            await foldButton(sidebar).click()
            await expect(sidebar.getByRole("button", { name: "Collapse all activity", exact: true })).toBeAttached()
            await expectDisjoint(sidebar, testInfo, `layout-${height}-expanded`)
            await foldButton(sidebar).click()
        }
        await page.setViewportSize({ width: 1200, height: 600 })
        await scroller.hover({ position: { x: 2, y: 60 } })
        await page.mouse.wheel(0, -40)
        const railScroller = rail.rail.locator(":scope > div")
        expect(await railScroller.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
        await railScroller.hover()
        await page.mouse.wheel(0, 2_000)
        await expect
            .poll(() => railScroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
            .toBeLessThanOrEqual(1)
        const last = rail.bar(prompt(TURN_COUNT - 1))
        await last.hover()
        await expect(sidebar.getByTestId("trajectory-turn-preview").filter({ hasText: prompt(TURN_COUNT - 1) })).toBeVisible()
        await expectHit(last)
        await last.click()
        await expect(sidebar.locator(`[data-message-ts="${base + (TURN_COUNT - 1) * 10}"]`)).toBeInViewport()
        await expect(last).toHaveAttribute("aria-current", "location")
        // Move straight to Expand, without detouring to dismiss the open preview first.
        const expand = foldButton(sidebar)
        const expandBox = await expand.boundingBox()
        expect(expandBox).not.toBeNull()
        await page.mouse.move(expandBox!.x + expandBox!.width / 2, expandBox!.y + expandBox!.height / 2, { steps: 8 })
        await capture(sidebar, testInfo, "direct-preview-to-expand")
        await expect
            .poll(() =>
                expand.evaluate((element) => {
                    const box = element.getBoundingClientRect()
                    return element.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2))
                }),
            )
            .toBe(true)
        await expand.click()
        await expect(sidebar.getByRole("button", { name: "Collapse all activity", exact: true })).toBeAttached()
        await scroller.hover({ position: { x: 2, y: 60 } })
        await page.mouse.wheel(0, -150)
        const top = sidebar.getByRole("button", { name: "Scroll to top", exact: true })
        await expectHit(top)
        await top.click()
        await expect.poll(() => scroller.evaluate((element) => element.scrollTop)).toBeLessThanOrEqual(1)
        await scroller.hover({ position: { x: 2, y: 60 } })
        await page.mouse.wheel(0, 150)
        const bottom = sidebar.getByRole("button", { name: "Scroll to bottom", exact: true })
        await expectHit(bottom)
        await bottom.click()
        await expect
            .poll(() => scroller.evaluate((element) => element.scrollHeight - element.clientHeight - element.scrollTop))
            .toBeLessThanOrEqual(10)
    },
)

floatingE2e("Floating controls - keyboard focus reveals hidden controls and keeps them reachable off hover", async ({ chat }) => {
    const { page, sidebar } = chat
    await pointerOutside(page, sidebar)
    await expectHidden(sidebar)
    // Tab from the last rail bar into the bulk control in actual document order.
    await trajectoryRail(sidebar)
        .bar(prompt(TURN_COUNT - 1))
        .focus()
    await page.keyboard.press("Tab")
    const expand = sidebar.getByRole("button", { name: "Expand all activity", exact: true })
    await expect(expand).toBeFocused()
    expect(await expand.evaluate((element) => element.matches(":focus-visible"))).toBe(true)
    await expectShown(sidebar)
    await expand.press("Enter")
    const collapse = sidebar.getByRole("button", { name: "Collapse all activity", exact: true })
    await expect(collapse).toBeFocused()
    await expectShown(sidebar)
    await pointerOutside(page, sidebar)
    await expectHidden(sidebar)
})
