import { access, cp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { expect, type Frame, type Locator, type Page } from "@playwright/test"
import { ServerTool } from "@shared/proto/dline/models/metadata"
import type { ElectronApplication } from "playwright"
// @ts-expect-error puppeteer-chromium-resolver does not publish TypeScript declarations.
import PCR from "puppeteer-chromium-resolver"
import type { MockApiConsumption, MockApiTarget } from "./fixtures/server"
import { getE2EMockProviderBaseUrl } from "./fixtures/server/api"
import { E2E_PROFILE_NAMES } from "./utils/api-profile"
import { E2ETestHelper, e2e } from "./utils/helpers"

type StoredWebToolsMode =
	| "WEB_TOOLS_MODE_AUTO"
	| "WEB_TOOLS_MODE_FORCE_LOCAL"
	| "WEB_TOOLS_MODE_FORCE_OFF"
	| "WEB_TOOLS_MODE_FORCE_REMOTE"

interface StoredProviderConfiguration {
	capabilities?: {
		maxTokens?: number
		contextWindow?: number
		supportsTools?: boolean
	}
	disabledServerTools?: ServerTool[]
	[key: string]: unknown
}

interface StoredProfile {
	name: string
	provider: string
	webToolsMode?: StoredWebToolsMode
	modelInfo?: { capabilities?: { tools?: ServerTool[]; [key: string]: unknown }; [key: string]: unknown }
	openai?: StoredProviderConfiguration
	anthropic?: StoredProviderConfiguration
	[key: string]: unknown
}

interface SearchMechanisms {
	hosted: unknown[]
	local: unknown[]
}

const profilesPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "api_profiles.json")
const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")

async function onlyTaskId(dlineDocsDir: string): Promise<string> {
	return E2ETestHelper.waitForValue(async () => {
		const entries = await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true }).catch(() => [])
		const taskIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
		return taskIds.length === 1 ? taskIds[0] : undefined
	}, 30_000)
}

async function attachHostedWebScreenshot(page: Page, name: string): Promise<void> {
	const testInfo = e2e.info()
	const screenshotPath = testInfo.outputPath(`${name}.png`)
	await page.screenshot({ path: screenshotPath, fullPage: false, timeout: 5_000 }).catch(() => undefined)
	if (
		await access(screenshotPath)
			.then(() => true)
			.catch(() => false)
	) {
		await testInfo.attach(name, { path: screenshotPath, contentType: "image/png" })
	}
}

async function attachHostedWebResumeEvidence(
	page: Page,
	dlineDir: string,
	dlineDocsDir: string,
	userDataDir: string,
	name: string,
): Promise<void> {
	await attachHostedWebScreenshot(page, name)
	const testInfo = e2e.info()
	const taskId = await onlyTaskId(dlineDocsDir)
	const taskDir = path.join(dlineDocsDir, "tasks", taskId)
	const snapshot = await E2ETestHelper.waitForValue(async () => {
		const content = await readFile(path.join(taskDir, "snapshot.json"), "utf8").catch(() => undefined)
		if (!content) return undefined
		const parsed = JSON.parse(content) as { interaction?: { kind?: string; status?: string } }
		return parsed.interaction?.kind === "resume" && parsed.interaction.status === "awaiting" ? content : undefined
	}, 30_000)
	const uiMessages = await E2ETestHelper.waitForValue(async () => {
		const content = await readFile(path.join(taskDir, "ui_messages.jsonl"), "utf8").catch(() => undefined)
		return content?.includes('"ask":"resume_task"') ? content : undefined
	}, 30_000)
	const settings = await E2ETestHelper.waitForValue(async () => {
		const content = await readFile(settingsPath(dlineDir), "utf8").catch(() => undefined)
		if (!content) return undefined
		const parsed = JSON.parse(content) as { autoApprovalSettings?: { actions?: { useWeb?: boolean } } }
		return parsed.autoApprovalSettings?.actions?.useWeb === false ? content : undefined
	}, 30_000)
	const outputLog = await E2ETestHelper.readDlineOutput(userDataDir)
	for (const evidence of [
		{ fileName: `${name}-snapshot.json`, content: snapshot, contentType: "application/json" },
		{ fileName: `${name}-ui_messages.jsonl`, content: uiMessages, contentType: "application/x-ndjson" },
		{ fileName: `${name}-settings.json`, content: settings, contentType: "application/json" },
		{ fileName: `${name}-dline-output.log`, content: outputLog, contentType: "text/plain" },
	]) {
		const evidencePath = testInfo.outputPath(evidence.fileName)
		await writeFile(evidencePath, evidence.content, "utf8")
		await testInfo.attach(evidence.fileName, { path: evidencePath, contentType: evidence.contentType })
	}
}

async function prepareWebFetchBrowser(dlineHomeDir: string): Promise<void> {
	const workerDirectoryName = path.basename(path.dirname(dlineHomeDir))
	const seedDir = path.join(E2ETestHelper.PUPPETEER_CACHE_DIR, workerDirectoryName)
	const prepareSeed = async (): Promise<void> => {
		await mkdir(seedDir, { recursive: true })
		const stats = await PCR({ downloadPath: seedDir })
		await access(stats.executablePath)
	}
	try {
		await prepareSeed()
	} catch {
		await rm(seedDir, { recursive: true, force: true })
		await prepareSeed()
	}

	const testPuppeteerDir = path.join(dlineHomeDir, "puppeteer")
	await rm(testPuppeteerDir, { recursive: true, force: true })
	await cp(seedDir, testPuppeteerDir, { recursive: true })
}

async function prepareRuntimeProfile(
	dlineDir: string,
	profileName: string,
	options: {
		apiFormat?: "OPENAI_CHAT" | "OPENAI_RESPONSES"
		baseUrl?: string
		enabled: boolean
		mode: StoredWebToolsMode
		supportsWebSearch?: boolean
	},
): Promise<void> {
	const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
	const profile = profiles.find((candidate) => candidate.name === profileName)
	if (!profile) throw new Error(`Missing E2E profile: ${profileName}`)

	profile.webToolsMode = options.mode
	if (options.baseUrl) profile.baseUrl = options.baseUrl
	const providerKey = profile.provider === "anthropic" ? "anthropic" : profile.provider === "deepseek" ? "deepseek" : "openai"
	const provider = (profile[providerKey] ?? {}) as StoredProviderConfiguration
	if (options.apiFormat) provider.apiFormat = options.apiFormat
	if (options.supportsWebSearch !== undefined) {
		provider.capabilities = {
			maxTokens: provider.capabilities?.maxTokens ?? 8_192,
			contextWindow: provider.capabilities?.contextWindow ?? 131_072,
			supportsTools: true,
			...provider.capabilities,
		}
		// The model declares what it can do; the profile only records what the user
		// turned off. Writing "no hosted search" as an empty declaration would make
		// the capability itself disappear instead of switching the route.
		//
		// Stored profiles carry proto enum numbers, and the runtime ignores any
		// non-numeric entry, so the fixture has to use ServerTool values here.
		profile.modelInfo = {
			...profile.modelInfo,
			capabilities: { ...profile.modelInfo?.capabilities, tools: [ServerTool.WEB_SEARCH] },
		}
		provider.disabledServerTools = options.supportsWebSearch ? [] : [ServerTool.WEB_SEARCH]
	}
	profile[providerKey] = provider
	await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

	const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
	settings.actModeProfile = profileName
	settings.planModeProfile = profileName
	settings.clineWebToolsEnabled = options.enabled
	await writeFile(settingsPath(dlineDir), `${JSON.stringify(settings, null, 2)}\n`, "utf8")
}

async function openSidebar(
	openVSCode: (workspacePath: string) => Promise<ElectronApplication>,
	workspaceDir: string,
	helper: E2ETestHelper,
): Promise<{ app: ElectronApplication; page: Page; sidebar: Frame }> {
	const app = await openVSCode(workspaceDir)
	const page = await app.firstWindow()
	await E2ETestHelper.openClineSidebar(page)
	const sidebar = await helper.getSidebar(page)
	await helper.signin(sidebar)
	return { app, page, sidebar }
}

async function configureSearxngSearch(dlineDir: string, serverBaseUrl: string): Promise<void> {
	const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
	settings.clineWebToolsEnabled = true
	settings.localWebSearchEngine = "searxng"
	settings.searxngSearchUrl = `${serverBaseUrl}/mock/searxng`
	await writeFile(settingsPath(dlineDir), `${JSON.stringify(settings, null, 2)}\n`, "utf8")
}

async function configureNormalApprovalMode(dlineDir: string): Promise<void> {
	const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
	const autoApprovalSettings = (settings.autoApprovalSettings ?? {}) as Record<string, unknown>
	const actions = (autoApprovalSettings.actions ?? {}) as Record<string, unknown>
	settings.yoloModeToggled = false
	settings.autoApproveAllToggled = false
	settings.autoApprovalSettings = {
		...autoApprovalSettings,
		actions: { ...actions, useWeb: false },
	}
	await writeFile(settingsPath(dlineDir), `${JSON.stringify(settings, null, 2)}\n`, "utf8")
}

async function configureCancelingPreToolUseHook(
	dlineDir: string,
	workspaceDir: string,
	errorMessage: string,
	delaySeconds = 0,
): Promise<void> {
	const hooksDir = path.join(workspaceDir, ".dline", "hooks")
	await mkdir(hooksDir, { recursive: true })
	const output = JSON.stringify({ cancel: true, errorMessage })
	const delay = delaySeconds > 0 ? `Start-Sleep -Seconds ${delaySeconds}\n` : ""
	await writeFile(path.join(hooksDir, "PreToolUse.ps1"), `${delay}Write-Output '${output}'\n`, "utf8")

	const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
	settings.hooksEnabled = true
	await writeFile(settingsPath(dlineDir), `${JSON.stringify(settings, null, 2)}\n`, "utf8")
}

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

async function closeCurrentTask(sidebar: Frame): Promise<void> {
	const closeButton = sidebar.getByRole("button", { name: "Close Task", exact: true })
	await expect(closeButton).toBeVisible()
	await closeButton.click()
	await expect(sidebar.getByTestId("chat-input")).toHaveAttribute("placeholder", "Type your task here...")
	await expect(closeButton).toHaveCount(0)
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
}

