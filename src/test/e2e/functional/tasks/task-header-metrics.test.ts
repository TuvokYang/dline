import { readdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import type { MockApiTarget, MockTokenUsage } from "@e2e/fixtures/server"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { readTaskApiRateMetrics } from "@e2e/utils/read-task-api-rate-metrics"
import { expect, type Frame } from "@playwright/test"
import type { ElectronApplication } from "playwright"

interface ApiRequestInfo {
	tokensIn?: number
	tokensOut?: number
	cacheWrites?: number
	cacheReads?: number
	cost?: number
}

interface StoredRateRecord {
	kind?: string
	second?: number
	revision?: number
	signals?: string[]
	requestCount?: number
	effectiveTokens?: number
	tokenQuality?: string
}

interface RateSummary {
	requestsPerMinute: number
	tokensPerMinute: number
	tokenCount: number
}

interface MetricsCase {
	title: string
	target: MockApiTarget
	profileName: string
	taskText: string
	completion: string
	usage: MockTokenUsage
}

interface StoredProfile {
	name: string
	webToolsMode?: string
}

const cases: readonly MetricsCase[] = [
	{
		title: "OpenAI Responses",
		target: "openai-compatible-responses",
		profileName: E2E_PROFILE_NAMES.mockOpenAiResponses,
		taskText: "E2E_TASK_HEADER_METRICS_OPENAI_RESPONSES",
		completion: "E2E_TASK_HEADER_METRICS_OPENAI_RESPONSES_DONE",
		usage: { inputTokens: 1_200, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 100 },
	},
	{
		title: "Anthropic Messages",
		target: "anthropic-messages",
		profileName: E2E_PROFILE_NAMES.mockAnthropic,
		taskText: "E2E_TASK_HEADER_METRICS_ANTHROPIC",
		completion: "E2E_TASK_HEADER_METRICS_ANTHROPIC_DONE",
		usage: { inputTokens: 1_200, outputTokens: 200, cacheReadTokens: 300, cacheWriteTokens: 100 },
	},
]

async function configureProfileBeforeLaunch(dlineDir: string, profileName: string): Promise<void> {
	const settingsDirectory = path.join(dlineDir, "data", "settings")
	const profilesPath = path.join(settingsDirectory, "api_profiles.json")
	const profiles = JSON.parse(await readFile(profilesPath, "utf8")) as StoredProfile[]
	const profile = profiles.find((candidate) => candidate.name === profileName)
	if (!profile) throw new Error(`Missing TaskHeader metrics E2E profile: ${profileName}`)
	profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
	await writeFile(profilesPath, `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

	const settingsPath = path.join(settingsDirectory, "settings.json")
	const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>
	settings.actModeProfile = profileName
	settings.planModeProfile = profileName
	settings.clineWebToolsEnabled = false
	await writeFile(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, "utf8")
}

async function openSidebar(app: ElectronApplication, helper: E2ETestHelper): Promise<Frame> {
	const page = await app.firstWindow()
	await E2ETestHelper.openClineSidebar(page)
	const sidebar = await helper.getSidebar(page)
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	await helper.signin(sidebar)
	return sidebar
}

async function onlyTaskId(dlineDocsDir: string): Promise<string> {
	return E2ETestHelper.waitForValue(async () => {
		const entries = await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true }).catch(() => [])
		const taskIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
		return taskIds.length === 1 ? taskIds[0] : undefined
	}, 30_000)
}

function expectedTotalTokens(usage: MockTokenUsage): number {
	return usage.inputTokens + usage.outputTokens + (usage.cacheReadTokens ?? 0) + (usage.cacheWriteTokens ?? 0)
}

async function readFinalRequestInfo(dlineDocsDir: string, taskId: string): Promise<ApiRequestInfo | undefined> {
	const raw = await readFile(path.join(dlineDocsDir, "tasks", taskId, "ui_messages.jsonl"), "utf8").catch(() => "")
	const requests = raw
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as { type?: string; say?: string; text?: string })
		.filter((message) => message.type === "say" && message.say === "api_req_started" && message.text)
		.map((message) => JSON.parse(message.text ?? "{}") as ApiRequestInfo)
	return requests.at(-1)
}

function storedActivitySeconds(record: StoredRateRecord): { activeSeconds: number; providerActiveSeconds: number } {
	const signals = record.signals ?? []
	const taskActive = signals.includes("task_active")
	const providerActive = signals.includes("provider_active")
	const legacyActive = !taskActive && !providerActive
	return {
		activeSeconds: taskActive || legacyActive ? 1 : 0,
		providerActiveSeconds: providerActive || legacyActive ? 1 : 0,
	}
}

function extrapolatePerMinute(value: number, activeSeconds: number): number {
	return activeSeconds > 0 ? Math.round((value * 60) / activeSeconds) : 0
}

async function readRateSummary(dlineDocsDir: string, taskId: string): Promise<RateSummary | undefined> {
	const storedRecords = readTaskApiRateMetrics<StoredRateRecord>(dlineDocsDir, taskId) ?? []
	const canonical = new Map<number, StoredRateRecord>()
	for (const record of storedRecords) {
		if (
			record.kind !== "second" ||
			typeof record.second !== "number" ||
			typeof record.revision !== "number" ||
			typeof record.requestCount !== "number" ||
			typeof record.effectiveTokens !== "number"
		) {
			continue
		}
		const current = canonical.get(record.second)
		if (!current || (current.revision ?? -1) <= record.revision) canonical.set(record.second, record)
	}
	const records = [...canonical.values()]
	if (records.length === 0) return undefined
	const activity = records.reduce(
		(total, record) => {
			const current = storedActivitySeconds(record)
			return {
				activeSeconds: total.activeSeconds + current.activeSeconds,
				providerActiveSeconds: total.providerActiveSeconds + current.providerActiveSeconds,
			}
		},
		{ activeSeconds: 0, providerActiveSeconds: 0 },
	)
	const requestCount = records.reduce((total, record) => total + (record.requestCount ?? 0), 0)
	const tokenCount = records.reduce((total, record) => total + (record.effectiveTokens ?? 0), 0)
	return {
		requestsPerMinute: extrapolatePerMinute(requestCount, activity.activeSeconds),
		tokensPerMinute: extrapolatePerMinute(tokenCount, activity.providerActiveSeconds),
		tokenCount,
	}
}

async function waitForPersistedMetrics(
	dlineDocsDir: string,
	taskId: string,
	usage: MockTokenUsage,
): Promise<{ request: ApiRequestInfo; rate: RateSummary }> {
	return E2ETestHelper.waitForValue(async () => {
		const request = await readFinalRequestInfo(dlineDocsDir, taskId)
		const rate = await readRateSummary(dlineDocsDir, taskId)
		if (!request || !rate) return undefined
		if (
			request.tokensIn !== usage.inputTokens ||
			request.tokensOut !== usage.outputTokens ||
			request.cacheReads !== (usage.cacheReadTokens ?? 0) ||
			request.cacheWrites !== (usage.cacheWriteTokens ?? 0) ||
			typeof request.cost !== "number" ||
			request.cost <= 0 ||
			rate.tokenCount !== expectedTotalTokens(usage)
		) {
			return undefined
		}
		return { request, rate }
	}, 30_000)
}

async function expectTaskHeaderMetrics(
	sidebar: Frame,
	dlineDocsDir: string,
	taskId: string,
	usage: MockTokenUsage,
	request: ApiRequestInfo,
): Promise<void> {
	const cacheReadTokens = usage.cacheReadTokens ?? 0
	const cacheWriteTokens = usage.cacheWriteTokens ?? 0
	const totalInputTokens = usage.inputTokens + cacheReadTokens + cacheWriteTokens
	const priceTag = sidebar.locator("#price-tag")
	await expect(priceTag).toBeVisible()
	await expect(priceTag).toHaveAttribute(
		"title",
		`In: ${totalInputTokens} / Out: ${usage.outputTokens} / Cache read: ${cacheReadTokens} / Cache write: ${cacheWriteTokens}`,
	)
	expect(request.cost).toBeGreaterThan(0)

	const rate = sidebar.getByTestId("task-rate-metrics")
	await expect(rate).toBeVisible()
	const stableRate = await E2ETestHelper.waitForValue(async () => {
		const persistedRate = await readRateSummary(dlineDocsDir, taskId)
		if (!persistedRate || persistedRate.tokenCount !== expectedTotalTokens(usage)) return undefined
		const ariaLabel = await rate.getAttribute("aria-label")
		if (!ariaLabel?.match(/(?:^|; )RPM: [1-9]\d*(?:;|$)/)) return undefined
		if (!ariaLabel.includes(`TPM: ${persistedRate.tokensPerMinute}`)) return undefined
		if (ariaLabel.includes("Request")) return undefined
		return persistedRate
	}, 30_000)
	expect(stableRate.tokensPerMinute).toBeGreaterThan(0)
	expect(stableRate.requestsPerMinute).toBeGreaterThan(0)
}

async function reopenTaskFromHistory(sidebar: Frame, taskText: string): Promise<void> {
	const closeTask = sidebar.getByRole("button", { name: "Close Task", exact: true })
	if (await closeTask.isVisible()) {
		await closeTask.click()
		await expect(sidebar.getByTestId("chat-input")).toBeVisible()
	}
	await sidebar.page().getByRole("button", { name: "History", exact: true }).click()
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	const historyTask = sidebar.locator(".history-item").filter({ hasText: taskText })
	await expect(historyTask).toHaveCount(1)
	await historyTask.click()
	await expect(sidebar.getByText(taskText, { exact: true }).first()).toBeVisible({ timeout: 30_000 })
}

for (const testCase of cases) {
	e2e(
		`TaskHeader metrics - ${testCase.title} keeps late usage, rates, cost, and reopen persistence`,
		async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
			e2e.setTimeout(180_000)
			await configureProfileBeforeLaunch(dlineDir, testCase.profileName)
			server.resetOpenAiMock()
			const response = {
				name: "attempt_completion",
				arguments: { result: testCase.completion },
				usage: testCase.usage,
				beforeUsageDelayMs: 5_000,
			}
			server.enqueueResponses(
				testCase.target,
				testCase.target === "openai-compatible-responses"
					? { type: "tool-with-completion-snapshots", ...response }
					: { type: "tool", ...response },
			)

			let app: ElectronApplication | undefined
			let reopenedApp: ElectronApplication | undefined
			try {
				app = await openVSCode(workspaceDir)
				let sidebar = await openSidebar(app, helper)
				const input = sidebar.getByTestId("chat-input")
				await input.fill(testCase.taskText)
				await input.press("Enter")
				await expect(sidebar.getByText(testCase.completion, { exact: false }).last()).toBeVisible({ timeout: 60_000 })

				const taskId = await onlyTaskId(dlineDocsDir)
				const persisted = await waitForPersistedMetrics(dlineDocsDir, taskId, testCase.usage)
				await expectTaskHeaderMetrics(sidebar, dlineDocsDir, taskId, testCase.usage, persisted.request)
				expect(server.getMockConsumptions(testCase.target)).toHaveLength(1)
				expect(server.getMockConsumptions(testCase.target)[0]?.contractError).toBeUndefined()

				await app.close()
				app = undefined
				helper.clearCachedFrame()

				reopenedApp = await openVSCode(workspaceDir)
				sidebar = await openSidebar(reopenedApp, helper)
				await reopenTaskFromHistory(sidebar, testCase.taskText)
				await expectTaskHeaderMetrics(sidebar, dlineDocsDir, taskId, testCase.usage, persisted.request)
				await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
			} finally {
				await reopenedApp?.close()
				await app?.close()
			}
		},
	)
}
