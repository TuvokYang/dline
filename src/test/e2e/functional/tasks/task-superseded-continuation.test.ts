import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"

const TARGET = "anthropic-messages" as const
/** How long the cancelled Provider stream stays open after its visible text. */
const SUPERSEDED_STREAM_HOLD_MS = 25_000

async function selectProfile(sidebar: Frame, profileName: string): Promise<void> {
	const modelSwitcher = sidebar.getByRole("button", { name: "Select model" })
	if ((await modelSwitcher.innerText()).trim() === profileName) return
	await modelSwitcher.click()
	await expect(sidebar.getByText("Available Models", { exact: true })).toBeVisible()
	const profileOption = sidebar.getByRole("option").filter({ has: sidebar.getByText(profileName, { exact: true }) })
	await expect(profileOption).toHaveCount(1)
	await profileOption.click()
	await expect(modelSwitcher).toHaveText(profileName)
	await expect(sidebar.getByText("Available Models", { exact: true })).not.toBeVisible()
}

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

e2e(
	"Task lifecycle - a cancelled stream that ends after Resume does not continue the superseded request loop",
	async ({ helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(240_000)
		await helper.signin(sidebar)
		await selectProfile(sidebar, E2E_PROFILE_NAMES.mockAnthropic)
		server.clearPendingResponses(TARGET)
		server.enqueueResponses(
			TARGET,
			{
				// Anthropic has no transport abort, so this stream outlives Cancel and
				// Resume exactly like the Provider stream in the reported task.
				type: "message",
				text: "E2E_SUPERSEDED_STREAM_TEXT",
				beforeUsageDelayMs: SUPERSEDED_STREAM_HOLD_MS,
			},
			{
				type: "tool",
				name: "attempt_completion",
				arguments: { result: "E2E_SUPERSEDED_RESUME_OK" },
				expectedRequestIncludes: ["E2E_SUPERSEDED_RESUME_DRAFT"],
			},
			{
				type: "error",
				status: 500,
				code: "unexpected_superseded_request",
				message: "A superseded continuation sent another Provider request",
			},
		)

		await sendTask(sidebar, "E2E_SUPERSEDED_CONTINUATION_TASK")
		await expect.poll(() => server.getRequestCount(TARGET), { timeout: 60_000 }).toBe(1)
		const supersededStreamStartedAt = Date.now()
		await expect(sidebar.getByText("E2E_SUPERSEDED_STREAM_TEXT", { exact: false }).last()).toBeVisible({
			timeout: 30_000,
		})

		const cancelButton = sidebar.getByRole("button", { name: "Cancel", exact: true }).first()
		await expect(cancelButton).toBeVisible({ timeout: 30_000 })
		await cancelButton.click()

		const resumeButton = sidebar.getByRole("button", { name: "Resume", exact: true }).first()
		await expect(resumeButton).toBeVisible({ timeout: 30_000 })
		const input = sidebar.getByTestId("chat-input")
		await expect(input).toBeEnabled()
		await input.fill("E2E_SUPERSEDED_RESUME_DRAFT")
		await resumeButton.click()
		await expect(sidebar.getByText("E2E_SUPERSEDED_RESUME_OK", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => server.getRequestCount(TARGET)).toBe(2)
		expect(Date.now() - supersededStreamStartedAt).toBeLessThan(SUPERSEDED_STREAM_HOLD_MS)

		// Let the superseded stream finish, then give its request loop time to act.
		const settleMs = SUPERSEDED_STREAM_HOLD_MS + 12_000 - (Date.now() - supersededStreamStartedAt)
		await page.waitForTimeout(Math.max(0, settleMs))

		expect(server.getRequestCount(TARGET)).toBe(2)
		const unexpectedRequests = server
			.getMockConsumptions(TARGET)
			.slice(2)
			.map((consumption) => JSON.stringify(consumption.requestBody).slice(-400))
		expect(unexpectedRequests).toEqual([])
		await expect(sidebar.getByTestId("error-retry-box")).toHaveCount(0)
		await expect(sidebar.locator('vscode-button[aria-label="Retry"]')).toHaveCount(0)
		await expect(sidebar.getByText("API Request Failed", { exact: false })).toHaveCount(0)
		await expect(sidebar.getByText("You did not use a tool", { exact: false })).toHaveCount(0)
		const taskFooter = sidebar.getByRole("contentinfo")
		await expect(taskFooter.getByText("Start New Task", { exact: true })).toBeVisible()
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)
