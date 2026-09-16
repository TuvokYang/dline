import { readdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { expect, type Frame, type Page } from "@playwright/test"
import type { ElectronApplication } from "playwright"
import { E2E_PROFILE_NAMES } from "./utils/api-profile"
import { E2ETestHelper, e2e } from "./utils/helpers"

interface StoredTaskSettings {
	mode?: string
	planModeProfile?: string
	actModeProfile?: string
}

interface StoredTaskSnapshot {
	phase?: string
	newTaskConsumed?: {
		functionId?: string
		dlineTid?: string
	}
}

async function configurePlanModeProfiles(dlineDir: string): Promise<void> {
	const settingsPath = path.join(dlineDir, "data", "settings", "settings.json")
	const settings = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>
	await writeFile(
		settingsPath,
		`${JSON.stringify(
			{
				...settings,
				mode: "plan",
				planActSeparateModelsSetting: true,
				planModeProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
				actModeProfile: E2E_PROFILE_NAMES.mockDeepSeek,
			},
			null,
			2,
		)}\n`,
		"utf8",
	)

	const globalStatePath = path.join(dlineDir, "data", "globalState.json")
	const globalState = JSON.parse(await readFile(globalStatePath, "utf8")) as Record<string, unknown>
	await writeFile(globalStatePath, `${JSON.stringify({ ...globalState, mode: "plan" }, null, 2)}\n`, "utf8")

	const profilesPath = path.join(dlineDir, "data", "settings", "api_profiles.json")
	const profiles = JSON.parse(await readFile(profilesPath, "utf8")) as Array<Record<string, unknown>>
	for (const profile of profiles) {
		if (profile.name === E2E_PROFILE_NAMES.mockOpenAiResponses || profile.name === E2E_PROFILE_NAMES.mockDeepSeek) {
			profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
		}
	}
	await writeFile(profilesPath, `${JSON.stringify(profiles, null, 2)}\n`, "utf8")
}

async function openSignedInSidebar(app: ElectronApplication, helper: E2ETestHelper): Promise<{ page: Page; sidebar: Frame }> {
	const page = await app.firstWindow()
	await E2ETestHelper.openClineSidebar(page)
	const sidebar = await helper.getSidebar(page)
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	await helper.signin(sidebar)
	return { page, sidebar }
}

async function taskIds(dlineDocsDir: string): Promise<string[]> {
	const entries = await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true }).catch(() => [])
	return entries
		.filter((entry) => entry.isDirectory())
		.map((entry) => entry.name)
		.sort()
}

async function readTaskSettings(dlineDocsDir: string, taskId: string): Promise<StoredTaskSettings> {
	return JSON.parse(await readFile(path.join(dlineDocsDir, "tasks", taskId, "settings.json"), "utf8"))
}

async function readTaskSnapshot(dlineDocsDir: string, taskId: string): Promise<StoredTaskSnapshot> {
	return JSON.parse(await readFile(path.join(dlineDocsDir, "tasks", taskId, "snapshot.json"), "utf8"))
}

async function expectInheritedTaskSettings(dlineDocsDir: string, taskId: string): Promise<void> {
	await expect
		.poll(
			async () => {
				try {
					const settings = await readTaskSettings(dlineDocsDir, taskId)
					return {
						mode: settings.mode,
						planModeProfile: settings.planModeProfile,
						actModeProfile: settings.actModeProfile,
					}
				} catch {
					return undefined
				}
			},
			{ timeout: 30_000 },
		)
		.toEqual({
			mode: "plan",
			planModeProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
			actModeProfile: E2E_PROFILE_NAMES.mockDeepSeek,
		})
}

