import { readdir, readFile, writeFile } from "node:fs/promises"
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

type PersistedRecord = Record<string, unknown>

interface SeededToolUse {
	functionId: string
	dlineTid: string
	name: string
	input: Record<string, unknown>
	result: string
}

interface PairingScenario {
	id: string
	label: string
	knownSplitRegression?: boolean
	tools: readonly SeededToolUse[]
}

interface TurnEndPairingScenario {
	id: string
	label: string
	knownSplitRegression: boolean
	initialTaskText: string
	tool: {
		name: string
		arguments: Record<string, unknown>
		visibleText: string
	}
	feedback: string
	action: "submit_text" | "select_option" | "reject_new_task"
}

const COMPACT_INSTRUCTION_MARKER = "The current conversation is rapidly running out of context"
const profilesPath = (dlineDir: string): string => path.join(dlineDir, "data", "settings", "api_profiles.json")
const settingsPath = (dlineDir: string): string => path.join(dlineDir, "data", "settings", "settings.json")

const turnEndScenarios: readonly TurnEndPairingScenario[] = [
	turnEndScenario("qna", "qna_respond", { response: "E2E_QNA_PAIRING" }, "E2E_QNA_PAIRING", "submit_text"),
	turnEndScenario(
		"plan",
		"make_plan",
		{ response: "E2E_PLAN_PAIRING", needs_more_exploration: false },
		"E2E_PLAN_PAIRING",
		"submit_text",
	),
	turnEndScenario(
		"followup",
		"ask_followup_question",
		{ question: "E2E_FOLLOWUP_PAIRING", options: ["E2E_OPTION_A", "E2E_OPTION_B"] },
		"E2E_FOLLOWUP_PAIRING",
		"select_option",
	),
	turnEndScenario(
		"report",
		"generate_report",
		{ title: "E2E_REPORT_PAIRING", content: "E2E_REPORT_PAIRING_CONTENT" },
		"E2E_REPORT_PAIRING",
		"submit_text",
	),
	turnEndScenario(
		"completion",
		"attempt_completion",
		{ result: "E2E_COMPLETION_PAIRING" },
		"E2E_COMPLETION_PAIRING",
		"submit_text",
	),
	{
		id: "new-task",
		label: "new_task",
		knownSplitRegression: false,
		initialTaskText: "/newtask E2E_COMPACTION_PAIRING_NEW_TASK",
		tool: {
			name: "new_task",
			arguments: { context: "E2E_NEW_TASK_PAIRING_CONTEXT" },
			visibleText: "E2E_NEW_TASK_PAIRING_CONTEXT",
		},
		feedback: "E2E_NEW_TASK_PAIRING_FEEDBACK",
		action: "reject_new_task",
	},
]

const recoveredTurnEndScenarios: readonly PairingScenario[] = [
	{
		id: "qna",
		label: "recovered qna_respond",
		knownSplitRegression: false,
		tools: [
			seededTool(
				"qna",
				"qna_respond",
				{ response: "E2E_QNA_PAIRING" },
				"[qna_respond] Result:\n<feedback>\nE2E_QNA_PAIRING_FEEDBACK\n</feedback>",
			),
		],
	},
	{
		id: "plan",
		label: "recovered make_plan",
		knownSplitRegression: false,
		tools: [
			seededTool(
				"plan",
				"make_plan",
				{ response: "E2E_PLAN_PAIRING", needs_more_exploration: false },
				"[make_plan] Result:\n<feedback>\nE2E_PLAN_PAIRING_FEEDBACK\n</feedback>",
			),
		],
	},
	{
		id: "followup",
		label: "recovered ask_followup_question",
		knownSplitRegression: false,
		tools: [
			seededTool(
				"followup",
				"ask_followup_question",
				{ question: "E2E_FOLLOWUP_PAIRING", options: ["E2E_OPTION_A", "E2E_OPTION_B"] },
				"[ask_followup_question] Result:\n<feedback>\nE2E_OPTION_B\n</feedback>",
			),
		],
	},
	{
		id: "report",
		label: "recovered generate_report",
		knownSplitRegression: false,
		tools: [
			seededTool(
				"report",
				"generate_report",
				{ title: "E2E_REPORT_PAIRING", content: "E2E_REPORT_PAIRING_CONTENT" },
				"[generate_report] Result:\n<feedback>\nE2E_REPORT_PAIRING_FEEDBACK\n</feedback>",
			),
		],
	},
	{
		id: "completion",
		label: "recovered attempt_completion",
		knownSplitRegression: false,
		tools: [
			seededTool(
				"completion",
				"attempt_completion",
				{ result: "E2E_COMPLETION_PAIRING" },
				"[attempt_completion] Result: Done\n<feedback>\nE2E_COMPLETION_PAIRING_FEEDBACK\n</feedback>",
			),
		],
	},
	{
		id: "new-task",
		label: "recovered new_task",
		knownSplitRegression: false,
		tools: [
			seededTool(
				"new-task",
				"new_task",
				{ context: "E2E_NEW_TASK_PAIRING_CONTEXT" },
				"[new_task] Result:\n<!-- dline:new-task-feedback:v1 -->\nThe user provided feedback instead of creating a new task:\n<feedback>\nE2E_NEW_TASK_PAIRING_FEEDBACK\n</feedback>",
			),
		],
	},
]

