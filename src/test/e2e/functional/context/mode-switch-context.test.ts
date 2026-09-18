import { readdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import type { MockApiConsumption } from "@e2e/fixtures/server"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Locator, type TestInfo } from "@playwright/test"
import { MAX_TOOL_RESULT_TEXT_BYTES } from "@shared/content-limits"
import type { ElectronApplication } from "playwright"

interface StoredProfile {
	id: string
	name: string
	modelId?: string
	webToolsMode?: "WEB_TOOLS_MODE_FORCE_OFF"
	openai?: {
		capabilities?: {
			contextWindow?: number
		}
	}
}

interface StoredCompletionSnapshot {
	phase?: string
	completion?: { completionId?: string }
	interaction?: {
		interactionId?: string
		kind?: string
		status?: string
	}
	anchor?: { interactionId?: string }
	turn?: { blocks?: Array<{ dlineTid?: string; phase?: string; toolName?: string }> }
}

const COMPACT_SIGNAL = "__dline_mode_switch_compact__"
const COMPACT_INSTRUCTION_MARKER = "The current conversation is rapidly running out of context"
const INTERNAL_MODE_RESPONSE = "PLAN_MODE_TOGGLE_RESPONSE"
const profilesPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "api_profiles.json")
const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")

async function configureModeProfiles(
	dlineDir: string,
	options: {
		actProfile: string
		actContextWindow: number
		planProfile: string
		planContextWindow: number
	},
): Promise<void> {
	const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
	for (const [name, contextWindow] of [
		[options.actProfile, options.actContextWindow],
		[options.planProfile, options.planContextWindow],
	] as const) {
		const profile = profiles.find((candidate) => candidate.name === name)
		if (!profile?.openai?.capabilities) throw new Error(`Missing configurable E2E profile: ${name}`)
		profile.openai.capabilities.contextWindow = contextWindow
		profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
	}
	await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

	const actProfile = profiles.find((candidate) => candidate.name === options.actProfile)
	const planProfile = profiles.find((candidate) => candidate.name === options.planProfile)
	if (!actProfile || !planProfile) throw new Error("Configured mode Profiles disappeared before settings write")
	const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
	await writeFile(
		settingsPath(dlineDir),
		`${JSON.stringify(
			{
				...settings,
				planActSeparateModelsSetting: true,
				actModeProfileId: actProfile.id,
				actModeProfile: actProfile.name,
				planModeProfileId: planProfile.id,
				planModeProfile: planProfile.name,
			},
			null,
			2,
		)}\n`,
		"utf8",
	)
}

async function configureAutoCompact(dlineDir: string, enabled: boolean): Promise<void> {
	const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
	const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
	if (!profile?.openai?.capabilities) throw new Error("Missing configurable OpenAI Responses E2E profile")
	profile.modelId = "gpt-5.4-mini"
	profile.openai.capabilities.contextWindow = 131_072
	profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
	await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

	const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
	await writeFile(
		settingsPath(dlineDir),
		`${JSON.stringify(
			{
				...settings,
				actModeProfileId: profile.id,
				actModeProfile: profile.name,
				planModeProfileId: profile.id,
				planModeProfile: profile.name,
				useAutoCondense: enabled,
			},
			null,
			2,
		)}\n`,
		"utf8",
	)
}

