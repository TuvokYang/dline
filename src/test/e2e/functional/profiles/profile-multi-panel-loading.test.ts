import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Page } from "@playwright/test"

/**
 * P0 regression guards for the bottom-bar Profile selector.
 *
 * 1. Every editor panel must resolve its Profile Catalog. A panel stuck on
 *    "Loading profiles…" means its `getApiProfiles` RPC never settled.
 * 2. An in-task Profile switch must leave the preflight phase. A switcher stuck on
 *    "Checking target Profile..." means the context-transition lease was never released.
 */

const LOADING_PROFILES_TEXT = "Loading profiles…"
const PREFLIGHT_TEXT = "Checking target Profile..."

async function findAdditionalDlineFrame(page: Page, existingFrames: ReadonlySet<Frame>): Promise<Frame> {
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

function modelSwitcher(frame: Frame) {
	return frame.getByRole("button", { name: "Select model" })
}

/** Fail with the observed label instead of a bare timeout so the stuck phase is visible. */
async function expectProfileCatalogResolved(frame: Frame, label: string): Promise<void> {
	await expect
		.poll(async () => (await modelSwitcher(frame).innerText()).trim(), { timeout: 20_000 })
		.not.toContain(LOADING_PROFILES_TEXT)
	const resolvedText = (await modelSwitcher(frame).innerText()).trim()
	expect(resolvedText, `${label} did not resolve its Profile Catalog`).not.toBe("")
	expect(resolvedText, `${label} reported an unavailable Profile Catalog`).not.toContain("Profiles unavailable")
}

e2e(
	"Profile selector - every concurrently opened editor panel resolves its Profile Catalog",
	async ({ helper, page, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await E2ETestHelper.dismissWhatsNewModal(sidebar)
		await helper.signin(sidebar)
		await expectProfileCatalogResolved(sidebar, "sidebar")

		// Open several panels without awaiting each Catalog so their Controllers,
		// `getApiProfiles` RPCs, and `flushPendingState` writes overlap in one process.
		const panels: Frame[] = []
		for (let index = 0; index < 6; index++) {
			panels.push(await createDlinePanel(page))
		}

		for (const [index, panel] of panels.entries()) {
			await expectProfileCatalogResolved(panel, `panel ${index + 1}`)
		}
		// The sidebar must not regress once several panels share the process-local Catalog.
		await expectProfileCatalogResolved(sidebar, "sidebar after panels")

		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Profile selector - an in-task Profile switch leaves preflight and adopts the target Profile",
	async ({ helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await E2ETestHelper.dismissWhatsNewModal(sidebar)
		await helper.signin(sidebar)

		server.resetOpenAiMock()
		server.enqueueResponses("openai-compatible-chat", {
			type: "tool",
			id: "call_profile_switch_ready",
			name: "qna_respond",
			arguments: { response: "E2E_PROFILE_SWITCH_TASK_READY" },
		})

		const input = sidebar.getByTestId("chat-input")
		await expect(input).toBeEnabled({ timeout: 60_000 })
		await input.fill("E2E_PROFILE_SWITCH_ACTIVE_TASK")
		await sidebar.getByTestId("send-button").click()
		await expect(sidebar.getByText("E2E_PROFILE_SWITCH_TASK_READY", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})

		const switcher = modelSwitcher(sidebar)
		await expect(switcher).toBeEnabled({ timeout: 30_000 })
		await switcher.click()
		const targetOption = sidebar
			.getByRole("option")
			.filter({ has: sidebar.getByText(E2E_PROFILE_NAMES.mockOpenAiResponses, { exact: true }) })
		await expect(targetOption).toHaveCount(1)
		await targetOption.click()

		// The transition must settle: no permanent preflight and no permanently disabled control.
		await expect.poll(async () => (await switcher.innerText()).trim(), { timeout: 45_000 }).not.toContain(PREFLIGHT_TEXT)
		await expect(switcher).toBeEnabled({ timeout: 30_000 })
		await expect(switcher).toHaveText(E2E_PROFILE_NAMES.mockOpenAiResponses, { timeout: 30_000 })

		// A second switch must not be rejected by a retained transition lease.
		await switcher.click()
		const returnOption = sidebar
			.getByRole("option")
			.filter({ has: sidebar.getByText(E2E_PROFILE_NAMES.mockOpenAi, { exact: true }) })
		await expect(returnOption).toHaveCount(1)
		await returnOption.click()
		await expect(switcher).toHaveText(E2E_PROFILE_NAMES.mockOpenAi, { timeout: 45_000 })

		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)
