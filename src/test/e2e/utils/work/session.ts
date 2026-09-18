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
