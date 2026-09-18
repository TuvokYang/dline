import { type FSWatcher, watch } from "node:fs"
import { appendFile, readdir, readFile, stat, writeFile } from "node:fs/promises"
import path from "node:path"
import { setTimeout as delay } from "node:timers/promises"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type TestInfo } from "@playwright/test"
import type { ElectronApplication } from "playwright"

const TASK_TEXT = "E2E_LARGE_UI_JSONL_COMPACTION_TASK"
const READY_MARKER = "E2E_LARGE_UI_JSONL_READY"
const CONTINUATION_MARKER = "E2E_LARGE_UI_JSONL_CONTINUATION"
const SUMMARY_MARKER = "E2E_LARGE_UI_JSONL_ACCEPTED_SUMMARY"
const COMPLETION_MARKER = "E2E_LARGE_UI_JSONL_CONTINUED"
const UI_MESSAGES_FILE = "ui_messages.jsonl"
const UI_MESSAGES_TEMP_PREFIX = `${UI_MESSAGES_FILE}.tmp.`
const TARGET_UI_MESSAGES_BYTES = 32 * 1024 * 1024
const STREAM_CHUNK_SIZE = 8
const STREAM_CHUNK_DELAY_MS = 1_500

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

interface TempFileObservation {
	name: string
	firstSeenAtMs: number
	lastSeenAtMs: number
	maxBytes: number
}

const profilesPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "api_profiles.json")
const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")

async function configureResponsesAutoCompaction(dlineDir: string): Promise<void> {
	const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
	const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
	if (!profile?.openai?.capabilities) throw new Error("Missing configurable OpenAI Responses E2E profile")
	profile.modelId = "gpt-5.6-sol"
	profile.openai.capabilities.contextWindow = 131_072
	profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
	await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

	const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
	await writeFile(
		settingsPath(dlineDir),
		`${JSON.stringify(
			{
				...settings,
				actModeProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
				planModeProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
				useAutoCondense: true,
				autoCondenseTriggerPercent: 60,
				autoCondenseMaxContextTokens: 100_000,
			},
			null,
			2,
		)}\n`,
		"utf8",
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

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled()
	await input.fill(text)
	await input.press("Enter")
	await expect(input).toHaveValue("")
	await expect(sidebar.getByText(text, { exact: true }).last()).toBeVisible()
}

async function onlyTaskId(dlineDocsDir: string): Promise<string> {
	return await E2ETestHelper.waitForValue(async () => {
		const entries = await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true }).catch(() => [])
		const taskIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
		return taskIds.length === 1 ? taskIds[0] : undefined
	}, 30_000)
}

async function growUiMessagesFile(filePath: string, targetBytes: number): Promise<number> {
	const persisted = await readFile(filePath, "utf8")
	let maxTs = 0
	for (const line of persisted.split(/\r?\n/)) {
		if (!line.trim()) continue
		const message = JSON.parse(line) as { ts?: unknown }
		if (typeof message.ts === "number") maxTs = Math.max(maxTs, message.ts)
	}

	const padding = "x".repeat(8 * 1024)
	const lines: string[] = []
	let appendedBytes = 0
	let pairIndex = 0
	while (Buffer.byteLength(persisted, "utf8") + appendedBytes < targetBytes) {
		const ts = maxTs + pairIndex * 2 + 1
		const started = `${JSON.stringify({
			ts,
			type: "say",
			say: "api_req_started",
			text: JSON.stringify({
				requestId: `seed_${ts}`,
				modelId: "dline-e2e-model",
				provider: "openai",
				tokensIn: 3_312,
				tokensOut: 217,
				cacheReads: 123_456,
				cost: 0.018179,
				padding,
			}),
		})}\n`
		const finished = `${JSON.stringify({
			ts: ts + 1,
			type: "say",
			say: "api_req_finished",
			text: JSON.stringify({ requestId: `seed_${ts}`, cost: 0.018179, totalTokensIn: 3_312, totalTokensOut: 217 }),
		})}\n`
		lines.push(started, finished)
		appendedBytes += Buffer.byteLength(started, "utf8") + Buffer.byteLength(finished, "utf8")
		pairIndex++
	}

	const separator = persisted.length > 0 && !persisted.endsWith("\n") ? "\n" : ""
	await appendFile(filePath, `${separator}${lines.join("")}`, "utf8")
	return (await stat(filePath)).size
}

class UiMessagesTempObserver {
	private readonly observations = new Map<string, TempFileObservation>()
	private readonly initialNames = new Set<string>()
	private watcher: FSWatcher | undefined
	private pollTimer: ReturnType<typeof setInterval> | undefined
	private scanQueue = Promise.resolve()

	private constructor(private readonly taskDir: string) {}

	static async start(taskDir: string): Promise<UiMessagesTempObserver> {
		const observer = new UiMessagesTempObserver(taskDir)
		for (const name of await observer.tempFileNames()) observer.initialNames.add(name)
		observer.watcher = watch(taskDir, { persistent: false }, (_eventType, filename) => {
			if (!filename) return
			observer.recordName(String(filename))
		})
		observer.pollTimer = setInterval(() => observer.scheduleScan(), 25)
		observer.pollTimer.unref?.()
		observer.scheduleScan()
		return observer
	}

	async stopAfterQuiet(quietMs = 2_000, timeoutMs = 30_000): Promise<readonly TempFileObservation[]> {
		const deadline = Date.now() + timeoutMs
		let emptySince: number | undefined
		while (Date.now() < deadline) {
			await this.scan()
			const active = (await this.tempFileNames()).filter((name) => !this.initialNames.has(name))
			if (active.length === 0) {
				emptySince ??= Date.now()
				if (Date.now() - emptySince >= quietMs) break
			} else {
				emptySince = undefined
			}
			await delay(50)
		}
		if (this.pollTimer) clearInterval(this.pollTimer)
		this.pollTimer = undefined
		this.watcher?.close()
		this.watcher = undefined
		await this.scanQueue
		return [...this.observations.values()].sort((left, right) => left.firstSeenAtMs - right.firstSeenAtMs)
	}

