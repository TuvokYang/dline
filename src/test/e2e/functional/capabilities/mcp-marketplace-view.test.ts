import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

/**
 * Regression test for BUGFIX-050.
 *
 * The Marketplace tab used to re-enter its fetch effect on every render because the
 * fetch callback was recreated each time and listed as an effect dependency. The
 * resulting loading state was an early return, so the search field was unmounted and
 * typing was interrupted. The tab bar also lived inside the scroll container, so it
 * scrolled away with the content.
 *
 * The marketplace endpoint is unreachable in E2E, which is exactly the state that used
 * to unmount the whole subtree. The controls must stay mounted and usable anyway.
 */

async function openMcpMarketplace(sidebar: Frame): Promise<void> {
	await sidebar.getByRole("button", { name: "Show MCP Servers", exact: true }).click()
	await sidebar.getByRole("button", { name: "Go to MCP server settings", exact: true }).click()
	await expect(sidebar.getByRole("heading", { name: "MCP Servers", exact: true })).toBeVisible()
	await sidebar.getByRole("button", { name: "Marketplace", exact: true }).click()
}

e2e(
	"MCP Marketplace - controls stay mounted and only the content area scrolls",
	async ({ helper, sidebar, userDataDir }, testInfo) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)

		await openMcpMarketplace(sidebar)

		// The search field must resolve regardless of whether the catalog request
		// succeeded or failed; a render loop or an early return would remove it.
		// VSCodeTextField renders a custom element wrapping a native input, so the
		// locator targets the inner control explicitly.
		const searchField = sidebar.locator('vscode-text-field[placeholder="Search MCPs..."] input')
		await expect(searchField).toBeVisible({ timeout: 60_000 })

		// Typing must not be interrupted. Every character is typed separately so an
		// unmount between keystrokes would truncate the value.
		await searchField.click()
		await sidebar.page().keyboard.type("filesystem", { delay: 60 })
		await expect(searchField).toHaveValue("filesystem")

		// The tab bar must remain visible while the field is in use.
		const marketplaceTab = sidebar.getByRole("button", { name: "Marketplace", exact: true })
		await expect(marketplaceTab).toBeVisible()

		const layout = await marketplaceTab.evaluate((tabButton: Element) => {
			function scrollParentOf(element: Element): HTMLElement | null {
				let current = element.parentElement
				while (current) {
					const overflowY = getComputedStyle(current).overflowY
					if (overflowY === "auto" || overflowY === "scroll") {
						return current
					}
					current = current.parentElement
				}
				return null
			}

			const tabRow = tabButton.parentElement
			const tabScrollParent = tabRow ? scrollParentOf(tabRow) : null
			const searchInput = document.querySelector('vscode-text-field[placeholder="Search MCPs..."]')
			const contentScrollParent = searchInput ? scrollParentOf(searchInput) : null

			return {
				hasTabRow: tabRow !== null,
				hasSearchInput: searchInput !== null,
				// The tab bar must not sit inside any scrollable ancestor within the view.
				tabScrollParentIsViewportOrNull: tabScrollParent === null,
				hasContentScrollParent: contentScrollParent !== null,
				// The content scroller must be a different element than anything wrapping the tabs.
				contentScrollerContainsTabs:
					contentScrollParent !== null && tabRow !== null && contentScrollParent.contains(tabRow),
				contentOverflowY: contentScrollParent ? getComputedStyle(contentScrollParent).overflowY : null,
			}
		})

		expect(layout.hasTabRow).toBe(true)
		expect(layout.hasSearchInput).toBe(true)
		expect(layout.hasContentScrollParent).toBe(true)
		expect(layout.contentOverflowY).toBe("auto")
		// The core scroll-ownership contract: the scroll container holds the content, not the tabs.
		expect(layout.contentScrollerContainsTabs).toBe(false)
		expect(layout.tabScrollParentIsViewportOrNull).toBe(true)

		// Switching tabs and returning must not break the view.
		await sidebar.getByRole("button", { name: "Configure", exact: true }).click()
		await expect(sidebar.getByText("Configure MCP Servers", { exact: true })).toBeVisible()
		await marketplaceTab.click()
		await expect(sidebar.locator('vscode-text-field[placeholder="Search MCPs..."] input')).toBeVisible()

		const screenshotPath = testInfo.outputPath("mcp-marketplace-view.png")
		await sidebar.locator("body").screenshot({ path: screenshotPath })
		await testInfo.attach("mcp-marketplace-view", { path: screenshotPath, contentType: "image/png" })

		await sidebar.getByRole("button", { name: "Done", exact: true }).click()
		await expect(sidebar.getByTestId("chat-input")).toBeVisible()
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)
