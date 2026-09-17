import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame } from "@playwright/test"
import { parseTaskCapabilityToggles } from "@shared/TaskCapabilityToggles"

interface StoredSettings {
	__settingsMigrationVersion?: number
	globalClineRulesToggles?: Record<string, boolean>
	globalSubagentsToggles?: Record<string, boolean>
	[key: string]: unknown
}

const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")
const markerPath = (dlineDir: string, markerName: string) => path.join(dlineDir, "e2e-markers", markerName)

async function updateSettings(dlineDir: string, update: (settings: StoredSettings) => void): Promise<void> {
	const filePath = settingsPath(dlineDir)
	const settings = JSON.parse(await readFile(filePath, "utf8")) as StoredSettings
	update(settings)
	await writeFile(filePath, `${JSON.stringify(settings, null, 2)}\n`, "utf8")
}

async function readRuleToggle(dlineDir: string, rulePath: string): Promise<boolean | undefined> {
	const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as StoredSettings
	return settings.globalClineRulesToggles?.[rulePath]
}

async function readSubagentToggle(dlineDir: string, subagentPath: string): Promise<boolean | undefined> {
	const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as StoredSettings
	return settings.globalSubagentsToggles?.[subagentPath]
}

async function onlyTaskId(dlineDocsDir: string): Promise<string> {
	const entries = await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true })
	const taskIds = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
	expect(taskIds).toHaveLength(1)
	return taskIds[0]
}

function taskResourceId(filePath: string): string {
	return process.platform === "win32"
		? filePath.replace(/^([A-Z]):/, (_, drive: string) => `${drive.toLowerCase()}:`)
		: filePath
}

async function readTaskWorkflowToggle(dlineDocsDir: string, taskId: string, workflowPath: string): Promise<boolean | undefined> {
	const settings = JSON.parse(await readFile(path.join(dlineDocsDir, "tasks", taskId, "settings.json"), "utf8")) as {
		taskCapabilityToggles?: string
	}
	return parseTaskCapabilityToggles(settings.taskCapabilityToggles)?.localWorkflowToggles[taskResourceId(workflowPath)]
}

async function waitForMarker(dlineDir: string, markerName: string, expected: string): Promise<void> {
	await expect
		.poll(async () => readFile(markerPath(dlineDir, markerName), "utf8").catch(() => ""), { timeout: 30_000 })
		.toBe(expected)
}

async function openCapabilities(sidebar: Frame): Promise<void> {
	await sidebar.getByRole("button", { name: "Show Dline Rules & Workflows", exact: true }).first().click()
	await expect(sidebar.getByTestId("capabilities-popup")).toBeVisible()
}

function capabilitySwitch(sidebar: Frame, sectionName: string, resourceName: string) {
	return sidebar
		.getByText(sectionName, { exact: true })
		.locator("..")
		.getByText(resourceName, { exact: true })
		.locator("xpath=ancestor::div[contains(@class, 'mb-2.5')][1]")
		.getByRole("switch")
}

const delayedRefresh = (method: "refreshRules" | "refreshSubagents", occurrence: number, markerName: string) =>
	JSON.stringify({
		action: "delay",
		service: "dline.FileService",
		method,
		occurrence,
		delayMs: 2_250,
		markerName,
	})

const delayedToggleRequest = (method: "toggleSubagent", occurrence: number, markerName: string) =>
	JSON.stringify({
		action: "delayRequest",
		service: "dline.FileService",
		method,
		occurrence,
		delayMs: 1_500,
		markerName,
	})

const delayedTaskSettingsRequest = (occurrence: number, markerName: string) =>
	JSON.stringify({
		action: "delayRequest",
		service: "dline.StateService",
		method: "updateTaskSettings",
		occurrence,
		delayMs: 8_000,
		markerName,
	})

