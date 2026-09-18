import { expect, type Page } from "@playwright/test"

export const openTab = async (_page: Page, tabName: string) => {
	await _page
		.getByRole("tab", { name: new RegExp(`${tabName}`) })
		.locator("a")
		.click()
}

export const addSelectedCodeToDline = async (_page: Page) => {
	const editor = _page.getByRole("textbox", { name: "The editor is not accessible" })
	const action = _page.getByRole("option", { name: "Add to Dline, Quick Fix" })
	const codeActionTrigger = _page.getByRole("listbox", { name: /Show Code Actions/ })
	const emptyMenu = codeActionTrigger.locator(".message", {
		hasText: "No code actions available",
	})

	for (let attempt = 1; attempt <= 2; attempt++) {
		await editor.focus()
		await editor.press("ControlOrMeta+a")
		await _page.keyboard.press("ControlOrMeta+.")
		let clickedVisibleTrigger = false

		await expect
			.poll(
				async () => {
					if ((await action.count()) > 0) return "action"
					if (await emptyMenu.isVisible()) return "empty"
					// VS Code can reveal the Code Action lightbulb without expanding its
					// menu after the keyboard shortcut. A single normal click completes
					// the same user interaction without hiding a missing provider result.
					if (!clickedVisibleTrigger && (await codeActionTrigger.isVisible())) {
						clickedVisibleTrigger = true
						await codeActionTrigger.click()
					}
					return "pending"
				},
				{ message: "Expected the Code Action menu to show Add to Dline or an explicit empty result" },
			)
			.not.toBe("pending")

		if ((await action.count()) > 0) {
			const actionWidget = _page.getByRole("listbox", { name: "Action Widget" })
			await expect(action).toHaveCount(1)
			await expect(action).toBeVisible()
			await expect(actionWidget).toBeFocused()
			await expect(actionWidget.getByRole("option").first()).toHaveAccessibleName("Add to Dline, Quick Fix")
			await _page.keyboard.press("Enter")
			return
		}

		await expect(emptyMenu).toBeVisible()
		if (attempt === 2) {
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
