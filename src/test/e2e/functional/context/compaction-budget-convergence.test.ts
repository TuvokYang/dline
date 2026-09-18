import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { type ElectronApplication, expect, type Frame } from "@playwright/test"

/**
 * BUGFIX-026: compaction must converge even when a Pass is measured as oversized.
 *
 * A conversation carrying large base64 screenshots used to deadlock: the planner selected a range
 * it considered feasible, the hidden Pass request rejected that exact range, and nothing shrank the
 * range for the next attempt. The task could no longer make progress. Compaction must instead
 * narrow the range until a Pass fits, so the task continues.
 */

interface StoredProfile {
	name: string
	modelId?: string
	webToolsMode?: "WEB_TOOLS_MODE_FORCE_OFF"
	openai?: {
		capabilities?: {
			contextWindow?: number
		}
	}
}

const ONE_PIXEL_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII="

const profilesPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "api_profiles.json")
const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")

async function configureImageHeavyCompaction(dlineDir: string): Promise<void> {
	const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
	const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
	if (!profile?.openai?.capabilities) throw new Error("Missing configurable OpenAI Responses E2E profile")
	profile.modelId = "gpt-5.6-sol"
	profile.openai.capabilities.contextWindow = 472_000
	profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
	await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

	const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
	await writeFile(
		settingsPath(dlineDir),
		`${JSON.stringify(
			{
				...settings,
				actModeProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
				planModeProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
				useAutoCondense: true,
				autoCondenseTriggerPercent: 95,
				autoCondenseMinReserveTokens: 5_000,
				autoCondenseMaxReserveTokens: 30_000,
				autoCondenseMaxContextTokens: 0,
			},
			null,
			2,
		)}\n`,
		"utf8",
	)
}

async function openSidebar(app: ElectronApplication, helper: E2ETestHelper): Promise<Frame> {
	const page = await app.firstWindow()
	await E2ETestHelper.openClineSidebar(page)
	const sidebar = await helper.getSidebar(page)
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	await helper.signin(sidebar)
	return sidebar
}

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled({ timeout: 60_000 })
	await input.fill(text)
	await input.press("Enter")
	await expect(input).toHaveValue("")
	// The turn that triggers compaction renders its user message once the hidden Pass is admitted,
	// so the echo is matched loosely and given the compaction admission budget.
	await expect(sidebar.getByText(text, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
}

/** Paste a valid PNG padded to a screenshot-sized payload, as read_file does for e2e failures. */
async function pasteLargeScreenshot(sidebar: Frame, trailingBytes: number): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await input.evaluate(
		(element, payload) => {
			const binary = atob(payload.encodedPng)
			const png = Uint8Array.from(binary, (character) => character.charCodeAt(0))
			const bytes = new Uint8Array(png.length + payload.trailingBytes)
			bytes.set(png)
			const screenshot = new File([bytes], "compaction-convergence-screenshot.png", { type: "image/png" })
			const clipboardData = new DataTransfer()
			clipboardData.items.add(screenshot)
			element.dispatchEvent(new ClipboardEvent("paste", { bubbles: true, cancelable: true, clipboardData }))
		},
		{ encodedPng: ONE_PIXEL_PNG_BASE64, trailingBytes },
	)
	await expect(sidebar.getByAltText("Thumbnail image-1")).toBeVisible()
}

e2e(
	"Compaction convergence - an image-heavy history still compacts and the task continues",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(240_000)
		await configureImageHeavyCompaction(dlineDir)

		const screenshotTurnMarker = "E2E_CONVERGENCE_SCREENSHOT_TURN"
		const summaryMarker = "E2E_CONVERGENCE_SUMMARY"
		const continuationMarker = "E2E_CONVERGENCE_CONTINUE"

		server.resetOpenAiMock()
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_convergence_ready",
				name: "qna_respond",
				arguments: { response: "E2E_CONVERGENCE_READY" },
				usage: { inputTokens: 120_000, outputTokens: 100 },
				matchRequestContract: true,
			},
			{
				type: "tool",
				id: "call_convergence_after_screenshot",
				name: "qna_respond",
				arguments: { response: "E2E_CONVERGENCE_SCREENSHOT_ACK" },
				// Push the projected usage close to the hard Pass window so the next turn must compact.
				usage: { inputTokens: 448_000, outputTokens: 100 },
				matchRequestContract: true,
			},
			{
				type: "tool",
				id: "call_convergence_summary",
				name: "summarize_task",
				arguments: { context: `${summaryMarker} preserves the task and the screenshot turn.` },
				expectedRequestIncludes: ["The current conversation is rapidly running out of context"],
				matchRequestContract: true,
			},
			{
				type: "tool",
				id: "call_convergence_complete",
				name: "attempt_completion",
				arguments: { result: "E2E_CONVERGENCE_OK" },
				expectedRequestIncludes: [summaryMarker, continuationMarker],
				expectedRequestExcludes: ["The current conversation is rapidly running out of context"],
				matchRequestContract: true,
			},
		)

		const app = await openVSCode(workspaceDir)
		try {
			const sidebar = await openSidebar(app, helper)
			await sendTask(sidebar, "E2E_CONVERGENCE_TASK")
			await expect(sidebar.getByText("E2E_CONVERGENCE_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})

			const input = sidebar.getByTestId("chat-input")
			await expect(input).toBeEnabled()
			await input.fill(screenshotTurnMarker)
			await pasteLargeScreenshot(sidebar, 320_000)
			await sidebar.getByTestId("send-button").click()
			await expect(sidebar.getByText("E2E_CONVERGENCE_SCREENSHOT_ACK", { exact: false }).last()).toBeVisible({
				timeout: 90_000,
			})

			// The next turn must compact. Before the fix the hidden Pass was rejected with
			// "no available output budget" and the planner reproposed the same range forever.
			await sendTask(sidebar, continuationMarker)

			const completedPass = sidebar.getByTestId("compaction-pass").last()
			await expect(completedPass).toHaveAttribute("data-compaction-status", "completed", { timeout: 150_000 })
			await expect(sidebar.getByTestId("compaction-failure")).toHaveCount(0)
			await expect(sidebar.getByText("E2E_CONVERGENCE_OK", { exact: false }).last()).toBeVisible({ timeout: 90_000 })

			const requests = server.getMockConsumptions("openai-compatible-responses")
			expect(requests.every((request) => request.contractError === undefined)).toBe(true)
			expect(requests.map((request) => request.toolName)).toEqual([
				"qna_respond",
				"qna_respond",
				"summarize_task",
				"attempt_completion",
			])
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)
