import { expect, type Frame, type Locator } from "@playwright/test"

/** The row that owns a capability name, including its enable switch. */
export function capabilityRow(sidebar: Frame, name: string): Locator {
	return sidebar.getByText(name, { exact: true }).locator("xpath=ancestor::div[contains(@class, 'mb-2.5')][1]")
}

/** Flip a capability switch and wait until the rendered state reflects the new value. */
export async function toggleCapability(sidebar: Frame, name: string, enabled: boolean): Promise<void> {
	const toggle = capabilityRow(sidebar, name).getByRole("switch")
	await expect(toggle).toHaveAttribute("data-state", enabled ? "unchecked" : "checked")
	await toggle.click()
	await expect(toggle).toHaveAttribute("data-state", enabled ? "checked" : "unchecked")
}
