import { readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { MockApiConsumption } from "@e2e/fixtures/server"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Page } from "@playwright/test"
import type { ElectronApplication } from "playwright"

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

interface StoredSettings {
	useAutoCondense?: boolean
	autoCondenseTriggerPercent?: number
	autoCondenseMinReserveTokens?: number
	autoCondenseMaxReserveTokens?: number
	autoCondenseMaxContextTokens?: number
	actModeProfile?: string
	planModeProfile?: string
}

const COMPACT_INSTRUCTION_MARKER = "The current conversation is rapidly running out of context"
const profilesPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "api_profiles.json")
const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")

async function configureLongContextMock(dlineDir: string): Promise<void> {
	const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
	const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
	if (!profile?.openai?.capabilities) throw new Error("Missing configurable OpenAI Responses E2E profile")
	profile.modelId = "gpt-5.4-mini"
	profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
	profile.openai.capabilities.contextWindow = 1_000_000
	await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

	const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as StoredSettings
	await writeFile(
		settingsPath(dlineDir),
		`${JSON.stringify(
			{
				...settings,
				actModeProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
				planModeProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
			},
			null,
			2,
		)}\n`,
		"utf8",
	)
}

async function readSettings(dlineDir: string): Promise<StoredSettings> {
	return JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as StoredSettings
}

async function openSidebar(
	app: ElectronApplication,
	helper: E2ETestHelper,
): Promise<{ page: Awaited<ReturnType<ElectronApplication["firstWindow"]>>; sidebar: Frame }> {
	const page = await app.firstWindow()
	await E2ETestHelper.openClineSidebar(page)
	const sidebar = await helper.getSidebar(page)
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	await helper.signin(sidebar)
	return { page, sidebar }
}

async function openFeatureSettings(page: Page, sidebar: Frame): Promise<void> {
	await page.getByRole("button", { name: "Settings", exact: true }).click()
	await expect(sidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible()
	await sidebar.getByTestId("tab-features").click()
	await expect(sidebar.getByRole("heading", { name: "Feature Settings" })).toBeVisible()
}

async function setRangeValue(range: ReturnType<Frame["getByRole"]>, value: number): Promise<void> {
	const minimum = Number(await range.getAttribute("aria-valuemin"))
	await range.focus()
	await range.press("Home")
	for (let current = minimum; current < value; current += 1) {
		await range.press("ArrowRight")
	}
	await expect(range).toHaveAttribute("aria-valuenow", String(value))
}

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled()
	await input.fill(text)
	await input.press("Enter")
	await expect(input).toHaveValue("")
	await expect(sidebar.getByText(text, { exact: true }).last()).toBeVisible()
}

function requestToolNames(consumption: MockApiConsumption): string[] {
	const body = consumption.requestBody as {
		tools?: Array<{ name?: string; function?: { name?: string } }>
	}
	return (body.tools ?? [])
		.map((tool) => tool.name ?? tool.function?.name)
		.filter((name): name is string => typeof name === "string")
}

