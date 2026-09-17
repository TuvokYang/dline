import { writeFile } from "node:fs/promises"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

interface LayoutSnapshot {
	label: string
	viewportHeight: number
	rootHeight: number
	scrollerHeight: number
	zeroHeightItems: number
}

async function captureLayout(sidebar: Frame, label: string): Promise<LayoutSnapshot> {
	return sidebar.evaluate((label) => {
		const root = document.getElementById("root")
		const scroller = document.querySelector('[data-virtuoso-scroller="true"]')
		const items = [...document.querySelectorAll<HTMLElement>("[data-index]")]
		return {
			label,
			viewportHeight: window.innerHeight,
			rootHeight: root?.getBoundingClientRect().height ?? 0,
			scrollerHeight: scroller?.getBoundingClientRect().height ?? 0,
			zeroHeightItems: items.filter((item) => item.getBoundingClientRect().height === 0).length,
		}
	}, label)
}

e2e.use({ devWebview: true, installVsix: false })

e2e(
	"Webview blank-layout diagnostic records recovery across sidebar lifecycle",
	async ({ helper, page, server, userDataDir }, testInfo) => {
		e2e.setTimeout(120_000)
		const consoleErrors: string[] = []
		const failedRequests: Array<{ url: string; error: string | null }> = []
		const snapshots: LayoutSnapshot[] = []
		page.on("console", (message) => {
			if (message.type() === "error") consoleErrors.push(message.text())
		})
		page.on("pageerror", (error) => consoleErrors.push(error.stack ?? error.message))
		page.on("requestfailed", (request) => {
			failedRequests.push({ url: request.url(), error: request.failure()?.errorText ?? null })
		})

		server.resetOpenAiMock()
		server.enqueueOpenAiResponses({
			type: "tool",
			id: "call_dev_webview_layout",
			name: "attempt_completion",
			arguments: { result: "E2E_DEV_WEBVIEW_LAYOUT_READY" },
		})

		await E2ETestHelper.openClineSidebar(page)
		let sidebar = await helper.getSidebar(page)
		await E2ETestHelper.dismissWhatsNewModal(sidebar)
		await helper.signin(sidebar)
		const input = sidebar.getByTestId("chat-input")
		await input.fill("Capture the Webview layout lifecycle.")
		await sidebar.getByTestId("send-button").click()
		await expect(sidebar.getByText("E2E_DEV_WEBVIEW_LAYOUT_READY", { exact: true })).toBeVisible({ timeout: 60_000 })
		await expect(sidebar.locator('[data-virtuoso-scroller="true"]')).toBeVisible()
		snapshots.push(await captureLayout(sidebar, "task-visible"))

		const dlineTab = page.getByRole("tab", { name: /Dline/ })
		for (let iteration = 1; iteration <= 3; iteration++) {
			await page.keyboard.press("ControlOrMeta+B")
			await expect(dlineTab).toHaveAttribute("aria-expanded", "false")
			await page.keyboard.press("ControlOrMeta+B")
			await E2ETestHelper.openClineSidebar(page)
			helper.clearCachedFrame()
			sidebar = await helper.getSidebar(page)
			await expect(sidebar.getByTestId("chat-input")).toBeVisible({ timeout: 5_000 })
			await expect(sidebar.locator('[data-virtuoso-scroller="true"]')).toBeVisible({ timeout: 5_000 })
			snapshots.push(await captureLayout(sidebar, `sidebar-reveal-${iteration}`))
		}

		for (const snapshot of snapshots) {
			expect(snapshot.viewportHeight, `${snapshot.label}: viewport`).toBeGreaterThan(0)
			expect(snapshot.rootHeight, `${snapshot.label}: root`).toBeGreaterThan(0)
			expect(snapshot.scrollerHeight, `${snapshot.label}: scroller`).toBeGreaterThan(0)
			expect(snapshot.zeroHeightItems, `${snapshot.label}: zero-height items`).toBe(0)
		}
		expect(server.getRequestCount("openai-compatible-chat")).toBe(1)
		expect(failedRequests.filter((request) => request.url.startsWith("http://localhost:8097"))).toEqual([])
		expect(failedRequests.filter((request) => request.url.includes("codicon.ttf"))).toEqual([])
		const unexpectedConsoleErrors = consoleErrors.filter(
			(message) =>
				!message.includes("[DEP0169]") &&
				!message.includes("Local webview dev server is not running") &&
				!message.includes("`DialogContent` requires a `DialogTitle`"),
		)
		expect(unexpectedConsoleErrors).toEqual([])

		const reportPath = testInfo.outputPath("webview-blank-layout-diagnostic.json")
		await writeFile(reportPath, `${JSON.stringify({ snapshots, failedRequests, consoleErrors }, null, 2)}\n`, "utf8")
		await testInfo.attach("webview-blank-layout-diagnostic", { path: reportPath, contentType: "application/json" })
		await page.screenshot({ path: testInfo.outputPath("webview-blank-layout-final.png"), fullPage: true })
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)
