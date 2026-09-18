import { readdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
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

type PersistedRecord = Record<string, unknown>

const profilesPath = (dlineDir: string): string => path.join(dlineDir, "data", "settings", "api_profiles.json")
const settingsPath = (dlineDir: string): string => path.join(dlineDir, "data", "settings", "settings.json")

async function configureResponsesAutoCompaction(dlineDir: string): Promise<void> {
	await configureCompactionSettings(dlineDir, {
		contextWindow: 131_072,
		triggerPercent: 60,
		maxContextTokens: 100_000,
	})
}

async function configureForcedCompaction(dlineDir: string): Promise<void> {
	await configureCompactionSettings(dlineDir, {
		contextWindow: 752_000,
		triggerPercent: 97,
		minReserveTokens: 5_000,
		maxReserveTokens: 30_000,
		maxContextTokens: 30_000,
	})
}

async function configureCompactionSettings(
	dlineDir: string,
	options: {
		contextWindow: number
		triggerPercent: number
		minReserveTokens?: number
		maxReserveTokens?: number
		maxContextTokens: number
	},
): Promise<void> {
	const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
	const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
	if (!profile?.openai?.capabilities) throw new Error("Missing configurable OpenAI Responses E2E profile")
	profile.modelId = "gpt-5.6-sol"
	profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
	profile.openai.capabilities.contextWindow = options.contextWindow
	await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

	const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as PersistedRecord
	await writeFile(
		settingsPath(dlineDir),
		`${JSON.stringify(
			{
				...settings,
				actModeProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
				planModeProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
				useAutoCondense: true,
				autoCondenseTriggerPercent: options.triggerPercent,
				autoCondenseMinReserveTokens: options.minReserveTokens ?? 5_000,
				autoCondenseMaxReserveTokens: options.maxReserveTokens ?? 30_000,
				autoCondenseMaxContextTokens: options.maxContextTokens,
			},
			null,
			2,
		)}\n`,
		"utf8",
	)
}

async function openSidebar(app: ElectronApplication, helper: E2ETestHelper): Promise<{ page: Page; sidebar: Frame }> {
	const page = await app.firstWindow()
	await E2ETestHelper.openClineSidebar(page)
	const sidebar = await helper.getSidebar(page)
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	await helper.signin(sidebar)
	return { page, sidebar }
}

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled()
	await input.fill(text)
	await input.press("Enter")
	await expect(input).toHaveValue("")
	await expect(sidebar.getByText(text, { exact: true }).last()).toBeVisible()
}

async function setAutoApproveAction(sidebar: Frame, label: string, enabled: boolean): Promise<void> {
	await sidebar.getByLabel("Open auto-approve settings").click()
	const checkbox = sidebar.locator("vscode-checkbox").filter({ hasText: label })
	await expect(checkbox).toHaveCount(1)
	const isChecked = () => checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))
	if ((await isChecked()) !== enabled) await sidebar.getByText(label, { exact: true }).click()
	await expect.poll(isChecked).toBe(enabled)
	await sidebar.getByLabel("Close auto-approve settings").click()
}

async function closeCurrentTask(sidebar: Frame): Promise<void> {
	const closeButton = sidebar.getByRole("button", { name: "Close Task", exact: true })
	await expect(closeButton).toBeVisible({ timeout: 30_000 })
	await closeButton.click()
	await expect(sidebar.getByTestId("chat-input")).toBeVisible({ timeout: 30_000 })
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
}

async function reopenTask(page: Page, sidebar: Frame, taskText: string): Promise<void> {
	await page.getByRole("button", { name: "History", exact: true }).click()
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	const historyTask = sidebar.locator(".history-item").filter({ hasText: taskText })
	await expect(historyTask).toHaveCount(1)
	await historyTask.click()
	await expect(sidebar.getByRole("button", { name: "Close Task", exact: true })).toBeVisible({ timeout: 30_000 })
	await expect(sidebar.getByText(taskText, { exact: true }).first()).toBeVisible({ timeout: 30_000 })
}