	private scheduleScan(): void {
		this.scanQueue = this.scanQueue.then(() => this.scan()).catch(() => undefined)
	}

	private async scan(): Promise<void> {
		for (const name of await this.tempFileNames()) this.recordName(name)
		await Promise.all(
			[...this.observations.values()].map(async (observation) => {
				try {
					const fileStat = await stat(path.join(this.taskDir, observation.name))
					observation.maxBytes = Math.max(observation.maxBytes, fileStat.size)
					observation.lastSeenAtMs = Date.now()
				} catch {
					// The atomic rename may remove the temp file between directory enumeration and stat.
				}
			}),
		)
	}

	private recordName(name: string): void {
		if (!name.startsWith(UI_MESSAGES_TEMP_PREFIX) || this.initialNames.has(name)) return
		const now = Date.now()
		const existing = this.observations.get(name)
		if (existing) {
			existing.lastSeenAtMs = now
			return
		}
		this.observations.set(name, { name, firstSeenAtMs: now, lastSeenAtMs: now, maxBytes: 0 })
	}

	private async tempFileNames(): Promise<string[]> {
		return (await readdir(this.taskDir).catch(() => [])).filter((name) => name.startsWith(UI_MESSAGES_TEMP_PREFIX))
	}
}

async function attachDiagnostics(
	testInfo: TestInfo,
	value: {
		baselineBytes: number
		configuredChunkCount: number
		observations: readonly TempFileObservation[]
		partialWindow: readonly TempFileObservation[]
	},
): Promise<void> {
	await testInfo.attach("automatic-compaction-streaming-persistence.json", {
		body: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
		contentType: "application/json",
	})
}

e2e(
	"Automatic compaction streaming - large ui_messages.jsonl is not atomically rewritten for every partial chunk",
	async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }, testInfo) => {
		e2e.setTimeout(240_000)
		await configureResponsesAutoCompaction(dlineDir)
		const summaryArguments = {
			context: `${SUMMARY_MARKER} preserves the pending continuation without repeated full rewrites.`,
		}
		const configuredChunkCount = Math.ceil(Buffer.byteLength(JSON.stringify(summaryArguments), "utf8") / STREAM_CHUNK_SIZE)
		expect(configuredChunkCount).toBeGreaterThanOrEqual(5)

		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_large_ui_jsonl_ready",
				name: "qna_respond",
				arguments: { response: READY_MARKER },
				usage: { inputTokens: 125_000, outputTokens: 100 },
			},
			{
				type: "tool-with-completion-snapshots",
				id: "call_large_ui_jsonl_summary",
				name: "summarize_task",
				arguments: summaryArguments,
				toolArgumentChunkSize: STREAM_CHUNK_SIZE,
				toolArgumentChunkDelayMs: STREAM_CHUNK_DELAY_MS,
				expectedRequestIncludes: ["The current conversation is rapidly running out of context"],
				expectedRequestExcludes: [CONTINUATION_MARKER],
			},
			{
				type: "tool",
				id: "call_large_ui_jsonl_complete",
				name: "attempt_completion",
				arguments: { result: COMPLETION_MARKER },
				expectedRequestIncludes: [SUMMARY_MARKER, CONTINUATION_MARKER],
			},
		)

		const app = await openVSCode(workspaceDir)
		try {
			const sidebar = await openSidebar(app, helper)
			await sendTask(sidebar, TASK_TEXT)
			await expect(sidebar.getByText(READY_MARKER, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			const taskId = await onlyTaskId(dlineDocsDir)
			const taskDir = path.join(dlineDocsDir, "tasks", taskId)
			const uiMessagesPath = path.join(taskDir, UI_MESSAGES_FILE)

			// Let the first turn's durable write settle, then enlarge the active Task's
			// file externally. The next dirty flush merges this committed tail under lock.
			await delay(1_500)
			const baselineBytes = await growUiMessagesFile(uiMessagesPath, TARGET_UI_MESSAGES_BYTES)
			expect(baselineBytes).toBeGreaterThanOrEqual(TARGET_UI_MESSAGES_BYTES)
			expect(server.getRequestCount("openai-compatible-responses")).toBe(1)

			const observer = await UiMessagesTempObserver.start(taskDir)
			await sendTask(sidebar, CONTINUATION_MARKER)
			await expect.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 90_000 }).toBe(3)
			const observations = await observer.stopAfterQuiet()

			const requests = server.getMockConsumptions("openai-compatible-responses")
			const summaryRequest = requests[1]
			const continuationRequest = requests[2]
			expect(summaryRequest.responseType).toBe("tool-with-completion-snapshots")
			expect(summaryRequest.contractError).toBeUndefined()
			expect(continuationRequest.contractError).toBeUndefined()
			const partialWindow = observations.filter(
				(observation) =>
					observation.firstSeenAtMs >= summaryRequest.receivedAtMs &&
					observation.firstSeenAtMs < continuationRequest.receivedAtMs,
			)
			await attachDiagnostics(testInfo, { baselineBytes, configuredChunkCount, observations, partialWindow })

			// A partial stream may cause at most one durable boundary write. Rewriting the
			// complete JSONL once per provider chunk makes persistence O(history size * chunks).
			expect(partialWindow.length).toBeLessThanOrEqual(1)
			expect(JSON.stringify(continuationRequest.requestBody)).toContain(SUMMARY_MARKER)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)
