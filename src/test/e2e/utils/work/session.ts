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

export async function clickWorkScrollToBottom(
	button: Locator,
	assertLatestReady: () => Promise<void>,
	timeoutMs = 5_000,
): Promise<void> {
	if (await button.count()) {
		try {
			await button.click({ timeout: Math.min(5_000, timeoutMs) })
		} catch (error) {
			// Reaching the intended tail can remove the control during click actionability checks.
			// A control that is still present must remain normally clickable.
			if (await button.count()) throw error
		}
	}
	// Neither a missing control nor the bottom of a loaded message window proves arrival at the conversation tail.
	await assertLatestReady()
}

export async function waitForWorkNavigationReady(
	button: Locator,
	isLatestInViewport: () => Promise<boolean>,
	timeoutMs = 5_000,
): Promise<void> {
	await expect.poll(async () => (await button.count()) > 0 || (await isLatestInViewport()), { timeout: timeoutMs }).toBe(true)
}

export async function scrollWorkToLatest(sidebar: Frame, expectedLatest: Locator, timeoutMs = 5_000): Promise<void> {
	const scroller = sidebar.locator('[data-virtuoso-scroller="true"]')
	await expect(scroller).toBeVisible()
	// Use the transcript gutter so an expanded tool's nested scroller cannot consume the wheel.
	await scroller.hover({ position: { x: 4, y: 40 } })
	await sidebar.page().mouse.wheel(0, 120)
	const scrollToBottom = sidebar.getByRole("button", { name: "Scroll to bottom", exact: true })
	const availabilityDeadline = Date.now() + timeoutMs
	await waitForWorkNavigationReady(
		scrollToBottom,
		async () => {
			if (!(await expectedLatest.isVisible())) return false
			// Virtualized overscan can mount a CSS-visible target outside the viewport before the control appears.
			return expectedLatest.evaluateAll(
				(elements, observationTimeoutMs) => {
					if (elements.length !== 1) return false
					return new Promise<boolean>((resolve, reject) => {
						const observer = new IntersectionObserver(([entry]) => {
							window.clearTimeout(timer)
							observer.disconnect()
							resolve(entry.intersectionRatio > 0)
						})
						const timer = window.setTimeout(() => {
							observer.disconnect()
							reject(new Error("Timed out observing the latest Work item in the viewport"))
						}, observationTimeoutMs)
						observer.observe(elements[0])
					})
				},
				Math.max(1, availabilityDeadline - Date.now()),
			)
		},
		timeoutMs,
	)
	await clickWorkScrollToBottom(
		scrollToBottom,
		async () => {
			// Preserve the old availability/click/final-check phase bounds; both semantic assertions share the final phase.
			const deadline = Date.now() + timeoutMs
			const remainingTimeout = () => Math.max(1, deadline - Date.now())
			await expect(expectedLatest).toBeVisible({ timeout: remainingTimeout() })
			await expect(expectedLatest).toBeInViewport({ timeout: remainingTimeout() })
		},
		timeoutMs,
	)
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
