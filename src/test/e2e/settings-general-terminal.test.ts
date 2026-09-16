import { mkdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import { expect, type Frame, type Locator, type Page } from "@playwright/test"
import type { ElectronApplication } from "playwright"
import { E2ETestHelper, e2e } from "./utils/helpers"
import { startSettingControlStabilityObserver, stopSettingControlStabilityObserver } from "./utils/ui-stability"

interface StoredSettings {
	chatInputSendShortcut?: string
	defaultTerminalProfile?: string
	shellIntegrationTimeout?: number
	terminalCommandTimeoutSeconds?: number
	terminalOutputLineLimit?: number
}

interface StoredGlobalState {
	vscodeTerminalExecutionMode?: string
}

async function readSettings(dlineDir: string): Promise<StoredSettings> {
	return JSON.parse(await readFile(path.join(dlineDir, "data", "settings", "settings.json"), "utf8"))
}

async function readGlobalState(dlineDir: string): Promise<StoredGlobalState> {
	return JSON.parse(await readFile(path.join(dlineDir, "data", "globalState.json"), "utf8"))
}

async function setShellIntegrationTimeout(sidebar: Frame, seconds: string): Promise<void> {
	const input = sidebar
		.getByText("Shell integration timeout (seconds)", { exact: true })
		.locator("..")
		.locator("vscode-text-field input")
	await input.fill(seconds)
	await expect(input).toHaveValue(seconds)
	await input.blur()
}

interface ShellEnvironmentFixture {
	postMarkerPath: string
	startupScripts: string[]
}

async function createShellEnvironmentFixture(workspaceDir: string, scope: string): Promise<ShellEnvironmentFixture> {
	const agentsDirectory = path.join(workspaceDir, ".agents")
	await mkdir(agentsDirectory, { recursive: true })
	const powershellScriptName = `startup-${scope}.ps1`
	const batchScriptName = `vcvars64-${scope}.bat`
	const missingScriptName = `missing-${scope}.ps1`
	await writeFile(
		path.join(agentsDirectory, powershellScriptName),
		`$env:DLINE_E2E_STARTUP = '${scope}-startup'
Write-Output 'HIDDEN_STARTUP_OUTPUT'
`,
		"utf8",
	)
	await writeFile(
		path.join(agentsDirectory, batchScriptName),
		`@set DLINE_E2E_BATCH=${scope}-batch\r\n@echo HIDDEN_BATCH_OUTPUT\r\n`,
		"utf8",
	)
	return {
		postMarkerPath: path.join(agentsDirectory, `post-${scope}.txt`),
		startupScripts: [`.agents\\${powershellScriptName}`, `.agents\\${batchScriptName}`, `.agents\\${missingScriptName}`],
	}
}

async function configureShellEnvironmentFromChat(
	sidebar: Frame,
	workspaceDir: string,
	scope: string,
	fixture: ShellEnvironmentFixture,
): Promise<void> {
	await sidebar.getByRole("button", { name: "Show Dline Rules & Workflows", exact: true }).first().click()
	await sidebar.getByRole("button", { name: "Environments", exact: true }).click()
	await expect(sidebar.getByTestId("shell-environment-panel")).toBeVisible()
	await expect
		.poll(async () => (await sidebar.getByLabel("Workspace").inputValue()).toLowerCase())
		.toBe(workspaceDir.toLowerCase())
	await sidebar.getByLabel("Terminal Profile").selectOption("powershell-legacy")

	await sidebar.getByRole("button", { name: "Add variable" }).click()
	await sidebar.getByLabel("Environment name 1").fill("DLINE_E2E_CONFIG")
	await sidebar.getByLabel("Environment value 1").fill(`${scope}-config`)

	await sidebar.getByRole("tab", { name: "Startup Scripts" }).click()
	for (const [index, startupScript] of fixture.startupScripts.entries()) {
		await sidebar.getByRole("button", { name: "Add startup script" }).click()
		await sidebar.getByRole("textbox", { name: `Startup script ${index + 1}` }).fill(startupScript)
	}

	await sidebar.getByRole("tab", { name: "Commands" }).click()
	await sidebar.getByRole("button", { name: "Add pre command" }).click()
	await sidebar
		.getByRole("textbox", { name: "Pre command 1" })
		.fill(`$env:DLINE_E2E_PRE = '${scope}-pre'; Write-Output 'HIDDEN_PRE_OUTPUT'`)
	await sidebar.getByRole("button", { name: "Add post command" }).click()
	await sidebar
		.getByRole("textbox", { name: "Post command 1" })
		.fill(
			`Set-Content -LiteralPath '${workspaceDir.replaceAll("'", "''")}\\.agents\\post-${scope}.txt' -Value 'post-ran'; Write-Output 'HIDDEN_POST_OUTPUT'`,
		)

	const configPath = path.join(workspaceDir, ".agents", "bashrc.yml")
	await expect.poll(async () => await readFile(configPath, "utf8").catch(() => "")).toContain("postCommand:")
	const config = await readFile(configPath, "utf8")
	expect(config).toContain("startupScripts:")
	expect(config).toContain("preCommands:")
	expect(config).toContain("postCommand:")
	await sidebar.getByRole("button", { name: "Hide Dline Rules & Workflows", exact: true }).first().click()
}

async function openSettings(page: Page, sidebar: Frame): Promise<void> {
	await page.getByRole("button", { name: "Settings", exact: true }).click()
	// The settings view can take several seconds to appear when the previous test left
	// the extension host busy, so allow a generous timeout here.
	await expect(sidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible({ timeout: 30_000 })
}

async function setDropdownValue(sidebar: Frame, dropdown: Locator, value: string, label: string): Promise<void> {
	await dropdown.evaluate((element) => {
		const target = element as HTMLElement & { __e2eChangeValues?: string[] }
		target.__e2eChangeValues = []
		target.addEventListener("change", () => {
			target.__e2eChangeValues?.push((target as unknown as HTMLSelectElement).value)
		})
	})
	await dropdown.click()
	await sidebar.getByRole("option", { name: label, exact: true }).click()
	await expect.poll(() => dropdown.evaluate((element) => (element as HTMLSelectElement).value)).toBe(value)
	await expect
		.poll(() =>
			dropdown.evaluate((element) => (element as HTMLElement & { __e2eChangeValues?: string[] }).__e2eChangeValues ?? []),
		)
		.toContain(value)
}

async function setRangeValue(range: Locator, value: string): Promise<void> {
	const { min, step } = await range.evaluate((element) => {
		const input = element as HTMLInputElement
		return { min: Number(input.min), step: Number(input.step) }
	})
	const steps = (Number(value) - min) / step
	expect(Number.isSafeInteger(steps)).toBe(true)
	await range.focus()
	await range.press("Home")
	for (let index = 0; index < steps; index++) {
		await range.press("ArrowRight")
	}
	await expect(range).toHaveValue(value)
}

async function selectSendShortcut(sidebar: Frame, value: string): Promise<void> {
	await sidebar.getByTestId("tab-general").click()
	const dropdown = sidebar.locator("#chat-input-send-shortcut")
	const labels: Record<string, string> = { enter: "Enter", ctrlEnter: "Ctrl + Enter", shiftEnter: "Shift + Enter" }
	await setDropdownValue(sidebar, dropdown, value, labels[value])
}

async function returnToChat(sidebar: Frame): Promise<void> {
	await sidebar.getByRole("button", { name: "Done", exact: true }).click()
	await expect(sidebar.getByTestId("chat-input")).toBeVisible()
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

async function expectShortcutTurn(
	sidebar: Frame,
	server: { openAiRequestCount: number },
	inputText: string,
	wrongShortcut: string,
	sendShortcut: string,
	completionMarker: string,
): Promise<void> {
	const beforeRequests = server.openAiRequestCount
	const input = sidebar.getByTestId("chat-input")
	await input.fill(inputText)
	await input.press(wrongShortcut)
	await expect(input).toHaveValue(`${inputText}\n`)
	expect(server.openAiRequestCount).toBe(beforeRequests)
	await input.fill(inputText)
	await input.press(sendShortcut)
	await expect(sidebar.getByText(inputText, { exact: true }).last()).toBeVisible()
	await expect(sidebar.getByText(completionMarker, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
	await expect.poll(() => server.openAiRequestCount).toBe(beforeRequests + 1)
}

e2e(
	"Settings - persists input shortcuts and terminal limits, then applies all send shortcut modes",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(240_000)
		let firstApp: ElectronApplication | undefined
		let reopenedApp: ElectronApplication | undefined

		try {
			firstApp = await openVSCode(workspaceDir)
			const firstPage = await firstApp.firstWindow()
			await E2ETestHelper.openClineSidebar(firstPage)
			const firstSidebar = await helper.getSidebar(firstPage)
			await helper.signin(firstSidebar)
			await openSettings(firstPage, firstSidebar)

			await selectSendShortcut(firstSidebar, "ctrlEnter")
			await firstSidebar.getByTestId("tab-terminal").click()
			await expect(
				firstSidebar.getByText("Set how long Dline waits for shell integration to activate before executing commands.", {
					exact: false,
				}),
			).toBeVisible()
			await expect(
				firstSidebar.getByText("When enabled, Dline reuses healthy prewarmed terminals", { exact: false }),
			).toBeVisible()
			await expect(
				firstSidebar.getByText("Choose whether Dline runs commands in the VS Code terminal or a background process.", {
					exact: true,
				}),
			).toBeVisible()
			await expect(firstSidebar.getByText(/Cline/)).toHaveCount(0)
			const timeout = firstSidebar.locator("#terminal-command-timeout input")
			await startSettingControlStabilityObserver(firstSidebar, { selector: "#terminal-command-timeout input" }, "value")
			await timeout.fill("0.5")
			await expect(firstSidebar.getByText("Enter at least 1 minute", { exact: true })).toBeVisible()
			await timeout.click()
			await timeout.press("Control+A")
			await timeout.pressSequentially("42")
			await expect(timeout).toHaveValue("42")
			await timeout.press("Tab")
			await expect(timeout).toHaveValue("42")
			await expect.poll(async () => (await readSettings(dlineDir)).terminalCommandTimeoutSeconds).toBe(2_520)
			await firstSidebar.page().waitForTimeout(300)
			const timeoutSamples = await stopSettingControlStabilityObserver(firstSidebar)
			const firstValidTimeoutSample = timeoutSamples.indexOf("42")
			expect(firstValidTimeoutSample).toBeGreaterThanOrEqual(0)
			expect(timeoutSamples.slice(firstValidTimeoutSample)).not.toContain("2")
			expect(timeoutSamples.slice(firstValidTimeoutSample)).not.toContain("4")
			expect(timeoutSamples.slice(firstValidTimeoutSample)).not.toContain("30")
			await setDropdownValue(
				firstSidebar,
				firstSidebar.locator("#terminal-execution-mode"),
				"backgroundExec",
				"Background Exec",
			)
			await expect.poll(async () => (await readGlobalState(dlineDir)).vscodeTerminalExecutionMode).toBe("backgroundExec")
			await setRangeValue(firstSidebar.locator("#terminal-output-limit"), "900")
			await expect.poll(async () => (await readSettings(dlineDir)).terminalOutputLineLimit).toBe(900)

			await expect
				.poll(async () => await readSettings(dlineDir))
				.toMatchObject({
					chatInputSendShortcut: "ctrlEnter",
					terminalCommandTimeoutSeconds: 2_520,
					terminalOutputLineLimit: 900,
				})
			await firstApp.close()
			firstApp = undefined

			reopenedApp = await openVSCode(workspaceDir)
			const reopenedPage = await reopenedApp.firstWindow()
			await E2ETestHelper.openClineSidebar(reopenedPage)
			const reopenedSidebar = await helper.getSidebar(reopenedPage)
			await helper.signin(reopenedSidebar)
			await openSettings(reopenedPage, reopenedSidebar)

			await reopenedSidebar.getByTestId("tab-general").click()
			await expect
				.poll(() =>
					reopenedSidebar
						.locator("#chat-input-send-shortcut")
						.evaluate((element) => (element as HTMLSelectElement).value),
				)
				.toBe("ctrlEnter")
			await reopenedSidebar.getByTestId("tab-terminal").click()
			await expect(reopenedSidebar.locator("#terminal-command-timeout input")).toHaveValue("42")
			await expect(reopenedSidebar.locator("#terminal-output-limit")).toHaveValue("900")
			await expect
				.poll(() =>
					reopenedSidebar
						.locator("#terminal-execution-mode")
						.evaluate((element) => (element as HTMLSelectElement).value),
				)
				.toBe("backgroundExec")

			server.resetOpenAiMock()
			server.enqueueOpenAiResponses(
				{ type: "tool", name: "attempt_completion", arguments: { result: "E2E_CTRL_ENTER_COMPLETE" } },
				{ type: "tool", name: "attempt_completion", arguments: { result: "E2E_SHIFT_ENTER_COMPLETE" } },
				{ type: "tool", name: "attempt_completion", arguments: { result: "E2E_ENTER_COMPLETE" } },
			)
			await returnToChat(reopenedSidebar)
			await expectShortcutTurn(
				reopenedSidebar,
				server,
				"E2E_CTRL_ENTER_INPUT",
				"Enter",
				"Control+Enter",
				"E2E_CTRL_ENTER_COMPLETE",
			)

			await openSettings(reopenedPage, reopenedSidebar)
			await selectSendShortcut(reopenedSidebar, "shiftEnter")
			await expect.poll(async () => (await readSettings(dlineDir)).chatInputSendShortcut).toBe("shiftEnter")
			await returnToChat(reopenedSidebar)
			await expectShortcutTurn(
				reopenedSidebar,
				server,
				"E2E_SHIFT_ENTER_INPUT",
				"Enter",
				"Shift+Enter",
				"E2E_SHIFT_ENTER_COMPLETE",
			)

			await openSettings(reopenedPage, reopenedSidebar)
			await selectSendShortcut(reopenedSidebar, "enter")
			await expect.poll(async () => (await readSettings(dlineDir)).chatInputSendShortcut).toBe("enter")
			await returnToChat(reopenedSidebar)
			await expectShortcutTurn(reopenedSidebar, server, "E2E_ENTER_INPUT", "Shift+Enter", "Enter", "E2E_ENTER_COMPLETE")
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await reopenedApp?.close()
			await firstApp?.close()
		}
	},
)

e2e(
	"Settings - shell integration timeout remains stable while entering multiple digits",
	async ({ dlineDir, helper, page, sidebar, userDataDir }) => {
		await helper.signin(sidebar)
		await openSettings(page, sidebar)
		await sidebar.getByTestId("tab-terminal").click()

		const timeoutField = sidebar
			.getByText("Shell integration timeout (seconds)", { exact: true })
			.locator("..")
			.locator("vscode-text-field")
		await timeoutField.evaluate((element) => {
			element.id = "e2e-shell-integration-timeout"
		})
		const timeoutInput = timeoutField.locator("input")
		await startSettingControlStabilityObserver(sidebar, { selector: "#e2e-shell-integration-timeout input" }, "value")
		await timeoutInput.click()
		await timeoutInput.press("Control+A")
		await timeoutInput.pressSequentially("15")
		await expect(timeoutInput).toHaveValue("15")
		await timeoutInput.press("Tab")
		await expect.poll(async () => (await readSettings(dlineDir)).shellIntegrationTimeout).toBe(15_000)
		await sidebar.page().waitForTimeout(300)
		const timeoutSamples = await stopSettingControlStabilityObserver(sidebar)
		const firstFinalValue = timeoutSamples.indexOf("15")
		expect(firstFinalValue).toBeGreaterThanOrEqual(0)
		expect(timeoutSamples.slice(firstFinalValue)).not.toContain("1")
		expect(timeoutSamples.slice(firstFinalValue)).not.toContain("4")
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Terminal - environment editor shares the capabilities popup with stable sizing and symmetric command controls",
	async ({ helper, sidebar, userDataDir }) => {
		e2e.setTimeout(120_000)
		await helper.signin(sidebar)
		await expect(sidebar.getByTestId("shell-environment-button")).toHaveCount(0)

		await sidebar.getByRole("button", { name: "Show Dline Rules & Workflows", exact: true }).first().click()
		const popup = sidebar.getByTestId("capabilities-popup")
		await expect(popup).toBeVisible()
		const initialHeight = await popup.evaluate((element) => element.getBoundingClientRect().height)

		for (const tabName of ["Skills", "Subagents", "Environments"]) {
			await sidebar.getByRole("button", { name: tabName, exact: true }).click()
			await expect.poll(() => popup.evaluate((element) => element.getBoundingClientRect().height)).toBe(initialHeight)
		}

		await expect(sidebar.getByTestId("shell-environment-panel")).toBeVisible()
		await sidebar.getByRole("tab", { name: "Commands" }).click()
		await sidebar.getByRole("button", { name: "Add pre command" }).click()
		await sidebar.getByRole("textbox", { name: "Pre command 1" }).fill("Write-Output pre")
		await sidebar.getByRole("button", { name: "Add post command" }).click()
		await sidebar.getByRole("textbox", { name: "Post command 1" }).fill("Write-Output post")

		await sidebar.getByRole("button", { name: "Subagents", exact: true }).click()
		await sidebar.getByRole("button", { name: "Environments", exact: true }).click()
		await expect(sidebar.getByRole("textbox", { name: "Pre command 1" })).toHaveValue("Write-Output pre")
		await expect(sidebar.getByRole("textbox", { name: "Post command 1" })).toHaveValue("Write-Output post")
		expect(await popup.evaluate((element) => element.getBoundingClientRect().height)).toBe(initialHeight)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Terminal - foreground VS Code terminal executes with the configured Windows shell",
	async ({ dlineDir, helper, page, server, sidebar, userDataDir, workspaceDir }) => {
		e2e.skip(process.platform !== "win32", "Configured Windows shell execution requires Windows")
		e2e.setTimeout(240_000)
		const shellFixture = await createShellEnvironmentFixture(workspaceDir, "foreground")
		await helper.signin(sidebar)
		await openSettings(page, sidebar)
		await sidebar.getByTestId("tab-terminal").click()
		await setDropdownValue(sidebar, sidebar.locator("#terminal-execution-mode"), "backgroundExec", "Background Exec")
		await setDropdownValue(sidebar, sidebar.locator("#terminal-execution-mode"), "vscodeTerminal", "VS Code Terminal")
		await setDropdownValue(sidebar, sidebar.locator("#default-terminal-profile"), "powershell-legacy", "Windows PowerShell")
		await setShellIntegrationTimeout(sidebar, "15")
		await expect
			.poll(async () => await readSettings(dlineDir))
			.toMatchObject({
				defaultTerminalProfile: "powershell-legacy",
				shellIntegrationTimeout: 15_000,
			})
		await expect.poll(async () => (await readGlobalState(dlineDir)).vscodeTerminalExecutionMode).toBe("vscodeTerminal")
		await returnToChat(sidebar)
		await configureShellEnvironmentFromChat(sidebar, workspaceDir, "foreground", shellFixture)

		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_vscode_powershell",
				name: "execute_command",
				arguments: {
					command:
						'Write-Output "E2E_VSCODE_POWERSHELL_OK"; Write-Output "E2E_PS_EDITION=$($PSVersionTable.PSEdition)"; Write-Output "E2E_CONFIG=$env:DLINE_E2E_CONFIG"; Write-Output "E2E_STARTUP=$env:DLINE_E2E_STARTUP"; Write-Output "E2E_BATCH=$env:DLINE_E2E_BATCH"; Write-Output "E2E_PRE=$env:DLINE_E2E_PRE"; & $env:ComSpec /d /c "exit 7"',
					workdirectory: ".",
					requires_approval: true,
					synchronous: true,
					timeout: 60,
				},
			},
			{
				type: "tool",
				id: "call_vscode_powershell_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_VSCODE_POWERSHELL_COMPLETE" },
				expectedToolResults: [
					{
						callId: "call_vscode_powershell",
						contentIncludes: [
							"Command failed with exit code 7.",
							"E2E_VSCODE_POWERSHELL_OK",
							"E2E_PS_EDITION=Desktop",
							"E2E_CONFIG=foreground-config",
							"E2E_STARTUP=foreground-startup",
							"E2E_BATCH=foreground-batch",
							"E2E_PRE=foreground-pre",
						],
					},
				],
			},
		)

		const input = sidebar.getByTestId("chat-input")
		await input.fill("Run the configured foreground PowerShell command.")
		await sidebar.getByTestId("send-button").click()
		const approveButton = sidebar.getByText("Approve", { exact: true })
		await expect(approveButton).toBeVisible({ timeout: 60_000 })
		await approveButton.click()
		await expect(sidebar.getByTestId("command-execution-mode").last()).toContainText("Foreground")
		const workingDirectoryRow = sidebar.getByTestId("command-workdirectory").last()
		await expect(workingDirectoryRow.getByLabel("Working directory")).toBeVisible()
		await expect(workingDirectoryRow).toContainText(workspaceDir)
		await expect(workingDirectoryRow.getByText("Working directory:", { exact: true })).toHaveCount(0)

		const completionMarker = sidebar.getByText("E2E_VSCODE_POWERSHELL_COMPLETE", { exact: false }).last()
		await expect(sidebar.getByRole("contentinfo").getByText("Start New Task", { exact: true })).toBeVisible({
			timeout: 60_000,
		})
		if (!(await completionMarker.isVisible())) {
			const scrollToBottom = sidebar.getByRole("button", { name: "Scroll to bottom", exact: true })
			await expect(scrollToBottom).toBeVisible()
			await scrollToBottom.evaluate((element) => (element as HTMLButtonElement).click())
		}
		await expect(completionMarker).toBeVisible()
		await expect.poll(() => server.openAiRequestCount).toBe(2)
		const continuation = server.getMockConsumptions("openai-compatible-chat")[1]
		expect(continuation.requestToolResults).toContainEqual(
			expect.objectContaining({
				callId: "call_vscode_powershell",
				content: expect.stringContaining("Command failed with exit code 7."),
			}),
		)
		const commandResult = continuation.requestToolResults.find((result) => result.callId === "call_vscode_powershell")
		expect(commandResult?.content).not.toContain("HIDDEN_")
		expect((await readFile(shellFixture.postMarkerPath, "utf8")).trim()).toBe("post-ran")
		const output = await E2ETestHelper.readDlineOutput(userDataDir)
		expect(output).toMatch(/\[TerminalPerf\] phase=execute_start[^\r\n]*terminalMode=vscode/)
		expect(output).toContain("[ShellEnvironment] startupScripts[2] failed")
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [/\[ShellEnvironment\] startupScripts\[2\] failed/])
	},
)

e2e(
	"Terminal - background Exec applies the configured PowerShell project environment",
	async ({ dlineDir, helper, page, server, sidebar, userDataDir, workspaceDir }) => {
		e2e.skip(process.platform !== "win32", "Configured Windows shell execution requires Windows")
		e2e.setTimeout(240_000)
		const shellFixture = await createShellEnvironmentFixture(workspaceDir, "background")
		await helper.signin(sidebar)
		await openSettings(page, sidebar)
		await sidebar.getByTestId("tab-terminal").click()
		await setDropdownValue(sidebar, sidebar.locator("#terminal-execution-mode"), "backgroundExec", "Background Exec")
		await setDropdownValue(sidebar, sidebar.locator("#default-terminal-profile"), "powershell-legacy", "Windows PowerShell")
		await expect.poll(async () => (await readSettings(dlineDir)).defaultTerminalProfile).toBe("powershell-legacy")
		await expect.poll(async () => (await readGlobalState(dlineDir)).vscodeTerminalExecutionMode).toBe("backgroundExec")
		await returnToChat(sidebar)
		await configureShellEnvironmentFromChat(sidebar, workspaceDir, "background", shellFixture)

		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_background_shell_environment",
				name: "execute_command",
				arguments: {
					command:
						'Write-Output "E2E_BACKGROUND_CONFIG=$env:DLINE_E2E_CONFIG"; Write-Output "E2E_BACKGROUND_STARTUP=$env:DLINE_E2E_STARTUP"; Write-Output "E2E_BACKGROUND_BATCH=$env:DLINE_E2E_BATCH"; Write-Output "E2E_BACKGROUND_PRE=$env:DLINE_E2E_PRE"',
					workdirectory: ".",
					requires_approval: true,
					synchronous: true,
					timeout: 60,
				},
			},
			{
				type: "tool",
				id: "call_background_shell_environment_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_BACKGROUND_BASHRC_COMPLETE" },
				expectedToolResults: [
					{
						callId: "call_background_shell_environment",
						contentIncludes: [
							"Command executed successfully (exit code 0).",
							"E2E_BACKGROUND_CONFIG=background-config",
							"E2E_BACKGROUND_STARTUP=background-startup",
							"E2E_BACKGROUND_BATCH=background-batch",
							"E2E_BACKGROUND_PRE=background-pre",
						],
					},
				],
			},
		)

		const input = sidebar.getByTestId("chat-input")
		await input.fill("Run a background terminal command with the project shell environment.")
		await sidebar.getByTestId("send-button").click()
		await expect(sidebar.getByText("Approve", { exact: true })).toBeVisible({ timeout: 60_000 })
		await sidebar.getByText("Approve", { exact: true }).click()
		// The mocked request is synchronous (foreground semantics): even though the global
		// terminal mode is backgroundExec, the execution-mode marker must say Foreground.
		await expect(sidebar.getByTestId("command-execution-mode").last()).toContainText("Foreground")
		await expect(sidebar.getByText("E2E_BACKGROUND_BASHRC_COMPLETE", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => server.openAiRequestCount).toBe(2)
		const continuation = server.getMockConsumptions("openai-compatible-chat")[1]
		expect(continuation.contractError).toBeUndefined()
		const commandResult = continuation.requestToolResults.find(
			(result) => result.callId === "call_background_shell_environment",
		)
		expect(commandResult?.content).not.toContain("HIDDEN_")
		expect((await readFile(shellFixture.postMarkerPath, "utf8")).trim()).toBe("post-ran")
		const output = await E2ETestHelper.readDlineOutput(userDataDir)
		expect(output).toContain("[ShellEnvironment] startupScripts[2] failed")
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [/\[ShellEnvironment\] startupScripts\[2\] failed/])
	},
)

