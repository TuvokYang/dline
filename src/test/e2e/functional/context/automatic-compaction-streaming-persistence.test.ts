import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { readTaskUiMessages, rewriteTaskUiMessages } from "@e2e/utils/task-instance-store"
import { expect, type Frame, type TestInfo } from "@playwright/test"
import type { UiMessage } from "@shared/ExtensionMessage"
import type { ElectronApplication } from "playwright"

const TASK_TEXT = "E2E_LARGE_UI_JSONL_COMPACTION_TASK"
const READY_MARKER = "E2E_LARGE_UI_JSONL_READY"
const CONTINUATION_MARKER = "E2E_LARGE_UI_JSONL_CONTINUATION"
const SUMMARY_MARKER = "E2E_LARGE_UI_JSONL_ACCEPTED_SUMMARY"
const COMPLETION_MARKER = "E2E_LARGE_UI_JSONL_CONTINUED"
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

interface SeededHistory {
	bytes: number
	count: number
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

async function closeCurrentTask(sidebar: Frame): Promise<void> {
	const closeButton = sidebar.getByRole("button", { name: "Close Task", exact: true })
	await expect(closeButton).toBeVisible({ timeout: 30_000 })
	await closeButton.click()
	await expect(closeButton).toHaveCount(0, { timeout: 30_000 })
	await expect(sidebar.getByTestId("chat-input")).toBeVisible()
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
}

async function reopenTask(sidebar: Frame, taskText: string): Promise<void> {
	const historyTask = sidebar.getByText(taskText, { exact: true }).last()
	await expect(historyTask).toBeVisible({ timeout: 30_000 })
	await historyTask.click()
	await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible({ timeout: 30_000 })
}

/**
 * Grows the stored chat history of a closed task to at least `targetBytes` of
 * serialized messages, appending realistic API request pairs after the last row.
 */
async function growStoredHistory(dlineDocsDir: string, taskId: string, targetBytes: number): Promise<SeededHistory> {
	const padding = "x".repeat(8 * 1024)
	const seeded: SeededHistory = { bytes: 0, count: 0 }
	await rewriteTaskUiMessages(dlineDocsDir, taskId, (messages) => {
		const grown = [...messages]
		let bytes = messages.reduce((sum, message) => sum + Buffer.byteLength(JSON.stringify(message), "utf8"), 0)
		const maxTs = messages.reduce((max, message) => Math.max(max, message.ts), 0)
		for (let pairIndex = 0; bytes < targetBytes; pairIndex++) {
			const ts = maxTs + pairIndex * 2 + 1
			const pair: UiMessage[] = [
				{
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
				},
				{
					ts: ts + 1,
					type: "say",
					say: "api_req_finished",
					text: JSON.stringify({ requestId: `seed_${ts}`, cost: 0.018179, totalTokensIn: 3_312, totalTokensOut: 217 }),
				},
			]
			for (const message of pair) bytes += Buffer.byteLength(JSON.stringify(message), "utf8")
			grown.push(...pair)
		}
		seeded.bytes = bytes
		seeded.count = grown.length
		return grown
	})
	return seeded
}

async function attachDiagnostics(
	testInfo: TestInfo,
	value: {
		seeded: SeededHistory
		configuredChunkCount: number
		storedCount: number
		storedPartialCount: number
	},
): Promise<void> {
	await testInfo.attach("automatic-compaction-streaming-persistence.json", {
		body: Buffer.from(`${JSON.stringify(value, null, 2)}\n`, "utf8"),
		contentType: "application/json",
	})
}

e2e(
	"Automatic compaction streaming - a large stored history keeps every row and never persists partial chunks",
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

			// messages.db has one writer: the open task. Grow the history while the task
			// is closed, then reopen it so the extension reads the grown rows back.
			await closeCurrentTask(sidebar)
			const seeded = await growStoredHistory(dlineDocsDir, taskId, TARGET_UI_MESSAGES_BYTES)
			expect(seeded.bytes).toBeGreaterThanOrEqual(TARGET_UI_MESSAGES_BYTES)
			expect(server.getRequestCount("openai-compatible-responses")).toBe(1)
			await reopenTask(sidebar, TASK_TEXT)

			await sendTask(sidebar, CONTINUATION_MARKER)
			await expect.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 90_000 }).toBe(3)
			await expect(sidebar.getByText(COMPLETION_MARKER, { exact: false }).last()).toBeVisible({ timeout: 60_000 })

			const requests = server.getMockConsumptions("openai-compatible-responses")
			const summaryRequest = requests[1]
			const continuationRequest = requests[2]
			expect(summaryRequest.responseType).toBe("tool-with-completion-snapshots")
			expect(summaryRequest.contractError).toBeUndefined()
			expect(continuationRequest.contractError).toBeUndefined()

			// Partial chunks stay in memory; only finished messages reach messages.db, so the
			// streamed summary can neither leave a partial row nor drop any seeded row.
			const stored = await readTaskUiMessages(dlineDocsDir, taskId)
			const storedPartialCount = stored.filter((message) => message.partial === true).length
			await attachDiagnostics(testInfo, {
				seeded,
				configuredChunkCount,
				storedCount: stored.length,
				storedPartialCount,
			})
			expect(storedPartialCount).toBe(0)
			expect(stored.length).toBeGreaterThanOrEqual(seeded.count)
			expect(JSON.stringify(continuationRequest.requestBody)).toContain(SUMMARY_MARKER)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)