async function reopenTask(sidebar: Frame, taskText: string): Promise<void> {
	const historyTask = sidebar.getByText(taskText, { exact: true }).last()
	await expect(historyTask).toBeVisible({ timeout: 30_000 })
	await historyTask.click()
	await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible({ timeout: 30_000 })
	await expect(sidebar.getByText(taskText, { exact: true }).first()).toBeVisible()
}

async function setAutoApproveAction(sidebar: Frame, label: string, enabled: boolean, dlineDir?: string): Promise<void> {
	await sidebar.getByLabel("Open auto-approve settings").click()
	const checkbox = sidebar.locator("vscode-checkbox").filter({ hasText: label })
	await expect(checkbox).toHaveCount(1)
	const isChecked = () => checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))
	if ((await isChecked()) !== enabled) {
		await sidebar.getByText(label, { exact: true }).click()
	}
	await expect.poll(isChecked).toBe(enabled)
	await sidebar.getByLabel("Close auto-approve settings").click()

	if (dlineDir) {
		const actionKey = label === "Use Web" ? "useWeb" : label === "Use the browser" ? "useBrowser" : undefined
		if (!actionKey) throw new Error(`Unsupported persisted auto-approve action: ${label}`)
		await expect
			.poll(
				async () => {
					const content = await readFile(settingsPath(dlineDir), "utf8").catch(() => undefined)
					if (!content) return undefined
					const parsed = JSON.parse(content) as {
						autoApprovalSettings?: { actions?: Record<string, boolean | undefined> }
					}
					return parsed.autoApprovalSettings?.actions?.[actionKey]
				},
				{ timeout: 30_000 },
			)
			.toBe(enabled)
	}
}

/**
 * Assert the 40vh height budget of a tool card.
 *
 * Cards cap their own height but differ in who scrolls: the Web Fetch card
 * scrolls itself, while the Web Search card clips and lets its results region
 * scroll. Only the height budget is shared, so that is what this checks.
 */
async function expect40VhCard(card: Locator, shouldScroll = false): Promise<void> {
	await expect(card).toBeVisible({ timeout: 60_000 })
	const metrics = await card.evaluate((element) => ({
		className: element.className,
		maxHeight: getComputedStyle(element).maxHeight,
		overflowY: getComputedStyle(element).overflowY,
		clientHeight: element.clientHeight,
		scrollHeight: element.scrollHeight,
		viewportHeight: window.innerHeight,
	}))
	expect(metrics.className).toContain("max-h-[40vh]")
	expect(["auto", "hidden"]).toContain(metrics.overflowY)
	expect(metrics.clientHeight).toBeLessThanOrEqual(metrics.viewportHeight * 0.4 + 1)
	if (shouldScroll && metrics.overflowY === "auto") {
		expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight)
	}
	expect(Number.parseFloat(metrics.maxHeight)).toBeCloseTo(metrics.viewportHeight * 0.4, 0)
}

function searchMechanisms(consumption: MockApiConsumption): SearchMechanisms {
	const body = consumption.requestBody as { tools?: Array<Record<string, unknown>> }
	const hosted: unknown[] = []
	const local: unknown[] = []
	for (const tool of body.tools ?? []) {
		const type = tool.type
		const name = tool.name
		const functionName = (tool.function as { name?: unknown } | undefined)?.name
		// Match any dated hosted search revision: pinning one version here would make
		// a version bump look like "no hosted search" instead of failing outright.
		if (type === "web_search" || (typeof type === "string" && /^web_search_\d{8}$/.test(type))) hosted.push(tool)
		if (
			(type === "function" && (functionName === "web_search" || name === "web_search")) ||
			(type === undefined && name === "web_search")
		) {
			local.push(tool)
		}
	}
	return { hosted, local }
}

function expectSingleSearchRoute(consumption: MockApiConsumption, expected: "hosted" | "local" | "none"): void {
	const mechanisms = searchMechanisms(consumption)
	expect(mechanisms.hosted).toHaveLength(expected === "hosted" ? 1 : 0)
	expect(mechanisms.local).toHaveLength(expected === "local" ? 1 : 0)
	expect(mechanisms.hosted.length + mechanisms.local.length).toBeLessThanOrEqual(1)
}

function expectIsolatedDirectories(dlineDir: string, dlineHomeDir: string, dlineDocsDir: string): void {
	expect(path.resolve(dlineHomeDir)).toBe(path.resolve(dlineDir))
	expect(path.resolve(dlineDocsDir)).not.toBe(path.resolve(dlineDir))
}

async function expectHostedLifecycle(
	sidebar: Frame,
	query: string,
	result: { title: string; url: string; snippet?: string },
): Promise<Locator> {
	await expect(sidebar.getByText("Dline searched the web for:", { exact: true })).toBeVisible({ timeout: 60_000 })
	const card = sidebar.getByTestId("web-search-card").filter({ hasText: query })
	await expect(card).toHaveCount(1)
	await expect(card.getByText(query, { exact: true })).toBeVisible()
	const toggle = card.getByTestId("web-search-details-toggle")
	await expect(toggle).toHaveAttribute("aria-expanded", "false")
	await expect(card.getByTestId("web-search-results")).toHaveCount(0)
	await expect(card.getByText(result.title, { exact: true })).toHaveCount(0)
	await toggle.click()
	await expect(toggle).toHaveAttribute("aria-expanded", "true")
	await expect(card.getByText(result.title, { exact: true })).toBeVisible()
	await expect(card.getByText(result.url, { exact: true })).toBeVisible()
	if (result.snippet) {
		await expect(card.getByText(result.snippet, { exact: true })).toBeVisible()
	}
	await expect40VhCard(card)
	return card
}