e2e(
	"Terminal - configured output limit bounds the final tool result and preserves the full log",
	async ({ dlineDir, helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(240_000)
		await helper.signin(sidebar)
		await openSettings(page, sidebar)
		await sidebar.getByTestId("tab-terminal").click()
		if (process.platform === "win32") {
			await setDropdownValue(
				sidebar,
				sidebar.locator("#default-terminal-profile"),
				"powershell-legacy",
				"Windows PowerShell",
			)
			await expect.poll(async () => (await readSettings(dlineDir)).defaultTerminalProfile).toBe("powershell-legacy")
		}
		await setRangeValue(sidebar.locator("#terminal-output-limit"), "100")
		await expect.poll(async () => (await readSettings(dlineDir)).terminalOutputLineLimit).toBe(100)
		// This case runs through a real VS Code terminal; give shell integration a
		// generous window so a slow startup does not degrade the command to
		// method:none and break the "Command executed successfully" contract.
		await setShellIntegrationTimeout(sidebar, "15")
		await expect.poll(async () => (await readSettings(dlineDir)).shellIntegrationTimeout).toBe(15_000)
		await returnToChat(sidebar)
		await setAutoApproveAction(sidebar, "Execute safe commands", false)

		const outputPrefix = "E2E_TERMINAL_LIMIT_LINE_"
		const prefixCodePoints = [...outputPrefix].map((character) => character.codePointAt(0)).join(",")
		const command = `node -e "const p=String.fromCodePoint(${prefixCodePoints}); for(let i=0;i<220;i++) console.log(p+i)"`
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_terminal_output_limit",
				name: "execute_command",
				arguments: {
					command,
					workdirectory: ".",
					requires_approval: true,
					synchronous: true,
					timeout: 60,
				},
			},
			{
				type: "tool",
				id: "call_terminal_output_limit_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_TERMINAL_OUTPUT_LIMIT_OK" },
				expectedToolResultCount: 1,
				expectedToolResults: [
					{
						callId: "call_terminal_output_limit",
						contentIncludes: [
							"Command executed successfully (exit code 0).",
							`${outputPrefix}0`,
							`${outputPrefix}219`,
							"lines written to",
							"Full output saved to:",
						],
					},
				],
			},
		)

		const input = sidebar.getByTestId("chat-input")
		await input.fill("Run a bounded foreground output command.")
		await sidebar.getByTestId("send-button").click()
		await expect(sidebar.getByText("Approve", { exact: true })).toBeVisible({ timeout: 60_000 })
		await sidebar.getByText("Approve", { exact: true }).click()
		await expect(sidebar.getByText("E2E_TERMINAL_OUTPUT_LIMIT_OK", { exact: false }).last()).toBeVisible({
			timeout: 90_000,
		})

		const continuation = server.getMockConsumptions("openai-compatible-chat")[1]
		expect(continuation.contractError).toBeUndefined()
		const [toolResult] = continuation.requestToolResults.filter((result) => result.callId === "call_terminal_output_limit")
		expect(toolResult).toBeDefined()
		expect(toolResult.content).toContain(`${outputPrefix}0`)
		expect(toolResult.content).toContain(`${outputPrefix}219`)
		expect(toolResult.content).not.toContain(`${outputPrefix}100\n`)
		const visibleMarkers = toolResult.content.match(new RegExp(outputPrefix, "g")) ?? []
		expect(visibleMarkers.length).toBeGreaterThan(0)
		expect(visibleMarkers.length).toBeLessThanOrEqual(100)
		const logPath = toolResult.content.match(/Full output saved to:\s*([^\r\n]+)/)?.[1]?.trim()
		if (!logPath) throw new Error("Bounded command result did not include its full-output log path")
		const log = await readFile(logPath, "utf8")
		expect(log).toContain(`${outputPrefix}0`)
		expect(log).toContain(`${outputPrefix}219`)
		expect(log.match(new RegExp(outputPrefix, "g"))).toHaveLength(220)
		await expect(sidebar.getByRole("button", { name: "Copy command" }).last()).toBeVisible()
		const completedCommand = sidebar.getByRole("button", { name: command, exact: true })
		await expect(completedCommand).toBeVisible()
		await completedCommand.click()

		// An expanded foreground command that moves its complete output to an owned log file must expose
		// the same clickable log link as a background command, not plain notice text.
		const logFileName = logPath.split(/[\\/]/).filter(Boolean).at(-1)
		if (!logFileName) throw new Error("Bounded command log path did not resolve to a file name")
		const commandLogLink = sidebar.getByRole("button", { name: `Open log file ${logFileName}` }).last()
		await expect(commandLogLink).toBeVisible({ timeout: 30_000 })
		await expect(commandLogLink).toHaveAttribute("title", `Click to open: ${logPath}`)
		await expect(sidebar.getByText("Output is large", { exact: false })).toHaveCount(0)
		await commandLogLink.click()
		await expect(page.getByRole("tab", { name: logFileName })).toBeVisible({ timeout: 30_000 })
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Terminal - timed out command returns its existing full-output log path",
	async ({ dlineDir, helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		await openSettings(page, sidebar)
		await sidebar.getByTestId("tab-terminal").click()
		await setDropdownValue(sidebar, sidebar.locator("#terminal-execution-mode"), "backgroundExec", "Background Exec")
		if (process.platform === "win32") {
			await setDropdownValue(sidebar, sidebar.locator("#default-terminal-profile"), "cmd", "Command Prompt")
		}
		await setRangeValue(sidebar.locator("#terminal-output-limit"), "100")
		await expect.poll(async () => (await readSettings(dlineDir)).terminalOutputLineLimit).toBe(100)
		await expect.poll(async () => (await readGlobalState(dlineDir)).vscodeTerminalExecutionMode).toBe("backgroundExec")
		if (process.platform === "win32") {
			await expect.poll(async () => (await readSettings(dlineDir)).defaultTerminalProfile).toBe("cmd")
		}
		await returnToChat(sidebar)
		await setAutoApproveAction(sidebar, "Execute safe commands", false)

		const outputPrefix = "E2E_TIMEOUT_LOG_LINE_"
		const command = `node -e "setTimeout(()=>{for(let i=0;i<120;i++) console.log('${outputPrefix}'+i)},2000); setInterval(() => {}, 1000)"`
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_timeout_log_contract",
				name: "execute_command",
				arguments: {
					command,
					workdirectory: ".",
					requires_approval: true,
					synchronous: true,
					timeout: 10,
				},
			},
			{
				type: "tool",
				id: "call_timeout_log_contract_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_TIMEOUT_LOG_CONTRACT_OK" },
				expectedToolResults: [
					{
						callId: "call_timeout_log_contract",
						contentIncludes: "Command reached its 10-second timeout and was terminated.",
					},
				],
			},
		)

		const input = sidebar.getByTestId("chat-input")
		await input.fill("Run a bounded command until its absolute timeout.")
		await sidebar.getByTestId("send-button").click()
		await expect(sidebar.getByText("Approve", { exact: true })).toBeVisible({ timeout: 60_000 })
		await sidebar.getByText("Approve", { exact: true }).click()
		await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(2)

		const continuation = server.getMockConsumptions("openai-compatible-chat")[1]
		expect(continuation.contractError).toBeUndefined()
		const timeoutResult = continuation.requestToolResults.find(({ callId }) => callId === "call_timeout_log_contract")
		expect(timeoutResult?.content).toContain("Command reached its 10-second timeout and was terminated.")
		const timeoutLogPath = timeoutResult?.content.match(/Full output saved to:\s*([^\r\n]+)/)?.[1]?.trim()
		if (!timeoutLogPath) throw new Error("Timed out command result did not include its full-output log path")
		expect(timeoutResult?.content.split("\n").at(-1)).toBe(`Full output saved to: ${timeoutLogPath}`)
		const timeoutLog = await readFile(timeoutLogPath, "utf8")
		expect(timeoutLog).toContain(`${outputPrefix}0`)
		expect(timeoutLog).toContain(`${outputPrefix}119`)
		await sidebar.getByRole("tab", { name: /^Activities(?: \d+)?$/ }).click()
		await sidebar.getByRole("button", { name: "All", exact: true }).first().click()
		const activity = sidebar.getByTestId("activity-item").filter({ hasText: command })
		await expect(activity).toContainText("timeout", { timeout: 30_000 })
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Terminal - automatic handoff exposes a background Activity and injects only status plus log metadata",
	async ({ helper, page, server, sidebar, userDataDir }, testInfo) => {
		e2e.setTimeout(240_000)
		await helper.signin(sidebar)
		await openSettings(page, sidebar)
		await sidebar.getByTestId("tab-terminal").click()
		await setDropdownValue(sidebar, sidebar.locator("#terminal-execution-mode"), "backgroundExec", "Background Exec")
		await returnToChat(sidebar)
		await setAutoApproveAction(sidebar, "Execute safe commands", false)
		const startedMarker = "E2E_AUTO_BACKGROUND_OUTPUT_STARTED"
		const finishedMarker = "E2E_AUTO_BACKGROUND_OUTPUT_FINISHED"
		const overwrittenProgress = "E2E_OLD_PROGRESS"
		const renderedText = "E2E_ACTIVITY_RENDER_中文_🚀"
		const startedCodePoints = [...startedMarker].map((character) => character.codePointAt(0)).join(",")
		const finishedCodePoints = [...finishedMarker].map((character) => character.codePointAt(0)).join(",")
		const renderedCodePoints = [...renderedText].map((character) => character.codePointAt(0)).join(",")
		const command = `node -e "const s=String.fromCodePoint(${startedCodePoints}); const f=String.fromCodePoint(${finishedCodePoints}); const r=String.fromCodePoint(${renderedCodePoints}); console.log(s); process.stdout.write('${overwrittenProgress}'+String.fromCodePoint(13)+String.fromCodePoint(27)+'[31m'+r+String.fromCodePoint(27)+'[0m'+String.fromCodePoint(9)+'COLUMN'+String.fromCodePoint(8)+'\\n'); setTimeout(()=>console.log(f),45000)"`
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_terminal_automatic_background",
				name: "execute_command",
				arguments: {
					command,
					workdirectory: ".",
					requires_approval: true,
					timeout: 60,
				},
			},
			{
				type: "tool",
				id: "call_terminal_automatic_background_qna",
				name: "qna_respond",
				arguments: { response: "E2E_AUTO_BACKGROUND_HANDOFF_READY" },
				expectedToolResults: [
					{
						callId: "call_terminal_automatic_background",
						contentIncludes: [
							"Command is still running after 10 seconds and is now tracked in the background.",
							"Its final status will be available only in a later model request.",
							"Log file:",
						],
					},
				],
				expectedRequestIncludes: [
					"# Background Commands",
					"function_id: call_terminal_automatic_background",
					"status: running",
					// The exact line delta varies with terminal startup noise, so only
					// require that at least one line was reported since the last send.
					"output change since last API send: +",
					"log:",
				],
				expectedRequestExcludes: [startedMarker, finishedMarker],
			},
			{
				type: "tool",
				id: "call_terminal_automatic_background_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_AUTO_BACKGROUND_RESULT_OK" },
				expectedRequestIncludes: [
					"E2E_AUTO_BACKGROUND_FEEDBACK",
					"function_id: call_terminal_automatic_background",
					"status: completed",
					"output change since last API send: +1 line",
					"# Background Results",
					"## Background Command Results",
					"completed",
					"log:",
				],
				expectedRequestExcludes: [startedMarker, finishedMarker],
			},
		)

		const input = sidebar.getByTestId("chat-input")
		await input.fill("Run a command that should hand off automatically after ten seconds.")
		await sidebar.getByTestId("send-button").click()
		await expect(sidebar.getByText("Approve", { exact: true })).toBeVisible({ timeout: 60_000 })
		await sidebar.getByText("Approve", { exact: true }).click()

		await sidebar.getByRole("tab", { name: /^Activities(?: \d+)?$/ }).click()
		await sidebar.getByRole("button", { name: "All", exact: true }).first().click()
		// The Activity panel truncates the command title to 240 characters, so match a
		// stable prefix of the full command instead of the full escaped string.
		const activity = sidebar.getByTestId("activity-item").filter({ hasText: command.slice(0, 120) })
		await expect(activity).toHaveCount(1, { timeout: 30_000 })
		await expect(activity).toContainText("running", { timeout: 30_000 })
		const timeoutIndicator = activity.getByLabel("Command timeout: 60 s")
		await expect(timeoutIndicator).toContainText("60 s")
		const timeoutLayout = await timeoutIndicator.evaluate((indicator) => {
			const icon = indicator.querySelector("svg")
			const label = indicator.querySelector("span")
			if (!icon || !label) throw new Error("Command timeout indicator is missing its icon or label")
			const iconRect = icon.getBoundingClientRect()
			const labelRect = label.getBoundingClientRect()
			const indicatorRect = indicator.getBoundingClientRect()
			const scale = indicator.offsetWidth > 0 ? indicatorRect.width / indicator.offsetWidth : 1
			return {
				iconHeight: iconRect.height,
				expectedIconHeight: Number.parseFloat(getComputedStyle(label).fontSize) * scale,
				centerDelta: Math.abs(iconRect.top + iconRect.height / 2 - (labelRect.top + labelRect.height / 2)),
			}
		})
		expect(Math.abs(timeoutLayout.iconHeight - timeoutLayout.expectedIconHeight)).toBeLessThanOrEqual(1)
		expect(timeoutLayout.centerDelta).toBeLessThanOrEqual(1)
		const activityCancelButton = activity.getByRole("button", { name: "Cancel", exact: true })
		const cancelLayout = await activityCancelButton.evaluate((button) => {
			const row = button.parentElement
			const textNode = Array.from(button.childNodes).find((node) => node.nodeType === Node.TEXT_NODE)
			if (!row || !textNode) throw new Error("Activity Cancel button is missing its row or text")
			const buttonRect = button.getBoundingClientRect()
			const rowRect = row.getBoundingClientRect()
			const textRange = document.createRange()
			textRange.selectNodeContents(textNode)
			const textRect = textRange.getBoundingClientRect()
			return {
				backgroundColor: getComputedStyle(button).backgroundColor,
				height: buttonRect.height,
				horizontalCenterDelta: Math.abs(buttonRect.left + buttonRect.width / 2 - (textRect.left + textRect.width / 2)),
				rowCenterDelta: Math.abs(buttonRect.top + buttonRect.height / 2 - (rowRect.top + rowRect.height / 2)),
			}
		})
		expect(cancelLayout.height).toBeLessThanOrEqual(20.5)
		expect(cancelLayout.horizontalCenterDelta).toBeLessThanOrEqual(1)
		expect(cancelLayout.rowCenterDelta).toBeLessThanOrEqual(1)
		expect(cancelLayout.backgroundColor).not.toBe("rgba(0, 0, 0, 0)")
		expect(cancelLayout.backgroundColor).not.toBe("transparent")
		const expectedCollapsedOutput = `${renderedText}→   COLUMN⌫`
		const activitySummary = activity.getByTestId("activity-output-summary")
		// The collapsed summary appears once the ANSI progress output arrives, which can
		// lag the activity creation by a few seconds on slow CI machines.
		await expect(activitySummary).toHaveText(expectedCollapsedOutput, { timeout: 30_000 })
		expect(await activitySummary.textContent()).not.toContain("\u001b")
		expect(await activitySummary.textContent()).not.toContain(overwrittenProgress)
		const activityScreenshotPath = testInfo.outputPath("activity-command-layout.png")
		await activity.screenshot({ path: activityScreenshotPath })
		await testInfo.attach("activity-command-layout", { path: activityScreenshotPath, contentType: "image/png" })

		await sidebar.getByRole("tab", { name: "Work", exact: true }).click()
		await expect(sidebar.getByText("E2E_AUTO_BACKGROUND_HANDOFF_READY", { exact: true })).toBeVisible({
			timeout: 60_000,
		})
		const runningStatus = sidebar.getByText("Running", { exact: true })
		await expect(runningStatus).toBeVisible()
		// The chat viewport continuously follows background activity output, so invoke
		// the already-visible header action without waiting for a stationary bounding box.
		await runningStatus.evaluate((element) => element.parentElement?.click())
		const collapsedCommand = sidebar.getByRole("button", { name: command, exact: true })
		await expect(collapsedCommand).toBeVisible()
		const commandSummary = collapsedCommand.getByTestId("command-output-summary")
		await expect(commandSummary).toHaveText(expectedCollapsedOutput)
		expect(await commandSummary.textContent()).not.toContain("\u001b")
		expect(await commandSummary.textContent()).not.toContain(overwrittenProgress)
		const commandScreenshotPath = testInfo.outputPath("collapsed-command-output.png")
		await collapsedCommand.screenshot({ path: commandScreenshotPath })
		await testInfo.attach("collapsed-command-output", { path: commandScreenshotPath, contentType: "image/png" })
		const handoff = server.getMockConsumptions("openai-compatible-chat")[1]
		expect(handoff.contractError).toBeUndefined()

		await sidebar.getByRole("tab", { name: /^Activities(?: \d+)?$/ }).click()
		await sidebar.getByRole("button", { name: "All", exact: true }).first().click()
		await activity.locator("button").first().click()
		const logLink = activity.getByRole("button", { name: /Open log file/ })
		await expect(logLink).toBeVisible({ timeout: 30_000 })
		const logPath = (await logLink.getAttribute("title"))?.replace(/^Click to open:\s*/, "")
		if (!logPath) throw new Error("Background Activity did not expose its log path")
		await expect(activity).toContainText(renderedText, { timeout: 30_000 })
		const activityText = await activity.textContent()
		expect(activityText).toContain("→   COLUMN⌫")
		expect(activityText).not.toContain("\u001b")
		expect(activityText).not.toContain("�")
		const renderedAnsi = activity.locator("pre span").filter({ hasText: renderedText })
		await expect(renderedAnsi).toHaveAttribute("style", /color/i)
		const outputBeforeLog = await activity
			.locator("pre")
			.last()
			.evaluate((output) => {
				const item = output.closest('[data-testid="activity-item"]')
				const link = item?.querySelector('button[title^="Click to open:"]')
				return Boolean(link && output.compareDocumentPosition(link) & Node.DOCUMENT_POSITION_FOLLOWING)
			})
		expect(outputBeforeLog).toBe(true)

		await sidebar.getByRole("tab", { name: /^Activities(?: \d+)?$/ }).click()
		await sidebar.getByRole("button", { name: "All", exact: true }).first().click()
		await expect(activity).toContainText("completed", { timeout: 90_000 })
		await expect.poll(async () => readFile(logPath, "utf8").catch(() => ""), { timeout: 90_000 }).toContain(finishedMarker)
		await sidebar.getByRole("tab", { name: "Work", exact: true }).click()
		await expect(input).toBeEnabled()
		await input.fill("E2E_AUTO_BACKGROUND_FEEDBACK")
		await input.press("Enter")
		await expect(sidebar.getByText("E2E_AUTO_BACKGROUND_RESULT_OK", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		const completion = server.getMockConsumptions("openai-compatible-chat")[2]
		expect(completion.contractError).toBeUndefined()
		const persistedLog = await readFile(logPath, "utf8")
		expect(persistedLog).toContain(startedMarker)
		expect(persistedLog).toContain(renderedText)
		expect(persistedLog).toContain(finishedMarker)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Terminal - synchronous command offers Continue in Background in the footer after the handoff wait",
	async ({ helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(240_000)
		await helper.signin(sidebar)
		await openSettings(page, sidebar)
		await sidebar.getByTestId("tab-terminal").click()
		await setDropdownValue(sidebar, sidebar.locator("#terminal-execution-mode"), "backgroundExec", "Background Exec")
		await returnToChat(sidebar)
		await setAutoApproveAction(sidebar, "Execute safe commands", true)
		server.resetOpenAiMock()
		const command = `node -e "console.log('E2E_MANUAL_HANDOFF_STARTED'); setInterval(() => {}, 1000)"`
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_manual_handoff_command",
				name: "execute_command",
				arguments: {
					command,
					workdirectory: ".",
					requires_approval: false,
					synchronous: true,
					timeout: 0,
				},
			},
			{
				type: "tool",
				id: "call_manual_handoff_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_MANUAL_HANDOFF_MOVED" },
				expectedToolResults: [
					{
						callId: "call_manual_handoff_command",
						contentIncludes: [
							"Command is running in the background",
							"Its final status will be available only in a later model request.",
						],
					},
				],
			},
		)

		const input = sidebar.getByTestId("chat-input")
		await input.fill("E2E_MANUAL_HANDOFF_TASK")
		await sidebar.getByTestId("send-button").click()
		await expect(sidebar.getByTestId("command-execution-mode").last()).toHaveText("Foreground", { timeout: 60_000 })
		const taskFooter = sidebar.getByRole("contentinfo")
		await expect(sidebar.getByRole("button", { name: "Move to background" })).toHaveCount(0)
		const continueInBackground = taskFooter.locator('vscode-button[aria-label="Continue in Background"]')
		const actionRow = continueInBackground.locator("xpath=..")
		const cancel = actionRow.locator('vscode-button[aria-label="Cancel"]')
		await expect(continueInBackground).toBeVisible({ timeout: 40_000 })
		await expect(cancel).toBeVisible()
		await expect(actionRow.locator("vscode-button")).toHaveText(["Continue in Background", "Cancel"])
		await taskFooter.screenshot({ path: e2e.info().outputPath("command-chat-footer-handoff.png") })
		await continueInBackground.click()

		await expect(sidebar.getByText("E2E_MANUAL_HANDOFF_MOVED", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		const handoffConsumption = server.getMockConsumptions("openai-compatible-chat")[1]
		expect(handoffConsumption.requestToolResults[0]?.content).toContain("Command is running in the background")
		expect(handoffConsumption.requestToolResults[0]?.content).toContain(
			"Its final status will be available only in a later model request.",
		)
		expect(handoffConsumption.contractError).toBeUndefined()

		await sidebar.getByRole("tab", { name: /^Activities(?: \d+)?$/ }).click()
		await sidebar.getByRole("button", { name: "All", exact: true }).first().click()
		const activity = sidebar.getByTestId("activity-item").filter({ hasText: command })
		await expect(activity).toHaveCount(1, { timeout: 30_000 })
		const activityCancelButton = activity.getByRole("button", { name: "Cancel", exact: true })
		await expect(activityCancelButton).toBeVisible()
		await activityCancelButton.click()
		await expect(activity).toContainText(/cancelled/i, { timeout: 30_000 })
		await expect(activityCancelButton).toHaveCount(0)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Terminal - task Cancel preserves a manually handed-off command after its tool result reaches the API",
	async ({ helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(240_000)
		await helper.signin(sidebar)
		await openSettings(page, sidebar)
		await sidebar.getByTestId("tab-terminal").click()
		await setDropdownValue(sidebar, sidebar.locator("#terminal-execution-mode"), "backgroundExec", "Background Exec")
		const handoffInput = sidebar.locator("#terminal-command-handoff input")
		await handoffInput.fill("1")
		await expect(handoffInput).toHaveValue("1")
		await returnToChat(sidebar)
		await setAutoApproveAction(sidebar, "Execute safe commands", true)

		const startedMarker = "E2E_TASK_CANCEL_HANDOFF_STARTED"
		const finishedMarker = "E2E_TASK_CANCEL_HANDOFF_FINISHED"
		const command = `node -e "console.log('${startedMarker}'); setTimeout(()=>console.log('${finishedMarker}'),12000)"`
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_task_cancel_handoff_command",
				name: "execute_command",
				arguments: {
					command,
					workdirectory: ".",
					requires_approval: false,
					synchronous: true,
					timeout: 30,
				},
			},
			{
				type: "tool",
				id: "call_task_cancel_handoff_interrupted",
				name: "attempt_completion",
				arguments: { result: "E2E_TASK_CANCEL_HANDOFF_MUST_NOT_RENDER" },
				delayMs: 30_000,
				expectedToolResults: [
					{
						callId: "call_task_cancel_handoff_command",
						contentIncludes: "Command is running in the background",
					},
				],
			},
		)

		const input = sidebar.getByTestId("chat-input")
		await input.fill("Move a command to the background, then cancel only the foreground task.")
		await sidebar.getByTestId("send-button").click()
		await expect(sidebar.getByTestId("command-execution-mode").last()).toHaveText("Foreground", { timeout: 60_000 })
		const taskFooter = sidebar.getByRole("contentinfo")
		await expect(sidebar.getByRole("button", { name: "Move to background" })).toHaveCount(0)
		const continueInBackground = taskFooter.locator('vscode-button[aria-label="Continue in Background"]')
		const taskCancelButton = taskFooter.locator('vscode-button[aria-label="Cancel"]')
		await expect(continueInBackground).toBeVisible({ timeout: 30_000 })
		await expect(taskCancelButton).toBeVisible()
		await continueInBackground.click()

		await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(2)
		const handoffConsumption = server.getMockConsumptions("openai-compatible-chat")[1]
		expect(handoffConsumption.contractError).toBeUndefined()
		expect(handoffConsumption.requestToolResults).toContainEqual(
			expect.objectContaining({
				callId: "call_task_cancel_handoff_command",
				content: expect.stringContaining("Command is running in the background"),
			}),
		)
		await expect(sidebar.getByTestId("command-execution-mode").last()).toHaveText("Background", { timeout: 30_000 })

		await sidebar.getByRole("tab", { name: /^Activities(?: \d+)?$/ }).click()
		await sidebar.getByRole("button", { name: "All", exact: true }).first().click()
		const activity = sidebar.getByTestId("activity-item").filter({ hasText: command })
		await expect(activity).toHaveCount(1, { timeout: 30_000 })
		await activity.locator("button").first().click()
		const logLink = activity.getByRole("button", { name: /Open log file/ })
		await expect(logLink).toBeVisible({ timeout: 30_000 })
		const logPath = (await logLink.getAttribute("title"))?.replace(/^Click to open:\s*/, "")
		if (!logPath) throw new Error("Handed-off command Activity did not expose its log path")

		await sidebar.getByRole("tab", { name: "Work", exact: true }).click()
		await expect(taskCancelButton).toBeVisible({ timeout: 30_000 })
		await taskCancelButton.click()
		await expect(taskFooter.getByText("Resume", { exact: true })).toBeVisible({ timeout: 30_000 })
		await expect(sidebar.getByText("E2E_TASK_CANCEL_HANDOFF_MUST_NOT_RENDER", { exact: false })).toHaveCount(0)

		await expect
			.poll(async () => readFile(logPath, "utf8").catch(() => ""), { timeout: 30_000 })
			.toMatch(new RegExp(`${finishedMarker}|\\[CANCELLED\\]`))
		const persistedLog = await readFile(logPath, "utf8")
		expect(persistedLog).toContain(finishedMarker)
		expect(persistedLog).not.toContain("[CANCELLED] Command cancelled by user")
		expect(server.getMockConsumptions("openai-compatible-chat")[1].abortedAtMs).toBeDefined()

		await sidebar.getByRole("tab", { name: /^Activities(?: \d+)?$/ }).click()
		await sidebar.getByRole("button", { name: "All", exact: true }).first().click()
		await expect(activity).toContainText("completed", { timeout: 30_000 })
		await expect(activity).not.toContainText("Cancelled by user")
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)
