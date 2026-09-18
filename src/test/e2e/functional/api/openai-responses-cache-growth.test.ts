import { copyFile, mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"
import type { ElectronApplication } from "playwright"

interface StoredProfile {
	name: string
	modelId?: string
	webToolsMode?: string
	openai?: {
		capabilities?: {
			contextWindow?: number
			maxTokens?: number
		}
	}
}

const SOURCE_SNAPSHOTS = [
	"standard.xml.basic.prompt.snap",
	"standard.xml.hosted-web.prompt.snap",
	"standard.xml.no-browser.prompt.snap",
	"standard.xml.no-focus.prompt.snap",
	"standard.xml.no-mcp.prompt.snap",
	"standard.xml.no-parallel.prompt.snap",
	"standard.xml.no-subagents.prompt.snap",
	"standard.xml.no-web.prompt.snap",
	"standard.xml.yolo.prompt.snap",
	"standard.native.basic.tools.snap",
	"standard.native.hosted-web.tools.snap",
	"standard.native.no-browser.tools.snap",
] as const

async function configureResponsesProfile(dlineDir: string): Promise<void> {
	const profilesPath = path.join(dlineDir, "data", "settings", "api_profiles.json")
	const profiles = JSON.parse(await readFile(profilesPath, "utf8")) as StoredProfile[]
	const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
	if (!profile?.openai?.capabilities) throw new Error("Missing configurable OpenAI Responses cache-growth profile")
	profile.modelId = "gpt-5.6-sol"
	profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
	profile.openai.capabilities.contextWindow = 472_000
	profile.openai.capabilities.maxTokens = 10_000
	await writeFile(profilesPath, `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

	const settingsPath = path.join(dlineDir, "data", "settings", "settings.json")
	const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>
	settings.actModeProfile = E2E_PROFILE_NAMES.mockOpenAiResponses
	settings.planModeProfile = E2E_PROFILE_NAMES.mockOpenAiResponses
	settings.clineWebToolsEnabled = false
	settings.useAutoCondense = false
	await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8")
}

async function prepareRealCorpus(workspaceDir: string): Promise<readonly string[]> {
	const sourceDirectory = path.join(
		E2ETestHelper.CODEBASE_ROOT_DIR,
		"src",
		"core",
		"prompts",
		"system-prompt",
		"__tests__",
		"__snapshots__",
		"profiles",
	)
	const targetDirectory = path.join(workspaceDir, "cache-corpus")
	await mkdir(targetDirectory, { recursive: true })
	return Promise.all(
		SOURCE_SNAPSHOTS.map(async (sourceName, index) => {
			const relativePath = path.join("cache-corpus", `cache-corpus-${String(index + 1).padStart(2, "0")}.snap`)
			await copyFile(path.join(sourceDirectory, sourceName), path.join(workspaceDir, relativePath))
			return relativePath.replaceAll("\\", "/")
		}),
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

async function selectProfile(sidebar: Frame, profileName: string): Promise<void> {
	const modelSwitcher = sidebar.getByRole("button", { name: "Select model" })
	if ((await modelSwitcher.innerText()).trim() === profileName) return
	await modelSwitcher.click()
	const option = sidebar.getByRole("option").filter({ has: sidebar.getByText(profileName, { exact: true }) })
	await expect(option).toHaveCount(1)
	await option.click()
	await expect(modelSwitcher).toHaveText(profileName)
}

async function setAutoApproveRead(sidebar: Frame): Promise<void> {
	await sidebar.getByLabel("Open auto-approve settings").click()
	const checkbox = sidebar.locator("vscode-checkbox").filter({ hasText: "Read project files" })
	await expect(checkbox).toHaveCount(1)
	const isChecked = () => checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))
	if (!(await isChecked())) await sidebar.getByText("Read project files", { exact: true }).click()
	await expect.poll(isChecked).toBe(true)
	await sidebar.getByLabel("Close auto-approve settings").click()
}

e2e(
	"OpenAI Responses cache keeps growing after a real Task crosses 180K input tokens",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(300_000)
		await configureResponsesProfile(dlineDir)
		const corpusPaths = await prepareRealCorpus(workspaceDir)

		server.resetOpenAiMock()
		for (const [index, corpusPath] of corpusPaths.entries()) {
			server.enqueueResponses("openai-compatible-responses", {
				type: "tool",
				id: `call_cache_growth_read_${index + 1}`,
				name: "read_file",
				arguments: { path: corpusPath },
				...(index === 0
					? {}
					: {
							expectedToolResults: [
								{
									callId: `call_cache_growth_read_${index}`,
									contentIncludes: path.basename(corpusPaths[index - 1]),
								},
							],
						}),
				matchRequestContract: true,
			})
		}
		server.enqueueResponses("openai-compatible-responses", {
			type: "tool",
			id: "call_cache_growth_complete",
			name: "attempt_completion",
			arguments: { result: "E2E_RESPONSES_CACHE_GROWTH_COMPLETE" },
			expectedToolResults: [
				{
					callId: `call_cache_growth_read_${corpusPaths.length}`,
					contentIncludes: path.basename(corpusPaths.at(-1)!),
				},
			],
			matchRequestContract: true,
		})

		const app = await openVSCode(workspaceDir)
		try {
			const sidebar = await openSidebar(app, helper)
			await selectProfile(sidebar, E2E_PROFILE_NAMES.mockOpenAiResponses)
			await setAutoApproveRead(sidebar)

			const taskText = "Read every requested real cache corpus file in sequence, then complete the task."
			const input = sidebar.getByTestId("chat-input")
			await input.fill(taskText)
			await sidebar.getByTestId("send-button").click()
			await expect
				.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 180_000 })
				.toBe(corpusPaths.length + 1)
			await expect(sidebar.getByText("E2E_RESPONSES_CACHE_GROWTH_COMPLETE", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})

			const consumptions = server.getMockConsumptions("openai-compatible-responses")
			expect(consumptions).toHaveLength(corpusPaths.length + 1)
			const diagnostics = consumptions.map((consumption) => {
				if (!consumption.cacheDiagnostic) throw new Error("Missing automatic OpenAI cache diagnostic")
				return consumption.cacheDiagnostic
			})
			expect(new Set(diagnostics.map(({ identity }) => identity)).size).toBe(1)
			const stablePrefixHash = diagnostics[0].actualPrefixHash
			for (let index = 1; index < diagnostics.length; index++) {
				const previous = diagnostics[index - 1]
				const current = diagnostics[index]
				expect(current.state).toBe("warm")
				expect(current.previousRequestIndex).toBe(previous.requestIndex)
				expect(current.totalInputTokens).toBeGreaterThan(previous.totalInputTokens)
				expect(current.cacheReadTokens).toBeGreaterThan(previous.cacheReadTokens)
				expect(current.prefixHashMatched).toBe(true)
				expect(current.actualPrefixHash).toBe(stablePrefixHash)
				expect(current.reusablePrefixTokens).toBeGreaterThanOrEqual(previous.totalInputTokens - 2)
				expect(current.firstDivergence?.component).toBe("input")
				expect(current.firstDivergence?.estimatedTokenOffset).toBeGreaterThanOrEqual(current.reusablePrefixTokens - 2)
			}
			const firstCacheReadAbove180K = diagnostics.findIndex(({ cacheReadTokens }) => cacheReadTokens > 180_000)
			expect(firstCacheReadAbove180K).toBeGreaterThan(0)
			for (const diagnostic of diagnostics.slice(firstCacheReadAbove180K)) {
				expect(diagnostic.totalInputTokens).toBeGreaterThan(180_000)
				expect(diagnostic.inputGrowthTokens).toBeGreaterThan(0)
				expect(diagnostic.cacheReadGrowthTokens).toBeGreaterThan(0)
				expect(diagnostic.warnings.map(({ code }) => code)).not.toContain("cache_plateau")
			}
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)