async function onlyTaskId(dlineDocsDir: string): Promise<string> {
	const entries = await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true })
	const taskIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
	if (taskIds.length !== 1 || !taskIds[0]) throw new Error(`Expected exactly one persisted task, found ${taskIds.length}`)
	return taskIds[0]
}

async function recreateInterruptedStreamingSnapshot(dlineDocsDir: string, taskId: string): Promise<void> {
	const taskDirectory = path.join(dlineDocsDir, "tasks", taskId)
	const apiHistoryPath = path.join(taskDirectory, "api_conversation_history.jsonl")
	const uiMessagesPath = path.join(taskDirectory, "ui_messages.jsonl")
	const snapshotPath = path.join(taskDirectory, "snapshot.json")
	const apiMessages = (await readFile(apiHistoryPath, "utf8"))
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as PersistedRecord)
	const pendingAssistant = apiMessages.at(-1)
	const qnaToolUse = Array.isArray(pendingAssistant?.content)
		? (pendingAssistant.content.find(
				(block) => typeof block === "object" && block !== null && (block as PersistedRecord).name === "qna_respond",
			) as PersistedRecord | undefined)
		: undefined
	const functionId = qnaToolUse?.function_id
	const dlineTid = qnaToolUse?.dline_tid
	if (pendingAssistant?.role !== "assistant" || typeof functionId !== "string" || typeof dlineTid !== "string") {
		throw new Error("Expected the setup task to end with a canonical qna_respond assistant message")
	}
	const completedApiMessages = [
		...apiMessages,
		{
			role: "user",
			content: [
				{
					type: "tool_result",
					function_id: functionId,
					dline_tid: dlineTid,
					content: [{ type: "text", text: "E2E_RECOVERED_RESUME_SETUP_ACK" }],
				},
			],
			ts: Date.now(),
		},
	]
	await writeFile(apiHistoryPath, `${completedApiMessages.map((message) => JSON.stringify(message)).join("\n")}\n`, "utf8")

	const uiMessages = (await readFile(uiMessagesPath, "utf8"))
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as PersistedRecord)
	const pendingAsk = uiMessages.at(-1)
	if (pendingAsk?.type !== "ask" || pendingAsk.ask !== "qna_respond") {
		throw new Error("Expected the setup task to end with a pending qna_respond UI interaction")
	}
	await writeFile(
		uiMessagesPath,
		`${uiMessages
			.slice(0, -1)
			.map((message) => JSON.stringify(message))
			.join("\n")}\n`,
		"utf8",
	)

	const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as PersistedRecord
	const apiIndex = completedApiMessages.length - 1
	const turnId = `resume-turn:${taskId}`
	snapshot.phase = "streaming"
	snapshot.apiIndex = apiIndex
	snapshot.revision = typeof snapshot.revision === "number" ? snapshot.revision + 1 : 1
	snapshot.anchor = { apiIndex, turnId }
	snapshot.turn = { turnId, assistantApiIndex: apiIndex + 1, mode: "parallel", blocks: [] }
	delete snapshot.interaction
	delete snapshot.interruptedInteraction
	delete snapshot.cancellation
	delete snapshot.completion
	delete snapshot.runtimeError
	delete snapshot.error
	await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8")
}