async function configureDeepSeekAutoCompact(dlineDir: string, useAutoCondense = true): Promise<void> {
	const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
	const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockDeepSeek)
	if (!profile) throw new Error("Missing configurable DeepSeek E2E profile")
	profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
	await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

	const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
	await writeFile(
		settingsPath(dlineDir),
		`${JSON.stringify(
			{
				...settings,
				actModeProfileId: profile.id,
				actModeProfile: profile.name,
				planModeProfileId: profile.id,
				planModeProfile: profile.name,
				useAutoCondense,
				autoCondenseTriggerPercent: 97,
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

async function configureTaskProfileSwitch(dlineDir: string): Promise<void> {
	const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
	const targetProfile = profiles.find((profile) => profile.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
	if (!targetProfile?.openai?.capabilities) throw new Error("Missing configurable OpenAI Responses E2E profile")
	targetProfile.modelId = "gpt-5.6-sol"
	targetProfile.openai.capabilities.contextWindow = 372_000
	targetProfile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
	const sourceProfile = profiles.find((profile) => profile.name === E2E_PROFILE_NAMES.mockDeepSeek)
	if (!sourceProfile) throw new Error("Missing configurable DeepSeek E2E profile")
	sourceProfile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
	await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

	const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
	await writeFile(
		settingsPath(dlineDir),
		`${JSON.stringify(
			{
				...settings,
				planActSeparateModelsSetting: false,
				actModeProfileId: sourceProfile.id,
				actModeProfile: sourceProfile.name,
				planModeProfileId: sourceProfile.id,
				planModeProfile: sourceProfile.name,
				useAutoCondense: true,
				autoCondenseTriggerPercent: 97,
				autoCondenseMaxContextTokens: 0,
			},
			null,
			2,
		)}\n`,
		"utf8",
	)
}

async function configureProfileCompactionSwitch(dlineDir: string): Promise<void> {
	const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
	const sourceProfile = profiles.find((profile) => profile.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
	const targetProfile = profiles.find((profile) => profile.name === E2E_PROFILE_NAMES.mockOpenAi)
	if (!sourceProfile?.openai?.capabilities || !targetProfile?.openai?.capabilities) {
		throw new Error("Missing configurable OpenAI E2E profiles")
	}
	sourceProfile.modelId = "gpt-5.6-sol"
	sourceProfile.openai.capabilities.contextWindow = 272_000
	sourceProfile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
	targetProfile.modelId = "gpt-5.6-sol"
	targetProfile.openai.capabilities.contextWindow = 131_072
	targetProfile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
	await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

	const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
	await writeFile(
		settingsPath(dlineDir),
		`${JSON.stringify(
			{
				...settings,
				planActSeparateModelsSetting: false,
				actModeProfileId: sourceProfile.id,
				actModeProfile: sourceProfile.name,
				planModeProfileId: sourceProfile.id,
				planModeProfile: sourceProfile.name,
				useAutoCondense: false,
			},
			null,
			2,
		)}\n`,
		"utf8",
	)
}

async function clickProfileOption(sidebar: Frame, profileName: string): Promise<void> {
	const modelSwitcher = sidebar.getByRole("button", { name: "Select model" })
	if ((await modelSwitcher.innerText()).trim() === profileName) return
	await modelSwitcher.click()
	const profileOption = sidebar.getByRole("option").filter({ has: sidebar.getByText(profileName, { exact: true }) })
	await expect(profileOption).toHaveCount(1)
	await profileOption.click()
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

async function sendTask(sidebar: Frame, text: string, readinessTimeout = 60_000): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled({ timeout: readinessTimeout })
	await input.fill(text)
	await expect(sidebar.getByTestId("send-button")).toHaveAttribute("aria-disabled", "false", {
		timeout: readinessTimeout,
	})
	await input.press("Enter")
	await expect(input).toHaveValue("")
	await expect(sidebar.getByText(text, { exact: true }).last()).toBeVisible()
}

async function startInputValueObserver(sidebar: Frame): Promise<void> {
	await sidebar.evaluate(() => {
		const root = globalThis as typeof globalThis & {
			__dlineModeSwitchInputObserver?: { timer: number; values: string[] }
		}
		if (root.__dlineModeSwitchInputObserver) window.clearInterval(root.__dlineModeSwitchInputObserver.timer)
		const values: string[] = []
		const read = () => {
			const input = document.querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')
			if (input) values.push(input.value)
		}
		read()
		const timer = window.setInterval(read, 5)
		root.__dlineModeSwitchInputObserver = { timer, values }
	})
}

async function stopInputValueObserver(sidebar: Frame): Promise<string[]> {
	return sidebar.evaluate(() => {
		const root = globalThis as typeof globalThis & {
			__dlineModeSwitchInputObserver?: { timer: number; values: string[] }
		}
		const observer = root.__dlineModeSwitchInputObserver
		if (!observer) return []
		window.clearInterval(observer.timer)
		delete root.__dlineModeSwitchInputObserver
		return [...observer.values]
	})
}

function requestToolNames(consumption: MockApiConsumption): string[] {
	const body = consumption.requestBody as {
		tools?: Array<{ name?: string; function?: { name?: string } }>
	}
	return (body.tools ?? [])
		.map((tool) => tool.name ?? tool.function?.name)
		.filter((name): name is string => typeof name === "string")
}

async function expectPlanMode(sidebar: Frame): Promise<void> {
	await expect(sidebar.getByRole("switch", { name: "Plan" })).toHaveAttribute("aria-checked", "true", {
		timeout: 60_000,
	})
}

async function expectNoInternalCompactionEcho(sidebar: Frame): Promise<void> {
	const visibleText = await sidebar.locator("body").innerText()
	expect(visibleText).not.toContain(COMPACT_SIGNAL)
	expect(visibleText).not.toContain(INTERNAL_MODE_RESPONSE)
	expect(visibleText).not.toContain("The current conversation is rapidly running out of context")
}

async function expectCompactionSummary(sidebar: Frame, summary: string): Promise<void> {
	await expect(sidebar.getByText(summary, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
	await expectNoInternalCompactionEcho(sidebar)
}

const CONTEXT_WINDOW_SEGMENT_ORDER = ["durable", "active", "staged", "environment"] as const
const CONTEXT_WINDOW_SEGMENT_COLORS = [
	"var(--vscode-charts-green, #3fb950)",
	"var(--vscode-charts-blue, #58a6ff)",
	"var(--vscode-charts-orange, #d18616)",
	"var(--vscode-charts-purple, #bc8cff)",
] as const

async function expandTaskHeader(sidebar: Frame): Promise<void> {
	const expandTaskHeader = sidebar.getByLabel("Expand task header")
	if (await expandTaskHeader.isVisible()) await expandTaskHeader.click()
	await expect(sidebar.getByTestId("context-window-indicator")).toBeVisible({ timeout: 60_000 })
}

async function readContextWindowVisual(sidebar: Frame) {
	return sidebar.getByTestId("context-window-segmented-progress").evaluate((progress) => {
		const progressElement = progress as HTMLElement
		return {
			contextWindow: Number(progressElement.dataset.contextWindow ?? 0),
			epoch: Number(progressElement.dataset.epoch ?? 0),
			minorFactor: Number(progressElement.dataset.minorFactor ?? 1),
			mode: progressElement.dataset.mode,
			motion: progressElement.dataset.motion,
			phase: progressElement.dataset.phase,
			profileName: progressElement.dataset.profileName,
			revision: Number(progressElement.dataset.revision ?? 0),
			segments: Array.from(progressElement.querySelectorAll<HTMLElement>("[data-segment]")).map((segment) => ({
				active: segment.dataset.active,
				label: segment.getAttribute("aria-label")?.split(":", 1)[0],
				authoritativeTokens: Number(segment.dataset.authoritativeTokens ?? 0),
				computedColor: getComputedStyle(segment).backgroundColor,
				inlineColor: segment.style.backgroundColor,
				inlineWidth: segment.style.width,
				kind: segment.dataset.segment,
				tokens: Number(segment.dataset.tokens ?? 0),
				transitionSource: segment.dataset.transitionSource,
			})),
		}
	})
}

function expectFourContextSegments(visual: Awaited<ReturnType<typeof readContextWindowVisual>>): void {
	expect(visual.segments.map((segment) => segment.kind)).toEqual(CONTEXT_WINDOW_SEGMENT_ORDER)
	const expectedColors = [...CONTEXT_WINDOW_SEGMENT_COLORS]
	if (visual.segments[1]?.label === "Receiving") {
		expectedColors[1] = "var(--vscode-charts-yellow, #d29922)"
	}
	expect(visual.segments.map((segment) => segment.inlineColor)).toEqual(expectedColors)
	expect(new Set(visual.segments.map((segment) => segment.computedColor)).size).toBe(4)
	expect(visual.segments.at(-1)?.kind).toBe("environment")
}

function expectContextVisualAllocation(visual: Awaited<ReturnType<typeof readContextWindowVisual>>): void {
	expect(visual.minorFactor).toBeGreaterThanOrEqual(1)
	expect(visual.minorFactor).toBeLessThanOrEqual(3)
	const widths = visual.segments.map((segment) => Number.parseFloat(segment.inlineWidth || "0"))
	expect(widths.reduce((total, width) => total + width, 0)).toBeLessThanOrEqual(100.000_001)
	const authoritativeTotal = visual.segments.reduce((total, segment) => total + segment.authoritativeTokens, 0)
	const displayTotal = visual.segments.reduce((total, segment) => total + segment.tokens, 0)
	const denominator = Math.max(visual.contextWindow, authoritativeTotal, displayTotal)
	for (const segment of visual.segments.slice(1)) {
		const expectedWidth = denominator > 0 ? (segment.tokens * visual.minorFactor * 100) / denominator : 0
		expect(Number.parseFloat(segment.inlineWidth || "0")).toBeCloseTo(expectedWidth, 4)
	}
}

async function captureLocatorEvidence(locator: Locator, testInfo: TestInfo, name: string): Promise<void> {
	await expect(locator).toBeVisible({ timeout: 60_000 })
	const screenshotPath = testInfo.outputPath(`${name}.png`)
	await locator.screenshot({ path: screenshotPath })
	await testInfo.attach(name, { path: screenshotPath, contentType: "image/png" })
}

async function captureContextWindowEvidence(sidebar: Frame, testInfo: TestInfo, name: string): Promise<void> {
	await captureLocatorEvidence(sidebar.getByTestId("context-window-indicator"), testInfo, name)
}

async function confirmManualCompaction(sidebar: Frame, summary: string): Promise<void> {
	await expect(sidebar.getByText(summary, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
	const confirmButton = sidebar.locator('vscode-button[aria-label="Condense Conversation"]')
	await expect(confirmButton).toBeVisible({ timeout: 60_000 })
	await expectNoInternalCompactionEcho(sidebar)
	await confirmButton.click()
}

async function taskDirectoryIds(dlineDocsDir: string): Promise<string[]> {
	try {
		return (await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true }))
			.filter((entry) => entry.isDirectory())
			.map((entry) => entry.name)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") return []
		throw error
	}
}

async function readCompletionSnapshot(dlineDocsDir: string, taskId: string): Promise<StoredCompletionSnapshot> {
	return JSON.parse(await readFile(path.join(dlineDocsDir, "tasks", taskId, "snapshot.json"), "utf8"))
}

function completionSnapshotState(snapshot: StoredCompletionSnapshot) {
	const completionBlock = snapshot.turn?.blocks?.find((block) => block.toolName === "attempt_completion")
	return {
		phase: snapshot.phase,
		completionId: snapshot.completion?.completionId,
		interactionId: snapshot.interaction?.interactionId,
		interactionKind: snapshot.interaction?.kind,
		interactionStatus: snapshot.interaction?.status,
		anchorInteractionId: snapshot.anchor?.interactionId,
		completionBlockId: completionBlock?.dlineTid,
	}
}

e2e(
	"Task-local profile switch - DeepSeek 160K to GPT-5.6 does not inject compaction below 372K",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		await configureTaskProfileSwitch(dlineDir)

		server.enqueueResponses("deepseek-chat", {
			type: "tool",
			id: "call_profile_switch_deepseek_ready",
			name: "attempt_completion",
			arguments: { result: "E2E_PROFILE_SWITCH_DEEPSEEK_READY" },
			usage: { inputTokens: 160_000, outputTokens: 100 },
			expectedRequestIncludes: ["E2E_PROFILE_SWITCH_DEEPSEEK_TASK"],
		})
		server.enqueueResponses("openai-compatible-responses", {
			type: "tool",
			id: "call_profile_switch_gpt_continue",
			name: "attempt_completion",
			arguments: { result: "E2E_PROFILE_SWITCH_GPT_CONTINUE_OK" },
			expectedRequestIncludes: ["E2E_PROFILE_SWITCH_GPT_CONTINUE"],
			expectedRequestExcludes: [COMPACT_INSTRUCTION_MARKER],
		})

		const app = await openVSCode(workspaceDir)
		try {
			const { sidebar } = await openSidebar(app, helper)
			await sendTask(sidebar, "E2E_PROFILE_SWITCH_DEEPSEEK_TASK", 60_000)
			await expect(sidebar.getByText("E2E_PROFILE_SWITCH_DEEPSEEK_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			// Reproduce the real task-local profile race: the selection RPC is
			// intentionally still in flight when the next user turn is submitted.
			await clickProfileOption(sidebar, E2E_PROFILE_NAMES.mockOpenAiResponses)

			const input = sidebar.getByTestId("chat-input")
			await expect(input).toBeEnabled()
			await input.fill("E2E_PROFILE_SWITCH_GPT_CONTINUE")
			await sidebar.getByTestId("send-button").click()
			await expect(sidebar.getByText("E2E_PROFILE_SWITCH_GPT_CONTINUE_OK", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})

			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(1)
			const targetRequest = server.getMockConsumptions("openai-compatible-responses")[0]
			expect(targetRequest).toMatchObject({ provider: "openai", protocol: "openai-responses" })
			expect(targetRequest.requestBody).toMatchObject({ model: "gpt-5.6-sol" })
			expect(JSON.stringify(targetRequest.requestBody)).not.toContain(COMPACT_INSTRUCTION_MARKER)
			expect(targetRequest.contractError).toBeUndefined()
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Task-local profile switch - smaller target warns and rebinds without immediate compaction",
	async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }, testInfo) => {
		e2e.setTimeout(240_000)
		await configureProfileCompactionSwitch(dlineDir)
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_profile_compaction_history_ready",
				name: "qna_respond",
				arguments: { response: "E2E_PROFILE_COMPACTION_HISTORY_READY" },
				expectedRequestIncludes: ["E2E_PROFILE_COMPACTION_TASK"],
			},
			{
				type: "tool",
				id: "call_profile_compaction_source_ready",
				name: "attempt_completion",
				arguments: { result: "E2E_PROFILE_COMPACTION_SOURCE_READY" },
				usage: { inputTokens: 140_000, outputTokens: 100 },
				expectedRequestIncludes: ["E2E_PROFILE_COMPACTION_LATEST"],
			},
		)

		const app = await openVSCode(workspaceDir)
		try {
			const { sidebar } = await openSidebar(app, helper)
			await sendTask(sidebar, "E2E_PROFILE_COMPACTION_TASK", 60_000)
			await expect(sidebar.getByText("E2E_PROFILE_COMPACTION_HISTORY_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await sendTask(sidebar, "E2E_PROFILE_COMPACTION_LATEST", 60_000)
			await expect(sidebar.getByText("E2E_PROFILE_COMPACTION_SOURCE_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await expandTaskHeader(sidebar)

			await clickProfileOption(sidebar, E2E_PROFILE_NAMES.mockOpenAi)
			const modelSwitcher = sidebar.getByRole("button", { name: "Select model" })
			await expect(modelSwitcher).toContainText(E2E_PROFILE_NAMES.mockOpenAiResponses)
			const dialog = sidebar.getByRole("dialog")
			await expect(dialog.getByRole("heading", { name: "Switch to a smaller context window?" })).toBeVisible()
			await expect(dialog).toContainText("nothing is compacted now")
			await expect(dialog).toContainText("ordinary compaction still runs later")
			await expect(dialog.getByText("Context in use", { exact: true })).toBeVisible()
			await expect(dialog.getByText("140,100 tokens", { exact: true })).toBeVisible()
			await expect(dialog).toContainText("Must fit below")
			await expect(dialog.getByRole("button", { name: "Compact & Switch" })).toHaveCount(0)
			await dialog.getByRole("button", { name: "Switch", exact: true }).click()

			const progress = sidebar.getByTestId("context-window-segmented-progress")
			await expect(modelSwitcher).toHaveText(E2E_PROFILE_NAMES.mockOpenAi, { timeout: 60_000 })
			await expect(sidebar.getByRole("dialog")).toHaveCount(0)
			await expect(progress).toHaveAttribute("data-phase", "stable", { timeout: 60_000 })
			const visual = await readContextWindowVisual(sidebar)
			expectFourContextSegments(visual)
			expect(visual).toMatchObject({
				contextWindow: 131_072,
				mode: "act",
				phase: "stable",
				profileName: E2E_PROFILE_NAMES.mockOpenAi,
			})
			expect(visual.segments[2]?.authoritativeTokens).toBeGreaterThan(0)
			expect(visual.segments.reduce((total, segment) => total + segment.authoritativeTokens, 0)).toBeGreaterThanOrEqual(
				140_100,
			)
			await captureContextWindowEvidence(sidebar, testInfo, "context-rebound")

			const [taskId] = await taskDirectoryIds(dlineDocsDir)
			if (!taskId) throw new Error("Profile switch E2E task directory was not created")
			const apiHistoryPath = path.join(dlineDocsDir, "tasks", taskId, "api_conversation_history.jsonl")
			const committedApiHistory = await readFile(apiHistoryPath, "utf8")
			expect(committedApiHistory).toContain("E2E_PROFILE_COMPACTION_TASK")
			expect(committedApiHistory).toContain("E2E_PROFILE_COMPACTION_HISTORY_READY")
			expect(committedApiHistory).toContain("E2E_PROFILE_COMPACTION_LATEST")
			expect(committedApiHistory).toContain("E2E_PROFILE_COMPACTION_SOURCE_READY")
			expect(committedApiHistory).not.toContain("E2E_PROFILE_TARGET_SUMMARY")

			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(2)
			expect(server.getRequestCount("openai-compatible-chat")).toBe(0)
			await expect(sidebar.getByTestId("compaction-pass")).toHaveCount(0)
			await expect(sidebar.getByText("Restore Task Only", { exact: true })).toHaveCount(0)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Mode switch context - welcome draft stays local until configured Enter submits it",
	async ({ dlineDocsDir, helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(120_000)
		await helper.signin(sidebar)
		server.enqueueResponses("openai-compatible-chat", {
			type: "tool",
			id: "call_welcome_mode_enter",
			name: "make_plan",
			arguments: { response: "E2E_WELCOME_MODE_ENTER_SENT", needs_more_exploration: false },
			expectedRequestIncludes: ["E2E_WELCOME_MODE_DRAFT", "PLAN MODE"],
		})

		const input = sidebar.getByTestId("chat-input")
		await expect(sidebar.getByRole("switch", { name: "Act" })).toHaveAttribute("aria-checked", "true")
		await input.fill("E2E_WELCOME_MODE_DRAFT")
		await sidebar.getByTestId("mode-switch").click()

		await expectPlanMode(sidebar)
		await expect(input).toHaveValue("E2E_WELCOME_MODE_DRAFT")
		expect(await taskDirectoryIds(dlineDocsDir)).toEqual([])
		expect(server.getRequestCount("openai-compatible-chat")).toBe(0)
		expect(server.getRequestCount("openai-compatible-responses")).toBe(0)

		await input.press("Enter")
		await expect(input).toHaveValue("")
		await expect(sidebar.getByText("E2E_WELCOME_MODE_DRAFT", { exact: true }).last()).toBeVisible()
		await expect(sidebar.getByText("E2E_WELCOME_MODE_ENTER_SENT", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(1)
		expect(server.getRequestCount("openai-compatible-responses")).toBe(0)
		expect(await taskDirectoryIds(dlineDocsDir)).toHaveLength(1)
		expect(server.getMockConsumptions("openai-compatible-chat")[0].contractError).toBeUndefined()
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Mode switch context - returning to Welcome cannot submit a draft until Send is clicked",
	async ({ dlineDocsDir, helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(150_000)
		await helper.signin(sidebar)
		server.enqueueResponses(
			"openai-compatible-chat",
			{
				type: "tool",
				id: "call_welcome_after_close_ready",
				name: "attempt_completion",
				arguments: { result: "E2E_WELCOME_AFTER_CLOSE_READY" },
			},
			{
				type: "tool",
				id: "call_welcome_after_close_explicit_send",
				name: "make_plan",
				arguments: { response: "E2E_WELCOME_AFTER_CLOSE_SENT", needs_more_exploration: false },
				expectedRequestIncludes: ["E2E_WELCOME_AFTER_CLOSE_DRAFT", "PLAN MODE"],
			},
		)

		await sendTask(sidebar, "E2E_WELCOME_AFTER_CLOSE_TASK")
		await expect(sidebar.getByText("E2E_WELCOME_AFTER_CLOSE_READY", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(1)
		expect(await taskDirectoryIds(dlineDocsDir)).toHaveLength(1)

		await sidebar.getByRole("button", { name: "Close Task", exact: true }).click()
		const input = sidebar.getByTestId("chat-input")
		await expect(input).toHaveAttribute("placeholder", "Type your task here...")
		await E2ETestHelper.dismissWhatsNewModal(sidebar)
		await input.fill("E2E_WELCOME_AFTER_CLOSE_DRAFT")
		await sidebar.getByTestId("mode-switch").click()

		await expectPlanMode(sidebar)
		await expect(input).toHaveValue("E2E_WELCOME_AFTER_CLOSE_DRAFT")
		await sidebar.page().waitForTimeout(1_000)
		expect(await taskDirectoryIds(dlineDocsDir)).toHaveLength(1)
		expect(server.getRequestCount("openai-compatible-chat")).toBe(1)

		await sidebar.getByTestId("send-button").click()
		await expect(input).toHaveValue("")
		await expect(sidebar.getByText("E2E_WELCOME_AFTER_CLOSE_SENT", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(2)
		expect(await taskDirectoryIds(dlineDocsDir)).toHaveLength(2)
		expect(server.getMockConsumptions("openai-compatible-chat")[1].contractError).toBeUndefined()
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Mode switch context - over-limit same profile switches directly without compaction",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(150_000)
		await configureModeProfiles(dlineDir, {
			actProfile: E2E_PROFILE_NAMES.mockOpenAi,
			actContextWindow: 131_072,
			planProfile: E2E_PROFILE_NAMES.mockOpenAi,
			planContextWindow: 131_072,
		})
		server.enqueueResponses(
			"openai-compatible-chat",
			{
				type: "tool",
				id: "call_same_profile_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_SAME_PROFILE_READY" },
				usage: { inputTokens: 400_000, outputTokens: 100 },
			},
			{
				type: "tool",
				id: "call_same_profile_plan",
				name: "make_plan",
				arguments: { response: "E2E_SAME_PROFILE_PLAN_OK", needs_more_exploration: false },
				expectedRequestIncludes: ["E2E_SAME_PROFILE_PLAN_DRAFT", "PLAN MODE"],
				expectedRequestExcludes: [COMPACT_SIGNAL],
			},
		)

		const app = await openVSCode(workspaceDir)
		try {
			const { sidebar } = await openSidebar(app, helper)
			await sendTask(sidebar, "E2E_SAME_PROFILE_TASK")
			await expect(sidebar.getByText("E2E_SAME_PROFILE_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})

			const input = sidebar.getByTestId("chat-input")
			await input.fill("E2E_SAME_PROFILE_PLAN_DRAFT")
			await startInputValueObserver(sidebar)
			await sidebar.getByTestId("mode-switch").evaluate((element) => element.click())
			await expectPlanMode(sidebar)
			await expect(sidebar.getByRole("heading", { name: "Compact context before switching?" })).toHaveCount(0)
			await expect(sidebar.getByText("E2E_SAME_PROFILE_PLAN_OK", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			const observedValues = await stopInputValueObserver(sidebar)
			expect(observedValues).not.toContain(COMPACT_SIGNAL)
			await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(2)
			const planRequest = server.getMockConsumptions("openai-compatible-chat")[1]
			expect(requestToolNames(planRequest)).toContain("make_plan")
			expect(requestToolNames(planRequest)).not.toContain("act_mode_respond")
			expect(planRequest.contractError).toBeUndefined()
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Mode switch interaction - an awaiting plan switches to Act without a request when input is empty",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(120_000)
		await configureModeProfiles(dlineDir, {
			actProfile: E2E_PROFILE_NAMES.mockOpenAi,
			actContextWindow: 131_072,
			planProfile: E2E_PROFILE_NAMES.mockOpenAi,
			planContextWindow: 131_072,
		})
		server.enqueueResponses("openai-compatible-chat", {
			type: "tool",
			id: "call_awaiting_plan",
			name: "make_plan",
			arguments: { response: "E2E_AWAITING_PLAN_READY", needs_more_exploration: false },
			expectedRequestIncludes: ["E2E_AWAITING_PLAN_TASK", "PLAN MODE"],
		})

		const app = await openVSCode(workspaceDir)
		try {
			const { sidebar } = await openSidebar(app, helper)
			await sidebar.getByTestId("mode-switch").click()
			await expectPlanMode(sidebar)
			await sendTask(sidebar, "E2E_AWAITING_PLAN_TASK")
			await expect(sidebar.getByText("E2E_AWAITING_PLAN_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})

			const input = sidebar.getByTestId("chat-input")
			await expect(input).toBeEnabled()
			await expect(input).toHaveValue("")
			await startInputValueObserver(sidebar)
			await sidebar.getByTestId("mode-switch").evaluate((element) => element.click())
			await expect(sidebar.getByRole("switch", { name: "Act" })).toHaveAttribute("aria-checked", "true", {
				timeout: 60_000,
			})

			const observedValues = await stopInputValueObserver(sidebar)
			expect.soft(observedValues).not.toContain(INTERNAL_MODE_RESPONSE)
			expect.soft(await sidebar.locator("body").innerText()).not.toContain(INTERNAL_MODE_RESPONSE)
			await expect(input).toBeEnabled()
			await expect(input).toHaveValue("")
			await expect(sidebar.getByText("E2E_AWAITING_PLAN_READY", { exact: false }).last()).toBeVisible()
			await expect(sidebar.getByText("E2E_AWAITING_PLAN_CONTINUED", { exact: false })).toHaveCount(0)
			expect(server.getRequestCount("openai-compatible-chat")).toBe(1)
			await expectNoInternalCompactionEcho(sidebar)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Mode switch interaction - an awaiting Act question switches to Plan without a request when input is empty",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(120_000)
		await configureModeProfiles(dlineDir, {
			actProfile: E2E_PROFILE_NAMES.mockOpenAi,
			actContextWindow: 131_072,
			planProfile: E2E_PROFILE_NAMES.mockOpenAi,
			planContextWindow: 131_072,
		})
		server.enqueueResponses("openai-compatible-chat", {
			type: "tool",
			id: "call_awaiting_act_question",
			name: "qna_respond",
			arguments: { response: "E2E_AWAITING_ACT_QUESTION" },
			expectedRequestIncludes: ["E2E_AWAITING_ACT_TASK", "ACT MODE"],
		})

		const app = await openVSCode(workspaceDir)
		try {
			const { sidebar } = await openSidebar(app, helper)
			await sendTask(sidebar, "E2E_AWAITING_ACT_TASK")
			await expect(sidebar.getByText("E2E_AWAITING_ACT_QUESTION", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})

			const input = sidebar.getByTestId("chat-input")
			await expect(input).toBeEnabled()
			await expect(input).toHaveValue("")
			await sidebar.getByTestId("mode-switch").evaluate((element) => element.click())
			await expectPlanMode(sidebar)
			await expect(input).toBeEnabled()
			await expect(input).toHaveValue("")
			await expect(sidebar.getByText("E2E_AWAITING_ACT_QUESTION", { exact: false }).last()).toBeVisible()
			await expect(sidebar.getByText("E2E_AWAITING_ACT_PLAN_CONTINUED", { exact: false })).toHaveCount(0)
			expect(server.getRequestCount("openai-compatible-chat")).toBe(1)
			await expectNoInternalCompactionEcho(sidebar)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Mode switch interaction - an awaiting Act question consumes its Plan-switch draft once",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(120_000)
		await configureModeProfiles(dlineDir, {
			actProfile: E2E_PROFILE_NAMES.mockOpenAi,
			actContextWindow: 131_072,
			planProfile: E2E_PROFILE_NAMES.mockOpenAi,
			planContextWindow: 131_072,
		})
		server.enqueueResponses(
			"openai-compatible-chat",
			{
				type: "tool",
				id: "call_reverse_draft_question",
				name: "qna_respond",
				arguments: { response: "E2E_REVERSE_DRAFT_QUESTION" },
			},
			{
				type: "tool",
				id: "call_reverse_draft_plan",
				name: "make_plan",
				arguments: { response: "E2E_REVERSE_DRAFT_PLAN_READY", needs_more_exploration: false },
				expectedRequestIncludes: ["E2E_REVERSE_SWITCH_DRAFT", "PLAN MODE"],
				expectedRequestExcludes: [INTERNAL_MODE_RESPONSE],
			},
		)

		const app = await openVSCode(workspaceDir)
		try {
			const { sidebar } = await openSidebar(app, helper)
			await sendTask(sidebar, "E2E_REVERSE_DRAFT_TASK")
			await expect(sidebar.getByText("E2E_REVERSE_DRAFT_QUESTION", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})

			const input = sidebar.getByTestId("chat-input")
			await input.fill("E2E_REVERSE_SWITCH_DRAFT")
			await sidebar.getByTestId("mode-switch").evaluate((element) => element.click())
			await expectPlanMode(sidebar)
			await expect(input).toHaveValue("")
			await expect.poll(() => server.getRequestCount("openai-compatible-chat"), { timeout: 20_000 }).toBe(2)
			await expect(sidebar.getByText("E2E_REVERSE_DRAFT_PLAN_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})

			await expect(sidebar.getByText("E2E_REVERSE_SWITCH_DRAFT", { exact: true })).toHaveCount(1)
			const continuationRequest = server.getMockConsumptions("openai-compatible-chat")[1]
			const continuationText = JSON.stringify(continuationRequest.requestBody)
			expect(continuationText.match(/E2E_REVERSE_SWITCH_DRAFT/g)).toHaveLength(1)
			expect(continuationRequest.contractError).toBeUndefined()
			await expectNoInternalCompactionEcho(sidebar)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Mode switch context - a smaller target switches directly when current usage fits",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(150_000)
		await configureModeProfiles(dlineDir, {
			actProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
			actContextWindow: 272_000,
			planProfile: E2E_PROFILE_NAMES.mockOpenAi,
			planContextWindow: 131_072,
		})
		server.enqueueResponses("openai-compatible-responses", {
			type: "tool",
			id: "call_smaller_fits_completion",
			name: "attempt_completion",
			arguments: { result: "E2E_SMALLER_FITS_READY" },
			usage: { inputTokens: 50_000, outputTokens: 100 },
		})
		server.enqueueResponses("openai-compatible-chat", {
			type: "tool",
			id: "call_smaller_fits_plan",
			name: "make_plan",
			arguments: { response: "E2E_SMALLER_FITS_PLAN_OK", needs_more_exploration: false },
			expectedRequestIncludes: ["E2E_SMALLER_FITS_PLAN_DRAFT", "PLAN MODE"],
			expectedRequestExcludes: [COMPACT_SIGNAL, COMPACT_INSTRUCTION_MARKER],
		})

		const app = await openVSCode(workspaceDir)
		try {
			const { sidebar } = await openSidebar(app, helper)
			await sendTask(sidebar, "E2E_SMALLER_FITS_TASK")
			await expect(sidebar.getByText("E2E_SMALLER_FITS_READY", { exact: false }).last()).toBeVisible({ timeout: 60_000 })

			await sidebar.getByTestId("chat-input").fill("E2E_SMALLER_FITS_PLAN_DRAFT")
			await sidebar.getByTestId("mode-switch").evaluate((element) => element.click())
			await expectPlanMode(sidebar)
			await expect(sidebar.getByRole("heading", { name: "Switch to a smaller context window?" })).toHaveCount(0)
			await expect(sidebar.getByText("E2E_SMALLER_FITS_PLAN_OK", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})

			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(1)
			await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(1)
			const targetRequest = server.getMockConsumptions("openai-compatible-chat")[0]
			expect(requestToolNames(targetRequest)).not.toEqual(["summarize_task"])
			expect(targetRequest.contractError).toBeUndefined()
			await expectNoInternalCompactionEcho(sidebar)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Mode switch context - cancelling required compaction keeps the source mode and draft",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(150_000)
		await configureModeProfiles(dlineDir, {
			actProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
			actContextWindow: 272_000,
			planProfile: E2E_PROFILE_NAMES.mockOpenAi,
			planContextWindow: 131_072,
		})
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_cancel_compaction_history",
				name: "qna_respond",
				arguments: { response: "E2E_CANCEL_COMPACTION_HISTORY_READY" },
				expectedRequestIncludes: ["E2E_CANCEL_COMPACTION_TASK"],
			},
			{
				type: "tool",
				id: "call_cancel_compaction_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_CANCEL_COMPACTION_READY" },
				usage: { inputTokens: 140_000, outputTokens: 100 },
				expectedRequestIncludes: ["E2E_CANCEL_COMPACTION_LATEST"],
			},
		)

		const app = await openVSCode(workspaceDir)
		try {
			const { sidebar } = await openSidebar(app, helper)
			await sendTask(sidebar, "E2E_CANCEL_COMPACTION_TASK")
			await expect(sidebar.getByText("E2E_CANCEL_COMPACTION_HISTORY_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await sendTask(sidebar, "E2E_CANCEL_COMPACTION_LATEST")
			await expect(sidebar.getByText("E2E_CANCEL_COMPACTION_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})

			const input = sidebar.getByTestId("chat-input")
			await input.fill("E2E_CANCEL_COMPACTION_DRAFT")
			await sidebar.getByTestId("mode-switch").evaluate((element) => element.click())
			const dialog = sidebar.getByRole("dialog")
			await expect(dialog.getByRole("heading", { name: "Compact context before switching?" })).toBeVisible()
			await dialog.getByRole("button", { name: "Cancel" }).click()

			await expect(dialog).toHaveCount(0)
			await expect(sidebar.getByRole("switch", { name: "Act" })).toHaveAttribute("aria-checked", "true")
			await expect(sidebar.getByRole("switch", { name: "Plan" })).toHaveAttribute("aria-checked", "false")
			await expect(input).toHaveValue("E2E_CANCEL_COMPACTION_DRAFT")
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(2)
			await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(0)
			await expectNoInternalCompactionEcho(sidebar)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Mode switch context - smaller target confirms, compacts, and continues with the target mode",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		await configureModeProfiles(dlineDir, {
			actProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
			actContextWindow: 272_000,
			planProfile: E2E_PROFILE_NAMES.mockOpenAi,
			planContextWindow: 131_072,
		})
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_smaller_target_history",
				name: "qna_respond",
				arguments: { response: "E2E_SMALLER_TARGET_HISTORY_READY" },
				expectedRequestIncludes: ["E2E_SMALLER_TARGET_TASK"],
			},
			{
				type: "tool",
				id: "call_smaller_target_completion",
				name: "qna_respond",
				arguments: { response: "E2E_SMALLER_TARGET_READY" },
				usage: { inputTokens: 140_000, outputTokens: 100 },
				expectedRequestIncludes: ["E2E_SMALLER_TARGET_LATEST"],
			},
		)
		server.enqueueResponses(
			"openai-compatible-chat",
			{
				type: "tool",
				id: "call_mode_switch_summary",
				name: "summarize_task",
				arguments: {
					context: "E2E_MODE_SWITCH_SUMMARY preserves E2E_SMALLER_TARGET_TASK and E2E_SMALLER_TARGET_LATEST.",
				},
				expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER, "E2E_SMALLER_TARGET_TASK"],
				expectedRequestExcludes: [COMPACT_SIGNAL, "E2E_SMALLER_TARGET_LATEST", "E2E_SMALLER_TARGET_PLAN_DRAFT"],
			},
			{
				type: "tool",
				id: "call_smaller_target_plan",
				name: "make_plan",
				arguments: { response: "E2E_SMALLER_TARGET_PLAN_OK", needs_more_exploration: false },
				expectedRequestIncludes: [
					"E2E_MODE_SWITCH_SUMMARY",
					"E2E_SMALLER_TARGET_LATEST",
					"E2E_SMALLER_TARGET_PLAN_DRAFT",
					"PLAN MODE",
				],
				expectedRequestExcludes: [COMPACT_SIGNAL],
			},
		)

		const app = await openVSCode(workspaceDir)
		try {
			const { sidebar } = await openSidebar(app, helper)
			await sendTask(sidebar, "E2E_SMALLER_TARGET_TASK")
			await expect(sidebar.getByText("E2E_SMALLER_TARGET_HISTORY_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await sendTask(sidebar, "E2E_SMALLER_TARGET_LATEST")
			await expect(sidebar.getByText("E2E_SMALLER_TARGET_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})

			const input = sidebar.getByTestId("chat-input")
			await input.fill("E2E_SMALLER_TARGET_PLAN_DRAFT")
			await startInputValueObserver(sidebar)
			await sidebar.getByTestId("mode-switch").evaluate((element) => element.click())
			const dialog = sidebar.getByRole("dialog")
			await expect(dialog.getByRole("heading", { name: "Compact context before switching?" })).toBeVisible()
			await expect(dialog.getByText("Source", { exact: true })).toBeVisible()
			await expect(
				dialog.getByText(`${E2E_PROFILE_NAMES.mockOpenAiResponses} · 272,000 tokens`, { exact: true }),
			).toBeVisible()
			await expect(dialog.getByText("Target", { exact: true })).toBeVisible()
			await expect(dialog.getByText(`${E2E_PROFILE_NAMES.mockOpenAi} · 131,072 tokens`, { exact: true })).toBeVisible()
			await expect(input).toHaveValue("E2E_SMALLER_TARGET_PLAN_DRAFT")
			await dialog.getByRole("button", { name: "Compact & Switch" }).click()

			await expectPlanMode(sidebar)
			await expect(sidebar.getByText("E2E_SMALLER_TARGET_PLAN_OK", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			const observedValues = await stopInputValueObserver(sidebar)
			expect(observedValues).not.toContain(COMPACT_SIGNAL)
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(2)
			await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(2)
			const targetRequests = server.getMockConsumptions("openai-compatible-chat")
			const summaryRequest = targetRequests[0]
			expect(summaryRequest).toMatchObject({ responseType: "tool", toolName: "summarize_task" })
			expect(requestToolNames(summaryRequest)).not.toContain("summarize_task")
			expect(summaryRequest.contractError).toBeUndefined()
			const targetRequest = targetRequests[1]
			expect(requestToolNames(targetRequest)).toContain("make_plan")
			expect(requestToolNames(targetRequest)).not.toContain("act_mode_respond")
			expect(requestToolNames(targetRequest)).not.toEqual(["summarize_task"])
			expect(targetRequest.contractError).toBeUndefined()
			await expectCompactionSummary(
				sidebar,
				"E2E_MODE_SWITCH_SUMMARY preserves E2E_SMALLER_TARGET_TASK and E2E_SMALLER_TARGET_LATEST.",
			)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Mode switch context - an over-limit summary truncates safely and retries before switching",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(210_000)
		await configureModeProfiles(dlineDir, {
			actProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
			actContextWindow: 272_000,
			planProfile: E2E_PROFILE_NAMES.mockOpenAi,
			planContextWindow: 131_072,
		})
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_over_limit_round_one",
				name: "qna_respond",
				arguments: { response: "E2E_OVER_LIMIT_ROUND_ONE" },
			},
			{
				type: "tool",
				id: "call_over_limit_middle_one",
				name: "qna_respond",
				arguments: { response: "E2E_OVER_LIMIT_MIDDLE_ONE_RESPONSE" },
			},
			{
				type: "tool",
				id: "call_over_limit_middle_two",
				name: "qna_respond",
				arguments: { response: "E2E_OVER_LIMIT_MIDDLE_TWO_RESPONSE" },
			},
			{
				type: "tool",
				id: "call_over_limit_late_turn",
				name: "qna_respond",
				arguments: { response: "E2E_OVER_LIMIT_LATE_RESPONSE" },
				usage: { inputTokens: 299_000, outputTokens: 1_000 },
				expectedRequestIncludes: ["E2E_OVER_LIMIT_LATE_TURN"],
			},
		)
		server.enqueueResponses(
			"openai-compatible-chat",
			{
				type: "error",
				status: 400,
				code: "context_length_exceeded",
				message: "Maximum context length is 131072 tokens; this request contains 300000 tokens.",
				requestId: "req_mode_switch_context_limit",
			},
			{
				type: "tool",
				id: "call_over_limit_summary",
				name: "summarize_task",
				arguments: {
					context:
						"E2E_OVER_LIMIT_SUMMARY preserves E2E_OVER_LIMIT_TASK, both middle turns, and E2E_OVER_LIMIT_LATE_TURN.",
				},
				expectedRequestIncludes: [
					COMPACT_INSTRUCTION_MARKER,
					"E2E_OVER_LIMIT_TASK",
					"E2E_OVER_LIMIT_MIDDLE_ONE",
					"E2E_OVER_LIMIT_MIDDLE_TWO",
				],
				expectedRequestExcludes: [COMPACT_SIGNAL, "E2E_OVER_LIMIT_LATE_TURN", "E2E_OVER_LIMIT_PLAN_DRAFT"],
			},
			{
				type: "tool",
				id: "call_over_limit_plan",
				name: "make_plan",
				arguments: { response: "E2E_OVER_LIMIT_PLAN_OK", needs_more_exploration: false },
				expectedRequestIncludes: [
					"E2E_OVER_LIMIT_SUMMARY",
					"E2E_OVER_LIMIT_LATE_TURN",
					"E2E_OVER_LIMIT_PLAN_DRAFT",
					"PLAN MODE",
				],
				expectedRequestExcludes: [COMPACT_SIGNAL],
			},
		)

		const app = await openVSCode(workspaceDir)
		try {
			const { sidebar } = await openSidebar(app, helper)
			await sendTask(sidebar, "E2E_OVER_LIMIT_TASK")
			await expect(sidebar.getByText("E2E_OVER_LIMIT_ROUND_ONE", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await sendTask(sidebar, "E2E_OVER_LIMIT_MIDDLE_ONE")
			await expect(sidebar.getByText("E2E_OVER_LIMIT_MIDDLE_ONE_RESPONSE", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await sendTask(sidebar, "E2E_OVER_LIMIT_MIDDLE_TWO")
			await expect(sidebar.getByText("E2E_OVER_LIMIT_MIDDLE_TWO_RESPONSE", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await sendTask(sidebar, "E2E_OVER_LIMIT_LATE_TURN")
			await expect(sidebar.getByText("E2E_OVER_LIMIT_LATE_RESPONSE", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})

			const input = sidebar.getByTestId("chat-input")
			await input.fill("E2E_OVER_LIMIT_PLAN_DRAFT")
			await startInputValueObserver(sidebar)
			await sidebar.getByTestId("mode-switch").evaluate((element) => element.click())
			const dialog = sidebar.getByRole("dialog")
			await expect(dialog.getByRole("heading", { name: "Compact context before switching?" })).toBeVisible()
			await dialog.getByRole("button", { name: "Compact & Switch" }).click()

			await expect(dialog.getByRole("heading", { name: "Switch not completed" })).toBeVisible({ timeout: 60_000 })
			await expect(dialog).toContainText("Mode switch compaction failed.")
			await expect(dialog).toContainText("remains active. The target settings were not adopted.")
			await expect(input).toHaveValue("E2E_OVER_LIMIT_PLAN_DRAFT")
			await dialog.getByRole("button", { name: "Retry", exact: true }).click()
			await expect(dialog.getByRole("heading", { name: "Compact context before switching?" })).toBeVisible({
				timeout: 60_000,
			})
			await dialog.getByRole("button", { name: "Compact & Switch" }).click()

			await expectPlanMode(sidebar)
			await expect(sidebar.getByText("E2E_OVER_LIMIT_PLAN_OK", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			const observedValues = await stopInputValueObserver(sidebar)
			expect(observedValues).not.toContain(COMPACT_SIGNAL)
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(4)
			await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(3)
			const targetRequests = server.getMockConsumptions("openai-compatible-chat")
			const firstSummary = targetRequests[0]
			const retriedSummary = targetRequests[1]
			for (const request of [firstSummary, retriedSummary]) {
				const requestText = JSON.stringify(request.requestBody)
				expect(requestToolNames(request)).not.toContain("summarize_task")
				expect(requestText).toContain("E2E_OVER_LIMIT_TASK")
				expect(requestText).toContain("E2E_OVER_LIMIT_MIDDLE_ONE")
				expect(requestText).toContain("E2E_OVER_LIMIT_MIDDLE_TWO")
				expect(requestText).not.toContain("E2E_OVER_LIMIT_LATE_TURN")
			}
			expect(requestToolNames(firstSummary)).toEqual(requestToolNames(retriedSummary))
			expect(firstSummary).toMatchObject({ responseType: "error" })
			expect(retriedSummary).toMatchObject({ responseType: "tool", toolName: "summarize_task" })
			expect(retriedSummary.contractError).toBeUndefined()
			expect(sidebar.getByText("E2E_OVER_LIMIT_TASK", { exact: true }).first()).toBeVisible()
			await expectCompactionSummary(
				sidebar,
				"E2E_OVER_LIMIT_SUMMARY preserves E2E_OVER_LIMIT_TASK, both middle turns, and E2E_OVER_LIMIT_LATE_TURN.",
			)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [/context length/i])
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Automatic compaction - enabled renders the API summary without internal instruction echo",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		await configureAutoCompact(dlineDir, true)
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_auto_compact_history",
				name: "qna_respond",
				arguments: { response: "E2E_AUTO_COMPACT_HISTORY_READY" },
				expectedRequestIncludes: ["E2E_AUTO_COMPACT_TASK"],
			},
			{
				type: "tool",
				id: "call_auto_compact_ready",
				name: "qna_respond",
				arguments: { response: "E2E_AUTO_COMPACT_READY" },
				usage: { inputTokens: 125_000, outputTokens: 100 },
				expectedRequestIncludes: ["E2E_AUTO_COMPACT_LATEST"],
			},
			{
				type: "tool",
				id: "call_auto_compact_summary",
				name: "summarize_task",
				arguments: { context: "E2E_AUTO_COMPACT_SUMMARY preserves the task and latest user request." },
				expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER],
				expectedRequestExcludes: [COMPACT_SIGNAL, "E2E_AUTO_COMPACT_CONTINUE"],
			},
			{
				type: "tool",
				id: "call_auto_compact_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_AUTO_COMPACT_OK" },
				expectedRequestIncludes: ["E2E_AUTO_COMPACT_SUMMARY", "E2E_AUTO_COMPACT_CONTINUE"],
				expectedRequestExcludes: [COMPACT_SIGNAL, COMPACT_INSTRUCTION_MARKER],
			},
		)

		const app = await openVSCode(workspaceDir)
		try {
			const { sidebar } = await openSidebar(app, helper)
			await sendTask(sidebar, "E2E_AUTO_COMPACT_TASK")
			await expect(sidebar.getByText("E2E_AUTO_COMPACT_HISTORY_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await sendTask(sidebar, "E2E_AUTO_COMPACT_LATEST")
			await expect(sidebar.getByText("E2E_AUTO_COMPACT_READY", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await sendTask(sidebar, "E2E_AUTO_COMPACT_CONTINUE")
			await expect(
				sidebar
					.getByText("E2E_AUTO_COMPACT_SUMMARY preserves the task and latest user request.", { exact: false })
					.last(),
			).toBeVisible({ timeout: 60_000 })
			await expect(sidebar.locator('vscode-button[aria-label="Condense Conversation"]')).toHaveCount(0)
			await expect(sidebar.locator('vscode-button[aria-label="Regenerate Summary"]')).toHaveCount(0)

			await expect.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 60_000 }).toBe(4)
			const requests = server.getMockConsumptions("openai-compatible-responses")
			expect(requests[2]).toMatchObject({ responseType: "tool", toolName: "summarize_task" })
			expect(requestToolNames(requests[2])).toEqual(requestToolNames(requests[1]))
			expect(requestToolNames(requests[2])).not.toContain("summarize_task")
			expect(requests[2].contractError).toBeUndefined()
			expect(requests[3].contractError).toBeUndefined()
			await expect(sidebar.getByText("E2E_AUTO_COMPACT_OK", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expectCompactionSummary(sidebar, "E2E_AUTO_COMPACT_SUMMARY preserves the task and latest user request.")
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Manual compaction - explicit /compact takes priority over an enabled automatic trigger",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(210_000)
		await configureAutoCompact(dlineDir, true)
		server.resetOpenAiMock()
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_manual_priority_history",
				name: "qna_respond",
				arguments: { response: "E2E_MANUAL_PRIORITY_HISTORY_READY" },
				expectedRequestIncludes: ["E2E_MANUAL_PRIORITY_TASK"],
			},
			{
				type: "tool",
				id: "call_manual_priority_ready",
				name: "qna_respond",
				arguments: { response: "E2E_MANUAL_PRIORITY_READY" },
				usage: { inputTokens: 70_000, outputTokens: 100 },
				expectedRequestIncludes: ["E2E_MANUAL_PRIORITY_LATEST"],
			},
			{
				type: "tool",
				id: "call_manual_priority_summary",
				name: "summarize_task",
				arguments: { context: "E2E_MANUAL_PRIORITY_SUMMARY preserves the latest manual guidance." },
				expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER, "E2E_MANUAL_PRIORITY_GUIDANCE"],
				expectedRequestExcludes: ["/compact"],
			},
			{
				type: "tool",
				id: "call_manual_priority_done",
				name: "attempt_completion",
				arguments: { result: "E2E_MANUAL_PRIORITY_DONE" },
				expectedRequestIncludes: ["E2E_MANUAL_PRIORITY_SUMMARY"],
				expectedRequestExcludes: [COMPACT_INSTRUCTION_MARKER],
			},
		)

		const app = await openVSCode(workspaceDir)
		try {
			const { sidebar } = await openSidebar(app, helper)
			await sendTask(sidebar, "E2E_MANUAL_PRIORITY_TASK")
			await expect(sidebar.getByText("E2E_MANUAL_PRIORITY_HISTORY_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await sendTask(sidebar, "E2E_MANUAL_PRIORITY_LATEST")
			await expect(sidebar.getByText("E2E_MANUAL_PRIORITY_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})

			await sendTask(sidebar, "/compact E2E_MANUAL_PRIORITY_GUIDANCE")
			await confirmManualCompaction(sidebar, "E2E_MANUAL_PRIORITY_SUMMARY preserves the latest manual guidance.")
			await expect(sidebar.getByText("E2E_MANUAL_PRIORITY_DONE", { exact: false }).last()).toBeVisible({ timeout: 60_000 })

			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(4)
			const requests = server.getMockConsumptions("openai-compatible-responses")
			expect(requests[2]).toMatchObject({ responseType: "tool", toolName: "summarize_task" })
			expect(requestToolNames(requests[2])).toEqual(requestToolNames(requests[1]))
			expect(requestToolNames(requests[2])).not.toContain("summarize_task")
			expect(requests.slice(2).every((request) => request.contractError === undefined)).toBe(true)
			await expectCompactionSummary(sidebar, "E2E_MANUAL_PRIORITY_SUMMARY preserves the latest manual guidance.")
			await expect(sidebar.locator('vscode-button[aria-label="Condense Conversation"]')).toHaveCount(0)
			await expect(sidebar.locator('vscode-button[aria-label="Regenerate Summary"]')).toHaveCount(0)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Manual compaction - applies a returned summary without starting a second automatic compaction",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(210_000)
		await configureAutoCompact(dlineDir, true)
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_manual_accept_history",
				name: "qna_respond",
				arguments: { response: "E2E_MANUAL_ACCEPT_HISTORY_READY" },
				expectedRequestIncludes: ["E2E_MANUAL_ACCEPT_TASK"],
			},
			{
				type: "tool",
				id: "call_manual_accept_ready",
				name: "qna_respond",
				arguments: { response: "E2E_MANUAL_ACCEPT_READY" },
				usage: { inputTokens: 70_000, outputTokens: 100 },
				expectedRequestIncludes: ["E2E_MANUAL_ACCEPT_LATEST"],
			},
			{
				type: "tool",
				id: "call_manual_accept_summary",
				name: "summarize_task",
				arguments: { context: "E2E_MANUAL_ACCEPT_SUMMARY replaces the original high-context history." },
				usage: { inputTokens: 75_000, outputTokens: 100 },
				expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER, "E2E_MANUAL_ACCEPT_GUIDANCE"],
				expectedRequestExcludes: ["/compact"],
			},
			{
				type: "tool",
				id: "call_manual_accept_done",
				name: "attempt_completion",
				arguments: { result: "E2E_MANUAL_ACCEPT_DONE" },
				expectedRequestIncludes: ["E2E_MANUAL_ACCEPT_SUMMARY"],
				expectedRequestExcludes: [COMPACT_INSTRUCTION_MARKER],
			},
		)

		const app = await openVSCode(workspaceDir)
		try {
			const { sidebar } = await openSidebar(app, helper)
			await sendTask(sidebar, "E2E_MANUAL_ACCEPT_TASK")
			await expect(sidebar.getByText("E2E_MANUAL_ACCEPT_HISTORY_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await sendTask(sidebar, "E2E_MANUAL_ACCEPT_LATEST")
			await expect(sidebar.getByText("E2E_MANUAL_ACCEPT_READY", { exact: false }).last()).toBeVisible({ timeout: 60_000 })

			await sendTask(sidebar, "/compact E2E_MANUAL_ACCEPT_GUIDANCE")
			await confirmManualCompaction(sidebar, "E2E_MANUAL_ACCEPT_SUMMARY replaces the original high-context history.")
			await expect(sidebar.getByText("E2E_MANUAL_ACCEPT_DONE", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(4)
			const requests = server.getMockConsumptions("openai-compatible-responses")

			expect(requests.slice(2).every((request) => request.contractError === undefined)).toBe(true)
			expect(requestToolNames(requests[3])).toEqual(requestToolNames(requests[2]))
			expect(requestToolNames(requests[3])).not.toContain("summarize_task")
			await expectCompactionSummary(sidebar, "E2E_MANUAL_ACCEPT_SUMMARY replaces the original high-context history.")
			await expect(sidebar.locator('vscode-button[aria-label="Condense Conversation"]')).toHaveCount(0)
			await expect(sidebar.locator('vscode-button[aria-label="Regenerate Summary"]')).toHaveCount(0)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Manual compaction - incomplete summary shows failure without exposing a partial preview",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(150_000)
		await configureAutoCompact(dlineDir, false)
		const partialSummary = "E2E_MANUAL_INCOMPLETE_PARTIAL_MUST_NOT_RENDER"
		const serializedArguments = JSON.stringify({ context: partialSummary })
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_manual_incomplete_history",
				name: "qna_respond",
				arguments: { response: "E2E_MANUAL_INCOMPLETE_HISTORY_READY" },
				expectedRequestIncludes: ["E2E_MANUAL_INCOMPLETE_TASK"],
			},
			{
				type: "tool",
				id: "call_manual_incomplete_ready",
				name: "qna_respond",
				arguments: { response: "E2E_MANUAL_INCOMPLETE_READY" },
				usage: { inputTokens: 70_000, outputTokens: 100 },
				expectedRequestIncludes: ["E2E_MANUAL_INCOMPLETE_LATEST"],
			},
			{
				type: "truncated-tool",
				id: "call_manual_incomplete_summary",
				name: "summarize_task",
				arguments: { context: partialSummary },
				truncateAfter: serializedArguments.length - 1,
				expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER, "E2E_MANUAL_INCOMPLETE_GUIDANCE"],
				expectedRequestExcludes: ["/compact"],
			},
		)

		const app = await openVSCode(workspaceDir)
		try {
			const { sidebar } = await openSidebar(app, helper)
			await sendTask(sidebar, "E2E_MANUAL_INCOMPLETE_TASK")
			await expect(sidebar.getByText("E2E_MANUAL_INCOMPLETE_HISTORY_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await sendTask(sidebar, "E2E_MANUAL_INCOMPLETE_LATEST")
			await expect(sidebar.getByText("E2E_MANUAL_INCOMPLETE_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await sendTask(sidebar, "/compact E2E_MANUAL_INCOMPLETE_GUIDANCE")

			await expect(sidebar.getByTestId("compaction-failure").last()).toBeVisible({
				timeout: 60_000,
			})
			await expect(sidebar.getByText(partialSummary, { exact: false })).not.toBeVisible()
			await expect(sidebar.locator('vscode-button[aria-label="Condense Conversation"]')).toHaveCount(0)
			await expect(sidebar.locator('vscode-button[aria-label="Regenerate Summary"]')).toHaveCount(0)
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(3)
			const requests = server.getMockConsumptions("openai-compatible-responses")
			expect(requests[2].responseType).toBe("truncated-tool")
			expect(requests[2].contractError).toBeUndefined()
			expect(requests[2].requestToolResults).not.toContainEqual(
				expect.objectContaining({ callId: "call_manual_incomplete_summary" }),
			)

			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [/max_output_tokens/])
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Automatic compaction - disabled sends the next turn directly",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(150_000)
		await configureAutoCompact(dlineDir, false)
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_auto_compact_disabled_ready",
				name: "qna_respond",
				arguments: { response: "E2E_AUTO_COMPACT_DISABLED_READY" },
				usage: { inputTokens: 125_000, outputTokens: 100 },
			},
			{
				type: "tool",
				id: "call_auto_compact_disabled_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_AUTO_COMPACT_DISABLED_OK" },
				expectedRequestIncludes: ["E2E_AUTO_COMPACT_DISABLED_CONTINUE"],
				expectedRequestExcludes: [COMPACT_SIGNAL, COMPACT_INSTRUCTION_MARKER],
			},
		)

		const app = await openVSCode(workspaceDir)
		try {
			const { sidebar } = await openSidebar(app, helper)
			await sendTask(sidebar, "E2E_AUTO_COMPACT_DISABLED_TASK")
			await expect(sidebar.getByText("E2E_AUTO_COMPACT_DISABLED_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await sendTask(sidebar, "E2E_AUTO_COMPACT_DISABLED_CONTINUE")
			await expect(sidebar.getByText("E2E_AUTO_COMPACT_DISABLED_OK", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})

			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(2)
			const secondRequest = server.getMockConsumptions("openai-compatible-responses")[1]
			expect(requestToolNames(secondRequest)).not.toEqual(["summarize_task"])
			expect(secondRequest.contractError).toBeUndefined()
			await expectNoInternalCompactionEcho(sidebar)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Manual compaction - header control dispatches once and reduces context usage",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		await configureAutoCompact(dlineDir, false)
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_manual_compact_history",
				name: "qna_respond",
				arguments: { response: "E2E_MANUAL_COMPACT_HISTORY_READY" },
				expectedRequestIncludes: ["E2E_MANUAL_COMPACT_TASK"],
			},
			{
				type: "tool",
				id: "call_manual_compact_ready",
				name: "qna_respond",
				arguments: { response: "E2E_MANUAL_COMPACT_READY" },
				usage: { inputTokens: 80_000, outputTokens: 100 },
				expectedRequestIncludes: ["E2E_MANUAL_COMPACT_LATEST"],
			},
			{
				type: "tool",
				id: "call_manual_compact_summary",
				name: "summarize_task",
				arguments: { context: "E2E_MANUAL_COMPACT_SUMMARY preserves the task and current intent." },
				delayMs: 1_500,
				expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER, "E2E_MANUAL_COMPACT_TASK"],
				expectedRequestExcludes: [COMPACT_SIGNAL, "/compact"],
			},
			{
				type: "tool",
				id: "call_manual_compact_applied",
				name: "qna_respond",
				arguments: { response: "E2E_MANUAL_COMPACT_APPLIED" },
				expectedRequestIncludes: ["E2E_MANUAL_COMPACT_SUMMARY"],
				expectedRequestExcludes: ["E2E_MANUAL_COMPACT_PRESERVED_DRAFT", COMPACT_SIGNAL, COMPACT_INSTRUCTION_MARKER],
			},
			{
				type: "tool",
				id: "call_manual_compact_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_MANUAL_COMPACT_DONE" },
				usage: { inputTokens: 1_200, outputTokens: 100 },
				expectedRequestIncludes: ["E2E_MANUAL_COMPACT_SUMMARY", "E2E_MANUAL_COMPACT_PRESERVED_DRAFT"],
				expectedRequestExcludes: [COMPACT_SIGNAL, COMPACT_INSTRUCTION_MARKER],
			},
		)

		const app = await openVSCode(workspaceDir)
		try {
			const { sidebar } = await openSidebar(app, helper)
			await sendTask(sidebar, "E2E_MANUAL_COMPACT_TASK")
			await expect(sidebar.getByText("E2E_MANUAL_COMPACT_HISTORY_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await sendTask(sidebar, "E2E_MANUAL_COMPACT_LATEST")
			await expect(sidebar.getByText("E2E_MANUAL_COMPACT_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})

			const input = sidebar.getByTestId("chat-input")
			await input.fill("E2E_MANUAL_COMPACT_PRESERVED_DRAFT")
			const expandTaskHeader = sidebar.getByLabel("Expand task header")
			if (await expandTaskHeader.isVisible()) await expandTaskHeader.click()
			const progress = sidebar.getByRole("progressbar", { name: "Context window usage progress" })
			await expect.poll(async () => Number(await progress.getAttribute("aria-valuenow"))).toBeGreaterThan(60_000)
			const beforeCompact = Number(await progress.getAttribute("aria-valuenow"))

			const compactButton = sidebar.locator("button").filter({
				has: sidebar.locator("svg.lucide-fold-vertical"),
			})
			await expect(compactButton).toBeVisible()
			await compactButton.click()
			await expect(sidebar.getByText("Compact the current task?", { exact: true })).toBeVisible()
			await sidebar.getByTitle("Yes, compact the task").click()
			await expect(compactButton).toBeVisible()
			await expect(compactButton).toHaveAttribute("aria-disabled", "true")
			await confirmManualCompaction(sidebar, "E2E_MANUAL_COMPACT_SUMMARY preserves the task and current intent.")
			await expect(input).toHaveValue("E2E_MANUAL_COMPACT_PRESERVED_DRAFT")
			await expect(sidebar.getByText("E2E_MANUAL_COMPACT_APPLIED", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(4)
			const resumedRequests = server.getMockConsumptions("openai-compatible-responses")
			expect(resumedRequests[2]).toMatchObject({ responseType: "tool", toolName: "summarize_task" })
			expect(requestToolNames(resumedRequests[2])).toEqual(requestToolNames(resumedRequests[1]))
			expect(requestToolNames(resumedRequests[2])).not.toContain("summarize_task")
			expect(resumedRequests[2].contractError).toBeUndefined()
			expect(resumedRequests[3]).toMatchObject({ responseType: "tool", toolName: "qna_respond" })
			expect(resumedRequests[3].contractError).toBeUndefined()
			expect(JSON.stringify(resumedRequests[3].requestBody)).not.toContain("E2E_MANUAL_COMPACT_PRESERVED_DRAFT")
			await expect(compactButton).toHaveAttribute("aria-disabled", "false")
			await sidebar.getByTestId("send-button").click()

			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBeGreaterThanOrEqual(5)
			const requests = server.getMockConsumptions("openai-compatible-responses")
			expect(requests[4]).toBeDefined()
			expect(requests[4].contractError).toBeUndefined()
			await expect(sidebar.getByText("E2E_MANUAL_COMPACT_DONE", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(5)
			await expectCompactionSummary(sidebar, "E2E_MANUAL_COMPACT_SUMMARY preserves the task and current intent.")
			await expect(sidebar.getByText("/compact", { exact: true })).toHaveCount(0)
			await expect.poll(async () => Number(await progress.getAttribute("aria-valuenow"))).toBeLessThan(beforeCompact)
			await expect(input).toHaveValue("")
			await expect(compactButton).toBeVisible()
			await expect(compactButton).toHaveAttribute("aria-disabled", "false")
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Manual compaction - /compact applies once and the next Enter is a normal user turn",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(210_000)
		await configureAutoCompact(dlineDir, false)
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_manual_followup_history",
				name: "qna_respond",
				arguments: { response: "E2E_MANUAL_FOLLOWUP_HISTORY_READY" },
				expectedRequestIncludes: ["E2E_MANUAL_FOLLOWUP_TASK"],
			},
			{
				type: "tool",
				id: "call_manual_followup_ready",
				name: "qna_respond",
				arguments: { response: "E2E_MANUAL_FOLLOWUP_READY" },
				expectedRequestIncludes: ["E2E_MANUAL_FOLLOWUP_LATEST"],
			},
			{
				type: "tool",
				id: "call_manual_followup_summary",
				name: "summarize_task",
				arguments: { context: "E2E_MANUAL_FOLLOWUP_SUMMARY keeps the command decisions and unresolved failures." },
				expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER, "E2E_MANUAL_FOLLOWUP_GUIDANCE"],
				expectedRequestExcludes: ["/compact"],
			},
			{
				type: "tool",
				id: "call_manual_followup_applied",
				name: "qna_respond",
				arguments: { response: "E2E_MANUAL_FOLLOWUP_APPLIED" },
				expectedRequestIncludes: ["E2E_MANUAL_FOLLOWUP_SUMMARY"],
				expectedRequestExcludes: [COMPACT_INSTRUCTION_MARKER],
			},
			{
				type: "tool",
				id: "call_manual_followup_done",
				name: "attempt_completion",
				arguments: { result: "E2E_MANUAL_FOLLOWUP_DONE" },
				expectedRequestIncludes: ["E2E_MANUAL_FOLLOWUP_SUMMARY", "E2E_MANUAL_FOLLOWUP_MESSAGE"],
				expectedRequestExcludes: [COMPACT_INSTRUCTION_MARKER],
			},
		)

		const app = await openVSCode(workspaceDir)
		try {
			const { sidebar } = await openSidebar(app, helper)
			await sendTask(sidebar, "E2E_MANUAL_FOLLOWUP_TASK")
			await expect(sidebar.getByText("E2E_MANUAL_FOLLOWUP_HISTORY_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await sendTask(sidebar, "E2E_MANUAL_FOLLOWUP_LATEST")
			await expect(sidebar.getByText("E2E_MANUAL_FOLLOWUP_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})

			await sendTask(sidebar, "/compact E2E_MANUAL_FOLLOWUP_GUIDANCE")
			await confirmManualCompaction(
				sidebar,
				"E2E_MANUAL_FOLLOWUP_SUMMARY keeps the command decisions and unresolved failures.",
			)
			await expect(sidebar.getByText("E2E_MANUAL_FOLLOWUP_APPLIED", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await expectCompactionSummary(
				sidebar,
				"E2E_MANUAL_FOLLOWUP_SUMMARY keeps the command decisions and unresolved failures.",
			)
			await expect(sidebar.locator('vscode-button[aria-label="Condense Conversation"]')).toHaveCount(0)
			await expect(sidebar.locator('vscode-button[aria-label="Regenerate Summary"]')).toHaveCount(0)

			const input = sidebar.getByTestId("chat-input")
			await input.fill("E2E_MANUAL_FOLLOWUP_MESSAGE")
			await input.press("Enter")
			await expect(input).toHaveValue("")
			await expect(sidebar.getByText("E2E_MANUAL_FOLLOWUP_MESSAGE", { exact: true }).last()).toBeVisible()
			await expect(sidebar.getByText("E2E_MANUAL_FOLLOWUP_DONE", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(5)
			const requests = server.getMockConsumptions("openai-compatible-responses")
			expect(requests.slice(1).every((request) => request.contractError === undefined)).toBe(true)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"DeepSeek context - 630K usage remains at 63 percent of 1M without an early recovery truncation",
	async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		await configureDeepSeekAutoCompact(dlineDir)
		server.enqueueResponses(
			"deepseek-chat",
			{
				type: "tool",
				id: "call_deepseek_context_round_one",
				name: "qna_respond",
				arguments: { response: "E2E_DEEPSEEK_CONTEXT_ROUND_ONE" },
			},
			{
				type: "tool",
				id: "call_deepseek_context_round_two",
				name: "qna_respond",
				arguments: { response: "E2E_DEEPSEEK_CONTEXT_ROUND_TWO" },
				expectedRequestIncludes: ["E2E_DEEPSEEK_CONTEXT_MIDDLE_ONE"],
			},
			{
				type: "tool",
				id: "call_deepseek_context_ready",
				name: "qna_respond",
				arguments: { response: "E2E_DEEPSEEK_CONTEXT_READY" },
				usage: { inputTokens: 630_000, outputTokens: 100 },
				expectedRequestIncludes: ["E2E_DEEPSEEK_CONTEXT_LATE_TURN"],
			},
			{
				type: "tool",
				id: "call_deepseek_context_direct_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_DEEPSEEK_CONTEXT_DIRECT_OK" },
				usage: { inputTokens: 630_000, outputTokens: 100 },
				delayMs: 5_000,
				expectedRequestIncludes: ["E2E_DEEPSEEK_CONTEXT_CONTINUE"],
			},
			{
				type: "tool",
				id: "call_deepseek_context_final_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_DEEPSEEK_CONTEXT_FINAL_OK" },
				usage: { inputTokens: 630_000, outputTokens: 100 },
				delayMs: 5_000,
				expectedRequestIncludes: ["E2E_DEEPSEEK_CONTEXT_POST_COMPLETION_FEEDBACK"],
			},
		)

		const app = await openVSCode(workspaceDir)
		try {
			const { sidebar } = await openSidebar(app, helper)
			await sendTask(sidebar, "E2E_DEEPSEEK_CONTEXT_TASK")
			await expect(sidebar.getByText("E2E_DEEPSEEK_CONTEXT_ROUND_ONE", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await sendTask(sidebar, "E2E_DEEPSEEK_CONTEXT_MIDDLE_ONE")
			await expect(sidebar.getByText("E2E_DEEPSEEK_CONTEXT_ROUND_TWO", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await sendTask(sidebar, "E2E_DEEPSEEK_CONTEXT_LATE_TURN")
			await expect(sidebar.getByText("E2E_DEEPSEEK_CONTEXT_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})

			const expandTaskHeader = sidebar.getByLabel("Expand task header")
			if (await expandTaskHeader.isVisible()) await expandTaskHeader.click()
			await expect(sidebar.locator('[title="Current tokens used in this request"]')).toHaveText("630.1k")
			await expect(sidebar.locator('[title="Maximum context window size for this model"]')).toHaveText("1.0m")
			const progress = sidebar.getByRole("progressbar", { name: "Context window usage progress" })
			await expect(progress).toHaveAttribute("aria-valuenow", "630100")
			await expect(progress).toHaveAttribute("aria-valuemax", "1000000")
			await expect(progress).toHaveAttribute("aria-valuetext", "630100 of 1000000 tokens; phase receiving")
			const receivingVisual = await readContextWindowVisual(sidebar)
			expectFourContextSegments(receivingVisual)
			expect(receivingVisual.phase).toBe("receiving")
			expectContextVisualAllocation(receivingVisual)
			expect(receivingVisual.segments.reduce((total, segment) => total + segment.authoritativeTokens, 0)).toBe(630100)

			const focusableContextSegment = sidebar.getByTestId("context-window-tooltip-trigger")
			await focusableContextSegment.hover()
			const hoverCardContent = sidebar.locator('[data-slot="hover-card-content"]')
			await expect(hoverCardContent).toBeVisible()
			const contextWindowSummary = hoverCardContent.getByText("Context Window", { exact: true })
			await expect(contextWindowSummary).toBeVisible()
			await contextWindowSummary.click()
			const segmentDetails = hoverCardContent.getByTestId("context-window-segment-details")
			await expect(segmentDetails).toBeVisible()
			for (const kind of ["durable", "active", "staged", "environment"] as const) {
				await expect(segmentDetails.locator(`[data-segment-detail="${kind}"]`)).toBeVisible()
			}
			await captureLocatorEvidence(hoverCardContent, e2e.info(), "deepseek-context-630k")

			const [taskId] = await E2ETestHelper.waitForValue(async () => {
				const ids = await taskDirectoryIds(dlineDocsDir)
				return ids.length === 1 ? ids : undefined
			})
			if (!taskId) throw new Error("DeepSeek Context E2E task directory was not created")

			await sendTask(sidebar, "E2E_DEEPSEEK_CONTEXT_CONTINUE")
			await expect(sidebar.getByText("E2E_DEEPSEEK_CONTEXT_DIRECT_OK", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await expect.poll(() => server.getRequestCount("deepseek-chat"), { timeout: 30_000 }).toBe(4)
			await expect
				.poll(async () => completionSnapshotState(await readCompletionSnapshot(dlineDocsDir, taskId)), {
					timeout: 30_000,
				})
				.toMatchObject({
					phase: "completed",
					interactionKind: "completion",
					interactionStatus: "awaiting",
				})
			const firstCompletion = completionSnapshotState(await readCompletionSnapshot(dlineDocsDir, taskId))
			expect(firstCompletion.completionId).toBe(firstCompletion.interactionId)
			expect(firstCompletion.anchorInteractionId).toBe(firstCompletion.interactionId)
			expect(firstCompletion.completionBlockId).toBe(firstCompletion.interactionId)
			await expect(progress).toHaveAttribute("data-phase", "stable")
			await expect(progress).toHaveAttribute("aria-valuenow", "630100")
			await expect(progress).toHaveAttribute("aria-valuetext", "630100 of 1000000 tokens; phase stable")

			await sendTask(sidebar, "E2E_DEEPSEEK_CONTEXT_POST_COMPLETION_FEEDBACK")
			await expect.poll(() => server.getRequestCount("deepseek-chat"), { timeout: 30_000 }).toBe(5)
			await expect
				.poll(async () => completionSnapshotState(await readCompletionSnapshot(dlineDocsDir, taskId)), {
					timeout: 4_000,
				})
				.toMatchObject({
					phase: "streaming",
					completionId: undefined,
					interactionId: undefined,
					interactionKind: undefined,
					interactionStatus: undefined,
				})
			await expect(sidebar.getByText("E2E_DEEPSEEK_CONTEXT_FINAL_OK", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})

			const requests = server.getMockConsumptions("deepseek-chat")
			expect(requests).toHaveLength(5)
			expect(requests[3]).toMatchObject({ responseType: "tool", toolName: "attempt_completion" })
			expect(requests[4]).toMatchObject({ responseType: "tool", toolName: "attempt_completion" })
			await expect(progress).toHaveAttribute("data-phase", "stable")
			await expect(progress).toHaveAttribute("aria-valuenow", "630100")
			await expect(progress).toHaveAttribute("aria-valuetext", "630100 of 1000000 tokens; phase stable")
			await expect
				.poll(async () => completionSnapshotState(await readCompletionSnapshot(dlineDocsDir, taskId)), {
					timeout: 30_000,
				})
				.toMatchObject({
					phase: "completed",
					interactionKind: "completion",
					interactionStatus: "awaiting",
				})
			const finalCompletion = completionSnapshotState(await readCompletionSnapshot(dlineDocsDir, taskId))
			expect(finalCompletion.completionId).toBe(finalCompletion.interactionId)
			expect(finalCompletion.anchorInteractionId).toBe(finalCompletion.interactionId)
			expect(finalCompletion.completionBlockId).toBe(finalCompletion.interactionId)
			const stableVisual = await readContextWindowVisual(sidebar)
			expectFourContextSegments(stableVisual)
			expect(stableVisual.phase).toBe("stable")
			expect(stableVisual.segments.reduce((total, segment) => total + segment.authoritativeTokens, 0)).toBe(630100)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"DeepSeek context - 930K plus bounded completed tool turns compacts under the real 1M window",
	async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(300_000)
		await configureDeepSeekAutoCompact(dlineDir)

		const buildLargeFile = (marker: string, fill: string) =>
			[marker, ...Array.from({ length: 998 }, (_, index) => `${String(index).padStart(4, "0")}:${fill.repeat(355)}`)].join(
				"\n",
			)
		const seedFiles = Array.from({ length: 6 }, (_, index) => ({
			callId: `call_deepseek_pressure_seed_${index}`,
			marker: `E2E_DEEPSEEK_PRESSURE_SEED_${index}`,
			path: `deepseek-pressure-seed-${index}.txt`,
		}))
		const protectedFiles = Array.from({ length: 4 }, (_, index) => ({
			callId: `call_deepseek_pressure_protected_${index}`,
			marker: `E2E_DEEPSEEK_PRESSURE_PROTECTED_${index}`,
			path: `deepseek-pressure-protected-${index}.txt`,
		}))
		await Promise.all([
			...seedFiles.map((file, index) =>
				writeFile(path.join(workspaceDir, file.path), buildLargeFile(file.marker, String(index)), "utf8"),
			),
			...protectedFiles.map((file, index) =>
				writeFile(path.join(workspaceDir, file.path), buildLargeFile(file.marker, String(index + 6)), "utf8"),
			),
		])

		const summary = "E2E_DEEPSEEK_PRESSURE_SUMMARY preserves the task while the protected tool-result turn is replayed."
		server.enqueueResponses(
			"deepseek-chat",
			{
				type: "tools",
				tools: seedFiles.map((file) => ({ id: file.callId, name: "read_file", arguments: { path: file.path } })),
				expectedRequestIncludes: ["E2E_DEEPSEEK_PRESSURE_TASK"],
			},
			{
				type: "tools",
				tools: protectedFiles.map((file) => ({ id: file.callId, name: "read_file", arguments: { path: file.path } })),
				usage: { inputTokens: 930_000, outputTokens: 100 },
				expectedToolResults: seedFiles.map((file) => ({ callId: file.callId, contentIncludes: file.marker })),
			},
			{
				type: "tool",
				id: "call_deepseek_pressure_summary",
				name: "summarize_task",
				arguments: { context: summary },
				delayMs: 5_000,
				expectedRequestIncludes: [
					COMPACT_INSTRUCTION_MARKER,
					...seedFiles.map((file) => file.marker),
					...protectedFiles.map((file) => file.marker),
				],
			},
			{
				type: "tool",
				id: "call_deepseek_pressure_complete",
				name: "attempt_completion",
				arguments: { result: "E2E_DEEPSEEK_PRESSURE_COMPLETE" },
				expectedRequestIncludes: [summary],
				expectedRequestExcludes: [
					COMPACT_INSTRUCTION_MARKER,
					...seedFiles.map((file) => file.marker),
					...protectedFiles.map((file) => file.marker),
				],
			},
		)

		const app = await openVSCode(workspaceDir)
		try {
			const { page, sidebar } = await openSidebar(app, helper)
			await sendTask(sidebar, "E2E_DEEPSEEK_PRESSURE_TASK", 60_000)

			await expect.poll(() => server.getRequestCount("deepseek-chat"), { timeout: 120_000 }).toBeGreaterThanOrEqual(3)
			const requestsAtSummary = server.getMockConsumptions("deepseek-chat")
			const ordinaryRequest = requestsAtSummary[1]
			const summaryRequest = requestsAtSummary[2]
			const ordinaryEstimatedTokens = Math.ceil(Buffer.byteLength(JSON.stringify(ordinaryRequest.requestBody), "utf8") / 4)
			expect(ordinaryEstimatedTokens).toBeLessThan(800_000)
			expect(ordinaryRequest).toMatchObject({ responseType: "tools", usage: { inputTokens: 930_000 } })
			const seedResults = ordinaryRequest.requestToolResults.filter((result) =>
				seedFiles.some((file) => file.callId === result.callId),
			)
			expect(seedResults).toHaveLength(seedFiles.length)
			for (const result of seedResults) {
				expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(MAX_TOOL_RESULT_TEXT_BYTES)
				expect(result.content).toContain("[FILE TRUNCATED:")
			}
			expect(summaryRequest.contractError).toBeUndefined()
			expect(summaryRequest).toMatchObject({ responseType: "tool", toolName: "summarize_task" })
			const summarizedResults = summaryRequest.requestToolResults.filter((result) =>
				[...seedFiles, ...protectedFiles].some((file) => file.callId === result.callId),
			)
			expect(summarizedResults).toHaveLength(seedFiles.length + protectedFiles.length)
			for (const result of summarizedResults) {
				expect(Buffer.byteLength(result.content, "utf8")).toBeLessThanOrEqual(MAX_TOOL_RESULT_TEXT_BYTES)
				expect(result.content).toContain("[FILE TRUNCATED:")
			}

			const expandTaskHeader = sidebar.getByLabel("Expand task header")
			if (await expandTaskHeader.isVisible()) await expandTaskHeader.click()
			await expect(sidebar.locator('[title="Maximum context window size for this model"]')).toHaveText("1.0m")
			const contextProgress = sidebar.getByRole("progressbar", { name: "Context window usage progress" })
			let projectedTokens = 0
			await expect
				.poll(async () => {
					projectedTokens = Number(await contextProgress.getAttribute("aria-valuenow"))
					return projectedTokens > 930_100 && projectedTokens < 1_000_000
				})
				.toBe(true)

			await expect(sidebar.getByText("E2E_DEEPSEEK_PRESSURE_COMPLETE", { exact: false }).last()).toBeVisible({
				timeout: 120_000,
			})
			await expect.poll(() => server.getRequestCount("deepseek-chat"), { timeout: 60_000 }).toBe(4)
			const requests = server.getMockConsumptions("deepseek-chat")
			const finalRequest = requests[3]
			const finalEstimatedTokens = Math.ceil(Buffer.byteLength(JSON.stringify(finalRequest.requestBody), "utf8") / 4)
			expect(finalRequest).toMatchObject({ responseType: "tool", toolName: "attempt_completion" })
			expect(finalRequest.contractError).toBeUndefined()
			expect(finalEstimatedTokens).toBeLessThan(800_000)
			const summarizedResultIds = new Set([...seedFiles, ...protectedFiles].map((file) => file.callId))
			expect(finalRequest.requestToolResults.filter((result) => summarizedResultIds.has(result.callId))).toHaveLength(0)
			expect(requests.every((request) => request.status === undefined && request.contractError === undefined)).toBe(true)
			await expectCompactionSummary(sidebar, summary)
			await expect
				.poll(async () => Number(await contextProgress.getAttribute("aria-valuenow")))
				.toBeLessThan(projectedTokens)

			await captureContextWindowEvidence(sidebar, e2e.info(), "deepseek-context-1m-large-tool-result")

			const [taskId] = await taskDirectoryIds(dlineDocsDir)
			if (!taskId) throw new Error("DeepSeek pressure E2E task directory was not created")
			const taskDirectory = path.join(dlineDocsDir, "tasks", taskId)
			const apiHistory = await readFile(path.join(taskDirectory, "api_conversation_history.jsonl"), "utf8")
			const uiMessages = await readFile(path.join(taskDirectory, "ui_messages.jsonl"), "utf8")
			expect(apiHistory).not.toContain(summary)
			for (const file of [...seedFiles, ...protectedFiles]) expect(apiHistory).toContain(file.marker)
			expect(uiMessages).toContain(summary)
			const persistedCompactionTools = uiMessages
				.split(/\r?\n/)
				.filter(Boolean)
				.flatMap((line): Array<{ tool?: string; compactionStatus?: string }> => {
					const message = JSON.parse(line) as { say?: string; text?: string }
					if (message.say !== "tool" || !message.text) return []
					try {
						return [JSON.parse(message.text) as { tool?: string; compactionStatus?: string }]
					} catch {
						return []
					}
				})
			expect(persistedCompactionTools).toContainEqual(
				expect.objectContaining({ tool: "summarizeTask", compactionStatus: "completed" }),
			)
			expect(uiMessages).not.toMatch(/"conversationHistoryDeletedRange":\s*\[/)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"DeepSeek context - usage near 1M auto condenses with enough output budget for the summary",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		await configureDeepSeekAutoCompact(dlineDir)
		server.enqueueResponses(
			"deepseek-chat",
			{
				type: "tool",
				id: "call_deepseek_near_limit_ready",
				name: "qna_respond",
				arguments: { response: "E2E_DEEPSEEK_NEAR_LIMIT_READY" },
				usage: { inputTokens: 980_000, outputTokens: 100 },
			},
			{
				type: "tool",
				id: "call_deepseek_near_limit_summary",
				name: "summarize_task",
				arguments: { context: "E2E_DEEPSEEK_NEAR_LIMIT_SUMMARY preserves the task and latest request." },
				expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER],
				expectedRequestExcludes: [COMPACT_SIGNAL, "E2E_DEEPSEEK_NEAR_LIMIT_CONTINUE"],
			},
			{
				type: "tool",
				id: "call_deepseek_near_limit_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_DEEPSEEK_NEAR_LIMIT_OK" },
				expectedRequestIncludes: ["E2E_DEEPSEEK_NEAR_LIMIT_SUMMARY", "E2E_DEEPSEEK_NEAR_LIMIT_CONTINUE"],
				expectedRequestExcludes: [COMPACT_SIGNAL, COMPACT_INSTRUCTION_MARKER],
			},
		)

		const app = await openVSCode(workspaceDir)
		try {
			const { sidebar } = await openSidebar(app, helper)
			await sendTask(sidebar, "E2E_DEEPSEEK_NEAR_LIMIT_TASK")
			await expect(sidebar.getByText("E2E_DEEPSEEK_NEAR_LIMIT_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})

			const expandTaskHeader = sidebar.getByLabel("Expand task header")
			if (await expandTaskHeader.isVisible()) await expandTaskHeader.click()
			await expect(sidebar.locator('[title="Current tokens used in this request"]')).toHaveText("980.1k")
			await expect(sidebar.locator('[title="Maximum context window size for this model"]')).toHaveText("1.0m")
			await expect(sidebar.getByRole("progressbar", { name: "Context window usage progress" })).toHaveAttribute(
				"aria-valuenow",
				"980100",
			)

			await sendTask(sidebar, "E2E_DEEPSEEK_NEAR_LIMIT_CONTINUE")
			await expect.poll(() => server.getRequestCount("deepseek-chat"), { timeout: 60_000 }).toBeGreaterThanOrEqual(2)
			const requests = server.getMockConsumptions("deepseek-chat")
			const summaryRequest = requests[1]
			const summaryBody = summaryRequest.requestBody as { max_completion_tokens?: number }
			// The model output ceiling is independent from the input-context compaction trigger.
			expect(summaryBody.max_completion_tokens).toBe(384_000)
			expect(summaryRequest).toMatchObject({ responseType: "tool", toolName: "summarize_task" })
			expect(requestToolNames(summaryRequest)).toEqual(requestToolNames(requests[0]))
			expect(requestToolNames(summaryRequest)).not.toContain("summarize_task")

			await expect(sidebar.getByText("E2E_DEEPSEEK_NEAR_LIMIT_OK", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await expect.poll(() => server.getRequestCount("deepseek-chat")).toBe(3)
			const finalRequest = server.getMockConsumptions("deepseek-chat")[2]
			expect(finalRequest.contractError).toBeUndefined()
			expect(finalRequest.requestToolResults).not.toContainEqual(
				expect.objectContaining({ callId: "call_deepseek_near_limit_ready" }),
			)
			await expectCompactionSummary(sidebar, "E2E_DEEPSEEK_NEAR_LIMIT_SUMMARY preserves the task and latest request.")
			await expect
				.poll(async () =>
					Number(
						await sidebar
							.getByRole("progressbar", { name: "Context window usage progress" })
							.getAttribute("aria-valuenow"),
					),
				)
				.toBeLessThan(980_100)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"DeepSeek context - context-limit recovery tells the model that history was truncated",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		await configureDeepSeekAutoCompact(dlineDir, false)
		server.enqueueResponses(
			"deepseek-chat",
			{
				type: "tool",
				id: "call_deepseek_truncation_round_one",
				name: "qna_respond",
				arguments: { response: "E2E_DEEPSEEK_TRUNCATION_ROUND_ONE" },
			},
			{
				type: "tool",
				id: "call_deepseek_truncation_round_two",
				name: "qna_respond",
				arguments: { response: "E2E_DEEPSEEK_TRUNCATION_ROUND_TWO" },
				expectedRequestIncludes: ["E2E_DEEPSEEK_TRUNCATION_MIDDLE"],
			},
			{
				type: "tool",
				id: "call_deepseek_truncation_ready",
				name: "qna_respond",
				arguments: { response: "E2E_DEEPSEEK_TRUNCATION_READY" },
				expectedRequestIncludes: ["E2E_DEEPSEEK_TRUNCATION_LATE"],
			},
			{
				type: "error",
				status: 400,
				code: "context_length_exceeded",
				message: "The DeepSeek request exceeded its context window.",
				requestId: "req_deepseek_truncation_notice",
			},
			{
				type: "tool",
				id: "call_deepseek_truncation_recovered",
				name: "attempt_completion",
				arguments: { result: "E2E_DEEPSEEK_TRUNCATION_RECOVERED" },
				expectedRequestIncludes: [
					"E2E_DEEPSEEK_TRUNCATION_TASK",
					"E2E_DEEPSEEK_TRUNCATION_CONTINUE",
					"[NOTE] Some previous conversation history with the user has been removed",
				],
				expectedRequestExcludes: ["E2E_DEEPSEEK_TRUNCATION_MIDDLE"],
			},
		)

		const app = await openVSCode(workspaceDir)
		try {
			const { sidebar } = await openSidebar(app, helper)
			await sendTask(sidebar, "E2E_DEEPSEEK_TRUNCATION_TASK")
			await expect(sidebar.getByText("E2E_DEEPSEEK_TRUNCATION_ROUND_ONE", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await sendTask(sidebar, "E2E_DEEPSEEK_TRUNCATION_MIDDLE")
			await expect(sidebar.getByText("E2E_DEEPSEEK_TRUNCATION_ROUND_TWO", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await sendTask(sidebar, "E2E_DEEPSEEK_TRUNCATION_LATE")
			await expect(sidebar.getByText("E2E_DEEPSEEK_TRUNCATION_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await sendTask(sidebar, "E2E_DEEPSEEK_TRUNCATION_CONTINUE")

			await expect.poll(() => server.getRequestCount("deepseek-chat"), { timeout: 60_000 }).toBeGreaterThanOrEqual(5)
			const recoveryRequest = server.getMockConsumptions("deepseek-chat")[4]
			expect(JSON.stringify(recoveryRequest.requestBody)).toContain(
				"[NOTE] Some previous conversation history with the user has been removed",
			)
			expect(recoveryRequest).toMatchObject({ responseType: "tool", toolName: "attempt_completion" })
			await expect(sidebar.getByText("E2E_DEEPSEEK_TRUNCATION_RECOVERED", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [/context window/i])
		} finally {
			await app.close()
		}
	},
)
