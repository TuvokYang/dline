import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { MockApiConsumption } from "@e2e/fixtures/server"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { MultiInstanceLauncher } from "@e2e/utils/multi-instance"
import { expect, type Frame, type Page } from "@playwright/test"

interface StoredSettingsFile {
	subagentsEnabled?: boolean
	mcpEnabled?: boolean
	values?: {
		subagentsEnabled?: boolean
		mcpEnabled?: boolean
	}
}

const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")
const globalStatePath = (dlineDir: string) => path.join(dlineDir, "data", "globalState.json")

async function readStoredSettings(dlineDir: string): Promise<StoredSettingsFile> {
	return JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as StoredSettingsFile
}

async function readSubagentsEnabled(dlineDir: string): Promise<boolean | undefined> {
	const settings = await readStoredSettings(dlineDir)
	return settings.values?.subagentsEnabled ?? settings.subagentsEnabled
}

async function readMcpEnabled(dlineDir: string): Promise<boolean | undefined> {
	const settings = await readStoredSettings(dlineDir)
	return settings.values?.mcpEnabled ?? settings.mcpEnabled
}

async function openFeatureSettings(page: Page, sidebar: Frame): Promise<void> {
	await page.getByRole("button", { name: "Settings", exact: true }).click()
	await expect(sidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible()
	await sidebar.getByTestId("tab-features").click()
	await expect(sidebar.getByRole("heading", { name: "Feature Settings" })).toBeVisible()
}

function subagentsSwitch(sidebar: Frame) {
	return sidebar.locator('[id="Subagents"]')
}

async function setSubagentsEnabled(page: Page, sidebar: Frame, enabled: boolean): Promise<void> {
	await openFeatureSettings(page, sidebar)
	const toggle = subagentsSwitch(sidebar)
	await expect(toggle).toBeVisible()
	if ((await toggle.getAttribute("aria-checked")) !== String(enabled)) {
		await toggle.click()
	}
	await expect(toggle).toHaveAttribute("aria-checked", String(enabled))
	await sidebar.getByRole("button", { name: "Done", exact: true }).click()
	await expect(sidebar.getByTestId("chat-input")).toBeVisible()
}

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled()
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

function capabilityRow(sidebar: Frame, name: string) {
	return sidebar.getByText(name, { exact: true }).locator("xpath=ancestor::div[contains(@class, 'mb-2.5')][1]")
}

async function openSubagentCapabilityTab(sidebar: Frame): Promise<void> {
	const openButton = sidebar.getByRole("button", { name: "Show Dline Rules & Workflows", exact: true }).first()
	if (await openButton.isVisible()) await openButton.click()
	await expect(sidebar.getByRole("button", { name: "Hide Dline Rules & Workflows", exact: true }).first()).toBeVisible()
	const tab = sidebar.getByRole("button", { name: "Subagents", exact: true })
	await tab.click()
	await expect(tab).toHaveAttribute("aria-pressed", "true")
}

async function setNamedSubagentToggle(sidebar: Frame, name: string, enabled: boolean): Promise<void> {
	const row = capabilityRow(sidebar, name)
	const toggle = row.getByRole("switch")
	await expect(toggle).toHaveCount(1)
	if ((await toggle.getAttribute("data-state")) !== (enabled ? "checked" : "unchecked")) {
		await toggle.click()
	}
	await expect(toggle).toHaveAttribute("data-state", enabled ? "checked" : "unchecked")
}

async function captureSubagentCapabilityPopup(sidebar: Frame, name: string): Promise<void> {
	const popup = sidebar.getByTestId("capabilities-popup")
	await expect(popup).toBeVisible()
	const screenshotPath = e2e.info().outputPath(name)
	await popup.screenshot({ path: screenshotPath })
	await e2e.info().attach(name, { path: screenshotPath, contentType: "image/png" })
}

function requestToolNames(consumption: MockApiConsumption): string[] {
	const body = consumption.requestBody as {
		tools?: Array<{ name?: string; function?: { name?: string } }>
	}
	return (body.tools ?? [])
		.map((tool) => tool.name ?? tool.function?.name)
		.filter((name): name is string => typeof name === "string")
}

e2e(
	"Subagent feature toggle - semi-fresh canonical Settings uses the declared enabled default instead of stale legacy false",
	async ({ dlineDir, helper, openVSCode, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		const settings = await readStoredSettings(dlineDir)
		delete settings.subagentsEnabled
		if (settings.values) delete settings.values.subagentsEnabled
		await writeFile(settingsPath(dlineDir), `${JSON.stringify(settings, null, 2)}\n`, "utf8")

		const legacyGlobalState = JSON.parse(await readFile(globalStatePath(dlineDir), "utf8")) as Record<string, unknown>
		legacyGlobalState.subagentsEnabled = false
		await writeFile(globalStatePath(dlineDir), `${JSON.stringify(legacyGlobalState, null, 2)}\n`, "utf8")

		const app = await openVSCode(workspaceDir)
		try {
			const page = await app.firstWindow()
			await E2ETestHelper.openClineSidebar(page)
			const sidebar = await helper.getSidebar(page)
			await helper.signin(sidebar)
			await openFeatureSettings(page, sidebar)

			await expect(subagentsSwitch(sidebar)).toHaveAttribute("aria-checked", "true")
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app.close()
		}
	},
)

e2e(
	"Subagent feature toggle - enabling inside an active task advertises and executes use_subagent on the next request",
	async ({ dlineDir, helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		await setSubagentsEnabled(page, sidebar, false)
		await expect.poll(() => readSubagentsEnabled(dlineDir)).toBe(false)

		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_subagent_toggle_ready",
				name: "qna_respond",
				arguments: { response: "E2E_SUBAGENT_TOGGLE_READY" },
			},
			{
				type: "tool",
				id: "call_subagent_after_enable",
				name: "use_subagent",
				arguments: {
					agent_name: "default",
					task: "E2E_SUBAGENT_AFTER_ENABLE_CHILD",
					context: "Return the requested child marker.",
					timeout: 60,
				},
			},
			{
				type: "tool",
				id: "call_subagent_after_enable_child_complete",
				name: "attempt_completion",
				arguments: { result: "E2E_SUBAGENT_AFTER_ENABLE_CHILD_DONE" },
			},
			{
				type: "tool",
				id: "call_subagent_after_enable_parent_complete",
				name: "attempt_completion",
				arguments: { result: "E2E_SUBAGENT_AFTER_ENABLE_DONE" },
				expectedToolResults: [
					{
						callId: "call_subagent_after_enable",
						contentIncludes: "E2E_SUBAGENT_AFTER_ENABLE_CHILD_DONE",
					},
				],
			},
		)

		await sendTask(sidebar, "Create an active task while Subagents are disabled.")
		await expect(sidebar.getByText("E2E_SUBAGENT_TOGGLE_READY", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(1)
		const disabledRequest = server.getMockConsumptions("openai-compatible-chat")[0]
		expect(requestToolNames(disabledRequest)).not.toContain("use_subagent")
		expect(JSON.stringify(disabledRequest.requestBody)).not.toContain(
			"The Subagents available to the current task are listed below:",
		)
		expect(disabledRequest.contractError).toBeUndefined()

		await setSubagentsEnabled(page, sidebar, true)
		await expect.poll(() => readSubagentsEnabled(dlineDir)).toBe(true)

		// A running Task keeps its frozen prompt: changing Settings only marks it
		// stale and offers the refresh control. The new tool set reaches the model
		// once that refresh rebuilds the prompt.
		const refreshButton = sidebar.locator("button:has(svg.lucide-refresh-cw)").first()
		await expect(refreshButton.getByTestId("prompt-freshness-warning")).toBeVisible({ timeout: 30_000 })
		await refreshButton.click()
		const refreshDialog = sidebar.getByRole("dialog")
		await expect(refreshDialog.getByRole("heading", { name: "Refresh Prompt Cache", exact: true })).toBeVisible()
		await refreshDialog.getByRole("button", { name: "Confirm", exact: true }).click()
		await expect(refreshButton.getByTestId("prompt-freshness-warning")).toHaveCount(0, { timeout: 30_000 })
		// Refreshing rebuilds the prompt locally; it must not spend an API request.
		await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(1)

		await sendTask(sidebar, "Use the default subagent now that the feature is enabled.")

		await expect.poll(() => server.getRequestCount("openai-compatible-chat"), { timeout: 60_000 }).toBe(2)
		const enabledRequest = server.getMockConsumptions("openai-compatible-chat")[1]
		expect(requestToolNames(enabledRequest)).toContain("use_subagent")
		expect(enabledRequest.contractError).toBeUndefined()

		await expect(sidebar.getByText("E2E_SUBAGENT_AFTER_ENABLE_DONE", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect(sidebar.getByText(/Native tool 'use_subagent' was not available/, { exact: false })).toHaveCount(0)
		await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(4)
		const consumptions = server.getMockConsumptions("openai-compatible-chat")
		expect(consumptions[3].contractError).toBeUndefined()
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Named YAML subagent - profile-only updates canonicalize persisted tools and enforce completion recovery",
	async ({ helper, page, server, sidebar, userDataDir, workspaceDir }) => {
		e2e.setTimeout(240_000)
		await helper.signin(sidebar)
		await setSubagentsEnabled(page, sidebar, true)

		const agentName = "e2e-completion-contract"
		const customMarker = "E2E_COMPLETION_CONTRACT_CUSTOM"
		const childCompletionMarker = "E2E_COMPLETION_CONTRACT_CHILD_DONE"
		const agentPath = path.join(workspaceDir, ".agents", "subagents", `${agentName}.yml`)
		const originalYaml = `---
name: ${agentName}
description: E2E completion contract agent
tools:
  - read_file
  - attempt_completion
skills: []
---
${customMarker}
Preserve this instruction body exactly.\n`
		await mkdir(path.dirname(agentPath), { recursive: true })
		await writeFile(agentPath, originalYaml, "utf8")

		await openSubagentCapabilityTab(sidebar)
		const row = capabilityRow(sidebar, agentName)
		await expect(row).toBeVisible({ timeout: 30_000 })
		await setNamedSubagentToggle(sidebar, agentName, true)
		await row.locator("button").first().click()

		const profileSelect = row.getByRole("combobox")
		await expect(profileSelect).toBeVisible({ timeout: 30_000 })
		await profileSelect.selectOption({ label: E2E_PROFILE_NAMES.mockOpenAi })
		await expect
			.poll(async () => (await readFile(agentPath, "utf8")).includes(`profile: "${E2E_PROFILE_NAMES.mockOpenAi}"`))
			.toBe(true)

		const updatedYaml = await readFile(agentPath, "utf8")
		const originalBody = originalYaml.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/)?.[1]?.trim()
		const updatedBody = updatedYaml.match(/^---\r?\n[\s\S]*?\r?\n---\r?\n([\s\S]*)$/)?.[1]?.trim()
		// A profile-only save still reconciles the stored list with the
		// persistence policy, which never writes attempt_completion: it is
		// granted unconditionally at resolution, so storing it would present
		// an implicit guarantee as an editable preference. The selected tool
		// survives, and the completion contract is enforced below by the
		// child actually reporting back.
		expect(updatedYaml).toContain("tools:\n  - read_file")
		expect(updatedYaml).not.toContain("- attempt_completion")
		expect(updatedYaml).toContain("skills: []")
		expect(updatedBody).toBe(originalBody)
		expect(updatedYaml).toContain(`profile: "${E2E_PROFILE_NAMES.mockOpenAi}"`)

		await sidebar.getByRole("button", { name: "Hide Dline Rules & Workflows", exact: true }).first().click()
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_completion_contract_parent_subagent",
				name: "use_subagent",
				arguments: {
					agent_name: agentName,
					task: "E2E_COMPLETION_CONTRACT_CHILD_TASK",
					context: "Return the requested child marker.",
					timeout: 60,
				},
			},
			{ type: "message", text: "I have finished the review in plain text." },
			{
				type: "tool",
				id: "call_completion_contract_child_complete",
				name: "attempt_completion",
				arguments: { result: childCompletionMarker },
				expectedRequestIncludes: [
					customMarker,
					"# Required Completion Protocol",
					"Plain assistant text cannot complete a subagent run",
					"Call attempt_completion with a non-empty result",
				],
			},
			{
				type: "tool",
				id: "call_completion_contract_parent_complete",
				name: "attempt_completion",
				arguments: { result: "E2E_COMPLETION_CONTRACT_PARENT_DONE" },
				expectedToolResults: [
					{
						callId: "call_completion_contract_parent_subagent",
						contentIncludes: childCompletionMarker,
					},
				],
			},
		)

		await sendTask(sidebar, "Run the named subagent and enforce its completion protocol.")
		await expect(sidebar.getByText("E2E_COMPLETION_CONTRACT_PARENT_DONE", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(4)

		const consumptions = server.getMockConsumptions("openai-compatible-chat")
		const childInitialRequest = consumptions[1]
		const childRecoveryRequest = consumptions[2]
		expect(childInitialRequest.contractError).toBeUndefined()
		expect(requestToolNames(childInitialRequest)).toContain("attempt_completion")
		expect(JSON.stringify(childInitialRequest.requestBody)).toContain(customMarker)
		expect(JSON.stringify(childInitialRequest.requestBody)).toContain("# Required Completion Protocol")
		expect(JSON.stringify(childInitialRequest.requestBody)).toContain("Plain assistant text cannot complete a subagent run")
		expect(childRecoveryRequest.contractError).toBeUndefined()
		expect(JSON.stringify(childRecoveryRequest.requestBody)).toContain("Call attempt_completion with a non-empty result")
		expect(requestToolNames(childRecoveryRequest)).toContain("attempt_completion")
		expect(consumptions[3].contractError).toBeUndefined()
		await expect(sidebar.getByText(/Native tool 'use_subagent' was not available/, { exact: false })).toHaveCount(0)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Subagent feature toggle - changing Settings marks the active frozen prompt stale without another API request",
	async ({ dlineDir, helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		await setSubagentsEnabled(page, sidebar, false)
		await expect.poll(() => readSubagentsEnabled(dlineDir)).toBe(false)

		server.resetOpenAiMock()
		server.enqueueOpenAiResponses({
			type: "tool",
			id: "call_subagent_freshness_ready",
			name: "attempt_completion",
			arguments: { result: "E2E_SUBAGENT_FRESHNESS_READY" },
		})

		await sendTask(sidebar, "Create a frozen prompt before changing the Subagents setting.")
		await expect(sidebar.getByText("E2E_SUBAGENT_FRESHNESS_READY", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(1)

		const refreshButton = sidebar.locator("button:has(svg.lucide-refresh-cw)").first()
		const freshnessWarning = refreshButton.getByTestId("prompt-freshness-warning")
		await expect(refreshButton).toBeVisible()
		await expect(freshnessWarning).toHaveCount(0)

		await openFeatureSettings(page, sidebar)
		const toggle = subagentsSwitch(sidebar)
		await expect(toggle).toHaveAttribute("aria-checked", "false")
		await toggle.click()
		await expect(toggle).toHaveAttribute("aria-checked", "true")
		await expect.poll(() => readSubagentsEnabled(dlineDir), { timeout: 10_000 }).toBe(true)
		await sidebar.getByRole("button", { name: "Done", exact: true }).click()
		await expect(sidebar.getByTestId("chat-input")).toBeVisible()

		await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(1)
		await expect(freshnessWarning).toBeVisible()
		await refreshButton.hover()
		const freshnessTooltip = sidebar.getByRole("tooltip").filter({ hasText: "Prompt update available" })
		await expect(freshnessTooltip).toContainText("Subagents changed")
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Subagent feature toggle - enabled state survives later state publications and Settings remounts",
	async ({ dlineDir, helper, page, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		await setSubagentsEnabled(page, sidebar, false)
		await expect.poll(() => readSubagentsEnabled(dlineDir)).toBe(false)

		await openFeatureSettings(page, sidebar)
		const toggle = subagentsSwitch(sidebar)
		await toggle.click()
		await expect(toggle).toHaveAttribute("aria-checked", "true")
		await expect.poll(() => readSubagentsEnabled(dlineDir), { timeout: 10_000 }).toBe(true)

		// Remount the feature section after the committed backend state has been published.
		await sidebar.getByTestId("tab-general").click()
		await sidebar.getByTestId("tab-features").click()
		await expect(subagentsSwitch(sidebar)).toHaveAttribute("aria-checked", "true")

		// Publish two later global Settings revisions while Subagents remains enabled.
		const mcpSwitch = sidebar.locator('[id="Enable MCP"]')
		const originalMcpState = await mcpSwitch.getAttribute("aria-checked")
		await mcpSwitch.click()
		await expect(mcpSwitch).not.toHaveAttribute("aria-checked", originalMcpState ?? "true")
		await mcpSwitch.click()
		await expect(mcpSwitch).toHaveAttribute("aria-checked", originalMcpState ?? "true")
		await expect(subagentsSwitch(sidebar)).toHaveAttribute("aria-checked", "true")
		await expect.poll(() => readSubagentsEnabled(dlineDir), { timeout: 10_000 }).toBe(true)

		await sidebar.getByRole("button", { name: "Done", exact: true }).click()
		await expect(sidebar.getByTestId("chat-input")).toBeVisible()
		await openFeatureSettings(page, sidebar)
		await expect(subagentsSwitch(sidebar)).toHaveAttribute("aria-checked", "true")
		await sidebar.getByRole("button", { name: "Done", exact: true }).click()
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Subagent feature toggle - a stale second VS Code instance cannot roll an enabled active task back to disabled",
	async ({ dlineDir, dlineDocsDir, extensionsDir, server, workspaceDir }, testInfo) => {
		e2e.setTimeout(300_000)
		const launcher = new MultiInstanceLauncher({ dlineDir, dlineDocsDir, extensionsDir, server, testInfo, workspaceDir })
		try {
			const instanceA = await launcher.launch("subagent-instance-a")
			await setSubagentsEnabled(instanceA.page, instanceA.sidebar, false)
			await expect.poll(() => readSubagentsEnabled(dlineDir), { timeout: 10_000 }).toBe(false)

			const instanceB = await launcher.launch("subagent-instance-b")
			await openFeatureSettings(instanceB.page, instanceB.sidebar)
			await expect(subagentsSwitch(instanceB.sidebar)).toHaveAttribute("aria-checked", "false")

			server.resetOpenAiMock()
			server.enqueueOpenAiResponses(
				{
					type: "tool",
					id: "call_stale_instance_ready",
					name: "qna_respond",
					arguments: { response: "E2E_STALE_SUBAGENT_READY" },
				},
				{
					type: "tool",
					id: "call_stale_instance_subagent",
					name: "use_subagent",
					arguments: {
						agent_name: "default",
						task: "E2E_STALE_SUBAGENT_CHILD",
						context: "Return the child marker.",
						timeout: 60,
					},
				},
				{
					type: "tool",
					id: "call_stale_instance_child_complete",
					name: "attempt_completion",
					arguments: { result: "E2E_STALE_SUBAGENT_CHILD_DONE" },
				},
				{
					type: "tool",
					id: "call_stale_instance_parent_complete",
					name: "attempt_completion",
					arguments: { result: "E2E_STALE_SUBAGENT_PARENT_DONE" },
					expectedToolResults: [
						{
							callId: "call_stale_instance_subagent",
							contentIncludes: "E2E_STALE_SUBAGENT_CHILD_DONE",
						},
					],
				},
			)

			await sendTask(instanceA.sidebar, "Create the active task before enabling Subagents.")
			await expect(instanceA.sidebar.getByText("E2E_STALE_SUBAGENT_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})

			await openFeatureSettings(instanceA.page, instanceA.sidebar)
			await subagentsSwitch(instanceA.sidebar).click()
			await expect(subagentsSwitch(instanceA.sidebar)).toHaveAttribute("aria-checked", "true")
			await expect.poll(() => readSubagentsEnabled(dlineDir), { timeout: 10_000 }).toBe(true)

			// Instance B still owns the pre-enable snapshot. Committing another key must
			// merge against the latest disk revision instead of restoring Subagents=false.
			const instanceBMcpSwitch = instanceB.sidebar.locator('[id="Enable MCP"]')
			const originalMcpEnabled = (await instanceBMcpSwitch.getAttribute("aria-checked")) === "true"
			await instanceBMcpSwitch.click()
			await expect(instanceBMcpSwitch).toHaveAttribute("aria-checked", String(!originalMcpEnabled))
			await expect.poll(() => readMcpEnabled(dlineDir), { timeout: 10_000 }).toBe(!originalMcpEnabled)
			await expect.poll(() => readSubagentsEnabled(dlineDir), { timeout: 10_000 }).toBe(true)
			await expect(subagentsSwitch(instanceA.sidebar)).toHaveAttribute("aria-checked", "true")

			await instanceA.sidebar.getByRole("button", { name: "Done", exact: true }).click()

			// The active Task keeps its frozen prompt until refreshed, so rebuild it
			// before asserting that the merged (still enabled) setting reaches the model.
			const staleRefreshButton = instanceA.sidebar.locator("button:has(svg.lucide-refresh-cw)").first()
			await expect(staleRefreshButton.getByTestId("prompt-freshness-warning")).toBeVisible({ timeout: 30_000 })
			await staleRefreshButton.click()
			const staleRefreshDialog = instanceA.sidebar.getByRole("dialog")
			await expect(staleRefreshDialog.getByRole("heading", { name: "Refresh Prompt Cache", exact: true })).toBeVisible()
			await staleRefreshDialog.getByRole("button", { name: "Confirm", exact: true }).click()
			await expect(staleRefreshButton.getByTestId("prompt-freshness-warning")).toHaveCount(0, { timeout: 30_000 })

			await sendTask(instanceA.sidebar, "Use the default subagent after the stale instance committed another setting.")
			await expect(instanceA.sidebar.getByText("E2E_STALE_SUBAGENT_PARENT_DONE", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			const consumptions = server.getMockConsumptions("openai-compatible-chat")
			expect(requestToolNames(consumptions[1])).toContain("use_subagent")
			await expect(
				instanceA.sidebar.getByText(/Native tool 'use_subagent' was not available/, { exact: false }),
			).toHaveCount(0)
		} finally {
			await launcher.dispose()
		}
	},
)

e2e(
	"Named YAML subagent toggle - disabled agents are rejected and re-enabled agents execute in the active task",
	async ({ helper, page, server, sidebar, userDataDir, workspaceDir }) => {
		e2e.setTimeout(240_000)
		await helper.signin(sidebar)
		await setSubagentsEnabled(page, sidebar, true)

		const agentName = "e2e-named-toggle"
		const systemPromptMarker = "E2E_NAMED_TOGGLE_SYSTEM_PROMPT"
		const childDoneMarker = "E2E_NAMED_TOGGLE_CHILD_DONE"
		const namedSubagentDirectory = path.join(workspaceDir, ".agents", "subagents")
		await mkdir(namedSubagentDirectory, { recursive: true })
		await writeFile(
			path.join(namedSubagentDirectory, `${agentName}.yml`),
			`---
name: ${agentName}
description: E2E named subagent toggle
tools:
  - attempt_completion
---

${systemPromptMarker}
Return only the requested result.`,
			"utf8",
		)

		await openSubagentCapabilityTab(sidebar)
		await expect(capabilityRow(sidebar, agentName)).toBeVisible({ timeout: 30_000 })
		await setNamedSubagentToggle(sidebar, agentName, false)
		await captureSubagentCapabilityPopup(sidebar, "named-subagent-disabled.png")
		await sidebar.getByRole("button", { name: "Hide Dline Rules & Workflows", exact: true }).first().click()

		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_named_subagent_disabled",
				name: "use_subagent",
				arguments: {
					agent_name: agentName,
					task: "E2E_NAMED_TOGGLE_DISABLED_TASK",
					context: "The named agent is intentionally disabled.",
					timeout: 60,
				},
			},
			{
				type: "tool",
				id: "call_named_subagent_disabled_parent_complete",
				name: "attempt_completion",
				arguments: { result: "E2E_NAMED_TOGGLE_DISABLED_DONE" },
				expectedToolResults: [
					{
						callId: "call_named_subagent_disabled",
						contentIncludes: `Unknown or disabled subagent '${agentName}'`,
					},
				],
			},
		)

		await sendTask(sidebar, "Try the disabled named subagent and report the rejection.")
		await expect(sidebar.getByText("E2E_NAMED_TOGGLE_DISABLED_DONE", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(2)
		expect(server.getMockConsumptions("openai-compatible-chat")[0].contractError).toBeUndefined()
		expect(server.getMockConsumptions("openai-compatible-chat")[1].contractError).toBeUndefined()

		await openSubagentCapabilityTab(sidebar)
		await setNamedSubagentToggle(sidebar, agentName, true)
		await captureSubagentCapabilityPopup(sidebar, "named-subagent-enabled.png")
		await sidebar.getByRole("button", { name: "Hide Dline Rules & Workflows", exact: true }).first().click()

		// The active Task keeps its frozen prompt until the refresh control
		// rebuilds it, so the re-enabled agent reaches the model only after that.
		const namedRefreshButton = sidebar.locator("button:has(svg.lucide-refresh-cw)").first()
		await expect(namedRefreshButton.getByTestId("prompt-freshness-warning")).toBeVisible({ timeout: 30_000 })
		await namedRefreshButton.click()
		const namedRefreshDialog = sidebar.getByRole("dialog")
		await expect(namedRefreshDialog.getByRole("heading", { name: "Refresh Prompt Cache", exact: true })).toBeVisible()
		await namedRefreshDialog.getByRole("button", { name: "Confirm", exact: true }).click()
		await expect(namedRefreshButton.getByTestId("prompt-freshness-warning")).toHaveCount(0, { timeout: 30_000 })
		await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(2)

		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_named_subagent_enabled",
				name: "use_subagent",
				arguments: {
					agent_name: agentName,
					task: "E2E_NAMED_TOGGLE_ENABLED_TASK",
					context: "Return the named agent marker.",
					timeout: 60,
				},
			},
			{
				type: "tool",
				id: "call_named_subagent_enabled_child_complete",
				name: "attempt_completion",
				arguments: { result: childDoneMarker },
				expectedRequestIncludes: [systemPromptMarker],
			},
			{
				type: "tool",
				id: "call_named_subagent_enabled_parent_complete",
				name: "attempt_completion",
				arguments: { result: "E2E_NAMED_TOGGLE_ENABLED_DONE" },
				expectedToolResults: [{ callId: "call_named_subagent_enabled", contentIncludes: childDoneMarker }],
			},
		)

		await sendTask(sidebar, "Run the named subagent after enabling it in this active task.")
		await expect(sidebar.getByText("E2E_NAMED_TOGGLE_ENABLED_DONE", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(5)
		const consumptions = server.getMockConsumptions("openai-compatible-chat")
		expect(consumptions[3].contractError).toBeUndefined()
		expect(JSON.stringify(consumptions[3].requestBody)).toContain(systemPromptMarker)
		expect(consumptions[4].contractError).toBeUndefined()
		await expect(sidebar.getByText(/Native tool 'use_subagent' was not available/, { exact: false })).toHaveCount(0)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)