async function recreateRecoveredUnpairedToolTail(dlineDocsDir: string, taskId: string, commandMarker: string): Promise<void> {
	const taskDirectory = path.join(dlineDocsDir, "tasks", taskId)
	const apiHistoryPath = path.join(taskDirectory, "api_conversation_history.jsonl")
	const uiMessagesPath = path.join(taskDirectory, "ui_messages.jsonl")
	const snapshotPath = path.join(taskDirectory, "snapshot.json")
	const uiMessages = await readFile(uiMessagesPath, "utf8")
	expect(uiMessages).toContain('"say":"partial_tool_result"')
	expect(uiMessages).toContain(commandMarker)

	const apiMessages = (await readFile(apiHistoryPath, "utf8"))
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as PersistedRecord)
	const assistantIndex = apiMessages.findIndex((message) => {
		if (message.role !== "assistant" || !Array.isArray(message.content)) return false
		return message.content.some((block) => {
			if (typeof block !== "object" || block === null) return false
			const candidate = block as PersistedRecord
			return candidate.type === "tool_use" && candidate.name === "execute_command"
		})
	})
	if (assistantIndex < 0) throw new Error("Expected the setup task to persist an execute_command assistant message")

	const toolUse = (apiMessages[assistantIndex]?.content as unknown[]).find((block): block is PersistedRecord => {
		if (typeof block !== "object" || block === null) return false
		const candidate = block as PersistedRecord
		return candidate.type === "tool_use" && candidate.name === "execute_command"
	})
	const functionId = toolUse?.function_id
	const dlineTid = toolUse?.dline_tid
	if (typeof functionId !== "string" || typeof dlineTid !== "string") {
		throw new Error("Expected execute_command to have canonical function_id and dline_tid")
	}

	await writeFile(
		apiHistoryPath,
		`${apiMessages
			.slice(0, assistantIndex + 1)
			.map((message) => JSON.stringify(message))
			.join("\n")}\n`,
		"utf8",
	)

	const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as PersistedRecord
	const existingTurn = typeof snapshot.turn === "object" && snapshot.turn !== null ? (snapshot.turn as PersistedRecord) : {}
	const existingBlocks = Array.isArray(existingTurn.blocks) ? existingTurn.blocks : []
	const existingBlock = existingBlocks.find((block): block is PersistedRecord => {
		if (typeof block !== "object" || block === null) return false
		const candidate = block as PersistedRecord
		return candidate.functionId === functionId || candidate.dlineTid === dlineTid
	})
	const turnId = typeof existingTurn.turnId === "string" ? existingTurn.turnId : `turn:${dlineTid}`
	snapshot.phase = "between_turns"
	snapshot.apiIndex = assistantIndex
	snapshot.revision = typeof snapshot.revision === "number" ? snapshot.revision + 1 : 1
	snapshot.anchor = { apiIndex: assistantIndex, turnId }
	snapshot.turn = {
		...existingTurn,
		turnId,
		assistantApiIndex: assistantIndex,
		mode: "serial",
		blocks: [
			{
				...(existingBlock ?? {}),
				dlineTid,
				functionId,
				toolName: "execute_command",
				phase: "completed",
			},
		],
	}
	delete snapshot.interaction
	delete snapshot.interruptedInteraction
	delete snapshot.cancellation
	delete snapshot.completion
	delete snapshot.runtimeError
	delete snapshot.error
	delete snapshot.awaiting
	delete snapshot.approval
	delete snapshot.execution
	delete snapshot.resume
	await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8")
}