e2e.describe("Global toggle persistence regressions", () => {
	e2e.use({ isolateOsHome: true })

	e2e.describe("Dline version upgrade startup", () => {
		const markerName = "upgrade-empty-scan"
		e2e.use({ grpcUnaryFaults: delayedRefresh("refreshRules", 1, markerName) })

		e2e(
			"preserves a disabled global rule when the first new-version scan is temporarily empty",
			async ({ dlineDir, dlineDocsDir, helper, openVSCode, userDataDir, workspaceDir }) => {
				e2e.setTimeout(180_000)
				const ruleName = "e2e-upgrade-transient-rule.md"
				const rulePath = path.join(dlineDocsDir, "rules", ruleName)
				await mkdir(path.dirname(rulePath), { recursive: true })
				await updateSettings(dlineDir, (settings) => {
					settings.__settingsMigrationVersion = 2
					settings.globalClineRulesToggles = { [rulePath]: false }
				})

				const app = await openVSCode(workspaceDir)
				try {
					const page = await app.firstWindow()
					await E2ETestHelper.openClineSidebar(page)
					const sidebar = await helper.getSidebar(page)
					await helper.signin(sidebar)
					await openCapabilities(sidebar)
					await waitForMarker(dlineDir, markerName, "started")

					await writeFile(rulePath, "# Temporarily unavailable during Dline upgrade startup\n", "utf8")
					const toggle = capabilitySwitch(sidebar, "Global Rules", ruleName)
					await expect(toggle).toBeVisible({ timeout: 30_000 })

					expect(await readRuleToggle(dlineDir, rulePath)).toBe(false)
					await expect(toggle).toHaveAttribute("data-state", "unchecked")
					await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
				} finally {
					await app.close()
				}
			},
		)
	})

	e2e.describe("rapid inverse durable toggle commits", () => {
		const markerName = "rapid-inverse-subagent-toggle"
		e2e.use({ grpcUnaryFaults: delayedToggleRequest("toggleSubagent", 1, markerName) })

		e2e(
			"persists the newest global subagent intent when an older request reaches the handler later",
			async ({ dlineDir, dlineDocsDir, helper, openVSCode, userDataDir, workspaceDir }) => {
				e2e.setTimeout(180_000)
				const subagentName = "e2e-rapid-inverse-subagent"
				const subagentPath = path.join(dlineDocsDir, "subagents", `${subagentName}.yml`)
				await mkdir(path.dirname(subagentPath), { recursive: true })
				await writeFile(
					subagentPath,
					`---\nname: ${subagentName}\ndescription: Latest toggle intent must win\ntools: []\n---\n\nRemain enabled.\n`,
					"utf8",
				)
				await updateSettings(dlineDir, (settings) => {
					settings.__settingsMigrationVersion = 2
					settings.globalSubagentsToggles = { [subagentPath]: true }
				})

				const app = await openVSCode(workspaceDir)
				try {
					const page = await app.firstWindow()
					await E2ETestHelper.openClineSidebar(page)
					const sidebar = await helper.getSidebar(page)
					await helper.signin(sidebar)
					await openCapabilities(sidebar)
					await sidebar.getByRole("button", { name: "Subagents", exact: true }).click()
					const toggle = capabilitySwitch(sidebar, "Global Subagents", subagentName)
					await expect(toggle).toHaveAttribute("data-state", "checked", { timeout: 30_000 })

					await toggle.click()
					await waitForMarker(dlineDir, markerName, "started")
					await expect(toggle).toHaveAttribute("data-state", "unchecked", { timeout: 400 })
					await toggle.click()
					await expect(toggle).toHaveAttribute("data-state", "checked", { timeout: 400 })
					await waitForMarker(dlineDir, markerName, "released")
					await expect.poll(() => readSubagentToggle(dlineDir, subagentPath)).toBe(true)
					await expect(toggle).toHaveAttribute("data-state", "checked")
					await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
				} finally {
					await app.close()
				}
			},
		)
	})

	e2e.describe("slow durable toggle commit", () => {
		const markerName = "slow-subagent-toggle"
		e2e.use({ grpcUnaryFaults: delayedToggleRequest("toggleSubagent", 1, markerName) })

		e2e(
			"keeps a global subagent switch disabled while its durable commit is delayed",
			async ({ dlineDir, dlineDocsDir, helper, openVSCode, userDataDir, workspaceDir }) => {
				e2e.setTimeout(180_000)
				const subagentName = "e2e-stale-refresh-subagent"
				const subagentPath = path.join(dlineDocsDir, "subagents", `${subagentName}.yml`)
				await mkdir(path.dirname(subagentPath), { recursive: true })
				await writeFile(
					subagentPath,
					`---\nname: ${subagentName}\ndescription: Toggle must not rebound\ntools: []\n---\n\nRemain disabled.\n`,
					"utf8",
				)
				await updateSettings(dlineDir, (settings) => {
					settings.__settingsMigrationVersion = 2
					settings.globalSubagentsToggles = { [subagentPath]: true }
				})

				const app = await openVSCode(workspaceDir)
				try {
					const page = await app.firstWindow()
					await E2ETestHelper.openClineSidebar(page)
					const sidebar = await helper.getSidebar(page)
					await helper.signin(sidebar)
					await openCapabilities(sidebar)
					await sidebar.getByRole("button", { name: "Subagents", exact: true }).click()
					const toggle = capabilitySwitch(sidebar, "Global Subagents", subagentName)
					await expect(toggle).toHaveAttribute("data-state", "checked", { timeout: 30_000 })

					await toggle.click()
					await waitForMarker(dlineDir, markerName, "started")
					await expect(toggle).toHaveAttribute("data-state", "unchecked", { timeout: 400 })
					await waitForMarker(dlineDir, markerName, "released")
					await expect.poll(() => readSubagentToggle(dlineDir, subagentPath)).toBe(false)
					await expect(toggle).toHaveAttribute("data-state", "unchecked")
					expect(await readSubagentToggle(dlineDir, subagentPath)).toBe(false)
					await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
				} finally {
					await app.close()
				}
			},
		)
	})
})