async function expectConsumedTaskSnapshot(dlineDocsDir: string, taskId: string, functionId: string): Promise<void> {
	await expect
		.poll(
			async () => {
				try {
					const snapshot = await readTaskSnapshot(dlineDocsDir, taskId)
					return {
						phase: snapshot.phase,
						functionId: snapshot.newTaskConsumed?.functionId,
						hasDlineTid: Boolean(snapshot.newTaskConsumed?.dlineTid),
					}
				} catch {
					return undefined
				}
			},
			{ timeout: 30_000 },
		)
		.toEqual({ phase: "aborted", functionId, hasDlineTid: true })
}

async function sendTask(frame: Frame, text: string): Promise<void> {
	const input = frame.getByTestId("chat-input")
	await expect(input).toBeEnabled({ timeout: 60_000 })
	await input.fill(text)
	await input.press("Enter")
	await expect(input).toHaveValue("")
	await expect(frame.getByText(text, { exact: true }).last()).toBeVisible()
}

async function submitNewTaskFeedback(frame: Frame, text: string, action: "button" | "enter"): Promise<void> {
	const input = frame.getByTestId("chat-input")
	const regenerateContext = frame.locator('vscode-button[aria-label="Regenerate Context"]')
	await expect(input).toBeEnabled({ timeout: 60_000 })
	await expect(regenerateContext).toBeEnabled({ timeout: 60_000 })
	await input.fill(text)
	if (action === "button") {
		await regenerateContext.click()
	} else {
		await input.press("Enter")
	}
	await expect(input).toHaveValue("")
	await expect(frame.getByTestId(/^(?:user|queued)-input-markdown-scroll$/).filter({ hasText: text })).toHaveCount(1)
}

async function expectNoDecisionButtons(frame: Frame): Promise<void> {
	const footer = frame.getByRole("contentinfo")
	for (const label of ["Resume", "Start New Task", "Regenerate Context", "Approve", "Reject"]) {
		await expect(footer.getByText(label, { exact: true })).toHaveCount(0)
	}
}

async function findAdditionalDlineFrame(page: Page, existingFrames: ReadonlySet<Frame>): Promise<Frame> {
	let resolved: Frame | undefined
	await expect
		.poll(
			async () => {
				for (const frame of page.frames()) {
					if (existingFrames.has(frame) || frame.isDetached() || !frame.url().startsWith("vscode-webview://")) {
						continue
					}
					if ((await frame.locator("#root").count()) > 0) {
						resolved = frame
						return true
					}
				}
				return false
			},
			{ timeout: 30_000 },
		)
		.toBe(true)
	if (!resolved) throw new Error("Dline editor panel frame was not created")
	return resolved
}

async function createDlinePanel(page: Page): Promise<Frame> {
	const existingFrames = new Set(page.frames())
	await page.getByRole("button", { name: "New Task", exact: true }).click()
	const panel = await findAdditionalDlineFrame(page, existingFrames)
	await E2ETestHelper.dismissWhatsNewModal(panel)
	return panel
}

function editorWebviewCount(page: Page, sidebar: Frame): number {
	return page.frames().filter((frame) => frame !== sidebar && frame.url().startsWith("vscode-webview://")).length
}