e2e(
	"Recovered tool result - automatic compaction must pair the durable command result before Provider admission",
	async ({ dlineDocsDir, dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(240_000)
		await configureResponsesAutoCompaction(dlineDir)
		const commandMarker = "E2E_RECOVERED_COMMAND_STDOUT"
		const setupTask = "E2E_RECOVERED_TOOL_COMPACTION_SETUP"
		const followup = "E2E_RECOVERED_TOOL_COMPACTION_FOLLOWUP"
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_recovered_command",
				name: "execute_command",
				arguments: {
					command: `node -e "process.stdout.write('${commandMarker}')"`,
					workdirectory: ".",
					requires_approval: true,
					synchronous: true,
					timeout: 60,
				},
				usage: { inputTokens: 1_000, outputTokens: 100 },
			},
			{
				type: "tool",
				id: "call_recovered_setup_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_RECOVERED_SETUP_DONE" },
				expectedToolResults: [
					{
						callId: "call_recovered_command",
						contentIncludes: ["Command executed successfully (exit code 0).", commandMarker],
					},
				],
				usage: { inputTokens: 60_000, outputTokens: 100 },
			},
			{
				type: "message",
				text: "<thinking>E2E recovered compaction</thinking><summarize_task><context>E2E_RECOVERED_COMPACTION_SUMMARY</context></summarize_task>",
				expectedRequestIncludes: [commandMarker, "The current conversation is rapidly running out of context"],
			},
			{
				type: "tool",
				id: "call_recovered_followup_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_RECOVERED_TOOL_COMPACTION_OK" },
				expectedRequestIncludes: ["E2E_RECOVERED_COMPACTION_SUMMARY", followup],
			},
		)

		let firstApp: ElectronApplication | undefined
		let resumedApp: ElectronApplication | undefined
		try {
			firstApp = await openVSCode(workspaceDir)
			const first = await openSidebar(firstApp, helper)
			await setAutoApproveAction(first.sidebar, "Execute safe commands", true)
			await sendTask(first.sidebar, setupTask)
			await expect(first.sidebar.getByText(commandMarker, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			const approveButton = first.sidebar.getByText("Approve", { exact: true }).last()
			if (await approveButton.isVisible()) await approveButton.click()
			await expect(first.sidebar.getByText("E2E_RECOVERED_SETUP_DONE", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(2)

			await closeCurrentTask(first.sidebar)
			await firstApp.close()
			firstApp = undefined
			helper.clearCachedFrame()

			const taskId = await onlyTaskId(dlineDocsDir)
			await recreateRecoveredUnpairedToolTail(dlineDocsDir, taskId, commandMarker)
			await configureForcedCompaction(dlineDir)

			resumedApp = await openVSCode(workspaceDir)
			const resumed = await openSidebar(resumedApp, helper)
			await setAutoApproveAction(resumed.sidebar, "Execute safe commands", true)
			await reopenTask(resumed.page, resumed.sidebar, setupTask)
			const input = resumed.sidebar.getByTestId("chat-input")
			const resumeButton = resumed.sidebar.getByRole("contentinfo").getByText("Resume", { exact: true })
			await expect(resumeButton).toBeVisible({ timeout: 30_000 })
			await expect(input).toBeEnabled()
			await input.fill(followup)
			await resumeButton.click()
			await expect(input).toHaveValue("")
			await expect.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 120_000 }).toBe(4)
			await expect(resumed.sidebar.getByText(followup, { exact: true }).last()).toBeVisible({ timeout: 60_000 })
			await expect(resumed.sidebar.getByText("E2E_RECOVERED_TOOL_COMPACTION_OK", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			const requests = server.getMockConsumptions("openai-compatible-responses")
			expect(requests[2]?.contractError).toBeUndefined()
			expect(requests[3]?.contractError).toBeUndefined()
			await expect(resumed.sidebar.getByText("API Request Failed", { exact: true })).toHaveCount(0)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [/No complete logical turn/i])
		} finally {
			await firstApp?.close()
			await resumedApp?.close()
		}
	},
)

e2e(
	"Recovered Resume - terminal compaction failure retires the accepted continuation before Retry",
	async ({ dlineDocsDir, dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(240_000)
		await configureResponsesAutoCompaction(dlineDir)
		server.resetOpenAiMock()
		const setupTask = "E2E_RECOVERED_RESUME_COMPACTION_SETUP"
		const resumeDraft = "E2E_RECOVERED_RESUME_COMPACTION_DRAFT"
		const failureMessage = "No tool output found for function call fc_e2e_recovered_resume."
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_recovered_resume_ready",
				name: "qna_respond",
				arguments: { response: "E2E_RECOVERED_RESUME_READY" },
				usage: { inputTokens: 60_000, outputTokens: 100 },
			},
			{ type: "error", status: 400, message: failureMessage },
			{
				type: "tool",
				id: "call_recovered_resume_summary",
				name: "summarize_task",
				arguments: { context: "E2E_RECOVERED_RESUME_RETRY_SUMMARY" },
				expectedRequestIncludes: ["The current conversation is rapidly running out of context"],
				usage: { inputTokens: 20_000, outputTokens: 100 },
			},
			{
				type: "tool",
				id: "call_recovered_resume_complete",
				name: "attempt_completion",
				arguments: { result: "E2E_RECOVERED_RESUME_RETRY_OK" },
				expectedRequestIncludes: ["E2E_RECOVERED_RESUME_RETRY_SUMMARY", resumeDraft],
				usage: { inputTokens: 20_000, outputTokens: 100 },
			},
		)

		let firstApp: ElectronApplication | undefined
		let resumedApp: ElectronApplication | undefined
		try {
			firstApp = await openVSCode(workspaceDir)
			const first = await openSidebar(firstApp, helper)
			await sendTask(first.sidebar, setupTask)
			await expect(first.sidebar.getByText("E2E_RECOVERED_RESUME_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(1)
			await closeCurrentTask(first.sidebar)
			await firstApp.close()
			firstApp = undefined
			helper.clearCachedFrame()

			const taskId = await onlyTaskId(dlineDocsDir)
			await recreateInterruptedStreamingSnapshot(dlineDocsDir, taskId)
			await configureForcedCompaction(dlineDir)

			resumedApp = await openVSCode(workspaceDir)
			const resumed = await openSidebar(resumedApp, helper)
			await reopenTask(resumed.page, resumed.sidebar, setupTask)
			const footer = resumed.sidebar.getByRole("contentinfo")
			const resumeButton = footer.getByText("Resume", { exact: true })
			const input = resumed.sidebar.getByTestId("chat-input")
			await expect(resumeButton).toBeVisible({ timeout: 30_000 })
			await input.fill(resumeDraft)
			await resumeButton.click()
			await expect(input).toHaveValue("")

			await expect(resumed.sidebar.getByTestId("compaction-failure")).toBeVisible({
				timeout: 120_000,
			})
			await expect(resumed.sidebar.getByText("Automatic retry stopped", { exact: true })).toHaveCount(0)
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(2)
			// Cross the former 2-second first retry delay and prove the immutable 400 request stays terminal.
			await resumed.page.waitForTimeout(3_000)
			expect(server.getRequestCount("openai-compatible-responses")).toBe(2)
			const outputBeforeRetry = E2ETestHelper.readDlineOutputIfPresent(userDataDir) ?? ""
			expect(outputBeforeRetry).not.toContain("hydrated_interaction_mismatch")
			const retryBeforeReload = footer.getByText("Retry", { exact: true })
			await expect(retryBeforeReload).toBeVisible()
			await expect(retryBeforeReload).toBeEnabled()
			const retrySnapshotPath = path.join(dlineDocsDir, "tasks", taskId, "snapshot.json")
			await expect
				.poll(async () => {
					const snapshot = JSON.parse(await readFile(retrySnapshotPath, "utf8")) as PersistedRecord
					const interaction = snapshot.interaction as PersistedRecord | undefined
					return `${String(interaction?.kind)}:${String(interaction?.status)}`
				})
				.toBe("error_retry:awaiting")
			const legacySnapshot = JSON.parse(await readFile(retrySnapshotPath, "utf8")) as PersistedRecord
			const legacyInteraction = legacySnapshot.interaction as PersistedRecord
			delete legacyInteraction.persistedRequest
			delete legacyInteraction.retryContent
			await writeFile(retrySnapshotPath, `${JSON.stringify(legacySnapshot, null, 2)}\n`, "utf8")

			// Reload the extension host after the terminal compaction failure so the
			// in-memory replay recipe is gone while the active error interaction remains.
			await E2ETestHelper.runCommandPalette(resumed.page, "Developer: Reload Window")
			helper.clearCachedFrame()
			const retried = await openSidebar(resumedApp, helper)
			await reopenTask(retried.page, retried.sidebar, setupTask)
			const retryFooter = retried.sidebar.getByRole("contentinfo")
			const retryButton = retryFooter.getByText("Retry", { exact: true })
			await expect(retryButton).toBeVisible({ timeout: 30_000 })
			await expect(retryButton).toBeEnabled()
			await retryButton.click()
			await expect(retried.sidebar.getByText("E2E_RECOVERED_RESUME_RETRY_OK", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(4)
			await expect(retried.sidebar.getByTestId("error-retry-box")).toHaveCount(0)
			const outputAfterRetry = await E2ETestHelper.readDlineOutput(userDataDir)
			expect(outputAfterRetry).not.toContain("hydrated_interaction_mismatch")
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await firstApp?.close()
			await resumedApp?.close()
		}
	},
)
