import { expect, type Page } from "@playwright/test"

export const openTab = async (_page: Page, tabName: string) => {
	await _page
		.getByRole("tab", { name: new RegExp(`${tabName}`) })
		.locator("a")
		.click()
}

export const addSelectedCodeToDline = async (_page: Page) => {
	const editor = _page.getByRole("textbox", { name: "The editor is not accessible" })
	const actionWidget = _page.getByRole("listbox", { name: "Action Widget" }).last()
	const action = actionWidget.getByRole("option", { name: "Add to Dline, Quick Fix" }).first()
	const codeActionTrigger = _page.getByRole("listbox", { name: /Show Code Actions/ }).last()
	const emptyMenu = codeActionTrigger.locator(".message", {
		hasText: "No code actions available",
	})
	const waitForMenuState = async (timeoutMs: number): Promise<"action" | "empty" | "pending"> => {
		const deadline = Date.now() + timeoutMs
		while (Date.now() < deadline) {
			if (await action.isVisible()) return "action"
			if (await emptyMenu.isVisible()) return "empty"
			await _page.waitForTimeout(100)
		}
		return "pending"
	}

	const maxAttempts = 2
	for (let attempt = 1; attempt <= maxAttempts; attempt++) {
		await editor.focus()
		await editor.press("ControlOrMeta+a")
		await _page.keyboard.press("ControlOrMeta+.")

		// Give the keyboard-triggered Action Widget time to mount before touching
		// the lightbulb. Clicking it while the widget mounts lets the overlay
		// intercept Playwright's actionability retry and blocks all later checks.
		let menuState = await waitForMenuState(3_000)
		if (menuState === "pending" && (await codeActionTrigger.isVisible())) {
			// Monaco opens the lightbulb menu on mousedown, so only a real pointer
			// click works. Bound it: if the menu mounts concurrently, its overlay
			// intercepts the click and the state check below observes the result.
			await codeActionTrigger.click({ timeout: 5_000 }).catch(() => undefined)
			menuState = await waitForMenuState(10_000)
		}
		if (menuState === "pending") {
			if (attempt === maxAttempts) {
				throw new Error("Expected the Code Action menu to show Add to Dline or an explicit empty result")
			}
			await _page.keyboard.press("Escape")
			continue
		}

		if (menuState === "action") {
			await expect(action).toBeVisible()
			await expect(actionWidget).toBeFocused()
			await expect(actionWidget.getByRole("option").first()).toHaveAccessibleName("Add to Dline, Quick Fix")
			await _page.keyboard.press("Enter")
			return
		}

		await expect(emptyMenu).toBeVisible()
		if (attempt === maxAttempts) {
			throw new Error("VS Code returned an empty Code Action menu after the HTML language extension activation retry")
		}
		await _page.keyboard.press("Escape")
		await expect(emptyMenu).not.toBeVisible()
	}
}

export const toggleNotifications = async (_page: Page) => {
	await _page.waitForLoadState("domcontentloaded")
	await _page.keyboard.press("ControlOrMeta+Shift+p")
	const editorSearchBar = _page.getByRole("textbox")
	if (!(await editorSearchBar.isVisible())) {
		await _page.keyboard.press("ControlOrMeta+Shift+p")
	}
	await editorSearchBar.click({ delay: 100 }) // Ensure focus
	await editorSearchBar.fill("> Toggle Do Not Disturb Mode")
	await _page.keyboard.press("Enter")
	return _page
}