e2e(
	"New Task handoff - Sidebar carries submitted feedback and settings while consumed history stays inert",
	async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(240_000)
		await configurePlanModeProfiles(dlineDir)

		const originalTask = "/newtask E2E_NEW_TASK_SIDEBAR_SOURCE"
		const firstContext = "E2E_NEW_TASK_SIDEBAR_CONTEXT_DRAFT"
		const feedback = "E2E_NEW_TASK_SIDEBAR_FEEDBACK_KEEP_COMPATIBILITY"
		const successorContext = "E2E_NEW_TASK_SIDEBAR_SUCCESSOR_CONTEXT"
		const unsentDraft = "E2E_NEW_TASK_SIDEBAR_UNSENT_DRAFT"
		const successorReady = "E2E_NEW_TASK_SIDEBAR_SUCCESSOR_READY"
		const approvedToolId = "call_new_task_sidebar_approved"

		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_new_task_sidebar_initial",
				name: "new_task",
				arguments: { context: firstContext },
				expectedRequestIncludes: ["E2E_NEW_TASK_SIDEBAR_SOURCE", 'explicit_instructions type=\\"new_task\\"'],
			},
			{
				type: "tool",
				id: approvedToolId,
				name: "new_task",
				arguments: { context: successorContext },
				expectedRequestIncludes: [feedback, "dline:new-task-feedback:v1"],
				expectedToolResults: [
					{
						callId: "call_new_task_sidebar_initial",
						contentIncludes: [feedback, "dline:new-task-feedback:v1"],
					},
				],
			},
			{
				type: "tool",
				id: "call_new_task_sidebar_successor_ready",
				name: "qna_respond",
				arguments: { response: successorReady },
				expectedRequestIncludes: [successorContext, `<feedback>\\n${feedback}\\n</feedback>`],
				expectedRequestExcludes: ["E2E_NEW_TASK_SIDEBAR_SOURCE", firstContext, unsentDraft],
				expectedToolResultCount: 0,
			},
			{
				type: "error",
				status: 500,
				code: "unexpected_consumed_new_task_replay",
				message: "A consumed New Task round was replayed",
			},
		)

		const app = await openVSCode(workspaceDir)
		try {
			const { page, sidebar } = await openSignedInSidebar(app, helper)
			await expect(sidebar.getByRole("switch", { name: "Plan" })).toHaveAttribute("aria-checked", "true")
			await expect(sidebar.getByRole("button", { name: "Select model" })).toHaveText(E2E_PROFILE_NAMES.mockOpenAiResponses)

			await sendTask(sidebar, originalTask)
			await expect(sidebar.getByText(firstContext, { exact: true })).toBeVisible({ timeout: 60_000 })
			const [oldTaskId] = await E2ETestHelper.waitForValue(async () => {
				const ids = await taskIds(dlineDocsDir)
				return ids.length === 1 ? ids : undefined
			}, 30_000)
			if (!oldTaskId) throw new Error("Source Task ID was not persisted")
			await expectInheritedTaskSettings(dlineDocsDir, oldTaskId)

			await submitNewTaskFeedback(sidebar, feedback, "button")
			await expect(sidebar.getByText(successorContext, { exact: true })).toBeVisible({ timeout: 60_000 })
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(2)

			const input = sidebar.getByTestId("chat-input")
			await input.fill(unsentDraft)
			await sidebar.locator('vscode-button[aria-label="Start New Task"]').click()
			await expect(sidebar.getByText(successorReady, { exact: true })).toBeVisible({ timeout: 60_000 })
			await expect(input).toHaveValue(unsentDraft)
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(3)

			const successorTaskId = await E2ETestHelper.waitForValue(async () => {
				const ids = await taskIds(dlineDocsDir)
				return ids.length === 2 ? ids.find((id) => id !== oldTaskId) : undefined
			}, 30_000)
			expect(successorTaskId).not.toBe(oldTaskId)
			await expectInheritedTaskSettings(dlineDocsDir, successorTaskId)
			await expectConsumedTaskSnapshot(dlineDocsDir, oldTaskId, approvedToolId)

			const oldApiHistory = await readFile(
				path.join(dlineDocsDir, "tasks", oldTaskId, "api_conversation_history.jsonl"),
				"utf8",
			)
			const successorApiHistory = await readFile(
				path.join(dlineDocsDir, "tasks", successorTaskId, "api_conversation_history.jsonl"),
				"utf8",
			)
			expect(oldApiHistory).toContain(approvedToolId)
			expect(oldApiHistory).toContain(feedback)
			expect(successorApiHistory).toContain(successorContext)
			expect(successorApiHistory).toContain(feedback)
			expect(successorApiHistory).not.toContain("E2E_NEW_TASK_SIDEBAR_SOURCE")
			expect(successorApiHistory).not.toContain(unsentDraft)

			await sidebar.getByRole("button", { name: "Close Task", exact: true }).click()
			await page.getByRole("button", { name: "History", exact: true }).click()
			await E2ETestHelper.dismissWhatsNewModal(sidebar)
			const oldHistoryItem = sidebar.locator(".history-item").filter({ hasText: "E2E_NEW_TASK_SIDEBAR_SOURCE" })
			await expect(oldHistoryItem).toHaveCount(1)
			await oldHistoryItem.click()
			await expect(sidebar.getByText(originalTask, { exact: true }).first()).toBeVisible({ timeout: 30_000 })
			await expect(sidebar.getByText(feedback, { exact: true }).last()).toBeVisible()
			await expectNoDecisionButtons(sidebar)
			// Reopening a consumed historical Task is intentionally inert. Give the extension
			// one stabilization interval so an accidental deferred Provider replay is observable.
			await page.waitForTimeout(1_000)
			expect(server.getRequestCount("openai-compatible-responses")).toBe(3)
			expect(
				server.getMockConsumptions("openai-compatible-responses").every((entry) => entry.contractError === undefined),
			).toBe(true)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"New Task handoff - Editor Panel starts its successor in place without replacing the Sidebar Task",
	async ({ dlineDir, dlineDocsDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(240_000)
		await configurePlanModeProfiles(dlineDir)

		const sidebarTask = "E2E_NEW_TASK_ISOLATED_SIDEBAR_TASK"
		const sidebarWaiting = "E2E_NEW_TASK_ISOLATED_SIDEBAR_WAITING"
		const panelTask = "/newtask E2E_NEW_TASK_PANEL_SOURCE"
		const firstContext = "E2E_NEW_TASK_PANEL_CONTEXT_DRAFT"
		const feedback = "E2E_NEW_TASK_PANEL_FEEDBACK"
		const successorContext = "E2E_NEW_TASK_PANEL_SUCCESSOR_CONTEXT"
		const successorReady = "E2E_NEW_TASK_PANEL_SUCCESSOR_READY"
		const approvedToolId = "call_new_task_panel_approved"

		server.enqueueResponses("openai-compatible-responses", {
			type: "tool",
			id: "call_new_task_sidebar_waiting",
			name: "qna_respond",
			arguments: { response: sidebarWaiting },
			expectedRequestIncludes: [sidebarTask],
		})

		const app = await openVSCode(workspaceDir)
		try {
			const { page, sidebar } = await openSignedInSidebar(app, helper)
			await sendTask(sidebar, sidebarTask)
			await expect(sidebar.getByText(sidebarWaiting, { exact: true })).toBeVisible({ timeout: 60_000 })
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(1)
			const [sidebarTaskId] = await E2ETestHelper.waitForValue(async () => {
				const ids = await taskIds(dlineDocsDir)
				return ids.length === 1 ? ids : undefined
			}, 30_000)
			if (!sidebarTaskId) throw new Error("Sidebar Task ID was not persisted")

			const panel = await createDlinePanel(page)
			const editorFramesBeforeHandoff = editorWebviewCount(page, sidebar)
			await expect(panel.getByRole("switch", { name: "Plan" })).toHaveAttribute("aria-checked", "true")
			server.enqueueResponses("openai-compatible-responses", {
				type: "tool",
				id: "call_new_task_panel_initial",
				name: "new_task",
				arguments: { context: firstContext },
				expectedRequestIncludes: ["E2E_NEW_TASK_PANEL_SOURCE", 'explicit_instructions type=\\"new_task\\"'],
			})
			await sendTask(panel, panelTask)
			await expect(panel.getByText(firstContext, { exact: true })).toBeVisible({ timeout: 60_000 })
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(2)
			const oldPanelTaskId = await E2ETestHelper.waitForValue(async () => {
				const ids = await taskIds(dlineDocsDir)
				return ids.length === 2 ? ids.find((id) => id !== sidebarTaskId) : undefined
			}, 30_000)

			server.enqueueResponses("openai-compatible-responses", {
				type: "tool",
				id: approvedToolId,
				name: "new_task",
				arguments: { context: successorContext },
				expectedRequestIncludes: [feedback, "dline:new-task-feedback:v1"],
				expectedToolResults: [
					{
						callId: "call_new_task_panel_initial",
						contentIncludes: [feedback, "dline:new-task-feedback:v1"],
					},
				],
			})
			await submitNewTaskFeedback(panel, feedback, "enter")
			await expect(panel.getByText(successorContext, { exact: true })).toBeVisible({ timeout: 60_000 })
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(3)
			server.enqueueResponses("openai-compatible-responses", {
				type: "tool",
				id: "call_new_task_panel_successor_ready",
				name: "qna_respond",
				arguments: { response: successorReady },
				expectedRequestIncludes: [successorContext, `<feedback>\\n${feedback}\\n</feedback>`],
				expectedRequestExcludes: ["E2E_NEW_TASK_PANEL_SOURCE", firstContext],
				expectedToolResultCount: 0,
			})
			await panel.locator('vscode-button[aria-label="Start New Task"]').click()
			await expect(panel.getByText(successorReady, { exact: true })).toBeVisible({ timeout: 60_000 })
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(4)

			const successorTaskId = await E2ETestHelper.waitForValue(async () => {
				const ids = await taskIds(dlineDocsDir)
				return ids.length === 3 ? ids.find((id) => id !== sidebarTaskId && id !== oldPanelTaskId) : undefined
			}, 30_000)
			expect(successorTaskId).not.toBe(oldPanelTaskId)
			expect(successorTaskId).not.toBe(sidebarTaskId)
			await expectInheritedTaskSettings(dlineDocsDir, successorTaskId)
			await expectConsumedTaskSnapshot(dlineDocsDir, oldPanelTaskId, approvedToolId)

			const oldPanelApiHistory = await readFile(
				path.join(dlineDocsDir, "tasks", oldPanelTaskId, "api_conversation_history.jsonl"),
				"utf8",
			)
			const successorApiHistory = await readFile(
				path.join(dlineDocsDir, "tasks", successorTaskId, "api_conversation_history.jsonl"),
				"utf8",
			)
			expect(oldPanelApiHistory).toContain(approvedToolId)
			expect(oldPanelApiHistory).toContain(feedback)
			expect(successorApiHistory).toContain(successorContext)
			expect(successorApiHistory).toContain(feedback)
			expect(successorApiHistory).not.toContain("E2E_NEW_TASK_PANEL_SOURCE")
			expect(successorApiHistory).not.toContain(firstContext)

			expect(panel.isDetached()).toBe(false)
			expect(editorWebviewCount(page, sidebar)).toBe(editorFramesBeforeHandoff)
			await expect(panel.getByText(panelTask, { exact: true })).toHaveCount(0)
			await expect(panel.getByText(sidebarTask, { exact: true })).toHaveCount(0)
			await expect(sidebar.getByText(sidebarTask, { exact: true }).first()).toBeVisible()
			await expect(sidebar.getByText(sidebarWaiting, { exact: true })).toBeVisible()
			await expect(sidebar.getByText(successorReady, { exact: true })).toHaveCount(0)
			await expect(sidebar.getByTestId("chat-input")).toBeEnabled()

			const sidebarSettings = await readTaskSettings(dlineDocsDir, sidebarTaskId)
			expect(sidebarSettings).toMatchObject({
				mode: "plan",
				planModeProfile: E2E_PROFILE_NAMES.mockOpenAiResponses,
				actModeProfile: E2E_PROFILE_NAMES.mockDeepSeek,
			})
			expect(
				server.getMockConsumptions("openai-compatible-responses").every((entry) => entry.contractError === undefined),
			).toBe(true)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)
