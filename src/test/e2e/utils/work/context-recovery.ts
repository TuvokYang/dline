import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper } from "@e2e/utils/helpers"
import { seedLegacyTaskHistory } from "@e2e/utils/task-history-store"
import { expect, type Frame, type Page } from "@playwright/test"
import type { ClineApiReqInfo } from "@shared/ExtensionMessage"
import type { HistoryItem } from "@shared/HistoryItem"
import type { ElectronApplication } from "playwright"

interface StoredOpenAiProfile {
	apiFormat?: string
	capabilities?: Record<string, unknown>
	customModelEnabled?: boolean
	[key: string]: unknown
}

interface StoredProfile {
	id: string
	name: string
	provider?: string
	baseUrl?: string
	modelId?: string
	webToolsMode?: string
	openai?: StoredOpenAiProfile
	[key: string]: unknown
}

interface VisibleRowSnapshot {
	ts: number
	top: number
	bottom: number
	text: string
}

export interface WorkScrollerSnapshot {
	scrollTop: number
	scrollHeight: number
	clientHeight: number
	bottomGap: number
	visibleRows: VisibleRowSnapshot[]
}

export interface WorkPromptDiagnostic {
	taskId: string
	apiIndex: number
	providerAttempt: number
	requestKind: "ordinary" | "automatic_compaction" | "manual_compaction"
	restoredFromHistory: boolean
	provider: string
	modelId: string
	apiFormat: string | null
	runtimeHash: string
	promptIdentityHash: string
	systemPromptHash: string
	toolsHash: string
	serverToolsHash: string
	ordinaryBaselineAvailable: boolean
}

export interface WorkPromptCacheHealth {
	status: string
	sampleCount: number
	hitRate: number
	cacheReadTokens: number
	promptTokens: number
	nearContextWindow: boolean
}

export interface ContextRecoveryProfileSelection {
	sourceProfileName: string
	targetProfileName: string
}

export interface LockedLongHistorySeed {
	taskId: string
	taskText: string
	messageCount: number
}

const profilesPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "api_profiles.json")
const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")

function cloneJson<T>(value: T): T {
	return JSON.parse(JSON.stringify(value)) as T
}

