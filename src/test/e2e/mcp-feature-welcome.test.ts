import { mkdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { expect, type Frame, type Page } from "@playwright/test"
import type { ElectronApplication } from "playwright"
import { E2ETestHelper, e2e } from "./utils/helpers"

interface StoredSettings {
	mcpEnabled?: boolean
}

const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")

async function readSettings(dlineDir: string): Promise<StoredSettings> {
	return JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as StoredSettings
}

async function openSidebar(
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

async function openFeatureSettings(page: Page, sidebar: Frame): Promise<void> {
	await page.getByRole("button", { name: "Settings", exact: true }).click()
	await expect(sidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible()
	await sidebar.getByTestId("tab-features").click()
	await expect(sidebar.getByRole("heading", { name: "Feature Settings" })).toBeVisible()
}

e2e(
	"Enable MCP - defaults on, hides the chat control when disabled, and persists across restart",
	async ({ dlineDir, helper, openVSCode, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		let app: ElectronApplication | undefined

		try {
			app = await openVSCode(workspaceDir)
			const opened = await openSidebar(app, helper)
			await expect(opened.sidebar.getByRole("button", { name: "Show MCP Servers", exact: true }).first()).toBeVisible()

			await openFeatureSettings(opened.page, opened.sidebar)
			const enableMcpSwitch = opened.sidebar.locator('[id="Enable MCP"]')
			await expect(enableMcpSwitch).toHaveAttribute("aria-checked", "true")
			await enableMcpSwitch.click()
			await expect(enableMcpSwitch).toHaveAttribute("aria-checked", "false")
			await expect.poll(async () => (await readSettings(dlineDir)).mcpEnabled).toBe(false)

			await opened.sidebar.getByRole("button", { name: "Done", exact: true }).click()
			await expect(opened.sidebar.getByTestId("chat-input")).toBeVisible()
			await expect(opened.sidebar.getByRole("button", { name: "Show MCP Servers", exact: true })).toHaveCount(0)

			await app.close()
			app = undefined

			app = await openVSCode(workspaceDir)
			const reopened = await openSidebar(app, helper)
			await expect(reopened.sidebar.getByRole("button", { name: "Show MCP Servers", exact: true })).toHaveCount(0)
			await openFeatureSettings(reopened.page, reopened.sidebar)
			await expect(reopened.sidebar.locator('[id="Enable MCP"]')).toHaveAttribute("aria-checked", "false")
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app?.close()
		}
	},
)

e2e(
	"Welcome Recent - fits available space and does not expose user scrolling",
	async ({ dlineDocsDir, helper, openVSCode, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		const tasksDir = path.join(dlineDocsDir, "tasks")
		await mkdir(tasksDir, { recursive: true })
		const baseTimestamp = Date.now() - 60_000
		const taskHistory = Array.from({ length: 15 }, (_, index) => ({
			id: `e2e-welcome-layout-${index}`,
			ts: baseTimestamp + index,
			task: `E2E_WELCOME_LAYOUT_TASK_${index} ${"content ".repeat(12)}`,
			cwdOnTaskInitialization: workspaceDir,
		}))
		await writeFile(
			path.join(tasksDir, "taskHistory.jsonl"),
			`${taskHistory.map((item) => JSON.stringify(item)).join("\n")}\n`,
			"utf8",
		)

		const app = await openVSCode(workspaceDir)
		try {
			const opened = await openSidebar(app, helper)
			await opened.page.getByRole("button", { name: "New Task", exact: true }).click()
			const recentList = opened.sidebar.locator(".history-preview-list")
			await expect(recentList).toBeVisible({ timeout: 30_000 })
			await expect(opened.sidebar.getByText("E2E_WELCOME_LAYOUT_TASK_14", { exact: false })).toBeVisible()

			const layout = await recentList.evaluate((element) => {
				const style = getComputedStyle(element)
				const rect = element.getBoundingClientRect()
				const rows = [...element.querySelectorAll<HTMLElement>(".history-preview-item")]
				return {
					height: rect.height,
					maxHeight: window.innerHeight * 0.7,
					overflowX: style.overflowX,
					overflowY: style.overflowY,
					clientHeight: element.clientHeight,
					scrollHeight: element.scrollHeight,
					scrollTop: element.scrollTop,
					rowCount: rows.length,
					lastRowBottom: rows.at(-1)?.getBoundingClientRect().bottom,
					listBottom: rect.bottom,
				}
			})
			expect(layout.height, JSON.stringify(layout)).toBeGreaterThan(0)
			expect(layout.height, JSON.stringify(layout)).toBeLessThanOrEqual(layout.maxHeight)
			expect(layout.overflowX).toBe("hidden")
			expect(layout.overflowY).toBe("hidden")
			expect(layout.scrollHeight).toBe(layout.clientHeight)
			expect(layout.rowCount).toBeGreaterThan(0)
			expect(layout.rowCount).toBeLessThan(10)
			expect(layout.lastRowBottom, JSON.stringify(layout)).toBeLessThanOrEqual(layout.listBottom)
			expect(layout.scrollTop).toBe(0)

			await recentList.hover()
			await opened.page.mouse.wheel(0, 1_000)
			await opened.page.waitForTimeout(250)
			expect(await recentList.evaluate((element) => element.scrollTop)).toBe(0)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)