const ordinaryScenarios: readonly PairingScenario[] = [
	{
		id: "ordinary-serial",
		label: "serial read_file",
		tools: [
			seededTool(
				"ordinary-read",
				"read_file",
				{ path: "README.md" },
				"The file contains a literal fixture: <feedback>ordinary payload</feedback>.",
			),
		],
	},
	{
		id: "ordinary-parallel",
		label: "parallel ordinary tools",
		tools: [
			seededTool("parallel-read", "read_file", { path: "README.md" }, 'prompt_1: "<task>parallel fixture</task>"'),
			seededTool(
				"parallel-search",
				"search_files",
				{ path: ".", regex: "Test Workspace" },
				"const fixture = '<feedback>parallel payload</feedback>'",
			),
		],
	},
]

function turnEndScenario(
	id: string,
	name: string,
	input: Record<string, unknown>,
	visibleText: string,
	action: TurnEndPairingScenario["action"],
): TurnEndPairingScenario {
	return {
		id,
		label: name,
		knownSplitRegression: false,
		initialTaskText: `E2E_COMPACTION_PAIRING_${id.toUpperCase()}_TASK`,
		tool: { name, arguments: input, visibleText },
		feedback: action === "select_option" ? "E2E_OPTION_B" : `E2E_${id.toUpperCase()}_PAIRING_FEEDBACK`,
		action,
	}
}

function seededTool(id: string, name: string, input: Record<string, unknown>, result: string): SeededToolUse {
	return {
		functionId: `fc_e2e_compaction_pairing_${id.replaceAll("-", "_")}`,
		dlineTid: `dline_tid_e2e_compaction_pairing_${id.replaceAll("-", "_")}`,
		name,
		input,
		result,
	}
}

