import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Page } from "@playwright/test"

/**
 * Coverage for a newly opened panel rendering something.
 *
 * Symptom: opening a panel for a new task produced a blank view. The webview
 * returned `null` until the first state payload arrived, and `didHydrateState`
 * only ever moved forward on success — so a parse failure, a subscription
 * error and a stream that closed early all produced the same empty view, with
 * the only trace in a console the reporting user cannot be asked to open.
 *
 * The React tests cover the three states against a mocked context. What they
 * cannot show is that a real panel, driven by a real state subscription across
 * the host bridge, arrives at a rendered view at all. That is what this file
 * covers.
 */

/**
 * A VS Code webview is nested: an outer wrapper frame hosts the inner frame
 * that actually runs the React app. Both share the `vscode-webview://` scheme,
 * so the app root is what distinguishes them — matching on the URL alone
 * selects the wrapper, where none of the app's test ids exist.
 */
async function findAdditionalDlineFrame(page: Page, existingFrames: ReadonlySet<Frame>): Promise<Frame> {
	let resolved: Frame | undefined
	await expect
		.poll(
			async () => {
				for (const frame of page.frames()) {
					if (existingFrames.has(frame) || frame.isDetached() || !frame.url().startsWith("vscode-webview://")) {
						continue
					}
					try {
						if ((await frame.locator("#root").count()) === 0) {
							continue
						}
					} catch {
						// Frame detached or navigated mid-poll; try the next one.
						continue
					}
					resolved = frame
					return true
				}
				return false
			},
			{ timeout: 60_000 },
		)
		.toBe(true)
	if (!resolved) throw new Error("Dline editor panel frame was not created")
	return resolved
}

async function createDlinePanel(page: Page): Promise<Frame> {
	const existingFrames = new Set(page.frames())
	await page.getByRole("button", { name: "New Task", exact: true }).click()
	const panel = await findAdditionalDlineFrame(page, existingFrames)
	await E2ETestHelper.dismissWhatsNewModal(panel)
	return panel
}

/**
 * Visible text inside the app root, which is empty for the blank-panel defect.
 *
 * Read from `#root` rather than `body`: the webview host injects its own
 * markup around the app, and text from that wrapper would satisfy a
 * non-empty assertion even when the app itself rendered nothing.
 */
async function panelText(panel: Frame): Promise<string> {
	return panel.evaluate(() => {
		const root = document.querySelector("#root")
		if (!root) return ""
		return ((root as HTMLElement).innerText || root.textContent || "").trim()
	})
}

/**
 * Clears VS Code notification toasts.
 *
 * Toasts render above the editor area and swallow clicks aimed at the panel
 * beneath them. Leaving them up makes an interaction fail for a reason that
 * has nothing to do with the behavior under test.
 */
async function clearNotificationToasts(page: Page): Promise<void> {
	const clearButtons = page.getByRole("button", { name: "Clear Notification (Del)", exact: true })
	for (let attempt = 0; attempt < 5; attempt++) {
		if ((await clearButtons.count()) === 0) {
			return
		}
		await clearButtons
			.first()
			.click({ timeout: 5_000 })
			.catch(() => undefined)
	}
}

e2e(
	"Panel render - a newly opened panel renders content rather than a blank view",
	async ({ helper, page, sidebar, userDataDir }) => {
		e2e.setTimeout(240_000)
		await helper.signin(sidebar)

		const panel = await createDlinePanel(page)

		// The chat input is the first thing a usable panel offers. Its absence is
		// what the blank panel looked like from the user's side.
		await expect(panel.getByTestId("chat-input")).toBeVisible({ timeout: 60_000 })

		// Nothing rendered at all is the defect; assert on the body directly so a
		// future regression cannot pass by rendering only an invisible container.
		await expect.poll(() => panelText(panel).then((text) => text.length), { timeout: 60_000 }).toBeGreaterThan(0)

		// A panel that stalls in the loading state is also a failure: the fallback
		// exists to explain a wait, not to become the resting state.
		await expect(panel.getByTestId("hydration-pending")).toHaveCount(0)
		await expect(panel.getByTestId("hydration-failed")).toHaveCount(0)

		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e("Panel render - a panel stays usable while the sidebar is also open", async ({ helper, page, sidebar, userDataDir }) => {
	e2e.setTimeout(240_000)
	await helper.signin(sidebar)

	const panel = await createDlinePanel(page)
	await expect(panel.getByTestId("chat-input")).toBeVisible({ timeout: 60_000 })

	// Both webviews subscribe to state. The reported failure appeared with a
	// panel opened alongside the sidebar, so neither may end up blank.
	await expect(sidebar.getByTestId("chat-input")).toBeVisible({ timeout: 60_000 })
	await expect.poll(() => panelText(panel).then((text) => text.length), { timeout: 60_000 }).toBeGreaterThan(0)
	await expect(panel.getByTestId("hydration-failed")).toHaveCount(0)

	await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
})

e2e("Panel render - a task started in the panel reaches its result", async ({ helper, page, server, sidebar, userDataDir }) => {
	e2e.setTimeout(240_000)
	await helper.signin(sidebar)
	server.resetOpenAiMock()
	server.enqueueOpenAiResponses({
		type: "tool",
		id: "call_panel_done",
		name: "attempt_completion",
		arguments: { result: "E2E_PANEL_TASK_DONE" },
	})

	const panel = await createDlinePanel(page)
	const input = panel.getByTestId("chat-input")
	await expect(input).toBeVisible({ timeout: 60_000 })

	// A panel that renders but cannot run a task is only half recovered, so the
	// coverage goes past first paint to an actual result.
	await input.fill("Finish immediately from the panel.")
	await clearNotificationToasts(page)
	await panel.getByTestId("send-button").click()

	await expect(panel.getByText("E2E_PANEL_TASK_DONE", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
	await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
})