export async function configureContextRecoveryProfiles(dlineDir: string): Promise<ContextRecoveryProfileSelection> {
	const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
	const sourceIndex = profiles.findIndex((profile) => profile.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
	const targetIndex = profiles.findIndex((profile) => profile.name === E2E_PROFILE_NAMES.mockOpenAiOfficialResponses)
	const sourceProfile = profiles[sourceIndex]
	const targetProfile = profiles[targetIndex]
	if (sourceIndex < 0 || targetIndex < 0 || !sourceProfile?.openai?.capabilities || !targetProfile?.baseUrl) {
		throw new Error("Missing configurable OpenAI Responses Profiles for context recovery")
	}

	sourceProfile.modelId = "gpt-5.4-mini"
	sourceProfile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
	sourceProfile.openai = {
		...sourceProfile.openai,
		apiFormat: "OPENAI_RESPONSES",
		customModelEnabled: true,
		streamIncludeUsage: true,
		capabilities: {
			...sourceProfile.openai.capabilities,
			contextWindow: 131_072,
			maxTokens: 8_192,
			supportsPromptCache: true,
			supportsTools: true,
		},
	}

	const targetIdentity = {
		id: targetProfile.id,
		name: targetProfile.name,
		baseUrl: targetProfile.baseUrl,
	}
	profiles[targetIndex] = {
		...cloneJson(sourceProfile),
		...targetIdentity,
	}
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
				autoCondenseTriggerPercent: 60,
				autoCondenseMinReserveTokens: 5_000,
				autoCondenseMaxReserveTokens: 30_000,
				autoCondenseMaxContextTokens: 100_000,
			},
			null,
			2,
		)}\n`,
		"utf8",
	)

	return {
		sourceProfileName: sourceProfile.name,
		targetProfileName: targetProfile.name,
	}
}

export function workHistoryBodyMarker(index: number): string {
	return `WORK_CONTEXT_HISTORY_MESSAGE_${String(index).padStart(4, "0")}`
}

function workHistoryBody(index: number): string {
	const detailLines = Array.from({ length: (index % 4) + 1 }, (_, offset) => `detail-${index}-${offset + 1}`).join("\n")
	return `${workHistoryBodyMarker(index)}\n${detailLines}`
}

export async function seedLockedLongHistoryTask(
	dlineDocsDir: string,
	workspaceDir: string,
	seed: LockedLongHistorySeed,
): Promise<void> {
	const taskDir = path.join(dlineDocsDir, "tasks", seed.taskId)
	await mkdir(taskDir, { recursive: true })
	const baseTimestamp = Date.now() - 180_000
	const historyItem: HistoryItem = {
		id: seed.taskId,
		ts: baseTimestamp,
		task: seed.taskText,
		tokensIn: 0,
		tokensOut: 0,
		totalCost: 0,
		cwdOnTaskInitialization: workspaceDir,
	}
	const messages = [
		{ ts: baseTimestamp, type: "say", say: "task", text: seed.taskText },
		...Array.from({ length: seed.messageCount }, (_, offset) => {
			const index = offset + 1
			return {
				ts: baseTimestamp + index,
				type: "say",
				say: "text",
				text: workHistoryBody(index),
			}
		}),
	]

	await Promise.all([
		seedLegacyTaskHistory(dlineDocsDir, [historyItem]),
		writeFile(
			path.join(taskDir, "ui_messages.jsonl"),
			`${messages.map((message) => JSON.stringify(message)).join("\n")}\n`,
			"utf8",
		),
		writeFile(path.join(taskDir, "api_conversation_history.jsonl"), "", "utf8"),
		writeFile(
			path.join(taskDir, ".lock"),
			JSON.stringify({ held_by: "work-context-recovery-seed", locked_at: Date.now(), pid: 4242 }),
			"utf8",
		),
	])
}

export async function openContextRecoverySidebar(
	app: ElectronApplication,
	helper: E2ETestHelper,
): Promise<{ page: Page; sidebar: Frame }> {
	const page = await app.firstWindow()
	await E2ETestHelper.openClineSidebar(page)
	const sidebar = await helper.getSidebar(page)
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	await helper.signin(sidebar)
	return { page, sidebar }
}

export async function openContextRecoveryHistoryTask(page: Page, sidebar: Frame, taskText: string): Promise<void> {
	await page.getByRole("button", { name: "History", exact: true }).click()
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	const historyTask = sidebar.locator(".history-item").filter({ hasText: taskText })
	await expect(historyTask).toHaveCount(1)
	await historyTask.click()
	await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible({ timeout: 30_000 })
	await expect(sidebar.getByText(taskText, { exact: true }).first()).toBeVisible({ timeout: 30_000 })
}

export async function captureWorkScroller(sidebar: Frame): Promise<WorkScrollerSnapshot> {
	return sidebar.locator('[data-virtuoso-scroller="true"]').evaluate((scroller) => {
		const scrollerRect = scroller.getBoundingClientRect()
		const visibleRows = [...document.querySelectorAll<HTMLElement>("[data-message-ts]")]
			.map((element) => {
				const rect = element.getBoundingClientRect()
				return {
					ts: Number(element.dataset.messageTs),
					top: rect.top - scrollerRect.top,
					bottom: rect.bottom - scrollerRect.top,
					text: (element.innerText || element.textContent || "").trim().slice(0, 200),
				}
			})
			.filter((row) => Number.isFinite(row.ts) && row.bottom > 0 && row.top < scroller.clientHeight)
		return {
			scrollTop: scroller.scrollTop,
			scrollHeight: scroller.scrollHeight,
			clientHeight: scroller.clientHeight,
			bottomGap: Math.max(0, scroller.scrollHeight - scroller.clientHeight - scroller.scrollTop),
			visibleRows,
		}
	})
}

export function expectUniqueOrderedWorkRows(snapshot: WorkScrollerSnapshot): void {
	const timestamps = snapshot.visibleRows.map((row) => row.ts)
	expect(new Set(timestamps).size, "visible Chat rows must have unique message identities").toBe(timestamps.length)
	for (let index = 1; index < timestamps.length; index++) {
		const previousTimestamp = timestamps[index - 1]
		if (previousTimestamp === undefined) throw new Error("visible Chat row predecessor is missing")
		expect(timestamps[index], "visible Chat rows must remain ordered by message identity").toBeGreaterThan(previousTimestamp)
	}
}

export function earliestVisibleWorkHistoryIndex(snapshot: WorkScrollerSnapshot): number | undefined {
	const indexes = snapshot.visibleRows
		.flatMap((row) => [...row.text.matchAll(/WORK_CONTEXT_HISTORY_MESSAGE_(\d{4})/g)])
		.map((match) => Number(match[1]))
		.filter(Number.isFinite)
	return indexes.length > 0 ? Math.min(...indexes) : undefined
}

export async function unlockAndContinueContextTask(sidebar: Frame, text: string): Promise<void> {
	const unlockButton = sidebar.getByRole("button", { name: "Unlock", exact: true })
	await expect(unlockButton).toBeVisible({ timeout: 30_000 })
	await unlockButton.click()
	await expect(sidebar.getByText("Unlock Task", { exact: true })).toBeVisible({ timeout: 10_000 })
	await sidebar.getByRole("button", { name: "Confirm", exact: true }).click()
	await expect(unlockButton).toBeHidden({ timeout: 15_000 })

	const input = sidebar.getByTestId("chat-input")
	const sendButton = sidebar.getByTestId("send-button")
	const resumeButton = sidebar.getByRole("contentinfo").getByText("Resume", { exact: true })
	await expect(input).toBeEnabled({ timeout: 30_000 })
	await expect
		.poll(
			async () => (await resumeButton.isVisible().catch(() => false)) || (await sendButton.isEnabled().catch(() => false)),
			{
				timeout: 30_000,
			},
		)
		.toBe(true)
	await input.fill(text)
	if (await resumeButton.isVisible().catch(() => false)) await resumeButton.click()
	else await sendButton.click()
	await expect(sidebar.getByText(text, { exact: true }).last()).toBeVisible({ timeout: 30_000 })
}

export async function selectContextRecoveryProfile(sidebar: Frame, profileName: string): Promise<void> {
	const modelSwitcher = sidebar.getByRole("button", { name: "Select model" })
	await modelSwitcher.click()
	await expect(sidebar.getByText("Available Models", { exact: true })).toBeVisible()
	const option = sidebar.getByRole("option").filter({ has: sidebar.getByText(profileName, { exact: true }) })
	await expect(option).toHaveCount(1)
	await option.click()
	await expect(modelSwitcher).toHaveText(profileName, { timeout: 30_000 })
	await expect(sidebar.getByText("Available Models", { exact: true })).not.toBeVisible()
}

export async function closeContextRecoveryTask(sidebar: Frame): Promise<void> {
	const closeTask = sidebar.getByRole("button", { name: "Close Task", exact: true })
	await expect(closeTask).toBeVisible({ timeout: 30_000 })
	await closeTask.click()
	await expect(sidebar.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 })
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
}

export async function readTaskApiRequestInfos(dlineDocsDir: string, taskId: string): Promise<ClineApiReqInfo[]> {
	const raw = await readFile(path.join(dlineDocsDir, "tasks", taskId, "ui_messages.jsonl"), "utf8").catch(() => "")
	const requests: ClineApiReqInfo[] = []
	for (const line of raw.split(/\r?\n/).filter(Boolean)) {
		try {
			const message = JSON.parse(line) as { type?: string; say?: string; text?: string }
			if (message.type !== "say" || message.say !== "api_req_started" || !message.text) continue
			requests.push(JSON.parse(message.text) as ClineApiReqInfo)
		} catch {}
	}
	return requests
}

export async function waitForPositiveTaskCacheHit(
	dlineDocsDir: string,
	taskId: string,
	timeoutMs = 60_000,
): Promise<ClineApiReqInfo> {
	return E2ETestHelper.waitForValue(async () => {
		const latest = (await readTaskApiRequestInfos(dlineDocsDir, taskId)).at(-1)
		return (latest?.cacheReads ?? 0) > 0 && (latest?.cacheHitRate ?? 0) > 0 ? latest : undefined
	}, timeoutMs)
}

export async function waitForPersistedTaskMarkers(
	dlineDocsDir: string,
	taskId: string,
	markers: readonly string[],
	timeoutMs = 60_000,
): Promise<void> {
	await E2ETestHelper.waitForValue(async () => {
		const raw = await readFile(path.join(dlineDocsDir, "tasks", taskId, "ui_messages.jsonl"), "utf8").catch(() => "")
		return markers.every((marker) => raw.includes(marker)) ? true : undefined
	}, timeoutMs)
}

export function parseWorkPromptDiagnostics(output: string, taskId: string): WorkPromptDiagnostic[] {
	const marker = "[CompactionDiag] provider-input "
	const diagnostics: WorkPromptDiagnostic[] = []
	for (const line of output.split(/\r?\n/)) {
		const markerIndex = line.indexOf(marker)
		if (markerIndex < 0) continue
		try {
			const candidate = JSON.parse(line.slice(markerIndex + marker.length)) as Partial<WorkPromptDiagnostic>
			if (
				candidate.taskId !== taskId ||
				typeof candidate.apiIndex !== "number" ||
				typeof candidate.providerAttempt !== "number" ||
				(candidate.requestKind !== "ordinary" &&
					candidate.requestKind !== "automatic_compaction" &&
					candidate.requestKind !== "manual_compaction") ||
				typeof candidate.restoredFromHistory !== "boolean" ||
				typeof candidate.provider !== "string" ||
				typeof candidate.modelId !== "string" ||
				typeof candidate.runtimeHash !== "string" ||
				typeof candidate.promptIdentityHash !== "string" ||
				typeof candidate.systemPromptHash !== "string" ||
				typeof candidate.toolsHash !== "string" ||
				typeof candidate.serverToolsHash !== "string" ||
				typeof candidate.ordinaryBaselineAvailable !== "boolean"
			) {
				continue
			}
			diagnostics.push(candidate as WorkPromptDiagnostic)
		} catch {}
	}
	return diagnostics
}

export async function waitForWorkPromptDiagnostics(
	userDataDir: string,
	taskId: string,
	predicate: (diagnostics: readonly WorkPromptDiagnostic[]) => boolean,
	timeoutMs = 60_000,
): Promise<WorkPromptDiagnostic[]> {
	return E2ETestHelper.waitForValue(() => {
		const output = E2ETestHelper.readDlineOutputIfPresent(userDataDir)
		if (!output) return undefined
		const diagnostics = parseWorkPromptDiagnostics(output, taskId)
		return predicate(diagnostics) ? diagnostics : undefined
	}, timeoutMs)
}

export function parseWorkPromptCacheHealth(output: string, taskId: string): WorkPromptCacheHealth[] {
	const escapedTaskId = taskId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
	const pattern = new RegExp(
		`\\[Task ${escapedTaskId}\\] Prompt cache health: status=([^ ]+) sample=(\\d+) hitRate=([0-9.]+) cacheRead=(\\d+) promptTokens=(\\d+) nearContext=(true|false)`,
	)
	const snapshots: WorkPromptCacheHealth[] = []
	for (const line of output.split(/\r?\n/)) {
		const match = line.match(pattern)
		if (!match) continue
		snapshots.push({
			status: match[1] ?? "unknown",
			sampleCount: Number(match[2]),
			hitRate: Number(match[3]),
			cacheReadTokens: Number(match[4]),
			promptTokens: Number(match[5]),
			nearContextWindow: match[6] === "true",
		})
	}
	return snapshots
}

export async function waitForPositivePromptCacheHealth(
	userDataDir: string,
	taskId: string,
	timeoutMs = 60_000,
): Promise<WorkPromptCacheHealth> {
	return E2ETestHelper.waitForValue(() => {
		const output = E2ETestHelper.readDlineOutputIfPresent(userDataDir)
		if (!output) return undefined
		return parseWorkPromptCacheHealth(output, taskId).find((snapshot) => snapshot.hitRate > 0 && snapshot.cacheReadTokens > 0)
	}, timeoutMs)
}

export function expectStableWorkPromptPrefix(baseline: WorkPromptDiagnostic, current: WorkPromptDiagnostic, label: string): void {
	expect(current.systemPromptHash, `${label}: system prompt prefix drifted`).toBe(baseline.systemPromptHash)
	expect(current.toolsHash, `${label}: local/native tools prefix drifted`).toBe(baseline.toolsHash)
	expect(current.serverToolsHash, `${label}: hosted server tools prefix drifted`).toBe(baseline.serverToolsHash)
}