async function configureManualCompaction(dlineDir: string): Promise<void> {
	const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
	const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
	if (!profile?.openai?.capabilities) throw new Error("Missing configurable OpenAI Responses E2E profile")
	profile.modelId = "gpt-5.6-sol"
	profile.openai.capabilities.contextWindow = 131_072
	profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
	await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

	const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as PersistedRecord
	await writeFile(
		settingsPath(dlineDir),
		`${JSON.stringify(
			{
				...settings,
				actModeProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
				planModeProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
				useAutoCondense: false,
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

async function submitText(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled({ timeout: 60_000 })
	await input.fill(text)
	await input.press("Enter")
	await expect(input).toHaveValue("")
}

async function submitTurnEndFeedback(sidebar: Frame, scenario: TurnEndPairingScenario): Promise<void> {
	if (scenario.action === "select_option") {
		await sidebar.getByRole("button", { name: scenario.feedback, exact: true }).click()
		return
	}
	if (scenario.action === "reject_new_task") {
		const input = sidebar.getByTestId("chat-input")
		await expect(input).toBeEnabled({ timeout: 60_000 })
		await input.fill(scenario.feedback)
		await sidebar.locator('vscode-button[aria-label="Regenerate Context"]').click()
		await expect(input).toHaveValue("")
		return
	}
	await submitText(sidebar, scenario.feedback)
}

async function triggerTaskHeaderCompaction(sidebar: Frame): Promise<void> {
	const expandTaskHeader = sidebar.getByLabel("Expand task header")
	if (await expandTaskHeader.isVisible()) await expandTaskHeader.click()
	const compactButton = sidebar.locator("button").filter({
		has: sidebar.locator("svg.lucide-fold-vertical"),
	})
	await expect(compactButton).toBeVisible({ timeout: 30_000 })
	await compactButton.click()
	await expect(sidebar.getByText("Compact the current task?", { exact: true })).toBeVisible()
	await sidebar.getByTitle("Yes, compact the task").click()
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

async function seedCanonicalToolRound(dlineDocsDir: string, taskId: string, scenario: PairingScenario): Promise<void> {
	const taskDirectory = path.join(dlineDocsDir, "tasks", taskId)
	const now = Date.now()
	const history = [
		{
			role: "user",
			content: [{ type: "text", text: `<task>E2E_COMPACTION_PAIRING_${scenario.id.toUpperCase()}</task>` }],
			ts: now,
		},
		{
			role: "assistant",
			content: scenario.tools.map((tool) => ({
				type: "tool_use",
				function_id: tool.functionId,
				dline_tid: tool.dlineTid,
				name: tool.name,
				input: tool.input,
			})),
			ts: now + 1,
		},
		{
			role: "user",
			content: scenario.tools.map((tool) => ({
				type: "tool_result",
				function_id: tool.functionId,
				dline_tid: tool.dlineTid,
				content: [{ type: "text", text: tool.result }],
			})),
			ts: now + 2,
		},
	]
	await writeFile(
		path.join(taskDirectory, "api_conversation_history.jsonl"),
		`${history.map((message) => JSON.stringify(message)).join("\n")}\n`,
		"utf8",
	)

	const snapshotPath = path.join(taskDirectory, "snapshot.json")
	const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as PersistedRecord
	const turnId = `turn:e2e-compaction-pairing:${scenario.id}`
	snapshot.phase = "between_turns"
	snapshot.apiIndex = 1
	snapshot.revision = typeof snapshot.revision === "number" ? snapshot.revision + 1 : 1
	snapshot.anchor = { apiIndex: 1, turnId }
	snapshot.turn = {
		turnId,
		assistantApiIndex: 1,
		mode: scenario.tools.length > 1 ? "parallel" : "serial",
		blocks: scenario.tools.map((tool) => ({
			dlineTid: tool.dlineTid,
			functionId: tool.functionId,
			toolName: tool.name,
			phase: "completed",
		})),
	}
	for (const key of [
		"interaction",
		"interruptedInteraction",
		"cancellation",
		"completion",
		"runtimeError",
		"error",
		"awaiting",
		"approval",
		"execution",
		"resume",
	]) {
		delete snapshot[key]
	}
	await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8")
}

function expectCompletePairing(consumption: MockApiConsumption, scenario: { label: string }): void {
	const pairing = consumption.requestToolPairing
	const diagnostic = JSON.stringify(
		{
			scenario: scenario.label,
			responseType: consumption.responseType,
			contractError: consumption.contractError,
			pairing,
		},
		null,
		2,
	)
	expect(pairing.missingOutputIds, diagnostic).toEqual([])
	expect(pairing.orphanOutputIds, diagnostic).toEqual([])
	expect(pairing.duplicateCallIds, diagnostic).toEqual([])
	expect(pairing.duplicateOutputIds, diagnostic).toEqual([])
	expect(pairing.complete, diagnostic).toBe(true)
	expect(consumption.contractError, diagnostic).toBeUndefined()
}

for (const scenario of turnEndScenarios) {
	e2e(
		`Compaction tool pairing - ${scenario.label} keeps every Provider call paired with exactly one output`,
		async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
			e2e.setTimeout(180_000)
			e2e.fail(
				scenario.knownSplitRegression,
				"Known regression: tagged Turn-end feedback is indexed after its matching call, so the hidden Pass can contain a call without output.",
			)
			await configureManualCompaction(dlineDir)
			server.resetOpenAiMock()
			const pauseText = `E2E_COMPACTION_PAIRING_PAUSE_${scenario.id.toUpperCase()}`
			server.enqueueResponses(
				"openai-compatible-responses",
				{
					type: "tool",
					id: `call_pairing_turn_end_${scenario.id}`,
					name: scenario.tool.name,
					arguments: scenario.tool.arguments,
				},
				{
					type: "tool",
					id: `call_pairing_pause_${scenario.id}`,
					name: "qna_respond",
					arguments: { response: pauseText },
					expectedToolResults: [{ callId: `call_pairing_turn_end_${scenario.id}`, contentIncludes: scenario.feedback }],
				},
				{
					type: "message",
					text: `<thinking>Validate canonical tool pairing.</thinking><summarize_task><context>E2E_TURN_END_PAIRING_SUMMARY_${scenario.id.toUpperCase()}</context></summarize_task>`,
					expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER],
					requireCompleteToolPairing: true,
				},
			)

			const app = await openVSCode(workspaceDir)
			try {
				const { sidebar } = await openSidebar(app, helper)
				await submitText(sidebar, scenario.initialTaskText)
				await expect(sidebar.getByText(scenario.tool.visibleText, { exact: false }).last()).toBeVisible({
					timeout: 60_000,
				})
				await submitTurnEndFeedback(sidebar, scenario)
				await expect(sidebar.getByText(pauseText, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
				await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(2)
				await triggerTaskHeaderCompaction(sidebar)
				await expect.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 90_000 }).toBe(3)

				const compactionRequest = server.getMockConsumptions("openai-compatible-responses")[2]
				expect(compactionRequest, "The hidden compaction request was not captured").toBeDefined()
				expectCompletePairing(compactionRequest, scenario)
				await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
			} finally {
				await app.close()
			}
		},
	)
}

for (const scenario of [...recoveredTurnEndScenarios, ...ordinaryScenarios]) {
	e2e(
		`Compaction tool pairing - ${scenario.label} keeps every Provider call paired with exactly one output`,
		async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
			e2e.setTimeout(240_000)
			e2e.fail(
				scenario.knownSplitRegression === true,
				"Known recovered-history regression: the hidden Pass contains a function call without its canonical output.",
			)
			await configureManualCompaction(dlineDir)
			server.resetOpenAiMock()
			const taskText = `E2E_COMPACTION_PAIRING_SETUP_${scenario.id.toUpperCase()}`
			server.enqueueResponses(
				"openai-compatible-responses",
				{
					type: "tool",
					id: `call_pairing_setup_${scenario.id}`,
					name: "qna_respond",
					arguments: { response: `E2E_COMPACTION_PAIRING_READY_${scenario.id.toUpperCase()}` },
				},
				{
					type: "message",
					text: `<thinking>Validate canonical tool pairing.</thinking><summarize_task><context>E2E_ORDINARY_PAIRING_SUMMARY_${scenario.id.toUpperCase()}</context></summarize_task>`,
					expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER],
					requireCompleteToolPairing: true,
				},
			)

			let firstApp: ElectronApplication | undefined
			let resumedApp: ElectronApplication | undefined
			try {
				firstApp = await openVSCode(workspaceDir)
				const first = await openSidebar(firstApp, helper)
				await submitText(first.sidebar, taskText)
				await expect(
					first.sidebar.getByText(`E2E_COMPACTION_PAIRING_READY_${scenario.id.toUpperCase()}`, { exact: false }).last(),
				).toBeVisible({ timeout: 60_000 })
				await closeCurrentTask(first.sidebar)
				await firstApp.close()
				firstApp = undefined
				helper.clearCachedFrame()

				const taskId = await onlyTaskId(dlineDocsDir)
				await seedCanonicalToolRound(dlineDocsDir, taskId, scenario)

				resumedApp = await openVSCode(workspaceDir)
				const resumed = await openSidebar(resumedApp, helper)
				await reopenTask(resumed.page, resumed.sidebar, taskText)
				await triggerTaskHeaderCompaction(resumed.sidebar)
				await expect.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 90_000 }).toBe(2)

				const compactionRequest = server.getMockConsumptions("openai-compatible-responses")[1]
				expect(compactionRequest, "The hidden compaction request was not captured").toBeDefined()
				expectCompletePairing(compactionRequest, scenario)
				await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
			} finally {
				await firstApp?.close()
				await resumedApp?.close()
			}
		},
	)
}
