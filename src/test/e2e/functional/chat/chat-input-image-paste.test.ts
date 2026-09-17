import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Locator } from "@playwright/test"

const ONE_PIXEL_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

interface PasteObservation {
	dispatchReturned: boolean
	observedItemTypes: string[]
}

async function pasteScreenshot(input: Locator): Promise<PasteObservation> {
	return input.evaluate((element, encodedPng) => {
		const textArea = element as HTMLTextAreaElement
		let observedItemTypes: string[] = []
		textArea.addEventListener(
			"paste",
			(event) => {
				observedItemTypes = Array.from(event.clipboardData?.items ?? []).map((item) => item.type)
			},
			{ capture: true, once: true },
		)

		const binary = atob(encodedPng)
		const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0))
		const screenshot = new File([bytes], "clipboard-screenshot.png", { type: "image/png" })
		const clipboardData = new DataTransfer()
		clipboardData.items.add(screenshot)
		const pasteEvent = new ClipboardEvent("paste", {
			bubbles: true,
			cancelable: true,
			clipboardData,
		})

		return {
			dispatchReturned: textArea.dispatchEvent(pasteEvent),
			observedItemTypes,
		}
	}, ONE_PIXEL_PNG_BASE64)
}

e2e("Chat input - screenshot paste stays available while a task is running", async ({ helper, server, sidebar, userDataDir }) => {
	e2e.setTimeout(180_000)
	await helper.signin(sidebar)
	server.resetOpenAiMock()
	server.enqueueOpenAiResponses({
		type: "tool",
		name: "attempt_completion",
		arguments: { result: "E2E_RUNNING_SCREENSHOT_PASTE_DONE" },
		delayMs: 15_000,
	})

	const input = sidebar.getByTestId("chat-input")
	await input.fill("E2E_RUNNING_SCREENSHOT_PASTE_TASK")
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText("E2E_RUNNING_SCREENSHOT_PASTE_TASK", { exact: true }).first()).toBeVisible()
	await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(1)
	await expect(sidebar.getByRole("button", { name: "Cancel", exact: true }).first()).toBeVisible({ timeout: 30_000 })

	const runningDraft = "E2E_RUNNING_SCREENSHOT_PASTE_DRAFT"
	await input.fill(runningDraft)
	await expect(input).toHaveValue(runningDraft)

	const pasteObservation = await pasteScreenshot(input)
	expect(pasteObservation).toEqual({ dispatchReturned: false, observedItemTypes: ["image/png"] })
	await expect(sidebar.getByAltText("Thumbnail image-1")).toBeVisible()
	await expect(input).toHaveValue(runningDraft)
	await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
})
