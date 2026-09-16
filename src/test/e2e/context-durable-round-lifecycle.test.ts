import { readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { expect, type Frame } from "@playwright/test"
import { E2E_PROFILE_NAMES } from "./utils/api-profile"
import { E2ETestHelper, e2e } from "./utils/helpers"

interface StoredProfile {
	name: string
	webToolsMode?: string
	openai?: {
		capabilities?: {
			contextWindow?: number
		}
	}
}

interface ContextSegments {
	durable: number
	active: number
	staged: number
	environment: number
}

const profilesPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "api_profiles.json")
const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")

async function configureProfile(dlineDir: string): Promise<void> {
	const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
	const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
	if (!profile?.openai?.capabilities) throw new Error("Durable lifecycle E2E profile is missing")
	profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
	profile.openai.capabilities.contextWindow = 131_072
	await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

	const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
	settings.actModeProfile = E2E_PROFILE_NAMES.mockOpenAiResponses
	settings.planModeProfile = E2E_PROFILE_NAMES.mockOpenAiResponses
	settings.clineWebToolsEnabled = false
	settings.useAutoCondense = false
	await writeFile(settingsPath(dlineDir), `${JSON.stringify(settings, null, 2)}\n`, "utf8")
}

async function selectProfile(sidebar: Frame, profileName: string): Promise<void> {
	const modelSwitcher = sidebar.getByRole("button", { name: "Select model" })
	if ((await modelSwitcher.innerText()).trim() === profileName) return
	await modelSwitcher.click()
	await expect(sidebar.getByText("Available Models", { exact: true })).toBeVisible()
	const option = sidebar.getByRole("option").filter({ has: sidebar.getByText(profileName, { exact: true }) })
	await expect(option).toHaveCount(1)
	await option.click()
	await expect(modelSwitcher).toHaveText(profileName)
}

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

async function expandTaskHeader(sidebar: Frame): Promise<void> {
	const expand = sidebar.getByLabel("Expand task header")
	if (await expand.isVisible()) await expand.click()
	await expect(sidebar.getByTestId("context-window-indicator")).toBeVisible({ timeout: 60_000 })
}

async function readSegments(sidebar: Frame): Promise<ContextSegments> {
	return sidebar.getByTestId("context-window-segmented-progress").evaluate((progress) => {
		const value = (kind: string): number => {
			const segment = progress.querySelector<HTMLElement>(`[data-segment="${kind}"]`)
			return Number(segment?.dataset.authoritativeTokens ?? 0)
		}
		return {
			durable: value("durable"),
			active: value("active"),
			staged: value("staged"),
			environment: value("environment"),
		}
	})
}

e2e(
	"Context indicator - completed rounds become Durable before the next Sending phase",
	async ({ dlineDir, helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await configureProfile(dlineDir)
		server.resetOpenAiMock()
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_durable_lifecycle_qna",
				name: "qna_respond",
				arguments: { response: "E2E_DURABLE_LIFECYCLE_QNA" },
				usage: { inputTokens: 6_000, outputTokens: 100 },
			},
			{
				type: "tool",
				id: "call_durable_lifecycle_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_DURABLE_LIFECYCLE_COMPLETE" },
				usage: { inputTokens: 6_500, outputTokens: 100 },
				beforeUsageDelayMs: 5_000,
				expectedRequestIncludes: ["E2E_DURABLE_LIFECYCLE_FEEDBACK"],
			},
		)

		await helper.signin(sidebar)
		await selectProfile(sidebar, E2E_PROFILE_NAMES.mockOpenAiResponses)
		await sendTask(sidebar, "E2E_DURABLE_LIFECYCLE_TASK")
		await expect(sidebar.getByText("E2E_DURABLE_LIFECYCLE_QNA", { exact: false })).toBeVisible({ timeout: 60_000 })
		await expandTaskHeader(sidebar)

		const progress = sidebar.getByTestId("context-window-segmented-progress")
		const beforeContinuation = await readSegments(sidebar)
		await expect(progress).toHaveAttribute("data-phase", "receiving")
		expect(beforeContinuation.active).toBeGreaterThan(0)
		expect(beforeContinuation.durable).toBe(0)

		await sendTask(sidebar, "E2E_DURABLE_LIFECYCLE_FEEDBACK")
		await expect.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 30_000 }).toBe(2)
		await expect(progress).toHaveAttribute("data-phase", "receiving", { timeout: 30_000 })

		const duringContinuation = await readSegments(sidebar)
		expect(duringContinuation.durable).toBeGreaterThan(beforeContinuation.durable)
		expect(duringContinuation.durable).toBeLessThan(6_100)
		expect(duringContinuation.active).toBeGreaterThan(0)
		await sidebar.page().waitForTimeout(500)
		const stablePrefixSample = await readSegments(sidebar)
		expect(stablePrefixSample.durable).toBe(duringContinuation.durable)
		expect(stablePrefixSample.staged).toBeGreaterThanOrEqual(0)

		await expect(sidebar.getByText("E2E_DURABLE_LIFECYCLE_COMPLETE", { exact: false })).toBeVisible({ timeout: 60_000 })
		await expect(progress).toHaveAttribute("data-phase", "stable", { timeout: 30_000 })
		const afterContinuation = await readSegments(sidebar)
		expect(afterContinuation.active).toBe(0)
		expect(afterContinuation.durable).toBe(duringContinuation.durable)
		expect(afterContinuation.staged).toBeGreaterThan(0)
		expect(
			afterContinuation.durable + afterContinuation.active + afterContinuation.staged + afterContinuation.environment,
		).toBe(6_600)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)
