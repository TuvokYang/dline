import { expect, type Frame, type Locator } from "@playwright/test"

export interface WorkSessionAuthenticator {
	signin(sidebar: Frame): Promise<void>
}

export async function prepareWorkSession(sidebar: Frame, authenticator: WorkSessionAuthenticator): Promise<void> {
	await authenticator.signin(sidebar)
	await expectWorkComposerReady(sidebar)
}

export async function expectWorkComposerReady(sidebar: Frame, timeoutMs = 30_000): Promise<void> {
	await expect(sidebar.getByTestId("chat-input")).toBeVisible({ timeout: timeoutMs })
	await expect(sidebar.getByTestId("chat-input")).toBeEnabled({ timeout: timeoutMs })
	await expect(sidebar.getByTestId("send-button")).toBeVisible({ timeout: timeoutMs })
}

export async function sendWorkMessage(sidebar: Frame, text: string, timeoutMs = 30_000): Promise<Locator> {
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled({ timeout: timeoutMs })
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	const message = sidebar.getByText(text, { exact: true }).first()
	await expect(message).toBeVisible({ timeout: timeoutMs })
	return message
}

export async function scrollWorkToLatest(sidebar: Frame): Promise<void> {
	const scroller = sidebar.locator('[data-virtuoso-scroller="true"]')
	await expect(scroller).toBeVisible()
	// Use the transcript gutter so an expanded tool's nested scroller cannot consume the wheel.
	await scroller.hover({ position: { x: 4, y: 40 } })
	await sidebar.page().mouse.wheel(0, 120)
	const scrollToBottom = sidebar.getByRole("button", { name: "Scroll to bottom", exact: true })
	await expect
		.poll(async () => {
			if (await scrollToBottom.count()) return true
			return scroller.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight <= 10)
		})
		.toBe(true)
	if (await scrollToBottom.count()) await scrollToBottom.click()

	// Observe layout only: never reset scrollTop or repeatedly navigate until a moving row happens to pass.
	let previousGeometry: string | undefined
	await expect
		.poll(async () => {
			const geometry = await scroller.evaluate((element) => ({
				top: element.scrollTop,
				height: element.scrollHeight,
				viewport: element.clientHeight,
			}))
			const currentGeometry = JSON.stringify(geometry)
			const settled = currentGeometry === previousGeometry
			previousGeometry = currentGeometry
			return settled && geometry.height - geometry.top - geometry.viewport <= 10
		})
		.toBe(true)
}

export async function setWorkAutoApproveAction(sidebar: Frame, label: string, enabled: boolean): Promise<void> {
	await sidebar.getByLabel("Open auto-approve settings").click()
	const checkbox = sidebar.locator("vscode-checkbox").filter({ hasText: label })
	await expect(checkbox).toHaveCount(1)
	const isChecked = () => checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))
	if ((await isChecked()) !== enabled) await sidebar.getByText(label, { exact: true }).click()
	await expect.poll(isChecked).toBe(enabled)
	await sidebar.getByLabel("Close auto-approve settings").click()
}

export async function openWorkActivities(sidebar: Frame): Promise<Locator> {
	await sidebar.getByRole("tab", { name: /^Activities(?: \d+)?$/ }).click()
	const allFilter = sidebar.getByTestId("activity-status-filter-all")
	if (await allFilter.isVisible()) await allFilter.click()
	else await sidebar.getByRole("button", { name: "All", exact: true }).first().click()
	return sidebar.getByTestId("activity-item")
}

export async function openWorkTab(sidebar: Frame): Promise<void> {
	await sidebar.getByRole("tab", { name: "Work", exact: true }).click()
}