async function expectCompactionSummary(sidebar: Frame, summary: string): Promise<void> {
	await expect(sidebar.getByText(summary, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
	const visibleText = await sidebar.locator("body").innerText()
	expect(visibleText).not.toContain("The current conversation is rapidly running out of context")
}

e2e(
	"Auto compact settings - user configuration persists and controls summarize_task",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(240_000)
		await configureLongContextMock(dlineDir)
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_auto_settings_ready",
				name: "qna_respond",
				arguments: { response: "E2E_AUTO_SETTINGS_READY" },
				usage: { inputTokens: 120_000, outputTokens: 100 },
			},
			{
				type: "message",
				text: "<thinking>E2E auto settings summary</thinking><summarize_task><context>E2E_AUTO_SETTINGS_SUMMARY preserves the task and latest request.</context></summarize_task>",
				expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER],
				expectedRequestExcludes: ["E2E_AUTO_SETTINGS_CONTINUE"],
			},
			{
				type: "tool",
				id: "call_auto_settings_complete",
				name: "attempt_completion",
				arguments: { result: "E2E_AUTO_SETTINGS_OK" },
				expectedRequestIncludes: ["E2E_AUTO_SETTINGS_SUMMARY", "E2E_AUTO_SETTINGS_CONTINUE"],
				expectedRequestExcludes: [COMPACT_INSTRUCTION_MARKER],
			},
		)

		let settingsApp: ElectronApplication | undefined
		let taskApp: ElectronApplication | undefined
		try {
			settingsApp = await openVSCode(workspaceDir)
			const { page, sidebar } = await openSidebar(settingsApp, helper)
			await openFeatureSettings(page, sidebar)

			const autoCompactSwitch = sidebar.locator('[id="Auto Compact"]')
			await expect(autoCompactSwitch).toHaveAttribute("aria-checked", "false")
			await autoCompactSwitch.click()
			await expect(autoCompactSwitch).toHaveAttribute("aria-checked", "true")
			await expect.poll(async () => await readSettings(dlineDir)).toMatchObject({ useAutoCondense: true })

			const triggerSlider = sidebar.locator('[aria-label="Compression point (%)"] [role="slider"]')
			await setRangeValue(triggerSlider, 60)
			const minReserveInput = sidebar.getByLabel("Minimum reserve (K tokens)")
			const maxReserveInput = sidebar.getByLabel("Maximum reserve (K tokens)")
			await minReserveInput.fill("10")
			await maxReserveInput.fill("40")
			await maxReserveInput.press("Tab")
			const maxContextInput = sidebar.getByLabel("Maximum context (K tokens)")
			await maxContextInput.fill("100")
			await maxContextInput.press("Tab")

			await expect
				.poll(async () => await readSettings(dlineDir))
				.toMatchObject({
					useAutoCondense: true,
					autoCondenseTriggerPercent: 60,
					autoCondenseMinReserveTokens: 10_000,
					autoCondenseMaxReserveTokens: 40_000,
					autoCondenseMaxContextTokens: 100_000,
				})

			const screenshotPath = e2e.info().outputPath("auto-condense-settings.png")
			await page.screenshot({ path: screenshotPath })
			await e2e.info().attach("auto-condense-settings", { path: screenshotPath, contentType: "image/png" })

			await settingsApp.close()
			settingsApp = undefined
			helper.clearCachedFrame()

			taskApp = await openVSCode(workspaceDir)
			const reopened = await openSidebar(taskApp, helper)
			await openFeatureSettings(reopened.page, reopened.sidebar)
			await expect(reopened.sidebar.locator('[id="Auto Compact"]')).toHaveAttribute("aria-checked", "true")
			await expect(reopened.sidebar.locator('[aria-label="Compression point (%)"] [role="slider"]')).toHaveAttribute(
				"aria-valuenow",
				"60",
			)
			await expect(reopened.sidebar.getByLabel("Minimum reserve (K tokens)")).toHaveValue("10")
			await expect(reopened.sidebar.getByLabel("Maximum reserve (K tokens)")).toHaveValue("40")
			await expect(reopened.sidebar.getByLabel("Maximum context (K tokens)")).toHaveValue("100")

			await reopened.sidebar.getByRole("button", { name: "Done", exact: true }).click()
			await expect(reopened.sidebar.getByTestId("chat-input")).toBeVisible()
			await sendTask(reopened.sidebar, "E2E_AUTO_SETTINGS_TASK")
			await expect(reopened.sidebar.getByText("E2E_AUTO_SETTINGS_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await sendTask(reopened.sidebar, "E2E_AUTO_SETTINGS_CONTINUE")
			await expect(reopened.sidebar.getByText("E2E_AUTO_SETTINGS_OK", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})

			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(3)
			const requests = server.getMockConsumptions("openai-compatible-responses")
			expect(requests[1]).toMatchObject({ responseType: "message" })
			expect(requestToolNames(requests[1])).toEqual(requestToolNames(requests[0]))
			expect(requestToolNames(requests[1])).not.toContain("summarize_task")
			expect(requests[1].contractError).toBeUndefined()
			expect(requests[2].contractError).toBeUndefined()
			await expectCompactionSummary(reopened.sidebar, "E2E_AUTO_SETTINGS_SUMMARY preserves the task and latest request.")
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await settingsApp?.close()
			await taskApp?.close()
		}
	},
)