e2e(
	"ServerTool runtime - OpenAI Responses hosted Web Search waits for Use Web approval before the Provider request",
	async ({ dlineDir, dlineDocsDir, dlineHomeDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		expectIsolatedDirectories(dlineDir, dlineHomeDir, dlineDocsDir)
		await prepareRuntimeProfile(dlineDir, E2E_PROFILE_NAMES.mockOpenAiResponses, {
			enabled: true,
			mode: "WEB_TOOLS_MODE_AUTO",
			supportsWebSearch: true,
		})
		await configureNormalApprovalMode(dlineDir)
		const query = "Dline OpenAI hosted search"
		const completion = "E2E_OPENAI_HOSTED_WEB_SEARCH_OK"
		server.enqueueResponses("openai-compatible-responses", {
			type: "hosted-web-search",
			id: "ws_openai_e2e",
			query,
			results: [
				{
					title: "OpenAI hosted result",
					url: "https://example.test/openai-hosted",
					snippet: "E2E_OPENAI_HOSTED_RESULT_SNIPPET",
				},
			],
			followupTools: [{ id: "call_openai_hosted_done", name: "attempt_completion", arguments: { result: completion } }],
		})

		let app: ElectronApplication | undefined
		try {
			const opened = await openSidebar(openVSCode, workspaceDir, helper)
			app = opened.app
			const taskText = "Use OpenAI provider-hosted search and finish the task."
			await sendTask(opened.sidebar, taskText)
			let approveButton = opened.sidebar.getByRole("contentinfo").getByText("Approve", { exact: true })
			await expect
				.poll(
					async () => ({
						approvalCount: await approveButton.count(),
						providerRequests: server.getMockConsumptions("openai-compatible-responses").length,
					}),
					{ timeout: 60_000, intervals: [250, 500, 1_000] },
				)
				.toEqual({ approvalCount: 1, providerRequests: 0 })
			await expect(opened.sidebar.getByText("Dline wants to search the web for:", { exact: true })).toBeVisible()
			await expect(opened.sidebar.getByText("OpenAI Web Search (Hosted)", { exact: true })).toBeVisible()
			expect(server.getSearxngSearchRequests()).toHaveLength(0)
			await closeCurrentTask(opened.sidebar)
			await reopenTask(opened.sidebar, taskText)
			approveButton = opened.sidebar.getByRole("contentinfo").getByText("Approve", { exact: true })
			await expect(approveButton).toBeVisible({ timeout: 60_000 })
			expect(server.getMockConsumptions("openai-compatible-responses")).toHaveLength(0)
			expect(server.getSearxngSearchRequests()).toHaveLength(0)
			await approveButton.click()

			await expect.poll(() => server.getMockConsumptions("openai-compatible-responses").length, { timeout: 60_000 }).toBe(1)
			const [firstRequest] = server.getMockConsumptions("openai-compatible-responses")
			expect(firstRequest).toBeDefined()
			expectSingleSearchRoute(firstRequest, "hosted")
			expect(server.getSearxngSearchRequests()).toHaveLength(0)
			await expectHostedLifecycle(opened.sidebar, query, {
				title: "OpenAI hosted result",
				url: "https://example.test/openai-hosted",
				snippet: "E2E_OPENAI_HOSTED_RESULT_SNIPPET",
			})
			await expect(opened.sidebar.getByText(completion, { exact: false }).last()).toBeVisible({ timeout: 60_000 })

			await closeCurrentTask(opened.sidebar)
			await reopenTask(opened.sidebar, taskText)
			const restoredCard = opened.sidebar.getByTestId("web-search-card").filter({ hasText: query })
			await expect(restoredCard).toHaveCount(1)
			const restoredToggle = restoredCard.getByTestId("web-search-details-toggle")
			await expect(restoredToggle).toHaveAttribute("aria-expanded", "false")
			await expect(restoredCard.getByText("OpenAI hosted result", { exact: true })).toHaveCount(0)
			await restoredToggle.click()
			await expect(restoredCard.getByText("OpenAI hosted result", { exact: true })).toBeVisible()
			await expect(restoredCard.getByText("https://example.test/openai-hosted", { exact: true })).toBeVisible()
			await expect(restoredCard.getByText("E2E_OPENAI_HOSTED_RESULT_SNIPPET", { exact: true })).toBeVisible()

			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app?.close()
		}
	},
)

e2e(
	"ServerTool runtime - disabling Use Web prompts once and reuses manual Hosted approval for the current task",
	async ({ dlineDir, dlineDocsDir, dlineHomeDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		expectIsolatedDirectories(dlineDir, dlineHomeDir, dlineDocsDir)
		await prepareRuntimeProfile(dlineDir, E2E_PROFILE_NAMES.mockOpenAiResponses, {
			enabled: true,
			mode: "WEB_TOOLS_MODE_AUTO",
			supportsWebSearch: true,
		})
		await configureNormalApprovalMode(dlineDir)
		const ready = "E2E_HOSTED_APPROVAL_LEASE_READY"
		const approved = "E2E_HOSTED_APPROVAL_LEASE_APPROVED"
		const firstReply = "E2E_HOSTED_APPROVAL_LEASE_FIRST_REPLY"
		const secondReply = "E2E_HOSTED_APPROVAL_LEASE_SECOND_REPLY"
		const completion = "E2E_HOSTED_APPROVAL_LEASE_OK"
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_hosted_approval_lease_ready",
				name: "qna_respond",
				arguments: { response: ready },
			},
			{
				type: "tool",
				id: "call_hosted_approval_lease_approved",
				name: "qna_respond",
				arguments: { response: approved },
				expectedRequestIncludes: [firstReply],
			},
			{
				type: "tool",
				id: "call_hosted_approval_lease_done",
				name: "attempt_completion",
				arguments: { result: completion },
				expectedRequestIncludes: [secondReply],
			},
		)

		let app: ElectronApplication | undefined
		try {
			const opened = await openSidebar(openVSCode, workspaceDir, helper)
			app = opened.app
			await setAutoApproveAction(opened.sidebar, "Use Web", true, dlineDir)
			await sendTask(opened.sidebar, "Keep working after one manual Hosted Web approval.")
			await expect(opened.sidebar.getByText(ready, { exact: true })).toBeVisible({ timeout: 60_000 })
			await expect.poll(() => server.getMockConsumptions("openai-compatible-responses").length).toBe(1)

			await setAutoApproveAction(opened.sidebar, "Use Web", false, dlineDir)
			const input = opened.sidebar.getByTestId("chat-input")
			await input.fill(firstReply)
			await input.press("Enter")

			const footer = opened.sidebar.getByRole("contentinfo")
			const approveButton = footer.getByText("Approve", { exact: true })
			await expect(approveButton).toBeVisible({ timeout: 60_000 })
			expect(server.getMockConsumptions("openai-compatible-responses")).toHaveLength(1)
			await approveButton.click()

			await expect(opened.sidebar.getByText(approved, { exact: true })).toBeVisible({ timeout: 60_000 })
			await expect.poll(() => server.getMockConsumptions("openai-compatible-responses").length).toBe(2)
			await expect(approveButton).toHaveCount(0)

			await input.fill(secondReply)
			await input.press("Enter")
			await expect(opened.sidebar.getByText(completion, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expect.poll(() => server.getMockConsumptions("openai-compatible-responses").length).toBe(3)
			await expect(approveButton).toHaveCount(0)
			await attachHostedWebScreenshot(opened.page, "hosted-web-manual-approval-lease")
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app?.close()
		}
	},
)

e2e(
	"ServerTool runtime - rejecting Hosted Web approval leaves an immediate durable Resume path",
	async ({ dlineDir, dlineDocsDir, dlineHomeDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		expectIsolatedDirectories(dlineDir, dlineHomeDir, dlineDocsDir)
		await prepareRuntimeProfile(dlineDir, E2E_PROFILE_NAMES.mockOpenAiResponses, {
			enabled: true,
			mode: "WEB_TOOLS_MODE_AUTO",
			supportsWebSearch: true,
		})
		await configureNormalApprovalMode(dlineDir)
		const ready = "E2E_HOSTED_REJECT_RECOVERY_READY"
		const rejectedDraft = "E2E_HOSTED_REJECT_RECOVERY_DRAFT"
		server.enqueueResponses("openai-compatible-responses", {
			type: "tool",
			id: "call_hosted_reject_recovery_ready",
			name: "qna_respond",
			arguments: { response: ready },
		})

		let app: ElectronApplication | undefined
		try {
			const opened = await openSidebar(openVSCode, workspaceDir, helper)
			app = opened.app
			await setAutoApproveAction(opened.sidebar, "Use Web", true)
			const taskText = "Pause safely when I reject Hosted Web access."
			await sendTask(opened.sidebar, taskText)
			await expect(opened.sidebar.getByText(ready, { exact: true })).toBeVisible({ timeout: 60_000 })
			await expect.poll(() => server.getMockConsumptions("openai-compatible-responses").length).toBe(1)

			await setAutoApproveAction(opened.sidebar, "Use Web", false)
			const input = opened.sidebar.getByTestId("chat-input")
			await input.fill(rejectedDraft)
			await input.press("Enter")

			const footer = opened.sidebar.getByRole("contentinfo")
			const rejectButton = footer.getByText("Reject", { exact: true })
			await expect(rejectButton).toBeVisible({ timeout: 60_000 })
			expect(server.getMockConsumptions("openai-compatible-responses")).toHaveLength(1)
			await rejectButton.click()

			const resumeButton = footer.getByText("Resume", { exact: true })
			await expect(resumeButton).toBeVisible({ timeout: 30_000 })
			await expect(input).toBeEnabled()
			expect(server.getMockConsumptions("openai-compatible-responses")).toHaveLength(1)
			await expect(footer.getByText("Approve", { exact: true })).toHaveCount(0)
			await expect(rejectButton).toHaveCount(0)
			await attachHostedWebResumeEvidence(
				opened.page,
				dlineDir,
				dlineDocsDir,
				userDataDir,
				"hosted-web-reject-immediate-resume",
			)

			await closeCurrentTask(opened.sidebar)
			await reopenTask(opened.sidebar, taskText)
			await expect(opened.sidebar.getByRole("contentinfo").getByText("Resume", { exact: true })).toBeVisible({
				timeout: 30_000,
			})
			await expect(opened.sidebar.getByTestId("chat-input")).toBeEnabled()
			expect(server.getMockConsumptions("openai-compatible-responses")).toHaveLength(1)
			await attachHostedWebResumeEvidence(
				opened.page,
				dlineDir,
				dlineDocsDir,
				userDataDir,
				"hosted-web-reject-reopened-resume",
			)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app?.close()
		}
	},
)

e2e(
	"ServerTool runtime - OpenAI Responses preserves multiple hosted Web Search actions across task reopen",
	async ({ dlineDir, dlineDocsDir, dlineHomeDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		expectIsolatedDirectories(dlineDir, dlineHomeDir, dlineDocsDir)
		await prepareRuntimeProfile(dlineDir, E2E_PROFILE_NAMES.mockOpenAiResponses, {
			enabled: true,
			mode: "WEB_TOOLS_MODE_AUTO",
			supportsWebSearch: true,
		})
		const searchQuery = "Dline multi action hosted search"
		const secondQuery = "OpenAI Responses hosted actions"
		const openPageUrl = "https://example.test/open-page"
		const findPageUrl = "https://example.test/find-page"
		const findPattern = "E2E_FIND_IN_PAGE_PATTERN"
		const completion = "E2E_HOSTED_MULTI_ACTION_OK"
		server.enqueueResponses("openai-compatible-responses", {
			type: "hosted-web-search",
			query: searchQuery,
			results: [],
			actions: [
				{
					id: "ws_multi_search",
					action: {
						type: "search",
						queries: [searchQuery, secondQuery],
						sources: [
							{ url: "https://example.test/shared", title: "Shared source title" },
							{ url: "https://example.test/source-only", title: "Source-only result" },
						],
					},
					results: [
						{ title: "", url: "https://example.test/shared", snippet: "E2E_SHARED_RESULT_SNIPPET" },
						{ title: "Result-only item", url: "https://example.test/result-only" },
					],
				},
				{
					id: "ws_multi_open",
					action: {
						type: "open_page",
						url: openPageUrl,
						sources: [{ url: openPageUrl, title: "Opened page source" }],
					},
				},
				{
					id: "ws_multi_find",
					action: {
						type: "find_in_page",
						url: findPageUrl,
						pattern: findPattern,
					},
				},
			],
			followupTools: [{ id: "call_hosted_multi_done", name: "attempt_completion", arguments: { result: completion } }],
		})

		let app: ElectronApplication | undefined
		try {
			const opened = await openSidebar(openVSCode, workspaceDir, helper)
			app = opened.app
			await setAutoApproveAction(opened.sidebar, "Use Web", true)
			const taskText = "Use every OpenAI provider-hosted web action and preserve each result."
			await sendTask(opened.sidebar, taskText)

			await expect(opened.sidebar.getByTestId("web-search-card")).toHaveCount(3, { timeout: 60_000 })
			const searchCard = opened.sidebar.getByTestId("web-search-card").filter({ hasText: searchQuery })
			const openPageCard = opened.sidebar.getByTestId("web-search-card").filter({ hasText: openPageUrl })
			const findPageCard = opened.sidebar.getByTestId("web-search-card").filter({ hasText: findPattern })
			await expect(searchCard).toHaveCount(1)
			await expect(searchCard.getByText(secondQuery, { exact: true })).toBeVisible()
			await expect(openPageCard).toHaveCount(1)
			await expect(openPageCard.getByText("Dline opened a web page:", { exact: true })).toBeVisible()
			await expect(findPageCard).toHaveCount(1)
			await expect(findPageCard.getByText("Dline searched within a web page:", { exact: true })).toBeVisible()
			await expect(findPageCard.getByText(findPageUrl, { exact: true })).toBeVisible()

			const searchToggle = searchCard.getByTestId("web-search-details-toggle")
			await expect(searchToggle).toHaveText("Show results (3)")
			await searchToggle.click()
			await expect(searchCard.getByText("Shared source title", { exact: true })).toBeVisible()
			await expect(searchCard.getByText("E2E_SHARED_RESULT_SNIPPET", { exact: true })).toBeVisible()
			await expect(searchCard.getByText("Result-only item", { exact: true })).toBeVisible()
			await expect(searchCard.getByText("Source-only result", { exact: true })).toBeVisible()
			await expect(opened.sidebar.getByText("Provider-hosted web search", { exact: true })).toHaveCount(0)
			await expect(opened.sidebar.getByText(completion, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			expect(server.getMockConsumptions("openai-compatible-responses")).toHaveLength(1)
			expectSingleSearchRoute(server.getMockConsumptions("openai-compatible-responses")[0], "hosted")
			expect(server.getSearxngSearchRequests()).toHaveLength(0)

			await closeCurrentTask(opened.sidebar)
			await reopenTask(opened.sidebar, taskText)
			await expect(opened.sidebar.getByTestId("web-search-card")).toHaveCount(3)
			const restoredSearchCard = opened.sidebar.getByTestId("web-search-card").filter({ hasText: searchQuery })
			const restoredOpenPageCard = opened.sidebar.getByTestId("web-search-card").filter({ hasText: openPageUrl })
			const restoredFindPageCard = opened.sidebar.getByTestId("web-search-card").filter({ hasText: findPattern })
			await expect(restoredSearchCard).toHaveCount(1)
			await expect(restoredOpenPageCard.getByText("Dline opened a web page:", { exact: true })).toBeVisible()
			await expect(restoredFindPageCard.getByText("Dline searched within a web page:", { exact: true })).toBeVisible()
			const restoredToggle = restoredSearchCard.getByTestId("web-search-details-toggle")
			await expect(restoredToggle).toHaveText("Show results (3)")
			await restoredToggle.click()
			await expect(restoredSearchCard.getByText("Shared source title", { exact: true })).toBeVisible()
			await expect(restoredSearchCard.getByText("E2E_SHARED_RESULT_SNIPPET", { exact: true })).toBeVisible()
			await expect(restoredSearchCard.getByText("Source-only result", { exact: true })).toBeVisible()
			await expect(opened.sidebar.getByText("Provider-hosted web search", { exact: true })).toHaveCount(0)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app?.close()
		}
	},
)

e2e(
	"ServerTool runtime - checkpoint Restore replaces pending Hosted Web approval and reapproves the resumed request",
	async ({ dlineDir, dlineDocsDir, dlineHomeDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(240_000)
		expectIsolatedDirectories(dlineDir, dlineHomeDir, dlineDocsDir)
		await prepareRuntimeProfile(dlineDir, E2E_PROFILE_NAMES.mockOpenAiResponses, {
			enabled: true,
			mode: "WEB_TOOLS_MODE_AUTO",
			supportsWebSearch: true,
		})
		await configureNormalApprovalMode(dlineDir)
		const pendingDraft = "E2E_HOSTED_WEB_RESTORE_PENDING_DRAFT"
		const resumeDraft = "E2E_HOSTED_WEB_RESTORE_RESUME_DRAFT"
		const completion = "E2E_HOSTED_WEB_RESTORE_OK"
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_hosted_restore_ready",
				name: "qna_respond",
				arguments: { response: "E2E_HOSTED_WEB_RESTORE_READY" },
			},
			{
				type: "tool",
				id: "call_hosted_restore_done",
				name: "attempt_completion",
				arguments: { result: completion },
				expectedRequestIncludes: [resumeDraft],
			},
			{
				type: "error",
				status: 500,
				code: "unexpected_stale_hosted_request",
				message: "A stale Hosted Web approval sent an extra Provider request after checkpoint Restore",
			},
		)

		let app: ElectronApplication | undefined
		try {
			const opened = await openSidebar(openVSCode, workspaceDir, helper)
			app = opened.app
			await setAutoApproveAction(opened.sidebar, "Use Web", true)
			await sendTask(opened.sidebar, "Create a checkpoint before testing Hosted Web approval Restore.")
			await expect(opened.sidebar.getByText("E2E_HOSTED_WEB_RESTORE_READY", { exact: true })).toBeVisible({
				timeout: 60_000,
			})
			await expect.poll(() => server.getMockConsumptions("openai-compatible-responses").length).toBe(1)
			const checkpointLabels = opened.sidebar.getByText("Checkpoint", { exact: true })
			await expect.poll(() => checkpointLabels.count(), { timeout: 30_000 }).toBeGreaterThan(0)
			const restoreCheckpointIndex = (await checkpointLabels.count()) - 1

			await setAutoApproveAction(opened.sidebar, "Use Web", false)
			const input = opened.sidebar.getByTestId("chat-input")
			await input.fill(pendingDraft)
			await expect(opened.sidebar.getByTestId("send-button")).toHaveAttribute("aria-disabled", "false", {
				timeout: 60_000,
			})
			await input.press("Enter")
			let approveButton = opened.sidebar.getByRole("contentinfo").getByText("Approve", { exact: true })
			await expect(approveButton).toBeVisible({ timeout: 60_000 })
			await expect(opened.sidebar.getByText("OpenAI Web Search (Hosted)", { exact: true }).last()).toBeVisible()
			expect(server.getMockConsumptions("openai-compatible-responses")).toHaveLength(1)
			expect(server.getSearxngSearchRequests()).toHaveLength(0)

			const restoreCheckpointControl = checkpointLabels.nth(restoreCheckpointIndex).locator("..").locator("..")
			await restoreCheckpointControl.scrollIntoViewIfNeeded()
			await restoreCheckpointControl.hover()
			const restoreButton = restoreCheckpointControl.getByRole("button", { name: "Restore", exact: true })
			await expect(restoreButton).toBeVisible({ timeout: 3_000 })
			await restoreButton.click({ timeout: 3_000 })
			const moreOptions = opened.sidebar.getByText("More options", { exact: true })
			await expect(moreOptions).toBeVisible()
			await moreOptions.click()
			await opened.sidebar.getByRole("button", { name: "Restore Task Only", exact: true }).click()

			const resumeButton = opened.sidebar.getByRole("contentinfo").getByText("Resume", { exact: true })
			await expect(resumeButton).toBeVisible({ timeout: 5_000 })
			await expect(approveButton).toHaveCount(0)
			await expect(opened.sidebar.getByText(pendingDraft, { exact: true })).toHaveCount(0)
			expect(server.getMockConsumptions("openai-compatible-responses")).toHaveLength(1)
			expect(server.getSearxngSearchRequests()).toHaveLength(0)

			await input.fill(resumeDraft)
			await resumeButton.click()
			approveButton = opened.sidebar.getByRole("contentinfo").getByText("Approve", { exact: true })
			await expect
				.poll(
					async () => ({
						approvalCount: await approveButton.count(),
						providerRequests: server.getMockConsumptions("openai-compatible-responses").length,
					}),
					{ timeout: 60_000, intervals: [250, 500, 1_000] },
				)
				.toEqual({ approvalCount: 1, providerRequests: 1 })
			expect(server.getSearxngSearchRequests()).toHaveLength(0)
			await approveButton.click()

			await expect.poll(() => server.getMockConsumptions("openai-compatible-responses").length, { timeout: 60_000 }).toBe(2)
			const continuation = server.getMockConsumptions("openai-compatible-responses")[1]
			expect(continuation.contractError).toBeUndefined()
			expectSingleSearchRoute(continuation, "hosted")
			expect(JSON.stringify(continuation.requestBody)).toContain(resumeDraft)
			await expect(opened.sidebar.getByText(completion, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expect(opened.sidebar.getByText(/stale_interaction|stale interaction/i)).toHaveCount(0)
			expect(server.getMockConsumptions("openai-compatible-responses")).toHaveLength(2)
			expect(server.getSearxngSearchRequests()).toHaveLength(0)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app?.close()
		}
	},
)

e2e(
	"ServerTool runtime - OpenAI Responses Auto renders hosted routing failure and replays local fallback result",
	async ({ dlineDir, dlineDocsDir, dlineHomeDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		expectIsolatedDirectories(dlineDir, dlineHomeDir, dlineDocsDir)
		await prepareRuntimeProfile(dlineDir, E2E_PROFILE_NAMES.mockOpenAiResponses, {
			enabled: true,
			mode: "WEB_TOOLS_MODE_AUTO",
			supportsWebSearch: true,
		})
		await configureSearxngSearch(dlineDir, server.baseUrl)
		const query = "Dline hosted function fallback search"
		const resultMarker = `E2E local result for ${query}`
		const completion = "E2E_HOSTED_FUNCTION_AUTO_LOCAL_FALLBACK_OK"
		server.enqueueResponses(
			"openai-compatible-responses",
			{ type: "tool", id: "call_hosted_function_fallback", name: "web_search", arguments: { query } },
			{
				type: "tool",
				id: "call_hosted_function_fallback_done",
				name: "attempt_completion",
				arguments: { result: completion },
				expectedToolResults: [{ callId: "call_hosted_function_fallback", contentIncludes: resultMarker }],
			},
		)

		let app: ElectronApplication | undefined
		try {
			const opened = await openSidebar(openVSCode, workspaceDir, helper)
			app = opened.app
			await setAutoApproveAction(opened.sidebar, "Use Web", true)
			await sendTask(
				opened.sidebar,
				"Use OpenAI hosted search, recover locally if the provider returns a function call, then finish.",
			)
			await expect(opened.sidebar.getByText("OpenAI Web Search (Hosted)", { exact: true })).toBeVisible({
				timeout: 60_000,
			})
			await expect(
				opened.sidebar.getByText(
					"OpenAI hosted Web Search returned a local web_search function call instead of a hosted search event; falling back to Dline local Web Search.",
					{ exact: true },
				),
			).toBeVisible({ timeout: 60_000 })
			await expect(opened.sidebar.getByText("Dline wants to search the web for:", { exact: true })).toHaveCount(0)
			await expect(opened.sidebar.getByText("Approve", { exact: true })).toHaveCount(0)
			const fallbackCard = opened.sidebar.getByTestId("web-search-card").filter({ hasText: query })
			await expect(fallbackCard.getByText("SearXNG (Dline)", { exact: true })).toBeVisible({ timeout: 60_000 })
			const fallbackToggle = fallbackCard.getByTestId("web-search-details-toggle")
			await expect(fallbackToggle).toHaveAttribute("aria-expanded", "false")
			await fallbackToggle.click()
			await expect(fallbackCard.getByText(resultMarker, { exact: true })).toBeVisible()
			await expect(opened.sidebar.getByText(completion, { exact: false }).last()).toBeVisible({ timeout: 60_000 })

			const consumptions = server.getMockConsumptions("openai-compatible-responses")
			expect(consumptions).toHaveLength(2)
			expectSingleSearchRoute(consumptions[0], "hosted")
			expect(consumptions[1].contractError).toBeUndefined()
			const [searchRequest] = server.getSearxngSearchRequests()
			expect(searchRequest).toMatchObject({ query, format: "json" })
			expect(JSON.stringify(consumptions[1].requestBody)).toContain(resultMarker)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app?.close()
		}
	},
)

e2e(
	"ServerTool runtime - Force Remote on OpenAI Responses uses hosted Web Search without a local duplicate",
	async ({ dlineDir, dlineDocsDir, dlineHomeDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		expectIsolatedDirectories(dlineDir, dlineHomeDir, dlineDocsDir)
		await prepareRuntimeProfile(dlineDir, E2E_PROFILE_NAMES.mockOpenAiResponses, {
			enabled: true,
			mode: "WEB_TOOLS_MODE_FORCE_REMOTE",
			supportsWebSearch: true,
		})
		const query = "Dline forced remote hosted search"
		const completion = "E2E_FORCE_REMOTE_HOSTED_WEB_SEARCH_OK"
		server.enqueueResponses("openai-compatible-responses", {
			type: "hosted-web-search",
			id: "ws_openai_force_remote_e2e",
			query,
			results: [{ title: "Forced remote result", url: "https://example.test/forced-remote" }],
			followupTools: [{ id: "call_force_remote_done", name: "attempt_completion", arguments: { result: completion } }],
		})

		let app: ElectronApplication | undefined
		try {
			const opened = await openSidebar(openVSCode, workspaceDir, helper)
			app = opened.app
			await setAutoApproveAction(opened.sidebar, "Use Web", true)
			await sendTask(opened.sidebar, "Use forced remote web search and finish the task.")
			await expectHostedLifecycle(opened.sidebar, query, {
				title: "Forced remote result",
				url: "https://example.test/forced-remote",
			})
			await expect(opened.sidebar.getByText(completion, { exact: false }).last()).toBeVisible({ timeout: 60_000 })

			const [firstRequest] = server.getMockConsumptions("openai-compatible-responses")
			expect(firstRequest).toBeDefined()
			expectSingleSearchRoute(firstRequest, "hosted")
			expect(server.getSearxngSearchRequests()).toHaveLength(0)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app?.close()
		}
	},
)

e2e(
	"ServerTool runtime - DeepSeek Responses Auto projects built-in Web Search metadata and renders its lifecycle",
	async ({ dlineDir, dlineDocsDir, dlineHomeDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		expectIsolatedDirectories(dlineDir, dlineHomeDir, dlineDocsDir)
		await prepareRuntimeProfile(dlineDir, E2E_PROFILE_NAMES.mockDeepSeek, {
			apiFormat: "OPENAI_RESPONSES",
			baseUrl: getE2EMockProviderBaseUrl(server.baseUrl, "deepseek-responses"),
			enabled: true,
			mode: "WEB_TOOLS_MODE_AUTO",
		})
		const query = "Dline DeepSeek hosted search"
		const completion = "E2E_DEEPSEEK_HOSTED_WEB_SEARCH_OK"
		server.enqueueResponses("deepseek-responses", {
			type: "hosted-web-search",
			id: "ws_deepseek_e2e",
			query,
			results: [{ title: "DeepSeek hosted result", url: "https://example.test/deepseek-hosted" }],
			followupTools: [{ id: "call_deepseek_hosted_done", name: "attempt_completion", arguments: { result: completion } }],
		})

		let app: ElectronApplication | undefined
		try {
			const opened = await openSidebar(openVSCode, workspaceDir, helper)
			app = opened.app
			await setAutoApproveAction(opened.sidebar, "Use Web", true)
			await sendTask(opened.sidebar, "Use DeepSeek provider-hosted search and finish the task.")
			await expectHostedLifecycle(opened.sidebar, query, {
				title: "DeepSeek hosted result",
				url: "https://example.test/deepseek-hosted",
			})
			await expect(opened.sidebar.getByText(completion, { exact: false }).last()).toBeVisible({ timeout: 60_000 })

			const [firstRequest] = server.getMockConsumptions("deepseek-responses")
			expect(firstRequest).toBeDefined()
			expectSingleSearchRoute(firstRequest, "hosted")
			expect(server.getSearxngSearchRequests()).toHaveLength(0)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app?.close()
		}
	},
)

e2e(
	"ServerTool runtime - Anthropic Auto uses one hosted Web Search and renders its lifecycle",
	async ({ dlineDir, dlineDocsDir, dlineHomeDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		expectIsolatedDirectories(dlineDir, dlineHomeDir, dlineDocsDir)
		await prepareRuntimeProfile(dlineDir, E2E_PROFILE_NAMES.mockAnthropic, {
			enabled: true,
			mode: "WEB_TOOLS_MODE_AUTO",
			supportsWebSearch: true,
		})
		const query = "Dline Anthropic hosted search"
		const completion = "E2E_ANTHROPIC_HOSTED_WEB_SEARCH_OK"
		server.enqueueResponses("anthropic-messages", {
			type: "hosted-web-search",
			id: "srv_web_anthropic_e2e",
			query,
			results: [{ title: "Anthropic hosted result", url: "https://example.test/anthropic-hosted" }],
			followupTools: [{ id: "call_anthropic_hosted_done", name: "attempt_completion", arguments: { result: completion } }],
		})

		let app: ElectronApplication | undefined
		try {
			const opened = await openSidebar(openVSCode, workspaceDir, helper)
			app = opened.app
			await setAutoApproveAction(opened.sidebar, "Use Web", true)
			await sendTask(opened.sidebar, "Use Anthropic hosted search and finish the task.")
			await expectHostedLifecycle(opened.sidebar, query, {
				title: "Anthropic hosted result",
				url: "https://example.test/anthropic-hosted",
			})
			await expect(opened.sidebar.getByText(completion, { exact: false }).last()).toBeVisible({ timeout: 60_000 })

			const [firstRequest] = server.getMockConsumptions("anthropic-messages")
			expect(firstRequest).toBeDefined()
			expectSingleSearchRoute(firstRequest, "hosted")
			expect(server.getSearxngSearchRequests()).toHaveLength(0)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app?.close()
		}
	},
)

e2e(
	"ServerTool runtime - Anthropic Auto advertises versioned web search without inventing a hosted action",
	async ({ dlineDir, dlineDocsDir, dlineHomeDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		expectIsolatedDirectories(dlineDir, dlineHomeDir, dlineDocsDir)
		await prepareRuntimeProfile(dlineDir, E2E_PROFILE_NAMES.mockAnthropic, {
			enabled: true,
			mode: "WEB_TOOLS_MODE_AUTO",
			supportsWebSearch: true,
		})
		const completion = "E2E_ANTHROPIC_NO_HOSTED_ACTION_OK"
		server.enqueueResponses("anthropic-messages", {
			type: "tool",
			id: "call_anthropic_no_hosted_action_done",
			name: "attempt_completion",
			arguments: { result: completion },
		})

		let app: ElectronApplication | undefined
		try {
			const opened = await openSidebar(openVSCode, workspaceDir, helper)
			app = opened.app
			await setAutoApproveAction(opened.sidebar, "Use Web", true)
			await sendTask(opened.sidebar, "Finish without executing web search.")
			await expect(opened.sidebar.getByText(completion, { exact: false }).last()).toBeVisible({ timeout: 60_000 })

			const firstRequest = await E2ETestHelper.waitForValue(
				async () => server.getMockConsumptions("anthropic-messages")[0],
				30_000,
			)
			expect(searchMechanisms(firstRequest).hosted).toEqual([
				{ type: "web_search_20260318", name: "web_search", allowed_callers: ["direct"] },
			])
			await expect(opened.sidebar.getByText("Dline searched the web for:", { exact: true })).toHaveCount(0)
			await expect(opened.sidebar.getByTestId("web-search-card")).toHaveCount(0)
			expect(server.getSearxngSearchRequests()).toHaveLength(0)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app?.close()
		}
	},
)

e2e(
	"ServerTool runtime - Anthropic ignores an orphan hosted Web Search result",
	async ({ dlineDir, dlineDocsDir, dlineHomeDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		expectIsolatedDirectories(dlineDir, dlineHomeDir, dlineDocsDir)
		await prepareRuntimeProfile(dlineDir, E2E_PROFILE_NAMES.mockAnthropic, {
			enabled: true,
			mode: "WEB_TOOLS_MODE_AUTO",
			supportsWebSearch: true,
		})
		const completion = "E2E_ANTHROPIC_ORPHAN_HOSTED_RESULT_IGNORED"
		server.enqueueResponses("anthropic-messages", {
			type: "anthropic-orphan-web-search-result",
			id: "srv_web_anthropic_orphan_e2e",
			results: [{ title: "Orphan result", url: "https://example.test/anthropic-orphan" }],
			followupTools: [
				{
					id: "call_anthropic_orphan_done",
					name: "attempt_completion",
					arguments: { result: completion },
				},
			],
		})

		let app: ElectronApplication | undefined
		try {
			const opened = await openSidebar(openVSCode, workspaceDir, helper)
			app = opened.app
			await setAutoApproveAction(opened.sidebar, "Use Web", true)
			await sendTask(opened.sidebar, "Finish without executing web search.")
			await expect(opened.sidebar.getByText(completion, { exact: false }).last()).toBeVisible({ timeout: 60_000 })

			await expect(opened.sidebar.getByText("Dline searched the web for:", { exact: true })).toHaveCount(0)
			await expect(opened.sidebar.getByTestId("web-search-card")).toHaveCount(0)
			expect(server.getSearxngSearchRequests()).toHaveLength(0)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app?.close()
		}
	},
)

e2e(
	"ServerTool runtime - Auto falls back to local Web Search and returns its result to the provider",
	async ({ dlineDir, dlineDocsDir, dlineHomeDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		expectIsolatedDirectories(dlineDir, dlineHomeDir, dlineDocsDir)
		await prepareRuntimeProfile(dlineDir, E2E_PROFILE_NAMES.mockOpenAi, {
			enabled: true,
			mode: "WEB_TOOLS_MODE_AUTO",
			supportsWebSearch: true,
		})
		await configureSearxngSearch(dlineDir, server.baseUrl)
		const query = "Dline local fallback search"
		const resultMarker = `E2E local result for ${query}`
		const completion = "E2E_LOCAL_WEB_SEARCH_RESULT_REPLAYED"
		server.enqueueResponses(
			"openai-compatible-chat",
			{ type: "tool", id: "call_local_web_search", name: "web_search", arguments: { query } },
			{
				type: "tool",
				id: "call_local_web_search_done",
				name: "attempt_completion",
				arguments: { result: completion },
				expectedToolResults: [{ callId: "call_local_web_search", contentIncludes: resultMarker }],
			},
		)

		let app: ElectronApplication | undefined
		try {
			const opened = await openSidebar(openVSCode, workspaceDir, helper)
			app = opened.app
			await setAutoApproveAction(opened.sidebar, "Use the browser", true)
			await setAutoApproveAction(opened.sidebar, "Use Web", false)
			await sendTask(opened.sidebar, "Search locally when hosted search is unavailable, then finish.")
			await expect(opened.sidebar.getByText("Dline wants to search the web for:", { exact: true })).toBeVisible({
				timeout: 60_000,
			})
			await opened.sidebar.getByText("Approve", { exact: true }).click()
			await expect(opened.sidebar.getByText(completion, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			const searchCard = opened.sidebar.getByTestId("web-search-card").filter({ hasText: query })
			await expect(searchCard).toHaveCount(1)
			await expect(searchCard.getByText("SearXNG (Dline)", { exact: true })).toBeVisible()
			const searchToggle = searchCard.getByTestId("web-search-details-toggle")
			await expect(searchToggle).toHaveAttribute("aria-expanded", "false")
			await expect(searchCard.getByTestId("web-search-results")).toHaveCount(0)
			await expect(searchCard.getByText(resultMarker, { exact: true })).toHaveCount(0)
			await searchToggle.click()
			await expect(searchToggle).toHaveAttribute("aria-expanded", "true")
			await expect(searchCard.getByText(resultMarker, { exact: true })).toBeVisible()
			await expect(searchCard.getByText("https://example.test/dline-local-search", { exact: true })).toBeVisible()
			await expect40VhCard(searchCard, true)

			const consumptions = server.getMockConsumptions("openai-compatible-chat")
			expect(consumptions).toHaveLength(2)
			expectSingleSearchRoute(consumptions[0], "local")
			const [searchRequest] = server.getSearxngSearchRequests()
			expect(searchRequest).toMatchObject({ query, format: "json" })
			expect(searchRequest.authorization).toBeUndefined()
			expect(JSON.stringify(consumptions[1].requestBody)).toContain(resultMarker)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app?.close()
		}
	},
)

e2e(
	"ServerTool runtime - Force Local requires approval when local Use Web auto-approval is off",
	async ({ dlineDir, dlineDocsDir, dlineHomeDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(120_000)
		expectIsolatedDirectories(dlineDir, dlineHomeDir, dlineDocsDir)
		await prepareRuntimeProfile(dlineDir, E2E_PROFILE_NAMES.mockOpenAiResponses, {
			enabled: true,
			mode: "WEB_TOOLS_MODE_FORCE_LOCAL",
			supportsWebSearch: true,
		})
		await configureSearxngSearch(dlineDir, server.baseUrl)
		await configureNormalApprovalMode(dlineDir)
		const query = "Dline normal mode web approval isolation"
		server.enqueueResponses("openai-compatible-responses", {
			type: "tool",
			id: "call_normal_mode_web_search",
			name: "web_search",
			arguments: { query },
		})

		let app: ElectronApplication | undefined
		try {
			const opened = await openSidebar(openVSCode, workspaceDir, helper)
			app = opened.app
			await sendTask(opened.sidebar, "Require explicit local Web Search approval in normal mode.")

			await expect(opened.sidebar.getByText("Dline wants to search the web for:", { exact: true })).toBeVisible({
				timeout: 60_000,
			})
			await expect(opened.sidebar.getByRole("contentinfo").getByText("Approve", { exact: true })).toBeVisible()
			const consumptions = server.getMockConsumptions("openai-compatible-responses")
			expect(consumptions).toHaveLength(1)
			expectSingleSearchRoute(consumptions[0], "local")
			expect(server.getSearxngSearchRequests()).toHaveLength(0)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app?.close()
		}
	},
)

e2e(
	"ServerTool runtime - pending local Web Search remains executable after closing and reopening the task",
	async ({ dlineDir, dlineDocsDir, dlineHomeDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		expectIsolatedDirectories(dlineDir, dlineHomeDir, dlineDocsDir)
		await prepareRuntimeProfile(dlineDir, E2E_PROFILE_NAMES.mockOpenAiResponses, {
			enabled: true,
			mode: "WEB_TOOLS_MODE_FORCE_LOCAL",
			supportsWebSearch: true,
		})
		await configureSearxngSearch(dlineDir, server.baseUrl)
		await configureNormalApprovalMode(dlineDir)
		const query = "Dline restored local search"
		const resultMarker = `E2E local result for ${query}`
		const completion = "E2E_RESTORED_LOCAL_WEB_SEARCH_OK"
		server.enqueueResponses(
			"openai-compatible-responses",
			{ type: "tool", id: "call_restored_local_search", name: "web_search", arguments: { query } },
			{
				type: "tool",
				id: "call_restored_local_search_done",
				name: "attempt_completion",
				arguments: { result: completion },
				expectedToolResults: [{ callId: "call_restored_local_search", contentIncludes: resultMarker }],
			},
		)

		let app: ElectronApplication | undefined
		try {
			const opened = await openSidebar(openVSCode, workspaceDir, helper)
			app = opened.app
			const taskText = "Search locally only after I reopen and approve this task."
			await sendTask(opened.sidebar, taskText)
			await expect(opened.sidebar.getByText("Approve", { exact: true })).toBeVisible({ timeout: 60_000 })
			const initialConsumption = server.getMockConsumptions("openai-compatible-responses")[0]
			expect(initialConsumption).toBeDefined()
			expectSingleSearchRoute(initialConsumption, "local")
			expect(server.getSearxngSearchRequests()).toHaveLength(0)

			await closeCurrentTask(opened.sidebar)
			await reopenTask(opened.sidebar, taskText)
			const approveButton = opened.sidebar.getByRole("contentinfo").getByText("Approve", { exact: true })
			await expect(approveButton).toBeVisible({ timeout: 30_000 })
			await approveButton.click()

			await expect(opened.sidebar.getByText(completion, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expect.poll(() => server.getSearxngSearchRequests().length, { timeout: 30_000 }).toBe(1)
			const completedCard = opened.sidebar.getByTestId("web-search-card").filter({ hasText: query })
			await expect(completedCard).toHaveCount(1)
			const completedToggle = completedCard.getByTestId("web-search-details-toggle")
			await expect(completedToggle).toHaveAttribute("aria-expanded", "false")
			await completedToggle.click()
			await expect(completedCard.getByText(resultMarker, { exact: true })).toBeVisible()
			await expect(completedCard.getByText("https://example.test/dline-local-search", { exact: true })).toBeVisible()

			await closeCurrentTask(opened.sidebar)
			await reopenTask(opened.sidebar, taskText)
			const restoredCard = opened.sidebar.getByTestId("web-search-card").filter({ hasText: query })
			await expect(restoredCard).toHaveCount(1)
			const restoredToggle = restoredCard.getByTestId("web-search-details-toggle")
			await expect(restoredToggle).toHaveAttribute("aria-expanded", "false")
			await expect(restoredCard.getByText(resultMarker, { exact: true })).toHaveCount(0)
			await restoredToggle.click()
			await expect(restoredCard.getByText(resultMarker, { exact: true })).toBeVisible()
			await expect(restoredCard.getByText("https://example.test/dline-local-search", { exact: true })).toBeVisible()

			const consumptions = server.getMockConsumptions("openai-compatible-responses")
			expect(consumptions).toHaveLength(2)
			expectSingleSearchRoute(consumptions[1], "local")
			expect(consumptions[1].contractError).toBeUndefined()
			expect(JSON.stringify(consumptions[1].requestBody)).toContain(resultMarker)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app?.close()
		}
	},
)

e2e(
	"ServerTool runtime - Force Local on OpenAI Responses executes local Web Search instead of hosted search",
	async ({ dlineDir, dlineDocsDir, dlineHomeDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		expectIsolatedDirectories(dlineDir, dlineHomeDir, dlineDocsDir)
		await prepareRuntimeProfile(dlineDir, E2E_PROFILE_NAMES.mockOpenAiResponses, {
			enabled: true,
			mode: "WEB_TOOLS_MODE_FORCE_LOCAL",
			supportsWebSearch: true,
		})
		await configureSearxngSearch(dlineDir, server.baseUrl)
		const query = "Dline forced local search"
		const resultMarker = `E2E local result for ${query}`
		const completion = "E2E_FORCE_LOCAL_WEB_SEARCH_RESULT_REPLAYED"
		server.enqueueResponses(
			"openai-compatible-responses",
			{ type: "tool", id: "call_force_local_web_search", name: "web_search", arguments: { query } },
			{
				type: "tool",
				id: "call_force_local_web_search_done",
				name: "attempt_completion",
				arguments: { result: completion },
				expectedToolResults: [{ callId: "call_force_local_web_search", contentIncludes: resultMarker }],
			},
		)

		let app: ElectronApplication | undefined
		try {
			const opened = await openSidebar(openVSCode, workspaceDir, helper)
			app = opened.app
			await setAutoApproveAction(opened.sidebar, "Use the browser", false)
			await setAutoApproveAction(opened.sidebar, "Use Web", true)
			await sendTask(opened.sidebar, "Force local web search even though hosted search is available, then finish.")
			await expect.poll(() => server.getSearxngSearchRequests().length, { timeout: 60_000 }).toBe(1)
			await expect(opened.sidebar.getByText("Approve", { exact: true })).toHaveCount(0)
			await expect(opened.sidebar.getByText(completion, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			const searchCard = opened.sidebar.getByTestId("web-search-card").filter({ hasText: query })
			await expect(searchCard).toHaveCount(1)
			const searchToggle = searchCard.getByTestId("web-search-details-toggle")
			await expect(searchToggle).toHaveAttribute("aria-expanded", "false")
			await searchToggle.click()
			await expect(searchCard.getByText(resultMarker, { exact: true })).toBeVisible()
			await expect(searchCard.getByText("https://example.test/dline-local-search", { exact: true })).toBeVisible()

			const consumptions = server.getMockConsumptions("openai-compatible-responses")
			expect(consumptions).toHaveLength(2)
			expectSingleSearchRoute(consumptions[0], "local")
			const [searchRequest] = server.getSearxngSearchRequests()
			expect(searchRequest).toMatchObject({ query, format: "json" })
			expect(searchRequest.authorization).toBeUndefined()
			expect(JSON.stringify(consumptions[1].requestBody)).toContain(resultMarker)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app?.close()
		}
	},
)

e2e(
	"ServerTool runtime - OpenAI Responses manual Web Fetch reaches a terminal state within the product budget",
	async ({ dlineDir, dlineDocsDir, dlineHomeDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(120_000)
		expectIsolatedDirectories(dlineDir, dlineHomeDir, dlineDocsDir)
		await prepareRuntimeProfile(dlineDir, E2E_PROFILE_NAMES.mockOpenAiResponses, {
			enabled: true,
			mode: "WEB_TOOLS_MODE_FORCE_LOCAL",
			supportsWebSearch: true,
		})
		const url = `${server.baseUrl}/mock/web-fetch/page`
		const prompt = "Return the local Web Fetch page content within the product budget"
		const completion = "E2E_RESPONSES_MANUAL_WEB_FETCH_TERMINAL"
		server.enqueueResponses(
			"openai-compatible-responses",
			{ type: "tool", id: "call_responses_manual_web_fetch", name: "web_fetch", arguments: { url, prompt } },
			{
				type: "tool",
				id: "call_responses_manual_web_fetch_done",
				name: "attempt_completion",
				arguments: { result: completion },
			},
		)

		let app: ElectronApplication | undefined
		try {
			const opened = await openSidebar(openVSCode, workspaceDir, helper)
			app = opened.app
			await setAutoApproveAction(opened.sidebar, "Use Web", false)
			await sendTask(opened.sidebar, "Run an OpenAI Responses local Web Fetch after explicit approval.")
			await expect(opened.sidebar.getByText("Dline wants to fetch content from this URL:", { exact: true })).toBeVisible({
				timeout: 60_000,
			})
			await opened.sidebar.getByRole("contentinfo").getByText("Approve", { exact: true }).click()

			const fetchCard = opened.sidebar.getByTestId("web-fetch-card").filter({ hasText: url })
			await expect(fetchCard).toHaveCount(1)
			await expect
				.poll(
					async () => {
						if ((await fetchCard.getByTestId("web-fetch-details-toggle").count()) > 0) return "completed"
						const text = (await fetchCard.textContent()) ?? ""
						return /Web fetch failed:|Error fetching web content:|timed out|timeout|cancelled|canceled/i.test(text)
							? "failed"
							: "running"
					},
					{ timeout: 45_000, intervals: [250, 500, 1_000] },
				)
				.toMatch(/completed|failed/)
			await expect(opened.sidebar.getByText(completion, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app?.close()
		}
	},
)

const webFetchCases = [
	{
		title: "OpenAI Chat",
		profileName: E2E_PROFILE_NAMES.mockOpenAi,
		target: "openai-compatible-chat" as MockApiTarget,
		useBrowser: true,
		useWeb: false,
	},
	{
		title: "OpenAI Responses",
		profileName: E2E_PROFILE_NAMES.mockOpenAiResponses,
		target: "openai-compatible-responses" as MockApiTarget,
		useBrowser: false,
		useWeb: true,
	},
] as const

for (const testCase of webFetchCases) {
	e2e(
		`ServerTool runtime - ${testCase.title} executes local Web Fetch without a Cline login`,
		async ({ dlineDir, dlineDocsDir, dlineHomeDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
			e2e.setTimeout(300_000)
			expectIsolatedDirectories(dlineDir, dlineHomeDir, dlineDocsDir)
			await prepareRuntimeProfile(dlineDir, testCase.profileName, {
				enabled: true,
				mode: "WEB_TOOLS_MODE_AUTO",
				supportsWebSearch: true,
			})
			await prepareWebFetchBrowser(dlineHomeDir)
			const url = `${server.baseUrl}/mock/web-fetch/page`
			const prompt = "Extract the local Web Fetch marker"
			const completion = `E2E_${testCase.target.toUpperCase().replaceAll("-", "_")}_WEB_FETCH_OK`
			server.enqueueResponses(
				testCase.target,
				{ type: "tool", id: `call_${testCase.target}_web_fetch`, name: "web_fetch", arguments: { url, prompt } },
				{
					type: "tool",
					id: `call_${testCase.target}_web_fetch_done`,
					name: "attempt_completion",
					arguments: { result: completion },
					expectedToolResults: [
						{
							callId: `call_${testCase.target}_web_fetch`,
							contentIncludes: ["Dline local Web Fetch", prompt],
						},
					],
					expectedRequestExcludes: ["REMOVE_NAVIGATION", "REMOVE_SCRIPT"],
				},
			)

			let app: ElectronApplication | undefined
			try {
				const opened = await openSidebar(openVSCode, workspaceDir, helper)
				app = opened.app
				await setAutoApproveAction(opened.sidebar, "Use the browser", testCase.useBrowser)
				await setAutoApproveAction(opened.sidebar, "Use Web", testCase.useWeb)
				await sendTask(opened.sidebar, `Use ${testCase.title} local Web Fetch without signing in to Cline.`)
				if (testCase.useWeb) {
					await expect(opened.sidebar.getByTestId("web-fetch-card").filter({ hasText: url })).toBeVisible({
						timeout: 60_000,
					})
					await expect(opened.sidebar.getByText("Approve", { exact: true })).toHaveCount(0)
				} else {
					await expect(
						opened.sidebar.getByText("Dline wants to fetch content from this URL:", { exact: true }),
					).toBeVisible({
						timeout: 60_000,
					})
					await opened.sidebar.getByText("Approve", { exact: true }).click()
				}
				const fetchCard = opened.sidebar.getByTestId("web-fetch-card").filter({ hasText: url })
				await expect(fetchCard).toHaveCount(1)
				await expect(fetchCard.getByText("Browser Web Fetch (Dline)", { exact: true })).toBeVisible({
					timeout: 180_000,
				})
				const fetchToggle = fetchCard.getByTestId("web-fetch-details-toggle")
				await expect(fetchToggle).toHaveAttribute("aria-expanded", "false")
				await expect(fetchCard.getByTestId("web-fetch-results")).toHaveCount(0)
				await fetchToggle.click()
				await expect(fetchToggle).toHaveAttribute("aria-expanded", "true")
				const fetchResults = fetchCard.getByTestId("web-fetch-results")
				await expect(fetchResults).toContainText("E2E\\_WEB\\_FETCH\\_PAGE\\_CONTENT\\_00")
				await expect(fetchResults).toContainText("E2E\\_WEB\\_FETCH\\_PAGE\\_CONTENT\\_31")
				await expect40VhCard(fetchCard, true)
				await expect(opened.sidebar.getByText(completion, { exact: false }).last()).toBeVisible({ timeout: 60_000 })

				const consumptions = server.getMockConsumptions(testCase.target)
				expect(consumptions).toHaveLength(2)
				expect(consumptions[1].contractError).toBeUndefined()
				const [pageRequest] = server.getWebFetchPageRequests()
				expect(pageRequest).toBeDefined()
				expect(pageRequest.authorization).toBeUndefined()
				expect(server.getWebFetchPageRequests()).toHaveLength(1)
				await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
			} finally {
				await app?.close()
			}
		},
	)
}

e2e(
	"ServerTool runtime - checkpoint Restore cancels an established Web Fetch before the first Resume",
	async ({ dlineDir, dlineDocsDir, dlineHomeDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(480_000)
		expectIsolatedDirectories(dlineDir, dlineHomeDir, dlineDocsDir)
		await prepareRuntimeProfile(dlineDir, E2E_PROFILE_NAMES.mockOpenAiResponses, {
			enabled: true,
			mode: "WEB_TOOLS_MODE_FORCE_LOCAL",
			supportsWebSearch: true,
		})
		await prepareWebFetchBrowser(dlineHomeDir)
		const warmUrl = `${server.baseUrl}/mock/web-fetch/page`
		const delayedUrl = `${server.baseUrl}/mock/web-fetch/page?delayMs=30000`
		const resumeDraft = "E2E_WEB_FETCH_RESTORE_FIRST_RESUME_DRAFT"
		const completion = "E2E_WEB_FETCH_RESTORE_FIRST_RESUME_OK"
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_web_fetch_restore_ready",
				name: "qna_respond",
				arguments: { response: "E2E_WEB_FETCH_RESTORE_READY" },
			},
			{
				type: "tool",
				id: "call_web_fetch_restore_warm",
				name: "web_fetch",
				arguments: { url: warmUrl, prompt: "Warm the isolated Web Fetch browser" },
			},
			{
				type: "tool",
				id: "call_web_fetch_restore_warm_ready",
				name: "qna_respond",
				arguments: { response: "E2E_WEB_FETCH_RESTORE_WARM_READY" },
				expectedToolResults: [{ callId: "call_web_fetch_restore_warm", contentIncludes: "Dline local Web Fetch" }],
			},
			{
				type: "tool",
				id: "call_web_fetch_restore_in_flight",
				name: "web_fetch",
				arguments: { url: delayedUrl, prompt: "Remain in flight until checkpoint restore cancels this request" },
			},
			{
				type: "tool",
				id: "call_web_fetch_restore_done",
				name: "attempt_completion",
				arguments: { result: completion },
				expectedRequestIncludes: [resumeDraft],
			},
			{
				type: "error",
				status: 500,
				code: "unexpected_post_restore_request",
				message: "An obsolete Web Fetch continuation consumed the post-restore response",
			},
		)

		let app: ElectronApplication | undefined
		try {
			const opened = await openSidebar(openVSCode, workspaceDir, helper)
			app = opened.app
			await setAutoApproveAction(opened.sidebar, "Use Web", false)
			await sendTask(opened.sidebar, "Create a checkpoint before warming Web Fetch.")
			await expect(opened.sidebar.getByText("E2E_WEB_FETCH_RESTORE_READY", { exact: true })).toBeVisible({
				timeout: 60_000,
			})

			const checkpointLabels = opened.sidebar.getByText("Checkpoint", { exact: true })
			await expect.poll(() => checkpointLabels.count(), { timeout: 30_000 }).toBeGreaterThan(0)
			const input = opened.sidebar.getByTestId("chat-input")
			await input.fill("E2E_WARM_WEB_FETCH")
			await input.press("Enter")
			await expect(opened.sidebar.getByRole("contentinfo").getByText("Approve", { exact: true })).toBeVisible({
				timeout: 60_000,
			})
			await opened.sidebar.getByRole("contentinfo").getByText("Approve", { exact: true }).click()
			await expect(opened.sidebar.getByText("E2E_WEB_FETCH_RESTORE_WARM_READY", { exact: true })).toBeVisible({
				timeout: 300_000,
			})
			await expect.poll(() => server.getWebFetchPageRequests().length, { timeout: 30_000 }).toBe(1)

			await input.fill("E2E_START_DELAYED_WEB_FETCH")
			await input.press("Enter")
			const approveButton = opened.sidebar.getByRole("contentinfo").getByText("Approve", { exact: true })
			await expect(approveButton).toBeVisible({ timeout: 60_000 })
			await approveButton.click()
			const runningCard = opened.sidebar.getByTestId("web-fetch-card").filter({ hasText: delayedUrl })
			await expect(runningCard).toBeVisible({ timeout: 30_000 })
			await expect.poll(() => server.getWebFetchPageRequests().length, { timeout: 30_000 }).toBe(2)

			const restoreCheckpointControl = checkpointLabels.last().locator("..").locator("..")
			await restoreCheckpointControl.scrollIntoViewIfNeeded()
			await restoreCheckpointControl.hover()
			const restoreButton = restoreCheckpointControl.getByRole("button", { name: "Restore", exact: true })
			await expect(restoreButton).toBeVisible({ timeout: 3_000 })
			await restoreButton.click({ timeout: 3_000 })
			const moreOptions = opened.sidebar.getByText("More options", { exact: true })
			await expect(moreOptions).toBeVisible()
			await moreOptions.click()
			const restoreTaskButton = opened.sidebar.getByRole("button", { name: "Restore Task Only", exact: true })
			const restoreStartedAt = Date.now()
			await restoreTaskButton.click()

			const resumeButton = opened.sidebar.getByRole("contentinfo").getByText("Resume", { exact: true })
			await expect(resumeButton).toBeVisible({ timeout: 5_000 })
			await expect
				.poll(() => server.getWebFetchPageRequests()[1]?.closedAtMs, { timeout: 5_000 })
				.toBeGreaterThanOrEqual(restoreStartedAt)
			await input.fill(resumeDraft)
			await resumeButton.click()

			await expect(input).toHaveValue("")
			await expect(opened.sidebar.getByText(/stale_interaction|stale interaction/i)).toHaveCount(0)
			await expect(opened.sidebar.getByText(completion, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expect.poll(() => server.getMockConsumptions("openai-compatible-responses").length).toBe(5)
			const continuation = server.getMockConsumptions("openai-compatible-responses")[4]
			expect(continuation.contractError).toBeUndefined()
			expectSingleSearchRoute(continuation, "local")
			expect(JSON.stringify(continuation.requestBody)).toContain(resumeDraft)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app?.close()
		}
	},
)

e2e(
	"ServerTool runtime - PreToolUse cancellation terminates and restores the local Web Fetch card",
	async ({ dlineDir, dlineDocsDir, dlineHomeDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		expectIsolatedDirectories(dlineDir, dlineHomeDir, dlineDocsDir)
		await prepareRuntimeProfile(dlineDir, E2E_PROFILE_NAMES.mockOpenAiResponses, {
			enabled: true,
			mode: "WEB_TOOLS_MODE_AUTO",
			supportsWebSearch: true,
		})
		const errorMessage = "E2E Web Fetch blocked by PreToolUse hook"
		await configureCancelingPreToolUseHook(dlineDir, workspaceDir, errorMessage)
		const url = `${server.baseUrl}/mock/web-fetch/page`
		const prompt = "This fetch must be blocked before provider execution"
		const taskText = "Run the Web Fetch that the workspace policy will block."
		server.enqueueResponses("openai-compatible-responses", {
			type: "tool",
			id: "call_hook_cancelled_web_fetch",
			name: "web_fetch",
			arguments: { url, prompt },
		})

		let app: ElectronApplication | undefined
		try {
			const opened = await openSidebar(openVSCode, workspaceDir, helper)
			app = opened.app
			await setAutoApproveAction(opened.sidebar, "Use Web", true)
			await sendTask(opened.sidebar, taskText)

			const fetchCard = opened.sidebar.getByTestId("web-fetch-card").filter({ hasText: url })
			await expect(fetchCard.getByText(errorMessage, { exact: true })).toBeVisible({ timeout: 60_000 })
			await expect(fetchCard).toHaveCount(1)
			await expect(fetchCard.getByTestId("web-fetch-results")).toHaveCount(0)
			await expect(opened.sidebar.getByText("Approve", { exact: true })).toHaveCount(0)
			expect(server.getWebFetchPageRequests()).toHaveLength(0)
			expect(server.getMockConsumptions("openai-compatible-responses")).toHaveLength(1)

			await closeCurrentTask(opened.sidebar)
			await reopenTask(opened.sidebar, taskText)
			const restoredCard = opened.sidebar.getByTestId("web-fetch-card").filter({ hasText: url })
			await expect(restoredCard).toHaveCount(1)
			await expect(restoredCard.getByText(errorMessage, { exact: true })).toBeVisible()
			await expect(restoredCard.getByTestId("web-fetch-results")).toHaveCount(0)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app?.close()
		}
	},
)

e2e(
	"ServerTool runtime - local Web Fetch failure is replayed to the model and restored as one terminal card",
	async ({ dlineDir, dlineDocsDir, dlineHomeDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(300_000)
		expectIsolatedDirectories(dlineDir, dlineHomeDir, dlineDocsDir)
		await prepareRuntimeProfile(dlineDir, E2E_PROFILE_NAMES.mockOpenAi, {
			enabled: true,
			mode: "WEB_TOOLS_MODE_AUTO",
			supportsWebSearch: true,
		})
		await prepareWebFetchBrowser(dlineHomeDir)
		const url = "http://127.0.0.1:1/e2e-web-fetch-failure"
		const prompt = "Extract content from the intentionally unreachable page"
		const taskText = "Attempt the unreachable local Web Fetch, report its error, then finish."
		const completion = "E2E_LOCAL_WEB_FETCH_FAILURE_REPLAYED"
		server.enqueueResponses(
			"openai-compatible-chat",
			{ type: "tool", id: "call_failed_web_fetch", name: "web_fetch", arguments: { url, prompt } },
			{
				type: "tool",
				id: "call_failed_web_fetch_done",
				name: "attempt_completion",
				arguments: { result: completion },
				expectedToolResults: [{ callId: "call_failed_web_fetch", contentIncludes: ["Error fetching web content", url] }],
			},
		)

		let app: ElectronApplication | undefined
		try {
			const opened = await openSidebar(openVSCode, workspaceDir, helper)
			app = opened.app
			await setAutoApproveAction(opened.sidebar, "Use Web", true)
			await sendTask(opened.sidebar, taskText)
			await expect(opened.sidebar.getByText(completion, { exact: false }).last()).toBeVisible({ timeout: 180_000 })

			const fetchCard = opened.sidebar.getByTestId("web-fetch-card").filter({ hasText: url })
			await expect(fetchCard).toHaveCount(1)
			await expect(fetchCard).toContainText(/ERR_UNSAFE_PORT|unsafe port/i)
			await expect(fetchCard.getByTestId("web-fetch-results")).toHaveCount(0)
			await expect(opened.sidebar.getByText("Approve", { exact: true })).toHaveCount(0)

			const consumptions = server.getMockConsumptions("openai-compatible-chat")
			expect(consumptions).toHaveLength(2)
			expect(consumptions[1].contractError).toBeUndefined()
			expect(JSON.stringify(consumptions[1].requestBody)).toContain("Error fetching web content")

			await closeCurrentTask(opened.sidebar)
			await reopenTask(opened.sidebar, taskText)
			const restoredCard = opened.sidebar.getByTestId("web-fetch-card").filter({ hasText: url })
			await expect(restoredCard).toHaveCount(1)
			await expect(restoredCard).toContainText(/ERR_UNSAFE_PORT|unsafe port/i)
			await expect(restoredCard.getByTestId("web-fetch-results")).toHaveCount(0)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app?.close()
		}
	},
)

const disabledCases = [
	{
		title: "the global Web Tools switch is off",
		profileName: E2E_PROFILE_NAMES.mockOpenAiResponses,
		target: "openai-compatible-responses" as MockApiTarget,
		enabled: false,
		mode: "WEB_TOOLS_MODE_AUTO" as StoredWebToolsMode,
	},
	{
		title: "the provider mode is Off",
		profileName: E2E_PROFILE_NAMES.mockOpenAi,
		target: "openai-compatible-chat" as MockApiTarget,
		enabled: true,
		mode: "WEB_TOOLS_MODE_FORCE_OFF" as StoredWebToolsMode,
	},
	{
		title: "Force Remote is selected for an unsupported transport",
		profileName: E2E_PROFILE_NAMES.mockOpenAi,
		target: "openai-compatible-chat" as MockApiTarget,
		enabled: true,
		mode: "WEB_TOOLS_MODE_FORCE_REMOTE" as StoredWebToolsMode,
	},
] as const

for (const testCase of disabledCases) {
	e2e(
		`ServerTool runtime - exposes no search mechanism when ${testCase.title}`,
		async ({ dlineDir, dlineDocsDir, dlineHomeDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
			e2e.setTimeout(150_000)
			expectIsolatedDirectories(dlineDir, dlineHomeDir, dlineDocsDir)
			await prepareRuntimeProfile(dlineDir, testCase.profileName, {
				enabled: testCase.enabled,
				mode: testCase.mode,
				supportsWebSearch: true,
			})
			const completion = `E2E_NO_SEARCH_${testCase.mode}_${testCase.enabled ? "ON" : "OFF"}`
			server.enqueueResponses(testCase.target, {
				type: "tool",
				id: `call_${testCase.mode.toLowerCase()}_done`,
				name: "attempt_completion",
				arguments: { result: completion },
			})

			let app: ElectronApplication | undefined
			try {
				const opened = await openSidebar(openVSCode, workspaceDir, helper)
				app = opened.app
				await sendTask(opened.sidebar, `Finish without web search because ${testCase.title}.`)
				await expect(opened.sidebar.getByText(completion, { exact: false }).last()).toBeVisible({ timeout: 60_000 })

				const [firstRequest] = server.getMockConsumptions(testCase.target)
				expect(firstRequest).toBeDefined()
				expectSingleSearchRoute(firstRequest, "none")
				expect(server.getSearxngSearchRequests()).toHaveLength(0)
				await expect(opened.sidebar.getByText(/search(ed)? the web for:/i)).toHaveCount(0)
				await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
			} finally {
				await app?.close()
			}
		},
	)
}
