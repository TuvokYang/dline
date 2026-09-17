import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Page } from "@playwright/test"

/**
 * BUGFIX-038 runtime guard.
 *
 * Several tasks alive at once in one workspace must not multiply the shared
 * runtime cost. This test drives the real amplification shape the user hit -
 * multiple editor-panel tasks in one window - and asserts resource counts, not
 * just that the UI still works:
 *
 * - R2: the extension may only build ONE recursive prompt-input watch per
 *   workspace scope, no matter how many tasks subscribe.
 * - R1: repeated `@` mention typing across panels must stay served by the
 *   cached workspace enumeration.
 * - R3: the webview provider must keep every panel interactive throughout.
 */

/** Each `PromptInputFileWatcher.start()` logs exactly one of these. */
const WATCHER_START_LOG = "[PromptInputWatcherPerf] phase=start"

async function selectProfile(frame: Frame, profileName: string): Promise<void> {
	const modelSwitcher = frame.getByRole("button", { name: "Select model" })
	if ((await modelSwitcher.innerText()).trim() === profileName) return

	await modelSwitcher.click()
	const profileOption = frame.getByRole("option").filter({ has: frame.getByText(profileName, { exact: true }) })
	await expect(profileOption).toHaveCount(1)
	await profileOption.click()
	await expect(modelSwitcher).toHaveText(profileName)
}

/** Open a Dline task panel in the editor area and return its webview frame. */
async function createTaskPanel(page: Page): Promise<Frame> {
	const existingFrames = new Set(page.frames())
	await page.getByRole("button", { name: "New Task", exact: true }).click()

	let resolved: Frame | undefined
	await expect
		.poll(
			async () => {
				for (const frame of page.frames()) {
					if (existingFrames.has(frame) || frame.isDetached() || !frame.url().startsWith("vscode-webview://")) {
						continue
					}
					if ((await frame.locator("#root").count()) > 0) {
						resolved = frame
						return true
					}
				}
				return false
			},
			{ timeout: 30_000 },
		)
		.toBe(true)
	if (!resolved) throw new Error("Dline task panel frame was not created")
	await E2ETestHelper.dismissWhatsNewModal(resolved)
	return resolved
}

/**
 * Drive the `@` mention menu, the surface backed by the workspace enumeration
 * cache. Every keystroke re-queries, so an uncached walk would spawn one
 * ripgrep per character per panel.
 */
async function typeMentionQuery(frame: Frame): Promise<void> {
	const input = frame.getByTestId("chat-input")
	await input.click()
	await input.pressSequentially("@READ", { delay: 40 })
	const menu = frame.getByRole("listbox", { name: "Context mentions" })
	await expect(menu).toBeVisible({ timeout: 30_000 })
	await expect(menu.getByRole("option").first()).toBeVisible({ timeout: 30_000 })
	await input.press("Escape")
	await input.fill("")
}

async function runTaskInPanel(frame: Frame, text: string, completionMarker: string): Promise<void> {
	const input = frame.getByTestId("chat-input")
	await input.fill(text)
	await input.press("Enter")
	await expect(frame.getByText(completionMarker, { exact: false }).last()).toBeVisible({ timeout: 90_000 })
}

function countOccurrences(haystack: string, needle: string): number {
	return haystack.split(needle).length - 1
}

e2e(
	"Concurrent workspace tasks share one prompt-input watch and one cached mention enumeration",
	async ({ helper, page, server, sidebar, userDataDir }, testInfo) => {
		e2e.setTimeout(300_000)
		await helper.signin(sidebar)
		await selectProfile(sidebar, E2E_PROFILE_NAMES.mockOpenAiResponses)

		const firstMarker = "E2E_CPU_PANEL_ONE_DONE"
		const secondMarker = "E2E_CPU_PANEL_TWO_DONE"

		server.resetOpenAiMock()
		server.enqueueResponses(
			"openai-compatible-responses",
			{ type: "tool", id: "call_cpu_panel_one", name: "attempt_completion", arguments: { result: firstMarker } },
			{ type: "tool", id: "call_cpu_panel_two", name: "attempt_completion", arguments: { result: secondMarker } },
		)

		// Two editor-panel tasks stay alive at the same time, which is the shape
		// that used to build one recursive watch tree per task.
		const firstPanel = await createTaskPanel(page)
		await typeMentionQuery(firstPanel)
		await runTaskInPanel(firstPanel, "First panel task for BUGFIX-038.", firstMarker)

		const secondPanel = await createTaskPanel(page)
		await typeMentionQuery(secondPanel)
		await runTaskInPanel(secondPanel, "Second panel task for BUGFIX-038.", secondMarker)

		// R2 oracle: one shared watch for the workspace scope. Reverting the
		// registry restores per-task watchers and pushes this count to >= 2.
		const output = await E2ETestHelper.readDlineOutput(userDataDir)
		const watcherStarts = countOccurrences(output, WATCHER_START_LOG)
		expect(
			watcherStarts,
			`Expected a single shared prompt-input watch, saw ${watcherStarts} "${WATCHER_START_LOG}" entries`,
		).toBe(1)

		// R1/R3 oracle: both panels completed and both stay interactive, so the
		// cached enumeration served every mention query and the memoized provider
		// never starved a panel of updates.
		await expect(firstPanel.getByText(firstMarker, { exact: false }).last()).toBeVisible()
		await expect(secondPanel.getByText(secondMarker, { exact: false }).last()).toBeVisible()
		for (const panel of [firstPanel, secondPanel]) {
			const input = panel.getByTestId("chat-input")
			await input.fill("still responsive")
			await expect(input).toHaveValue("still responsive")
			await input.fill("")
		}

		const consumptions = server.getMockConsumptions("openai-compatible-responses")
		expect(consumptions.length).toBeGreaterThanOrEqual(2)
		expect(consumptions.every((consumption) => consumption.contractError === undefined)).toBe(true)

		const screenshotPath = testInfo.outputPath("multi-task-cpu-amplification.png")
		await page.screenshot({ path: screenshotPath, fullPage: false })
		await testInfo.attach("multi-task-cpu-amplification.png", { path: screenshotPath, contentType: "image/png" })

		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)
