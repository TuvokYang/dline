import { BROWSE_TARGET_INDEX, openSeededTask, SETTLE_SAMPLE_COUNT, seedJitterTask } from "@e2e/utils/chat-scroll-jitter/fixture"
import {
    countContestedRestores,
    describeRendering,
    describeSettleSamples,
    largestAnchorJump,
} from "@e2e/utils/chat-scroll-jitter/measurements"
import {
    attachDiagnostics,
    captureVisibleRows,
    installScrollObserver,
    readRenderingState,
    sampleSettling,
} from "@e2e/utils/chat-scroll-jitter/probes"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect } from "@playwright/test"
import type { ElectronApplication } from "playwright"

e2e.describe("Chat virtual scroll jitter", () => {
    e2e(
        "browsing a long history with collapsing rows settles without tremor",
        async ({ dlineDocsDir, helper, openVSCode, userDataDir, workspaceDir }, testInfo) => {
            e2e.setTimeout(240_000)
            await seedJitterTask(dlineDocsDir, workspaceDir)
            let app: ElectronApplication | undefined
            try {
                app = await openVSCode(workspaceDir)
                const { page, sidebar } = await openSeededTask(app, helper)
                const scroller = sidebar.locator('[data-virtuoso-scroller="true"]')
                await expect(scroller).toBeVisible({ timeout: 30_000 })
                await expect
                    .poll(async () => (await captureVisibleRows(sidebar)).length, {
                        message: "the seeded conversation must render rows",
                        timeout: 30_000,
                    })
                    .toBeGreaterThan(0)
                await installScrollObserver(sidebar)
                let visibleRows = await captureVisibleRows(sidebar)
                for (let attempt = 0; attempt < 40; attempt++) {
                    const indexes = visibleRows.flatMap((row) => {
                        const match = /E2E_JITTER_MESSAGE_(\d{4})/u.exec(row.text)
                        return match ? [Number(match[1])] : []
                    })
                    if (indexes.some((index) => index <= BROWSE_TARGET_INDEX)) break
                    // The list's center can hit a nested command-output scroller.
                    // Drive its outer gutter without changing the input amount or budget.
                    const box = await scroller.boundingBox()
                    if (!box) throw new Error("missing chat scroller geometry")
                    await scroller.hover({ position: { x: 2, y: box.height / 2 } })
                    await page.mouse.wheel(0, -2_400)
                    await page.waitForTimeout(100)
                    visibleRows = await captureVisibleRows(sidebar)
                }
                const reachedIndexes = visibleRows.flatMap((row) => {
                    const match = /E2E_JITTER_MESSAGE_(\d{4})/u.exec(row.text)
                    return match ? [Number(match[1])] : []
                })
                await testInfo.attach("chat-scroll-jitter-browse-state.json", {
                    body: JSON.stringify({ reachedIndexes, visibleRows }, null, 2),
                    contentType: "application/json",
                })
                expect(reachedIndexes.length, "browsing must render identifiable seeded rows").toBeGreaterThan(0)
                expect(
                    Math.min(...reachedIndexes),
                    `browsing must reach the older history range that triggers leading loads (reached=${Math.min(...reachedIndexes)})`,
                ).toBeLessThanOrEqual(BROWSE_TARGET_INDEX)
                const anchorRow = visibleRows[0]
                expect(anchorRow, "browsing must expose a visible anchor row").toBeDefined()
                if (!anchorRow) throw new Error("missing anchor row")
                const settleStart = await readRenderingState(sidebar)
                const diagnostics = await sampleSettling(sidebar, anchorRow.ts)
                await attachDiagnostics(testInfo, diagnostics)
                const resolvedSamples = diagnostics.samples.filter((sample) => sample.anchorTop !== null)
                expect(
                    resolvedSamples.length,
                    `the sampled anchor must stay resolvable, otherwise no jitter measurement was taken (${describeRendering("settleStart", settleStart)}; ${describeSettleSamples(diagnostics.samples)})`,
                ).toBeGreaterThan(SETTLE_SAMPLE_COUNT / 2)
                expect(
                    diagnostics.excessTravel,
                    `the anchor must not oscillate once input stops (net=${diagnostics.netTravel.toFixed(1)}, total=${diagnostics.totalTravel.toFixed(1)}, reversals=${diagnostics.reversals})`,
                ).toBeLessThanOrEqual(12)
                expect(
                    diagnostics.reversals,
                    "a settled viewport must not reverse direction repeatedly without input",
                ).toBeLessThanOrEqual(2)
                const contested = countContestedRestores(diagnostics.events)
                testInfo.annotations.push({ type: "contested-restores", description: String(contested) })
                const jump = largestAnchorJump(diagnostics.samples)
                expect(
                    jump,
                    `the anchor must not jump while no input is in flight (largest=${jump.toFixed(1)}px)`,
                ).toBeLessThanOrEqual(24)
                await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
            } finally {
                if (app) await app.close().catch(() => undefined)
            }
        },
    )
})
