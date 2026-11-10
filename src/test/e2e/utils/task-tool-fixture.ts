import { expect, type Frame } from "@playwright/test"

export async function setAutoApproveAction(sidebar: Frame, label: string, enabled: boolean): Promise<void> {
    await sidebar.getByLabel("Open auto-approve settings").click()
    const checkbox = sidebar.locator("vscode-checkbox").filter({ hasText: label })
    await expect(checkbox).toHaveCount(1)
    const isChecked = () => checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))
    if ((await isChecked()) !== enabled) {
        await sidebar.getByText(label, { exact: true }).click()
    }
    await expect.poll(isChecked).toBe(enabled)
    await sidebar.getByLabel("Close auto-approve settings").click()
}

export async function sendTask(sidebar: Frame, text: string): Promise<void> {
    const input = sidebar.getByTestId("chat-input")
    await input.fill(text)
    await sidebar.getByTestId("send-button").click()
    await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}
