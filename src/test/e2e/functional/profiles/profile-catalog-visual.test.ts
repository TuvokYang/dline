import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Page } from "@playwright/test"

async function openApiSettings(page: Page, sidebar: Frame): Promise<void> {
	await page.getByRole("toolbar", { name: "Dline actions" }).getByRole("button", { name: "Settings" }).click()
	await expect(sidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible({ timeout: 30_000 })
}

async function selectColorTheme(page: Page, sidebar: Frame, themeName: string, themeKind: string): Promise<void> {
	await E2ETestHelper.runCommandPalette(page, "Preferences: Color Theme")
	const themeInput = page.locator(".quick-input-widget input").last()
	await expect(themeInput).toBeVisible()
	await themeInput.fill(themeName)
	const themeOption = page
		.locator(".quick-input-widget .monaco-list-row")
		.filter({ has: page.getByText(themeName, { exact: true }) })
	await expect(themeOption).toHaveCount(1)
	await themeOption.click()
	await expect.poll(() => sidebar.locator("body").getAttribute("data-vscode-theme-kind"), { timeout: 15_000 }).toBe(themeKind)
}

async function captureProfileSettings(sidebar: Frame, name: string): Promise<void> {
	const screenshotPath = e2e.info().outputPath(`${name}.png`)
	await sidebar.locator("body").screenshot({ animations: "disabled", path: screenshotPath })
	await e2e.info().attach(name, { contentType: "image/png", path: screenshotPath })
}

async function expectNoHorizontalOverflow(sidebar: Frame, label: string): Promise<void> {
	const metrics = await sidebar.evaluate(() => ({
		clientWidth: document.documentElement.clientWidth,
		scrollWidth: document.documentElement.scrollWidth,
	}))
	expect(metrics.scrollWidth, `${label} should not overflow horizontally`).toBeLessThanOrEqual(metrics.clientWidth + 1)
}

e2e.use({ devWebview: true, installVsix: false })

e2e("Profile Catalog - captures compact profile settings across widths and themes", async ({ helper, page, sidebar }) => {
	e2e.setTimeout(180_000)
	const bringYourOwnKey = sidebar.getByText("Bring my own API key")
	const chatInput = sidebar.getByTestId("chat-input")
	await expect(bringYourOwnKey.or(chatInput)).toBeVisible({ timeout: 30_000 })
	if (await bringYourOwnKey.isVisible()) await helper.signin(sidebar)
	await expect(chatInput).toBeVisible({ timeout: 30_000 })
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	await openApiSettings(page, sidebar)

	const capabilityLists = sidebar.getByRole("list", { name: "Model capabilities" })
	await expect(capabilityLists.first()).toBeVisible()
	expect(await capabilityLists.first().locator("svg").count()).toBeGreaterThan(0)
	await expect(capabilityLists.first().locator("[style*='mask']")).toHaveCount(0)

	await page.setViewportSize({ height: 800, width: 700 })
	// The expanded body now lists model options, so a plain hasText filter can also
	// match another card whose picker happens to contain the name. Match the toggle.
	const thinkingCard = sidebar.getByTestId("api-profile-card").filter({
		has: sidebar.getByRole("button", { name: /^(Expand|Collapse) .*DeepSeek Thinking.*$/ }),
	})
	await thinkingCard.getByRole("button", { name: /^Expand / }).click()
	const profileNameInput = thinkingCard.locator('input[aria-label="Profile name"]')
	await expect(profileNameInput).toBeVisible()
	expect(await profileNameInput.evaluate((element) => element.getBoundingClientRect().width)).toBeLessThanOrEqual(320)
	// Expanding replaces the summary line with the editable name field, so the
	// summary stays in the DOM as the card's accessible description.
	await expect(thinkingCard.getByText(/deepseek · .* · Thinking:/i)).toBeAttached()
	const webToolsMode = thinkingCard.getByRole("combobox", { name: "Web Tools mode" })
	await expect(webToolsMode.getByRole("option")).toHaveText(["Auto", "Local only", "Off", "Hosted only"])
	await captureProfileSettings(sidebar, "profile-settings-expanded-thinking-700")
	await thinkingCard.getByRole("button", { name: /^Collapse / }).click()

	await selectColorTheme(page, sidebar, "Dark Modern", "vscode-dark")
	for (const width of [700, 480, 320]) {
		await page.setViewportSize({ height: 800, width })
		await expectNoHorizontalOverflow(sidebar, `Dark theme at ${width}px`)
		await captureProfileSettings(sidebar, `profile-settings-dark-${width}`)
	}

	await page.setViewportSize({ height: 800, width: 480 })
	await selectColorTheme(page, sidebar, "Light Modern", "vscode-light")
	await expectNoHorizontalOverflow(sidebar, "Light theme at 480px")
	await captureProfileSettings(sidebar, "profile-settings-light-480")

	await selectColorTheme(page, sidebar, "Dark High Contrast", "vscode-high-contrast")
	await expectNoHorizontalOverflow(sidebar, "High contrast theme at 480px")
	await captureProfileSettings(sidebar, "profile-settings-high-contrast-480")

	await sidebar.evaluate(() => document.documentElement.style.setProperty("--vscode-font-size", "16px"))
	await expectNoHorizontalOverflow(sidebar, "High contrast theme at 16px UI font")
	await captureProfileSettings(sidebar, "profile-settings-high-contrast-font-16")
})
