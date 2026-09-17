import { readFile } from "node:fs/promises"
import path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Page } from "@playwright/test"

const TASK_TEXT = "E2E_SYSTEMIC_SINGLE_TASK_PERFORMANCE"
const TASK_READY = "E2E_SYSTEMIC_SINGLE_TASK_READY"
const PROFILE_LOADING_TEXT = "Loading profiles…"
const PROFILE_BUDGET_MS = 5_000
const TASK_REQUEST_BUDGET_MS = 8_000
const SETTINGS_BUDGET_MS = 5_000
const CLOSE_BUDGET_MS = 5_000

interface StoredSettingsFile {
	showFeatureTips?: boolean
	values?: {
		showFeatureTips?: boolean
	}
}

function elapsedMs(startedAt: number): number {
	return Math.round(performance.now() - startedAt)
}

function modelSwitcher(sidebar: Frame) {
	return sidebar.getByRole("button", { name: "Select model" })
}

async function waitForProfileCatalog(sidebar: Frame): Promise<number> {
	const startedAt = performance.now()
	await expect
		.poll(async () => (await modelSwitcher(sidebar).innerText()).trim(), { timeout: 30_000 })
		.not.toContain(PROFILE_LOADING_TEXT)
	const resolved = (await modelSwitcher(sidebar).innerText()).trim()
	expect(resolved).not.toBe("")
	expect(resolved).not.toContain("Profiles unavailable")
	return elapsedMs(startedAt)
}

async function selectProfile(sidebar: Frame, profileName: string): Promise<void> {
	const switcher = modelSwitcher(sidebar)
	if ((await switcher.innerText()).trim() === profileName) return
	await switcher.click()
	const option = sidebar.getByRole("option").filter({ has: sidebar.getByText(profileName, { exact: true }) })
	await expect(option).toHaveCount(1)
	await option.click()
	await expect(switcher).toHaveText(profileName, { timeout: 30_000 })
}

function settingsPath(dlineDir: string): string {
	return path.join(dlineDir, "data", "settings", "settings.json")
}

async function readShowFeatureTips(dlineDir: string): Promise<boolean | undefined> {
	const stored = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as StoredSettingsFile
	return stored.values?.showFeatureTips ?? stored.showFeatureTips
}

async function openFeatureSettings(page: Page, sidebar: Frame): Promise<void> {
	await page.getByRole("button", { name: "Settings", exact: true }).click()
	await expect(sidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible()
	await sidebar.getByTestId("tab-features").click()
	await expect(sidebar.getByRole("heading", { name: "Feature Settings" })).toBeVisible()
}

e2e.use({ installVsix: false })

e2e(
	"Systemic performance - one ordinary Task keeps Profile, Settings, startup, and Close responsive",
	async ({ dlineDir, helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)

		const profileMs = await waitForProfileCatalog(sidebar)
		await selectProfile(sidebar, E2E_PROFILE_NAMES.mockOpenAi)

		server.resetOpenAiMock()
		server.enqueueOpenAiResponses({
			type: "tool",
			id: "call_systemic_ready",
			name: "qna_respond",
			arguments: { response: TASK_READY },
		})

		const taskInput = sidebar.getByTestId("chat-input")
		await expect(taskInput).toBeEnabled({ timeout: 30_000 })
		await taskInput.fill(TASK_TEXT)
		const taskSubmittedAtMs = Date.now()
		await sidebar.getByTestId("send-button").click()
		await expect.poll(() => server.getRequestCount("openai-compatible-chat"), { timeout: 30_000 }).toBe(1)
		const firstRequest = server.getMockConsumptions("openai-compatible-chat")[0]
		if (!firstRequest) throw new Error("The ordinary Task never reached the mock provider")
		const taskRequestMs = firstRequest.receivedAtMs - taskSubmittedAtMs
		await expect(sidebar.getByText(TASK_READY, { exact: false }).last()).toBeVisible({ timeout: 60_000 })

		await openFeatureSettings(page, sidebar)
		const featureTips = sidebar.getByRole("switch", { name: "Feature Tips" })
		await expect(featureTips).toBeVisible()
		const initialFeatureTips = (await featureTips.getAttribute("aria-checked")) === "true"
		const expectedFeatureTips = !initialFeatureTips
		const settingsStartedAt = performance.now()
		await featureTips.click()
		await expect(featureTips).toHaveAttribute("aria-checked", String(expectedFeatureTips), { timeout: 30_000 })
		await expect.poll(() => readShowFeatureTips(dlineDir), { timeout: 30_000 }).toBe(expectedFeatureTips)
		const settingsMs = elapsedMs(settingsStartedAt)
		await sidebar.getByRole("button", { name: "Done", exact: true }).click()
		await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible({ timeout: 30_000 })

		const closeStartedAt = performance.now()
		await sidebar.getByRole("button", { name: "Close Task", exact: true }).click()
		await expect(sidebar.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 })
		await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toHaveCount(0)
		const closeMs = elapsedMs(closeStartedAt)

		const timings = { profileMs, taskRequestMs, settingsMs, closeMs }
		console.log(`[systemic-single-task-performance] ${JSON.stringify(timings)}`)
		await e2e.info().attach("systemic-single-task-performance.json", {
			body: Buffer.from(`${JSON.stringify(timings, null, 2)}\n`, "utf8"),
			contentType: "application/json",
		})

		expect(profileMs, `Profile Catalog must resolve under ${PROFILE_BUDGET_MS}ms`).toBeLessThan(PROFILE_BUDGET_MS)
		expect(taskRequestMs, `ordinary Task must reach the provider under ${TASK_REQUEST_BUDGET_MS}ms`).toBeLessThan(
			TASK_REQUEST_BUDGET_MS,
		)
		expect(settingsMs, `Settings durable mutation must finish under ${SETTINGS_BUDGET_MS}ms`).toBeLessThan(SETTINGS_BUDGET_MS)
		expect(closeMs, `Close Task must return to the empty composer under ${CLOSE_BUDGET_MS}ms`).toBeLessThan(CLOSE_BUDGET_MS)

		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [
			/Error getting latest git commit hash/i,
			/Dline instance aborted/i,
		])
	},
)
