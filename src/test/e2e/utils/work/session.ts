import { expect, type Frame, type Locator } from "@playwright/test"

export interface WorkSessionAuthenticator {
	signin(sidebar: Frame): Promise<void>
}

export async function prepareWorkSession(sidebar: Frame, authenticator: WorkSessionAuthenticator): Promise<void> {
	await authenticator.signin(sidebar)
	await expectWorkComposerReady(sidebar)
}

export async function expectWorkComposerReady(sidebar: Frame, timeoutMs = 60_000): Promise<void> {
	await expect(sidebar.getByTestId("chat-input")).toBeVisible({ timeout: timeoutMs })
	await expect(sidebar.getByTestId("chat-input")).toBeEnabled({ timeout: timeoutMs })
	await expect(sidebar.getByTestId("send-button")).toBeVisible({ timeout: timeoutMs })
}

export async function expectWorkMessageVisible(
	sidebar: Frame,
	text: string,
	options: { exact?: boolean; timeout?: number } = {},
): Promise<Locator> {
	const message = sidebar.getByText(text, { exact: options.exact ?? true }).last()
	const scrollToBottom = sidebar.getByRole("button", { name: "Scroll to bottom", exact: true })
	await expect
		.poll(
			async () => {
				if (await message.isVisible().catch(() => false)) return true
				if (await scrollToBottom.isVisible().catch(() => false)) {
					await scrollToBottom.click().catch(() => undefined)
				}
				return message.isVisible().catch(() => false)
			},
			{ timeout: options.timeout ?? 30_000 },
		)
		.toBe(true)
	return message
}

export async function sendWorkMessage(sidebar: Frame, text: string, timeoutMs = 60_000): Promise<Locator> {
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled({ timeout: timeoutMs })
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	return expectWorkMessageVisible(sidebar, text, { timeout: timeoutMs })
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