e2e.describe("Task-scoped toggle persistence regressions", () => {
	const markerName = "task-reconcile-toggle-write"
	e2e.use({
		grpcUnaryFaults: delayedTaskSettingsRequest(1, markerName),
		isolateOsHome: true,
	})

	e2e(
		"preserves a newer task-scoped workflow toggle while discovery persistence is delayed",
		async ({ dlineDir, dlineDocsDir, helper, server, sidebar, userDataDir, workspaceDir }) => {
			e2e.setTimeout(180_000)
			await helper.signin(sidebar)
			server.resetOpenAiMock()
			server.enqueueOpenAiResponses({
				type: "tool",
				name: "attempt_completion",
				arguments: { result: "E2E_TASK_RECONCILE_TOGGLE_READY" },
			})

			const input = sidebar.getByTestId("chat-input")
			await input.fill("Create a completed task before reconciling a new workspace workflow.")
			await sidebar.getByTestId("send-button").click()
			await expect(sidebar.getByText("E2E_TASK_RECONCILE_TOGGLE_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			const taskId = await onlyTaskId(dlineDocsDir)
			const workflowName = "e2e-task-reconcile-race.md"
			const workflowPath = path.join(workspaceDir, ".agents", "workflows", workflowName)
			await mkdir(path.dirname(workflowPath), { recursive: true })
			await writeFile(
				workflowPath,
				"---\nname: e2e-task-reconcile-race\ndescription: Exercise task snapshot write ordering\n---\n\nRemain disabled.\n",
				"utf8",
			)

			await openCapabilities(sidebar)
			await sidebar.getByRole("button", { name: "Workflows", exact: true }).click()
			await waitForMarker(dlineDir, markerName, "started")
			const toggle = capabilitySwitch(sidebar, "Workspace Workflows", workflowName)
			await expect(toggle).toHaveAttribute("data-state", "checked", { timeout: 30_000 })
			await toggle.click()
			await expect(toggle).toHaveAttribute("data-state", "unchecked", { timeout: 400 })
			await waitForMarker(dlineDir, markerName, "released")
			await expect.poll(() => readTaskWorkflowToggle(dlineDocsDir, taskId, workflowPath)).toBe(false)
			await expect(toggle).toHaveAttribute("data-state", "unchecked")
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		},
	)
})
