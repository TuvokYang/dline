import { mkdir, readdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { startFooterActionStabilityObserver, stopFooterActionStabilityObserver } from "@e2e/utils/ui-stability"
import { expect, type Frame } from "@playwright/test"

async function setAutoApproveAction(sidebar: Frame, label: string, enabled: boolean): Promise<void> {
	await sidebar.getByLabel("Open auto-approve settings").click()
	const checkbox = sidebar.locator("vscode-checkbox").filter({ hasText: label })
	await expect(checkbox).toHaveCount(1)
	const isChecked = () => checkbox.evaluate((element) => Boolean((element as HTMLInputElement).checked))
	if ((await isChecked()) !== enabled) {
		await sidebar.getByText(label, { exact: true }).click()
	}
	await expect.poll(isChecked).toBe(enabled)
	await sidebar.getByLabel("Close auto-approve settings").click()
}

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

async function expectSingleUserFeedback(sidebar: Frame, text: string): Promise<void> {
	const feedback = sidebar.getByTestId(/^(?:user|queued)-input-markdown-scroll$/).filter({ hasText: text })
	await expect(feedback).toHaveCount(1)
	await expect(feedback).toHaveText(text)
}

async function expectComposerSendReady(sidebar: Frame): Promise<void> {
	await expect(sidebar.getByTestId("chat-input")).toBeEnabled()
	await expect(sidebar.getByTestId("send-button")).toHaveAttribute("aria-disabled", "false")
}

e2e("Tools - auto-approves a project read and continues with its result", async ({ helper, server, sidebar }) => {
	e2e.setTimeout(120_000)
	await helper.signin(sidebar)
	server.resetOpenAiMock()
	server.enqueueOpenAiResponses(
		{ type: "tool", id: "call_auto_read", name: "read_file", arguments: { path: "README.md" } },
		{
			type: "tool",
			id: "call_auto_read_completion",
			name: "attempt_completion",
			arguments: { result: "E2E read completed after the tool result." },
			expectedToolResults: [{ callId: "call_auto_read", contentIncludes: "# Test Workspace" }],
		},
		{
			type: "error",
			status: 500,
			code: "unexpected_additional_request",
			message: "Unexpected additional request after read completion",
		},
	)

	const input = sidebar.getByTestId("chat-input")
	await input.fill("Read the project README and report that the read completed.")
	await sidebar.getByTestId("send-button").click()

	await expect(sidebar.getByText("E2E read completed after the tool result.", { exact: false }).last()).toBeVisible({
		timeout: 60_000,
	})
	expect(server.getMockConsumptions("openai-compatible-chat").map((entry) => entry.toolName)).toEqual([
		"read_file",
		"attempt_completion",
	])
	await expect(input).toBeEnabled()
})

e2e(
	"Tools - ordinary tool results keep mention-like text opaque",
	async ({ helper, server, sidebar, userDataDir, workspaceDir }) => {
		e2e.setTimeout(120_000)
		const sourceFile = "mention-source.txt"
		const targetFile = "mention-target.txt"
		const literalMention = "@/mention-target.txt"
		const secretMarker = "E2E_TOOL_RESULT_MENTION_SECRET_MUST_NOT_LEAK"
		const completion = "E2E_TOOL_RESULT_MENTION_OPAQUE_OK"
		await writeFile(path.join(workspaceDir, sourceFile), `This ordinary tool output contains ${literalMention}.\n`, "utf8")
		await writeFile(path.join(workspaceDir, targetFile), `${secretMarker}\n`, "utf8")

		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{ type: "tool", id: "call_opaque_mention_read", name: "read_file", arguments: { path: sourceFile } },
			{
				type: "tool",
				id: "call_opaque_mention_completion",
				name: "attempt_completion",
				arguments: { result: completion },
				expectedToolResults: [{ callId: "call_opaque_mention_read", contentIncludes: literalMention }],
				expectedRequestIncludes: [literalMention],
				expectedRequestExcludes: [secretMarker],
			},
		)

		await sendTask(sidebar, "Read mention-source.txt and confirm completion without following references inside it.")
		await expect(sidebar.getByText(completion, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		expect(server.getMockConsumptions("openai-compatible-chat").map((entry) => entry.toolName)).toEqual([
			"read_file",
			"attempt_completion",
		])
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Tools - no-timeout muted commands hide successful stdout but preserve failure diagnostics",
	async ({ helper, server, sidebar, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		await expect(readFile(path.join(workspaceDir, ".agents", "bashrc.yml"), "utf8")).rejects.toMatchObject({
			code: "ENOENT",
		})
		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Execute safe commands", true)
		server.resetOpenAiMock()
		const successMarker = "E2E_MUTED_SUCCESS_STDOUT"
		const failureMarker = "E2E_MUTED_FAILURE_STDERR"
		const environmentName = "e2e-environment-name-that-is-intentionally-long"
		const successCommand = `node -e "console.log(['E2E','MUTED','SUCCESS','STDOUT'].join('_'))"`
		const failureCommand = `node -e "console.error('${failureMarker}'); process.stderr.write('\\x1b]0;E2E PowerShell\\x07\\x1b[0m(${environmentName})\\x1b[0m\\n'); process.exit(7)"`
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_muted_success",
				name: "execute_command",
				arguments: {
					command: successCommand,
					workdirectory: ".",
					requires_approval: false,
					synchronous: true,
					timeout: 0,
					mute_stdout: true,
				},
			},
			{
				type: "tool",
				id: "call_muted_failure",
				name: "execute_command",
				arguments: {
					command: failureCommand,
					workdirectory: ".",
					requires_approval: false,
					synchronous: true,
					timeout: 60,
					mute_stdout: true,
				},
				expectedToolResults: [
					{ callId: "call_muted_success", contentIncludes: "Command executed successfully (exit code 0)." },
				],
				expectedRequestExcludes: [successMarker],
			},
			{
				type: "tool",
				id: "call_muted_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_MUTED_COMMANDS_COMPLETE" },
				expectedToolResults: [{ callId: "call_muted_failure", contentIncludes: failureMarker }],
			},
		)

		await sendTask(sidebar, "Run one successful muted command without a timeout, then one failing muted command.")
		await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(3)
		await expect(sidebar.getByText(failureMarker, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		await sidebar.getByRole("button", { name: successCommand, exact: true }).click()
		await expect(sidebar.getByText(successMarker, { exact: false }).last()).toBeVisible()

		await sidebar.getByRole("tab", { name: /^Activities(?: \d+)?$/ }).click()
		await sidebar.getByRole("button", { name: "All", exact: true }).first().click()
		const successActivity = sidebar.getByTestId("activity-item").filter({ hasText: successCommand })
		const failureActivity = sidebar.getByTestId("activity-item").filter({ hasText: failureCommand })
		await expect(successActivity).toHaveCount(1)
		await expect(failureActivity).toHaveCount(1)
		await expect(failureActivity.getByTestId("activity-output-summary")).toContainText(failureMarker)
		await expect(successActivity.getByTestId("activity-environment-label")).toHaveCount(0)
		const environmentMode = failureActivity.getByTestId("activity-environment-mode")
		await expect(failureActivity.getByTestId("activity-environment-label")).toHaveText(`(${environmentName})`)
		const environmentModeLayout = await environmentMode.evaluate((group) => {
			const environment = group.querySelector<HTMLElement>('[data-testid="activity-environment-label"]')
			const mode = group.querySelector<HTMLElement>('[data-testid="activity-execution-mode"]')
			if (!environment || !mode) throw new Error("Environment and execution mode group is incomplete")
			const environmentRect = environment.getBoundingClientRect()
			const modeRect = mode.getBoundingClientRect()
			return {
				centerDelta: Math.abs(environmentRect.top + environmentRect.height / 2 - (modeRect.top + modeRect.height / 2)),
				environmentWidth: environmentRect.width,
				groupWidth: group.getBoundingClientRect().width,
				ordered: environmentRect.left < modeRect.left,
				groupOverflows: group.scrollWidth > group.clientWidth + 1,
				environmentTruncated: environment.scrollWidth > environment.clientWidth,
			}
		})
		expect(environmentModeLayout.centerDelta).toBeLessThanOrEqual(1)
		expect(environmentModeLayout.ordered).toBe(true)
		expect(environmentModeLayout.groupOverflows).toBe(false)
		expect(environmentModeLayout.environmentTruncated).toBe(true)
		await expect(successActivity.getByText("Command", { exact: true })).toHaveCount(0)
		await expect(successActivity.getByTestId("activity-kind-icon")).toHaveCount(1)
		await expect(successActivity.getByLabel(/Command timeout:/)).toHaveCount(0)
		const timeoutIndicator = failureActivity.getByLabel("Command timeout: 60 s")
		const timeoutLayout = await timeoutIndicator.evaluate((indicator) => {
			const icon = indicator.querySelector("svg")
			const label = indicator.querySelector("span")
			if (!icon || !label) throw new Error("Command timeout indicator is incomplete")
			const iconRect = icon.getBoundingClientRect()
			const labelRect = label.getBoundingClientRect()
			const indicatorRect = indicator.getBoundingClientRect()
			const scale = indicator.offsetWidth > 0 ? indicatorRect.width / indicator.offsetWidth : 1
			const expectedHeight = Number.parseFloat(getComputedStyle(label).fontSize) * scale
			return {
				iconHeight: iconRect.height,
				labelHeight: labelRect.height,
				fontSize: Number.parseFloat(getComputedStyle(label).fontSize),
				scale,
				expectedHeight,
				heightDelta: Math.abs(iconRect.height - expectedHeight),
				centerDelta: Math.abs(iconRect.top + iconRect.height / 2 - (labelRect.top + labelRect.height / 2)),
			}
		})
		expect(timeoutLayout.heightDelta, JSON.stringify(timeoutLayout)).toBeLessThanOrEqual(1)
		expect(timeoutLayout.centerDelta).toBeLessThanOrEqual(1)
		await successActivity.getByTestId("activity-toggle").click()
		await failureActivity.getByTestId("activity-toggle").click()
		await expect(successActivity.getByTestId("activity-output-summary")).toHaveCount(0)
		await expect(failureActivity.getByTestId("activity-output-summary")).toHaveCount(0)
		await expect(successActivity.getByTestId("activity-command-line")).toContainText(successCommand)
		await expect(failureActivity.getByTestId("activity-command-line")).toContainText(failureCommand)
		await expect(successActivity.getByTestId("activity-header")).toBeVisible()
		await expect(failureActivity.getByTestId("activity-header")).toBeVisible()
		const activityHierarchy = await failureActivity.evaluate((first) => {
			const list = first.parentElement
			if (!list) throw new Error("Activity list is missing")
			const items = Array.from(list.querySelectorAll<HTMLElement>('[data-testid="activity-item"]'))
			if (items.length < 2) throw new Error("Expected at least two Activity cards")
			const second = items.find((item) => item !== first)
			if (!second) throw new Error("Second Activity card is missing")
			const firstBody = first.querySelector<HTMLElement>('[data-testid="activity-body"]')
			const firstCommand = first.querySelector<HTMLElement>('[data-testid="activity-command-line"]')
			const firstHeader = first.querySelector<HTMLElement>('[data-testid="activity-header"]')
			if (!firstBody || !firstCommand || !firstHeader) throw new Error("Expanded Activity hierarchy is incomplete")
			const firstRect = first.getBoundingClientRect()
			const secondRect = second.getBoundingClientRect()
			const upperRect = firstRect.top <= secondRect.top ? firstRect : secondRect
			const lowerRect = firstRect.top <= secondRect.top ? secondRect : firstRect
			const outerBorder = Number.parseFloat(getComputedStyle(first).borderTopWidth)
			const innerBorder = Number.parseFloat(getComputedStyle(firstBody).borderTopWidth)
			return {
				cardGap: lowerRect.top - upperRect.bottom,
				expectedCardGap: Number.parseFloat(getComputedStyle(document.documentElement).fontSize) * 0.5,
				outerBorder,
				innerBorder,
				outerBorderColor: getComputedStyle(first).borderTopColor,
				innerBorderColor: getComputedStyle(firstBody).borderTopColor,
				overflows: items.some((item) => item.scrollWidth > item.clientWidth + 1),
				commandBackground: getComputedStyle(firstCommand).backgroundColor,
				headerBackground: getComputedStyle(firstHeader).backgroundColor,
			}
		})
		expect(activityHierarchy.cardGap).toBeCloseTo(activityHierarchy.expectedCardGap, 1)
		expect(activityHierarchy.outerBorder).toBeGreaterThan(0)
		expect(activityHierarchy.innerBorder).toBeGreaterThan(0)
		expect(activityHierarchy.outerBorderColor).not.toBe(activityHierarchy.innerBorderColor)
		expect(activityHierarchy.overflows).toBe(false)
		expect(activityHierarchy.commandBackground).not.toBe(activityHierarchy.headerBackground)
		const desktopActivityScreenshot = e2e.info().outputPath("activity-command-hierarchy-desktop.png")
		await sidebar.getByTestId("activity-list").screenshot({ path: desktopActivityScreenshot })
		await e2e.info().attach("activity-command-hierarchy-desktop", {
			path: desktopActivityScreenshot,
			contentType: "image/png",
		})
		const desktopWidth = await sidebar.evaluate(() => document.documentElement.getBoundingClientRect().width)
		const targetNarrowWidth = Math.max(160, Math.floor(desktopWidth * 0.72))
		const narrowWidth = await sidebar.evaluate((width) => {
			document.documentElement.style.width = `${width}px`
			document.body.style.width = `${width}px`
			return document.documentElement.getBoundingClientRect().width
		}, targetNarrowWidth)
		expect(narrowWidth).toBeLessThan(desktopWidth)
		await expect(successActivity).toBeVisible()
		expect(await successActivity.evaluate((item) => item.scrollWidth <= item.clientWidth + 1)).toBe(true)
		const narrowEnvironmentModeLayout = await environmentMode.evaluate((group) => {
			const environment = group.querySelector<HTMLElement>('[data-testid="activity-environment-label"]')
			const mode = group.querySelector<HTMLElement>('[data-testid="activity-execution-mode"]')
			if (!environment || !mode) throw new Error("Environment and execution mode group is incomplete")
			const environmentRect = environment.getBoundingClientRect()
			const modeRect = mode.getBoundingClientRect()
			return {
				centerDelta: Math.abs(environmentRect.top + environmentRect.height / 2 - (modeRect.top + modeRect.height / 2)),
				environmentWidth: environmentRect.width,
				groupWidth: group.getBoundingClientRect().width,
				groupOverflows: group.scrollWidth > group.clientWidth + 1,
				environmentTruncated: environment.scrollWidth > environment.clientWidth,
			}
		})
		expect(narrowEnvironmentModeLayout.centerDelta).toBeLessThanOrEqual(1)
		expect(narrowEnvironmentModeLayout.groupOverflows).toBe(false)
		expect(narrowEnvironmentModeLayout.environmentTruncated).toBe(true)
		expect(narrowEnvironmentModeLayout.groupWidth).toBeLessThan(environmentModeLayout.groupWidth)
		expect(narrowEnvironmentModeLayout.environmentWidth).toBeLessThan(environmentModeLayout.environmentWidth)
		const narrowActivityScreenshot = e2e.info().outputPath("activity-command-hierarchy-narrow.png")
		await sidebar.getByTestId("activity-list").screenshot({ path: narrowActivityScreenshot })
		await e2e.info().attach("activity-command-hierarchy-narrow", {
			path: narrowActivityScreenshot,
			contentType: "image/png",
		})
		const consumptions = server.getMockConsumptions("openai-compatible-chat")
		const successResult = consumptions[1].requestToolResults.find(({ callId }) => callId === "call_muted_success")
		expect(successResult?.content).toContain("Command executed successfully (exit code 0).")
		expect(successResult?.content).not.toContain(successMarker)
		const failureResult = consumptions[2].requestToolResults.find(({ callId }) => callId === "call_muted_failure")
		expect(failureResult?.content).toContain(failureMarker)
		expect(failureResult?.content).toMatch(/Command failed with exit code [1-9]\d*\./)
		expect(failureResult?.content).not.toContain("Command executed successfully")
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Tools - keyboard-typed draft stays local while a foreground command finishes",
	async ({ helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Execute safe commands", false)
		server.resetOpenAiMock()
		const command = `node -e "console.log('E2E_DRAFT_COMMAND_STARTED'); setTimeout(() => console.log('E2E_DRAFT_COMMAND_FINISHED'), 2000)"`
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_unsent_draft_foreground_command",
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
				id: "call_unsent_draft_foreground_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_UNSENT_DRAFT_FOREGROUND_DONE" },
				expectedToolResults: [
					{
						callId: "call_unsent_draft_foreground_command",
						contentIncludes: ["E2E_DRAFT_COMMAND_STARTED", "E2E_DRAFT_COMMAND_FINISHED"],
					},
				],
			},
			{
				type: "error",
				status: 500,
				code: "unexpected_unsent_draft_foreground_request",
				message: "An unsent draft triggered an extra request after a foreground command",
			},
		)

		await sendTask(sidebar, "E2E_UNSENT_DRAFT_FOREGROUND_TASK")
		const approveButton = sidebar.getByText("Approve", { exact: true })
		await expect(approveButton).toBeVisible({ timeout: 60_000 })
		await approveButton.click()
		const copyCommandButton = sidebar.getByRole("button", { name: "Copy command" }).last()
		await expect(copyCommandButton).toBeVisible({ timeout: 60_000 })
		const commandActions = copyCommandButton.locator("xpath=ancestor::div[.//button[normalize-space()='Cancel']][1]")
		await expect(commandActions.getByRole("button", { name: "Cancel", exact: true })).toBeVisible()
		await expect(sidebar.getByTestId("command-execution-mode").last()).toHaveText("Foreground")

		const unsentDraft = "E2E_FOREGROUND_DRAFT_MUST_STAY_LOCAL"
		const input = sidebar.getByTestId("chat-input")
		await input.click()
		await input.pressSequentially(unsentDraft, { delay: 20 })
		await expect(input).toHaveValue(unsentDraft)

		await expect(
			sidebar.getByTestId("completion-output-scroll").filter({ hasText: "E2E_UNSENT_DRAFT_FOREGROUND_DONE" }),
		).toBeVisible({ timeout: 60_000 })
		await page.waitForTimeout(1_000)

		await expect(input).toHaveValue(unsentDraft)
		const submittedFeedback = sidebar.getByTestId(/^(?:direct|queued)-user-input$/).filter({ hasText: unsentDraft })
		await expect(submittedFeedback).toHaveCount(0)
		expect(server.openAiRequestCount).toBe(2)
		expect(JSON.stringify(server.getOpenAiRequestBodies())).not.toContain(unsentDraft)
		expect(server.getMockConsumptions("openai-compatible-chat")[1].contractError).toBeUndefined()
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Tools - parallel read, write, replace, and command return one complete result batch",
	async ({ helper, server, sidebar, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Read project files", true)
		await setAutoApproveAction(sidebar, "Edit project files", true)
		await setAutoApproveAction(sidebar, "Execute safe commands", true)

		const writtenRelativePath = "e2e-parallel-written.txt"
		const writtenPath = path.join(workspaceDir, writtenRelativePath)
		const replacedRelativePath = "e2e-parallel-replaced.txt"
		const replacedPath = path.join(workspaceDir, replacedRelativePath)
		await writeFile(replacedPath, "before\n", "utf8")
		const toolCalls = [
			{ id: "call_parallel_read", name: "read_file", arguments: { path: "README.md" } },
			{
				id: "call_parallel_write",
				name: "write_to_file",
				arguments: { path: writtenRelativePath, content: "parallel write persisted\n" },
			},
			{
				id: "call_parallel_replace",
				name: "replace_in_file",
				arguments: {
					path: replacedRelativePath,
					diff: "------- SEARCH\nbefore\n=======\nafter\n+++++++ REPLACE",
				},
			},
			{
				id: "call_parallel_command",
				name: "execute_command",
				arguments: {
					command: `node -e "process.stdout.write('E2E_PARALLEL_COMMAND_STDOUT')"`,
					workdirectory: ".",
					requires_approval: false,
					synchronous: true,
					timeout: 60,
				},
			},
		] as const

		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{ type: "tools", tools: toolCalls },
			{
				type: "tool",
				id: "call_parallel_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_PARALLEL_TOOL_RESULTS_OK" },
				expectedToolResultCount: 4,
				expectedToolResults: [
					{ callId: "call_parallel_read", contentIncludes: "# Test Workspace" },
					{ callId: "call_parallel_write", contentIncludes: "successfully saved" },
					{ callId: "call_parallel_replace", contentIncludes: "successfully replaced" },
					{
						callId: "call_parallel_command",
						contentIncludes: ["Command executed successfully (exit code 0).", "E2E_PARALLEL_COMMAND_STDOUT"],
					},
				],
			},
			{
				type: "error",
				status: 500,
				code: "unexpected_additional_request",
				message: "Unexpected request after parallel tools completed",
			},
		)

		await sendTask(sidebar, "Run four independent tools in one parallel response.")
		await expect(sidebar.getByText("E2E_PARALLEL_TOOL_RESULTS_OK", { exact: false }).last()).toBeVisible({
			timeout: 90_000,
		})
		expect((await readFile(writtenPath, "utf8")).replaceAll("\r\n", "\n")).toBe("parallel write persisted\n")
		expect((await readFile(replacedPath, "utf8")).replaceAll("\r\n", "\n")).toBe("after\n")

		const consumptions = server.getMockConsumptions("openai-compatible-chat")
		expect(consumptions).toHaveLength(2)
		expect(consumptions[0]).toMatchObject({ responseType: "tools", responseToolCalls: toolCalls })
		expect(consumptions[1].contractError).toBeUndefined()
		expect(consumptions[1].requestToolResults).toHaveLength(4)
		for (const tool of toolCalls) {
			expect(consumptions[1].requestToolResults.filter((result) => result.callId === tool.id)).toHaveLength(1)
		}
		await expect(sidebar.getByRole("button", { name: "Copy command" }).last()).toBeVisible()
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Tools - Process Anyway preserves successful parallel tool results at the mistake limit",
	async ({ helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Read project files", true)

		const callIds = [
			"call_mistake_limit_read_1",
			"call_mistake_limit_read_2",
			"call_mistake_limit_read_3",
			"call_mistake_limit_parallel_read_4",
			"call_mistake_limit_parallel_read_5",
		] as const
		const readCall = (id: (typeof callIds)[number]) => ({ id, name: "read_file", arguments: { path: "README.md" } })
		const expectedResults = (ids: readonly (typeof callIds)[number][]) =>
			ids.map((callId) => ({ callId, contentIncludes: "# Test Workspace" }))
		const guidance = "E2E_PROCESS_ANYWAY_PRESERVE_RESULTS_GUIDANCE"

		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{ type: "tool", ...readCall(callIds[0]) },
			{
				type: "tool",
				...readCall(callIds[1]),
				expectedToolResultCount: 1,
				expectedToolResults: expectedResults(callIds.slice(0, 1)),
			},
			{
				type: "tool",
				...readCall(callIds[2]),
				expectedToolResultCount: 2,
				expectedToolResults: expectedResults(callIds.slice(0, 2)),
			},
			{
				type: "tools",
				tools: [readCall(callIds[3]), readCall(callIds[4])],
				expectedToolResultCount: 3,
				expectedToolResults: expectedResults(callIds.slice(0, 3)),
			},
			{
				type: "tool",
				id: "call_mistake_limit_preserved_results_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_PROCESS_ANYWAY_PRESERVED_RESULTS_OK" },
				expectedToolResultCount: 5,
				expectedToolResults: expectedResults(callIds),
				expectedRequestIncludes: [guidance],
			},
			{
				type: "error",
				status: 500,
				code: "unexpected_additional_request",
				message: "Unexpected request after Process Anyway preserved the parallel tool results",
			},
		)

		await sendTask(sidebar, "Repeat the same project read until the mistake-limit recovery is required.")
		await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(4)

		const attention = sidebar.getByTestId("error-message-box")
		await expect(attention.getByText("Task Needs Attention", { exact: true })).toBeVisible({ timeout: 60_000 })
		const processAnyway = sidebar.getByRole("contentinfo").locator('vscode-button[aria-label="Process Anyway"]')
		await expect(processAnyway).toBeVisible()

		const input = sidebar.getByTestId("chat-input")
		await input.fill(guidance)
		await processAnyway.click()
		await expect(input).toHaveValue("")
		await expectSingleUserFeedback(sidebar, guidance)
		await expect(sidebar.getByText("E2E_PROCESS_ANYWAY_PRESERVED_RESULTS_OK", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => server.openAiRequestCount).toBe(5)

		const consumptions = server.getMockConsumptions("openai-compatible-chat")
		expect(consumptions.map((entry) => entry.responseType)).toEqual(["tool", "tool", "tool", "tools", "tool"])
		const continuation = consumptions[4]
		expect(continuation.contractError).toBeUndefined()
		expect(continuation.requestToolResults).toHaveLength(5)
		for (const callId of callIds) {
			expect(continuation.requestToolResults.filter((result) => result.callId === callId)).toHaveLength(1)
		}
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Tools - project read approval carries the input draft into the continuation",
	async ({ helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(120_000)
		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Read project files", false)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{ type: "tool", id: "call_approved_read", name: "read_file", arguments: { path: "README.md" } },
			{
				type: "tool",
				id: "call_approved_read_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_READ_APPROVAL_DRAFT_OK" },
				expectedToolResults: [{ callId: "call_approved_read", contentIncludes: "# Test Workspace" }],
				expectedRequestIncludes: ["E2E_READ_APPROVAL_NOTE"],
			},
		)

		await sendTask(sidebar, "Request an explicitly approved project read.")
		const approveButton = sidebar.getByText("Approve", { exact: true })
		await expect(approveButton).toBeVisible({ timeout: 60_000 })
		await startFooterActionStabilityObserver(sidebar, ["Approve"])
		await sidebar.page().waitForTimeout(750)
		const approvalStabilityEvents = await stopFooterActionStabilityObserver(sidebar)
		expect(approvalStabilityEvents).toEqual([])
		const input = sidebar.getByTestId("chat-input")
		await input.fill("E2E_READ_APPROVAL_NOTE")
		await approveButton.click()

		await expect(input).toHaveValue("")
		await expectSingleUserFeedback(sidebar, "E2E_READ_APPROVAL_NOTE")
		await expect(sidebar.getByText("E2E_READ_APPROVAL_DRAFT_OK", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => server.openAiRequestCount).toBe(2)
		const continuation = server.getMockConsumptions("openai-compatible-chat")[1]
		expect(continuation.requestToolResults).toContainEqual(
			expect.objectContaining({ callId: "call_approved_read", content: expect.stringContaining("# Test Workspace") }),
		)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Tools - rejected project read does not execute and carries rejection feedback",
	async ({ helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(120_000)
		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Read project files", false)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{ type: "tool", id: "call_rejected_read", name: "read_file", arguments: { path: "README.md" } },
			{
				type: "tool",
				id: "call_rejected_read_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_READ_REJECTION_CONTINUED" },
				expectedToolResults: [{ callId: "call_rejected_read", contentIncludes: "The user denied this operation." }],
				expectedRequestIncludes: ["E2E_READ_REJECT_FEEDBACK"],
			},
		)

		await sendTask(sidebar, "Request a project read that will be rejected.")
		const rejectButton = sidebar.getByText("Reject", { exact: true })
		await expect(rejectButton).toBeVisible({ timeout: 60_000 })
		const input = sidebar.getByTestId("chat-input")
		await input.fill("E2E_READ_REJECT_FEEDBACK")
		await rejectButton.click()

		await expect(input).toHaveValue("")
		await expectSingleUserFeedback(sidebar, "E2E_READ_REJECT_FEEDBACK")
		await expect(sidebar.getByText("E2E_READ_REJECTION_CONTINUED", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => server.openAiRequestCount).toBe(2)
		const continuation = server.getMockConsumptions("openai-compatible-chat")[1]
		expect(continuation.requestToolResults).toContainEqual(
			expect.objectContaining({
				callId: "call_rejected_read",
				content: expect.stringContaining("The user denied this operation."),
			}),
		)
		const rejectedReadResult = continuation.requestToolResults.find(({ callId }) => callId === "call_rejected_read")
		expect(rejectedReadResult?.content).toContain("E2E_READ_REJECT_FEEDBACK")
		expect(JSON.stringify(continuation.requestBody)).not.toContain("This workspace is used for testing the extension")
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Tools - rejecting a missing external path between project reads persists skipped results",
	async ({ dlineDocsDir, helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(120_000)
		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Read project files", true)
		server.resetOpenAiMock()

		const missingExternalPath = path.join(dlineDocsDir, "missing-external", "does-not-exist.txt")
		const skippedReason = "The tool was skipped after an earlier interaction was rejected."
		server.enqueueOpenAiResponses(
			{
				type: "tools",
				tools: [
					{ id: "call_batch_local_before", name: "read_file", arguments: { path: "README.md" } },
					{ id: "call_batch_missing_external", name: "read_file", arguments: { path: missingExternalPath } },
					{ id: "call_batch_local_after", name: "read_file", arguments: { path: "test.ts" } },
					{ id: "call_batch_search_after", name: "search_files", arguments: { path: ".", regex: "Test Workspace" } },
				],
			},
			{
				type: "tool",
				id: "call_batch_missing_external_continuation",
				name: "attempt_completion",
				arguments: { result: "E2E_MISSING_EXTERNAL_REJECTION_CONTINUED" },
				expectedToolResultCount: 4,
				expectedToolResults: [
					{ callId: "call_batch_local_before", contentIncludes: "# Test Workspace" },
					{ callId: "call_batch_missing_external", contentIncludes: "The user denied this operation." },
					{ callId: "call_batch_local_after", contentIncludes: skippedReason },
					{ callId: "call_batch_search_after", contentIncludes: skippedReason },
				],
				expectedRequestExcludes: ["prior session ended before it was stored"],
			},
		)

		await sendTask(sidebar, "Read the requested project files and the external path in one batch.")
		const rejectButton = sidebar.getByText("Reject", { exact: true })
		await expect(rejectButton).toBeVisible({ timeout: 60_000 })
		await rejectButton.click()

		await expect(sidebar.getByText("E2E_MISSING_EXTERNAL_REJECTION_CONTINUED", { exact: false }).last()).toBeVisible({
			timeout: 30_000,
		})
		await expect.poll(() => server.openAiRequestCount).toBe(2)

		const taskId = await E2ETestHelper.waitForValue(async () => {
			const entries = await readdir(path.join(dlineDocsDir, "tasks"), { withFileTypes: true }).catch(() => [])
			const ids = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
			return ids.length === 1 ? ids[0] : undefined
		}, 30_000)
		if (!taskId) throw new Error("E2E task directory was not created")
		const durableHistoryPath = path.join(dlineDocsDir, "tasks", taskId, "api_conversation_history.jsonl")

		await sidebar.getByRole("button", { name: "Close Task", exact: true }).click()
		await expect(sidebar.getByTestId("chat-input")).toBeVisible()
		const durableHistory = await E2ETestHelper.waitForValue(async () => {
			const content = await readFile(durableHistoryPath, "utf8").catch(() => "")
			return content.includes('"function_id":"call_batch_search_after"') ? content : undefined
		}, 30_000)
		if (!durableHistory) throw new Error("Skipped tool results were not flushed to durable history")
		expect(durableHistory).toContain('"function_id":"call_batch_local_after"')
		expect(durableHistory.split(skippedReason)).toHaveLength(3)
		expect(durableHistory).not.toContain("prior session ended before it was stored")
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Tools - Enter rejects pending read, write, and command approvals with the current draft",
	async ({ helper, server, sidebar, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Read project files", false)
		await setAutoApproveAction(sidebar, "Edit project files", false)
		await setAutoApproveAction(sidebar, "Execute safe commands", false)
		server.resetOpenAiMock()
		const relativePath = "e2e-enter-rejected-write.txt"
		const filePath = path.join(workspaceDir, relativePath)
		const commandMarker = "E2E_ENTER_REJECTED_COMMAND_MUST_NOT_RUN"
		server.enqueueOpenAiResponses(
			{ type: "tool", id: "call_enter_rejected_read", name: "read_file", arguments: { path: "README.md" } },
			{
				type: "tool",
				id: "call_enter_rejected_write",
				name: "write_to_file",
				arguments: { path: relativePath, content: "must be reverted\n" },
				expectedToolResults: [{ callId: "call_enter_rejected_read", contentIncludes: "The user denied this operation." }],
				expectedRequestIncludes: ["E2E_ENTER_READ_FEEDBACK"],
			},
			{
				type: "tool",
				id: "call_enter_rejected_command",
				name: "execute_command",
				arguments: {
					command: `node -e "console.log('${commandMarker}')"`,
					workdirectory: ".",
					requires_approval: true,
					synchronous: true,
					timeout: 60,
				},
				expectedToolResults: [
					{ callId: "call_enter_rejected_write", contentIncludes: "The user denied this operation." },
				],
				expectedRequestIncludes: ["E2E_ENTER_WRITE_FEEDBACK"],
			},
			{
				type: "tool",
				id: "call_enter_rejected_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_ENTER_APPROVAL_REJECTION_OK" },
				expectedToolResults: [
					{ callId: "call_enter_rejected_command", contentIncludes: "The user denied this operation." },
				],
				expectedRequestIncludes: ["E2E_ENTER_COMMAND_FEEDBACK"],
			},
		)

		await sendTask(sidebar, "Reject three approval tools by pressing Enter with feedback.")
		const input = sidebar.getByTestId("chat-input")
		await expect(sidebar.getByText("Approve", { exact: true })).toBeVisible({ timeout: 60_000 })
		await expectComposerSendReady(sidebar)
		await input.fill("E2E_ENTER_READ_FEEDBACK")
		await input.press("Enter")
		await expect(input).toHaveValue("")
		await expectSingleUserFeedback(sidebar, "E2E_ENTER_READ_FEEDBACK")
		await expect(sidebar.getByText(relativePath, { exact: false }).last()).toBeVisible({ timeout: 60_000 })

		await expectComposerSendReady(sidebar)
		await input.fill("E2E_ENTER_WRITE_FEEDBACK")
		await input.press("Enter")
		await expect(input).toHaveValue("")
		await expectSingleUserFeedback(sidebar, "E2E_ENTER_WRITE_FEEDBACK")
		await expect(sidebar.getByRole("button", { name: "Copy command" }).last()).toBeVisible({ timeout: 60_000 })
		await expect
			.poll(() =>
				readFile(filePath, "utf8")
					.then(() => true)
					.catch(() => false),
			)
			.toBe(false)

		await expectComposerSendReady(sidebar)
		await input.fill("E2E_ENTER_COMMAND_FEEDBACK")
		await input.press("Enter")
		await expect(input).toHaveValue("")
		await expectSingleUserFeedback(sidebar, "E2E_ENTER_COMMAND_FEEDBACK")
		await expect(sidebar.getByText("E2E_ENTER_APPROVAL_REJECTION_OK", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		const skippedCommand = sidebar.getByTestId("command-card").filter({ hasText: "Skipped" }).last()
		await expect(skippedCommand).toBeVisible()
		await expect(skippedCommand.getByTestId("command-status-icon")).toHaveClass(/lucide-circle-slash/)
		await expect(skippedCommand.locator(".lucide-circle-x")).toHaveCount(0)
		await expect(sidebar.getByText(commandMarker, { exact: true })).toHaveCount(0)
		await expect.poll(() => server.openAiRequestCount).toBe(4)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Tools - approved write, rejected replace, and approved retry preserve real workspace state",
	async ({ helper, server, sidebar, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_write_file",
				name: "write_to_file",
				arguments: { path: "e2e-tool-file.txt", content: "alpha\n" },
			},
			{
				type: "tool",
				id: "call_rejected_replace",
				name: "replace_in_file",
				arguments: {
					path: "e2e-tool-file.txt",
					diff: "------- SEARCH\nalpha\n=======\nbeta\n+++++++ REPLACE",
				},
				expectedToolResults: [{ callId: "call_write_file", contentIncludes: "successfully saved" }],
				expectedRequestIncludes: ["E2E_WRITE_APPROVAL_NOTE"],
			},
			{
				type: "tool",
				id: "call_approved_replace",
				name: "replace_in_file",
				arguments: {
					path: "e2e-tool-file.txt",
					diff: "------- SEARCH\nalpha\n=======\nbeta\n+++++++ REPLACE",
				},
				expectedToolResults: [
					{
						callId: "call_rejected_replace",
						contentIncludes: ["The user denied this operation.", "file was not updated"],
					},
				],
				expectedRequestIncludes: ["E2E_REPLACE_REJECT_FEEDBACK"],
			},
			{
				type: "tool",
				id: "call_write_replace_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_WRITE_REPLACE_OK" },
				expectedToolResults: [{ callId: "call_approved_replace", contentIncludes: "successfully replaced" }],
			},
		)

		await sendTask(sidebar, "Create and then edit a project file with explicit approval.")
		const approveButton = sidebar.getByText("Approve", { exact: true })
		await expect(approveButton).toBeVisible({ timeout: 60_000 })
		const input = sidebar.getByTestId("chat-input")
		await input.fill("E2E_WRITE_APPROVAL_NOTE")
		await approveButton.click()

		const filePath = path.join(workspaceDir, "e2e-tool-file.txt")
		await expect
			.poll(async () =>
				readFile(filePath, "utf8")
					.then((text) => text.replaceAll("\r\n", "\n"))
					.catch(() => ""),
			)
			.toBe("alpha\n")
		const rejectButton = sidebar.getByText("Reject", { exact: true })
		await expect(rejectButton).toBeVisible({ timeout: 60_000 })
		await input.fill("E2E_REPLACE_REJECT_FEEDBACK")
		await rejectButton.click()
		await expect(input).toHaveValue("")
		await expect.poll(async () => (await readFile(filePath, "utf8")).replaceAll("\r\n", "\n")).toBe("alpha\n")
		await expect(approveButton).toBeVisible({ timeout: 60_000 })
		await approveButton.click()
		await expect.poll(async () => (await readFile(filePath, "utf8")).replaceAll("\r\n", "\n")).toBe("beta\n")
		await expect(sidebar.getByText("E2E_WRITE_REPLACE_OK", { exact: false }).last()).toBeVisible({ timeout: 60_000 })

		await expect.poll(() => server.openAiRequestCount).toBe(4)
		const consumptions = server.getMockConsumptions("openai-compatible-chat")
		expect(consumptions.map((entry) => entry.toolName)).toEqual([
			"write_to_file",
			"replace_in_file",
			"replace_in_file",
			"attempt_completion",
		])
		expect(consumptions[2].requestToolResults).toContainEqual(
			expect.objectContaining({
				callId: "call_rejected_replace",
				content: expect.stringContaining("file was not updated"),
			}),
		)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Tools - Cancel after an approved read resumes with the durable read result",
	async ({ helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Read project files", false)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{ type: "tool", id: "call_cancel_approved_read", name: "read_file", arguments: { path: "README.md" } },
			{
				type: "tool",
				id: "call_cancel_approved_read_interrupted",
				name: "attempt_completion",
				arguments: { result: "E2E_CANCEL_APPROVED_READ_MUST_NOT_RENDER" },
				delayMs: 30_000,
				expectedToolResults: [{ callId: "call_cancel_approved_read", contentIncludes: "# Test Workspace" }],
			},
			{
				type: "tool",
				id: "call_cancel_approved_read_resumed",
				name: "attempt_completion",
				arguments: { result: "E2E_CANCEL_APPROVED_READ_RESUME_OK" },
				expectedToolResults: [{ callId: "call_cancel_approved_read", contentIncludes: "# Test Workspace" }],
				expectedRequestIncludes: ["E2E_CANCEL_APPROVED_READ_RESUME_DRAFT"],
			},
		)

		await sendTask(sidebar, "Approve a read, then cancel its in-flight continuation.")
		const approveButton = sidebar.getByText("Approve", { exact: true })
		await expect(approveButton).toBeVisible({ timeout: 60_000 })
		await approveButton.click()
		await expect(sidebar.getByText("Dline read 1 file:", { exact: true })).toBeVisible({ timeout: 30_000 })
		await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(2)

		const taskFooter = sidebar.getByRole("contentinfo")
		const cancelButton = taskFooter.getByText("Cancel", { exact: true })
		await expect(cancelButton).toBeVisible({ timeout: 30_000 })
		await cancelButton.click()
		const resumeButton = taskFooter.getByText("Resume", { exact: true })
		await expect(resumeButton).toBeVisible({ timeout: 30_000 })
		await expect(sidebar.getByText("E2E_CANCEL_APPROVED_READ_MUST_NOT_RENDER", { exact: false })).toHaveCount(0)

		const input = sidebar.getByTestId("chat-input")
		await input.fill("E2E_CANCEL_APPROVED_READ_RESUME_DRAFT")
		await resumeButton.click()
		await expect(sidebar.getByText("E2E_CANCEL_APPROVED_READ_RESUME_OK", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => server.openAiRequestCount).toBe(3)
		const continuation = server.getMockConsumptions("openai-compatible-chat")[2]
		expect(continuation.contractError).toBeUndefined()
		expect(continuation.requestToolResults).toContainEqual(
			expect.objectContaining({
				callId: "call_cancel_approved_read",
				content: expect.stringContaining("# Test Workspace"),
			}),
		)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Tools - Cancel after an approved write resumes without repeating the write",
	async ({ helper, server, sidebar, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Edit project files", false)
		server.resetOpenAiMock()
		const relativePath = "e2e-cancel-approved-write.txt"
		const filePath = path.join(workspaceDir, relativePath)
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_cancel_approved_write",
				name: "write_to_file",
				arguments: { path: relativePath, content: "write survives cancellation\n" },
			},
			{
				type: "tool",
				id: "call_cancel_approved_write_interrupted",
				name: "attempt_completion",
				arguments: { result: "E2E_CANCEL_APPROVED_WRITE_MUST_NOT_RENDER" },
				delayMs: 30_000,
				expectedToolResults: [{ callId: "call_cancel_approved_write", contentIncludes: "successfully saved" }],
			},
			{
				type: "tool",
				id: "call_cancel_approved_write_resumed",
				name: "attempt_completion",
				arguments: { result: "E2E_CANCEL_APPROVED_WRITE_RESUME_OK" },
				expectedToolResults: [{ callId: "call_cancel_approved_write", contentIncludes: "successfully saved" }],
				expectedRequestIncludes: ["E2E_CANCEL_APPROVED_WRITE_RESUME_DRAFT"],
			},
		)

		await sendTask(sidebar, "Approve a write, then cancel its in-flight continuation.")
		const approveButton = sidebar.getByText("Approve", { exact: true })
		await expect(approveButton).toBeVisible({ timeout: 60_000 })
		await approveButton.click()
		await expect
			.poll(async () =>
				readFile(filePath, "utf8")
					.then((text) => text.replaceAll("\r\n", "\n"))
					.catch(() => ""),
			)
			.toBe("write survives cancellation\n")
		await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(2)

		const taskFooter = sidebar.getByRole("contentinfo")
		const cancelButton = taskFooter.getByText("Cancel", { exact: true })
		await expect(cancelButton).toBeVisible({ timeout: 30_000 })
		await cancelButton.click()
		const resumeButton = taskFooter.getByText("Resume", { exact: true })
		await expect(resumeButton).toBeVisible({ timeout: 30_000 })
		await expect(sidebar.getByText("E2E_CANCEL_APPROVED_WRITE_MUST_NOT_RENDER", { exact: false })).toHaveCount(0)

		const input = sidebar.getByTestId("chat-input")
		await input.fill("E2E_CANCEL_APPROVED_WRITE_RESUME_DRAFT")
		await resumeButton.click()
		await expect(sidebar.getByText("E2E_CANCEL_APPROVED_WRITE_RESUME_OK", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => server.openAiRequestCount).toBe(3)
		expect(await readFile(filePath, "utf8")).toContain("write survives cancellation")
		const continuation = server.getMockConsumptions("openai-compatible-chat")[2]
		expect(continuation.contractError).toBeUndefined()
		expect(continuation.requestToolResults).toContainEqual(
			expect.objectContaining({
				callId: "call_cancel_approved_write",
				content: expect.stringContaining("successfully saved"),
			}),
		)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Tools - approved foreground command reports output, copies the command, and returns exit status",
	async ({ app, helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Execute safe commands", false)
		server.resetOpenAiMock()
		const command = `node -e "process.stdout.write('E2E_COMMAND_STDOUT')"`
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_successful_command",
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
				id: "call_successful_command_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_COMMAND_APPROVAL_OK" },
				expectedToolResults: [
					{
						callId: "call_successful_command",
						contentIncludes: ["Command executed successfully (exit code 0).", "E2E_COMMAND_STDOUT"],
					},
				],
				expectedRequestIncludes: ["E2E_COMMAND_APPROVAL_NOTE"],
			},
		)

		await sendTask(sidebar, "Run a foreground command with explicit approval.")
		const approveButton = sidebar.getByText("Approve", { exact: true })
		await expect(approveButton).toBeVisible({ timeout: 60_000 })
		await startFooterActionStabilityObserver(sidebar, ["Approve"])
		await sidebar.page().waitForTimeout(750)
		const approvalStabilityEvents = await stopFooterActionStabilityObserver(sidebar)
		expect(approvalStabilityEvents).toEqual([])
		const input = sidebar.getByTestId("chat-input")
		await input.fill("E2E_COMMAND_APPROVAL_NOTE")
		await approveButton.click()

		await expect(sidebar.getByText("E2E_COMMAND_APPROVAL_OK", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		const copyCommandButton = sidebar.getByRole("button", { name: "Copy command" }).last()
		await expect(copyCommandButton).toBeVisible()
		await copyCommandButton.click()
		await expect(sidebar.getByRole("button", { name: "Copied" }).last()).toBeVisible()
		expect(await app.evaluate(({ clipboard }) => clipboard.readText())).toBe(command)
		await expect.poll(() => server.openAiRequestCount).toBe(2)
		const continuation = server.getMockConsumptions("openai-compatible-chat")[1]
		expect(continuation.requestToolResults).toContainEqual(
			expect.objectContaining({
				callId: "call_successful_command",
				content: expect.stringContaining("E2E_COMMAND_STDOUT"),
			}),
		)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Tools - command-row Cancel terminates only the running foreground command and returns cancellation",
	async ({ helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Execute safe commands", false)
		server.resetOpenAiMock()
		const command = `node -e "console.log('E2E_COMMAND_CANCEL_STARTED'); setInterval(() => {}, 1000)"`
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_cancelled_command",
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
				id: "call_cancelled_command_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_COMMAND_CANCEL_OK" },
				expectedToolResults: [
					{ callId: "call_cancelled_command", contentIncludes: "Command was cancelled by the user." },
				],
			},
		)

		await sendTask(sidebar, "Run a foreground command and wait for command-specific cancellation.")
		const approveButton = sidebar.getByText("Approve", { exact: true })
		await expect(approveButton).toBeVisible({ timeout: 60_000 })
		await approveButton.click()

		const copyCommandButton = sidebar.getByRole("button", { name: "Copy command" }).last()
		await expect(copyCommandButton).toBeVisible({ timeout: 60_000 })
		const commandActions = copyCommandButton.locator("xpath=ancestor::div[.//button[normalize-space()='Cancel']][1]")
		const commandCancelButton = commandActions.getByRole("button", { name: "Cancel", exact: true })
		await expect(commandCancelButton).toBeVisible({ timeout: 60_000 })
		await commandCancelButton.evaluate((element) => element.setAttribute("data-e2e-footer-stability", "command-cancel"))
		await startFooterActionStabilityObserver(sidebar, ["Cancel"], '[data-e2e-footer-stability="command-cancel"]')
		await sidebar.page().waitForTimeout(750)
		const commandCancelStabilityEvents = await stopFooterActionStabilityObserver(sidebar)
		expect(commandCancelStabilityEvents).toEqual([])
		await commandCancelButton.click()

		const cancelledCommand = sidebar.getByTestId("command-card").filter({ hasText: "Cancelled" }).last()
		await expect(cancelledCommand).toBeVisible({ timeout: 30_000 })
		await expect(cancelledCommand.getByTestId("command-status-icon")).toHaveClass(/lucide-circle-slash/)
		await expect(cancelledCommand.locator(".lucide-circle-x")).toHaveCount(0)
		const cancelledScreenshotPath = e2e.info().outputPath("cancelled-command-neutral-icon.png")
		await cancelledCommand.screenshot({ path: cancelledScreenshotPath })
		await e2e.info().attach("cancelled-command-neutral-icon", {
			path: cancelledScreenshotPath,
			contentType: "image/png",
		})
		await expect(sidebar.getByText("E2E_COMMAND_CANCEL_OK", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		const consumptions = server.getMockConsumptions("openai-compatible-chat")
		expect(consumptions.map((entry) => entry.toolName)).toEqual(["execute_command", "attempt_completion"])
		expect(consumptions[1].requestToolResults).toContainEqual(
			expect.objectContaining({
				callId: "call_cancelled_command",
				content: expect.stringContaining("Command was cancelled by the user."),
			}),
		)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Tools - command-row Cancel stops an explicit background command and injects its final status",
	async ({ helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Execute safe commands", false)
		server.resetOpenAiMock()
		const command = `node -e "console.log('E2E_BACKGROUND_COMMAND_STARTED'); setInterval(() => {}, 1000)"`
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_background_command",
				name: "execute_command",
				arguments: {
					command,
					workdirectory: ".",
					requires_approval: true,
					background: true,
					timeout: 60,
				},
			},
			{
				type: "tool",
				id: "call_background_command_qna",
				name: "qna_respond",
				arguments: { response: "E2E_BACKGROUND_COMMAND_READY_TO_CANCEL" },
				expectedToolResults: [
					{ callId: "call_background_command", contentIncludes: "Command is running in the background." },
				],
			},
			{
				type: "tool",
				id: "call_background_command_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_BACKGROUND_COMMAND_CANCEL_OK" },
				expectedRequestIncludes: [
					"E2E_BACKGROUND_COMMAND_CANCEL_FEEDBACK",
					"# Background Results",
					"## Background Command Results",
					"E2E_BACKGROUND_COMMAND_STARTED",
					"cancelled",
				],
			},
		)

		await sendTask(sidebar, "Start an explicit background command and wait for command-specific cancellation.")
		const approveButton = sidebar.getByText("Approve", { exact: true })
		await expect(approveButton).toBeVisible({ timeout: 60_000 })
		await approveButton.click()
		await expect(sidebar.getByText("E2E_BACKGROUND_COMMAND_READY_TO_CANCEL", { exact: true })).toBeVisible({
			timeout: 60_000,
		})

		const copyCommandButton = sidebar.getByRole("button", { name: "Copy command" }).last()
		await expect(copyCommandButton).toBeVisible()
		const commandActions = copyCommandButton.locator("xpath=ancestor::div[.//button[normalize-space()='Cancel']][1]")
		const commandCancelButton = commandActions.getByRole("button", { name: "Cancel", exact: true })
		await expect(commandCancelButton).toBeVisible({ timeout: 30_000 })
		await commandCancelButton.click()
		await expect(sidebar.getByText("Cancelled", { exact: true }).last()).toBeVisible({ timeout: 30_000 })

		const input = sidebar.getByTestId("chat-input")
		await input.fill("E2E_BACKGROUND_COMMAND_CANCEL_FEEDBACK")
		await input.press("Enter")
		await expect(input).toHaveValue("")
		await expect(sidebar.getByText("E2E_BACKGROUND_COMMAND_CANCEL_OK", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})

		await expect.poll(() => server.openAiRequestCount).toBe(3)
		const continuation = server.getMockConsumptions("openai-compatible-chat")[2]
		expect(continuation.contractError).toBeUndefined()
		const continuationRequest = JSON.stringify(continuation.requestBody)
		expect(continuationRequest).toContain("# Background Results")
		expect(continuationRequest).toContain("## Background Command Results")
		expect(continuationRequest).toContain("E2E_BACKGROUND_COMMAND_STARTED")
		expect(continuationRequest).toContain("cancelled")
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Tools - kill_command terminates the exact background execute_command by function_id",
	async ({ helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Execute safe commands", false)
		server.resetOpenAiMock()
		const executeFunctionId = "call_ai_kill_background_command"
		const killFunctionId = "call_ai_kill_command"
		const command = `node -e "console.log('E2E_AI_KILL_STARTED'); setInterval(() => {}, 1000)"`
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: executeFunctionId,
				name: "execute_command",
				arguments: {
					command,
					workdirectory: ".",
					requires_approval: true,
					background: true,
					timeout: 60,
				},
			},
			{
				type: "tool",
				id: killFunctionId,
				name: "kill_command",
				arguments: { function_id: executeFunctionId },
				expectedToolResults: [
					{
						callId: executeFunctionId,
						contentIncludes: ["Command is running in the background.", `function_id: ${executeFunctionId}`],
					},
				],
			},
			{
				type: "tool",
				id: "call_ai_kill_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_AI_KILL_COMMAND_OK" },
				expectedToolResults: [
					{ callId: killFunctionId, contentIncludes: "Termination was requested for the running command." },
				],
			},
		)

		await sendTask(sidebar, "Start a background command, then terminate it with kill_command.")
		const approveButton = sidebar.getByText("Approve", { exact: true })
		await expect(approveButton).toBeVisible({ timeout: 60_000 })
		await approveButton.click()

		await expect(sidebar.getByText("Dline requested command termination:", { exact: true })).toBeVisible({
			timeout: 60_000,
		})
		const killResult = sidebar.getByTestId("kill-command-result")
		await expect(killResult.getByText(command, { exact: true })).toBeVisible()
		await expect(killResult.getByText(executeFunctionId, { exact: true })).toHaveCount(0)
		await expect(killResult.getByText("Termination was requested for the running command.", { exact: true })).toBeVisible()
		await expect(sidebar.getByText("E2E_AI_KILL_COMMAND_OK", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		await killResult.getByRole("button", { name: "View command activity", exact: true }).click()
		await expect(sidebar.getByRole("tab", { name: /Activities/ })).toHaveAttribute("aria-selected", "true")
		const commandActivity = sidebar.getByTestId("activity-item").filter({ hasText: "E2E_AI_KILL_STARTED" })
		await expect(commandActivity).toBeVisible()
		await expect(commandActivity.getByRole("button", { name: /^Open log file / })).toBeVisible()
		await expect.poll(() => server.openAiRequestCount).toBe(3)
		const consumptions = server.getMockConsumptions("openai-compatible-chat")
		expect(consumptions.map((entry) => entry.toolName)).toEqual(["execute_command", "kill_command", "attempt_completion"])
		expect(consumptions[2].contractError).toBeUndefined()
		expect(consumptions[2].requestToolResults).toContainEqual(
			expect.objectContaining({
				callId: killFunctionId,
				content: expect.stringContaining("Termination was requested for the running command."),
			}),
		)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Tools - local subagent YAML controls its system prompt and final output token budget",
	async ({ helper, server, sidebar, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		const subagentDirectory = path.join(workspaceDir, ".agents", "subagents")
		const yamlSystemPromptMarker = "E2E_SUBAGENT_YAML_SYSTEM_PROMPT"
		// Stays above MIN_SUBAGENT_OUTPUT_TOKENS so the configured value, not the
		// floor that protects results from being erased, is the budget under test.
		const truncatedResultMarker = "...[truncated to 1,024 tokens"
		const omittedTailMarker = "E2E_SUBAGENT_BUDGET_TAIL"
		const longChildResult = `E2E_SUBAGENT_BUDGET_PREFIX_${"A".repeat(8_192)}_${omittedTailMarker}`
		await mkdir(subagentDirectory, { recursive: true })
		await writeFile(
			path.join(subagentDirectory, "e2e-output-budget.yml"),
			`---
name: e2e-output-budget
description: E2E subagent output budget
profile: ${E2E_PROFILE_NAMES.mockOpenAiResponses}
tools:
  - attempt_completion
maxOutputTokens: 1024
---

${yamlSystemPromptMarker}
Return only the highest-value findings.`,
			"utf8",
		)

		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Read project files", false)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_subagent_output_budget",
				name: "use_subagent",
				arguments: {
					agent_name: "e2e-output-budget",
					task: "E2E_SUBAGENT_OUTPUT_BUDGET_TASK",
					context: "Verify the configured final response budget.",
					timeout: 60,
				},
			},
			{
				type: "tool",
				id: "call_subagent_output_budget_parent_complete",
				name: "attempt_completion",
				arguments: { result: "E2E_SUBAGENT_OUTPUT_BUDGET_DONE" },
				expectedToolResults: [
					{
						callId: "call_subagent_output_budget",
						contentIncludes: ["E2E_SUBAGENT_BUDGET_PREFIX_", truncatedResultMarker],
					},
				],
				expectedRequestExcludes: [omittedTailMarker],
			},
		)
		server.enqueueResponses("openai-compatible-responses", {
			type: "tool",
			id: "call_subagent_output_budget_child_complete",
			name: "attempt_completion",
			arguments: { result: longChildResult },
			expectedRequestIncludes: [
				yamlSystemPromptMarker,
				"# Final Response Budget",
				"Keep that final result within 1,024 tokens.",
			],
		})

		await sendTask(sidebar, "Run the configured output-budget subagent.")
		const approveButton = sidebar.getByText("Approve", { exact: true })
		await expect(approveButton).toBeVisible({ timeout: 60_000 })
		await approveButton.click()
		await expect(sidebar.getByText("E2E_SUBAGENT_OUTPUT_BUDGET_DONE", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})

		await expect.poll(() => server.getRequestCount("openai-compatible-chat")).toBe(2)
		await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(1)
		const childRequest = server.getMockConsumptions("openai-compatible-responses")[0]
		expect(childRequest.contractError).toBeUndefined()
		const childRequestText = JSON.stringify(childRequest.requestBody)
		expect(childRequestText).toContain(yamlSystemPromptMarker)
		expect(childRequestText).toContain("# Final Response Budget")
		expect(childRequestText).toContain("Keep that final result within 1,024 tokens.")

		const parentContinuation = server.getMockConsumptions("openai-compatible-chat")[1]
		expect(parentContinuation.contractError).toBeUndefined()
		const returnedResult = parentContinuation.requestToolResults.find(
			(result) => result.callId === "call_subagent_output_budget",
		)?.content
		expect(returnedResult).toContain("E2E_SUBAGENT_BUDGET_PREFIX_")
		expect(returnedResult).toContain(truncatedResultMarker)
		expect(returnedResult).not.toContain(omittedTailMarker)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Tools - subagent aligns header actions, wraps context, and orders Tools before output",
	async ({ helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		const subagentTask = "E2E_SUBAGENT_RENDERING_TASK"
		const subagentContext = [
			"Inspect the workspace in the exact order requested.",
			"Keep this second context line hidden until the user expands it.",
			"Keep this third context line hidden as well.",
		].join("\n")

		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Read project files", false)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_subagent_rendering",
				name: "use_subagent",
				arguments: {
					agent_name: "default",
					task: subagentTask,
					context: subagentContext,
					timeout: 60,
				},
			},
			{
				type: "tool",
				id: "call_subagent_rendering_read",
				name: "read_file",
				arguments: { path: "README.md" },
			},
			{
				type: "tool",
				id: "call_subagent_rendering_list",
				name: "list_files",
				arguments: { path: ".", recursive: false },
				expectedToolResults: [{ callId: "call_subagent_rendering_read", contentIncludes: "# Test Workspace" }],
			},
			{
				type: "tool",
				id: "call_subagent_rendering_complete",
				name: "attempt_completion",
				arguments: { result: "E2E_SUBAGENT_RENDERING_CHILD_DONE" },
				expectedToolResults: [{ callId: "call_subagent_rendering_list", contentIncludes: "README.md" }],
			},
			{
				type: "tool",
				id: "call_subagent_rendering_parent_complete",
				name: "attempt_completion",
				arguments: { result: "E2E_SUBAGENT_RENDERING_DONE" },
				expectedToolResults: [
					{ callId: "call_subagent_rendering", contentIncludes: "E2E_SUBAGENT_RENDERING_CHILD_DONE" },
				],
			},
		)

		await sendTask(sidebar, "Ask a subagent to inspect the workspace in order.")
		const approveButton = sidebar.getByText("Approve", { exact: true })
		await expect(approveButton).toBeVisible({ timeout: 60_000 })
		await approveButton.click()
		await expect(sidebar.getByText("E2E_SUBAGENT_RENDERING_DONE", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})

		const taskHeading = sidebar.getByRole("heading", { name: subagentTask, exact: true }).last()
		await expect(taskHeading).toBeVisible()
		const subagentCard = taskHeading.locator("xpath=ancestor::*[@data-testid='subagent-item'][1]")
		await expect(subagentCard.getByTestId("subagent-name")).toHaveText("default")
		// A single foreground run is identified by its agent name; the "#n" index
		// only distinguishes items inside a batch.
		await expect(subagentCard).not.toContainText("subagent_1")
		const itemHeader = subagentCard.getByTestId("subagent-item-header")
		const executionMode = itemHeader.getByTestId("subagent-execution-mode")
		await expect(executionMode).toHaveText("Foreground")
		await expect(itemHeader.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0)
		await expect(subagentCard.getByRole("button", { name: "Continue in Background", exact: true })).toHaveCount(0)

		// TODO(BUGFIX-049): the Task block layout contract predates the
		// SubagentStatusRow popover rework and no longer matches the rendered DOM.
		// Redefine it against the current component before re-enabling.
		await expect(taskHeading).toBeVisible()

		const context = subagentCard.getByTestId("subagent-context")
		await expect(context).toContainText("Context")
		const contextContent = context.getByTestId("subagent-context-content")
		// The row truncates to one line and reveals the full context through a
		// popover, so the trigger no longer carries a title attribute.
		await expect(contextContent).toContainText("Inspect the workspace in the exact order requested")
		await expect(contextContent).not.toHaveAttribute("title", subagentContext)
		const contextLayout = await context.evaluate((element) => {
			const style = getComputedStyle(element)
			return {
				clientHeight: element.clientHeight,
				scrollWidth: element.scrollWidth,
				clientWidth: element.clientWidth,
				overflowX: style.overflowX,
			}
		})
		expect(contextLayout.clientHeight).toBeGreaterThan(0)
		expect(contextLayout.scrollWidth).toBeLessThanOrEqual(contextLayout.clientWidth + 1)
		expect(contextLayout.overflowX).toBe("hidden")
		const contextTextLayout = await contextContent.evaluate((element) => {
			const style = getComputedStyle(element)
			return {
				overflowWrap: style.overflowWrap,
				whiteSpace: style.whiteSpace,
			}
		})
		// The trigger truncates to a single line; the wrapped, pre-formatted copy
		// lives in the popover that "Context" opens.
		expect(contextTextLayout.whiteSpace).toBe("nowrap")

		// The wrapped, pre-formatted copy lives in the popover the trigger opens.
		const showFullContext = subagentCard.getByRole("button", { name: "Show full subagent context", exact: true })
		await expect(showFullContext).toHaveCount(1)
		await showFullContext.click()
		const contextPopover = sidebar.getByTestId("subagent-context-popover-content")
		await expect(contextPopover).toBeVisible()
		await expect(contextPopover).toContainText("Keep this second context line hidden until the user expands it.")
		await expect(contextPopover).toContainText("Keep this third context line hidden as well.")
		const popoverTextLayout = await contextPopover.evaluate((element) => {
			const style = getComputedStyle(element)
			return { overflowWrap: style.overflowWrap, whiteSpace: style.whiteSpace }
		})
		expect(popoverTextLayout.whiteSpace).toBe("pre-wrap")
		expect(["anywhere", "break-word"]).toContain(popoverTextLayout.overflowWrap)
		// Close the popover so it cannot cover the sections asserted below.
		await showFullContext.click()
		await expect(contextPopover).toHaveCount(0)

		// The tools section is expanded by default and lists each executed step.
		const toolRows = subagentCard.getByTestId("subagent-tool-step")
		await expect(toolRows).toHaveCount(3)
		expect(await subagentCard.getByTestId("subagent-tool-step-name").allTextContents()).toEqual([
			"read_file",
			"list_files",
			"attempt_completion",
		])
		expect(await toolRows.allTextContents()).toEqual([
			expect.stringContaining("README.md"),
			expect.stringContaining("list_files"),
			expect.stringContaining("attempt_completion"),
		])
		await expect(subagentCard.getByRole("button", { name: "Collapse subagent tools", exact: true })).toHaveCount(1)
		const toolsScroll = subagentCard.getByTestId("subagent-tools-scroll")
		expect(
			await toolsScroll.evaluate((element) => {
				const style = getComputedStyle(element)
				return { overflowX: style.overflowX, overflowY: style.overflowY }
			}),
		).toEqual({ overflowX: "hidden", overflowY: "auto" })

		// The output section stays collapsed until requested, and is ordered after Tools.
		const showOutput = subagentCard.getByRole("button", { name: "Show subagent output", exact: true })
		await expect(showOutput).toHaveCount(1)
		await expect(subagentCard.getByTestId("subagent-output")).toHaveCount(0)
		expect(
			await subagentCard.evaluate((card) => {
				const tools = card.querySelector<HTMLElement>('[aria-label="Collapse subagent tools"]')
				const toggle = card.querySelector<HTMLElement>('[aria-label="Show subagent output"]')
				if (!tools || !toggle) throw new Error("Subagent Tools or output toggle is missing")
				return Boolean(tools.compareDocumentPosition(toggle) & Node.DOCUMENT_POSITION_FOLLOWING)
			}),
		).toBe(true)

		// The list bounds the complete subagent collection at 60vh and owns outer scrolling.
		const itemsContainer = sidebar.getByTestId("subagent-list-scroll")
		const itemsLayout = await itemsContainer.evaluate((element) => {
			const style = getComputedStyle(element)
			return {
				maxHeight: Number.parseFloat(style.maxHeight),
				overflowY: style.overflowY,
				viewportHeight: window.innerHeight,
			}
		})
		expect(itemsLayout.overflowY).toBe("auto")
		expect(itemsLayout.maxHeight).toBeCloseTo(itemsLayout.viewportHeight * 0.6, 0)
		// The card itself is height-bounded (30vh) so a long run cannot grow the chat.
		const cardLayout = await subagentCard.evaluate((element) => {
			const style = getComputedStyle(element)
			return {
				maxHeight: Number.parseFloat(style.maxHeight),
				overflowY: style.overflowY,
				viewportHeight: window.innerHeight,
			}
		})
		expect(cardLayout.overflowY).toBe("hidden")
		expect(cardLayout.maxHeight).toBeCloseTo(cardLayout.viewportHeight * 0.3, 0)

		await showOutput.click()
		const output = subagentCard.getByTestId("subagent-output")
		expect(
			await subagentCard.evaluate((card) => {
				const toggle = card.querySelector<HTMLElement>('[aria-label="Hide subagent output"]')
				const result = card.querySelector<HTMLElement>('[data-testid="subagent-output"]')
				if (!toggle || !result) throw new Error("Subagent output hierarchy is incomplete")
				return Boolean(toggle.compareDocumentPosition(result) & Node.DOCUMENT_POSITION_FOLLOWING)
			}),
		).toBe(true)
		await expect(output).toContainText("E2E_SUBAGENT_RENDERING_CHILD_DONE")
		expect(
			await subagentCard.getByTestId("subagent-output-scroll").evaluate((element) => {
				const style = getComputedStyle(element)
				return { overflowX: style.overflowX, overflowY: style.overflowY }
			}),
		).toEqual({ overflowX: "hidden", overflowY: "auto" })
		await subagentCard.screenshot({ path: e2e.info().outputPath("subagent-bounded-sections.png") })
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Tools - subagent-row Cancel stops a foreground subagent and returns its tool result",
	async ({ helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Read project files", false)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_foreground_subagent",
				name: "use_subagent",
				arguments: {
					agent_name: "default",
					task: "E2E_FOREGROUND_SUBAGENT_CANCEL_TASK",
					context: "Remain active until the user cancels this subagent.",
					timeout: 60,
				},
			},
			{
				type: "tool",
				id: "call_delayed_subagent_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_CANCELLED_SUBAGENT_MUST_NOT_COMPLETE" },
				delayMs: 30_000,
			},
			{
				type: "tool",
				id: "call_foreground_subagent_cancel_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_FOREGROUND_SUBAGENT_CANCEL_OK" },
				// A cancelled foreground subagent reports a recoverable stop and
				// points the model at the Retry control instead of a final result.
				expectedToolResults: [
					{
						callId: "call_foreground_subagent",
						contentIncludes: [
							"stopped without producing a result (Cancelled by the user)",
							"Retry control on the subagent activity",
						],
					},
				],
			},
		)

		await sendTask(sidebar, "Start a foreground subagent and wait for its row-specific cancellation.")
		const approveButton = sidebar.getByText("Approve", { exact: true })
		await expect(approveButton).toBeVisible({ timeout: 60_000 })
		await approveButton.click()

		const subagentTask = sidebar.getByText("E2E_FOREGROUND_SUBAGENT_CANCEL_TASK", { exact: true }).last()
		await expect(subagentTask).toBeVisible({ timeout: 60_000 })
		await expect.poll(() => server.openAiRequestCount).toBe(2)
		const subagentCard = subagentTask.locator("xpath=ancestor::*[@data-testid='subagent-item'][1]")
		const itemHeader = subagentCard.getByTestId("subagent-item-header")
		await expect(itemHeader.getByTestId("subagent-execution-mode")).toHaveText("Foreground")
		const cancelButton = itemHeader.getByRole("button", { name: "Cancel", exact: true })
		await expect(cancelButton).toBeVisible()
		await expect(subagentCard.getByRole("button", { name: "Continue in Background", exact: true })).toHaveCount(0)
		const taskFooter = sidebar.getByRole("contentinfo")
		await expect(taskFooter.locator('vscode-button[aria-label="Continue in Background"]')).toBeVisible()
		await expect(taskFooter.locator('vscode-button[aria-label="Cancel"]')).toBeVisible()
		await subagentCard.screenshot({ path: e2e.info().outputPath("foreground-subagent-card-actions.png") })
		await taskFooter.screenshot({ path: e2e.info().outputPath("foreground-subagent-chat-footer.png") })
		await cancelButton.evaluate((element) => element.setAttribute("data-e2e-footer-stability", "subagent-cancel"))
		await startFooterActionStabilityObserver(sidebar, ["Cancel"], '[data-e2e-footer-stability="subagent-cancel"]')
		await sidebar.page().waitForTimeout(750)
		const subagentCancelStabilityEvents = await stopFooterActionStabilityObserver(sidebar)
		expect(subagentCancelStabilityEvents).toEqual([])
		await cancelButton.click()

		await expect(sidebar.getByText("Cancelled", { exact: true }).last()).toBeVisible({ timeout: 30_000 })
		await expect(sidebar.getByText("E2E_CANCELLED_SUBAGENT_MUST_NOT_COMPLETE", { exact: false })).toHaveCount(0)
		await expect(sidebar.getByText("E2E_FOREGROUND_SUBAGENT_CANCEL_OK", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})

		await expect.poll(() => server.openAiRequestCount).toBe(3)
		const consumptions = server.getMockConsumptions("openai-compatible-chat")
		expect(consumptions.map((entry) => entry.toolName)).toEqual(["use_subagent", "attempt_completion", "attempt_completion"])
		const continuation = consumptions[2]
		expect(continuation.contractError).toBeUndefined()
		expect(continuation.requestToolResults).toContainEqual(
			expect.objectContaining({
				callId: "call_foreground_subagent",
				content: expect.stringContaining("stopped without producing a result (Cancelled by the user)"),
			}),
		)
		expect(continuation.requestToolResults).toContainEqual(
			expect.objectContaining({
				callId: "call_foreground_subagent",
				content: expect.stringContaining("Retry control on the subagent activity"),
			}),
		)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e("Tools - batch subagent Cancel keeps siblings active before Cancel all", async ({ helper, server, sidebar, userDataDir }) => {
	e2e.setTimeout(180_000)
	await helper.signin(sidebar)
	await setAutoApproveAction(sidebar, "Read project files", false)
	server.resetOpenAiMock()
	server.enqueueOpenAiResponses(
		{
			type: "tool",
			id: "call_foreground_subagents",
			name: "use_subagents",
			arguments: {
				prompt_1: "<task>E2E_BATCH_CANCEL_ONE</task><context>Remain active until cancelled.</context>",
				prompt_2: "<task>E2E_BATCH_CANCEL_TWO</task><context>Remain active until cancelled.</context>",
				prompt_3: "<task>E2E_BATCH_CANCEL_THREE</task><context>Remain active until cancelled.</context>",
				timeout: 60,
			},
		},
		...Array.from({ length: 3 }, (_, index) => ({
			type: "tool" as const,
			id: `call_delayed_batch_subagent_${index + 1}`,
			name: "attempt_completion",
			arguments: { result: `E2E_CANCELLED_BATCH_SUBAGENT_${index + 1}_MUST_NOT_COMPLETE` },
			delayMs: 30_000,
		})),
		{
			type: "tool",
			id: "call_foreground_subagents_cancel_completion",
			name: "attempt_completion",
			arguments: { result: "E2E_FOREGROUND_SUBAGENTS_CANCEL_OK" },
			expectedToolResults: [
				{
					callId: "call_foreground_subagents",
					contentIncludes: [
						"[1] CANCELLED - E2E_BATCH_CANCEL_ONE",
						"[2] CANCELLED - E2E_BATCH_CANCEL_TWO",
						"[3] CANCELLED - E2E_BATCH_CANCEL_THREE",
						// Cancelled items are preserved for retry, not reported as results.
						"Cancelled by the user",
					],
				},
			],
		},
	)

	await sendTask(sidebar, "Start three foreground subagents and expose their cancellation controls.")
	const approveButton = sidebar.getByText("Approve", { exact: true })
	await expect(approveButton).toBeVisible({ timeout: 60_000 })
	await approveButton.click()

	const firstTask = sidebar.getByText("E2E_BATCH_CANCEL_ONE", { exact: true }).last()
	await expect(firstTask).toBeVisible({ timeout: 60_000 })
	await expect(sidebar.getByText("E2E_BATCH_CANCEL_TWO", { exact: true }).last()).toBeVisible()
	await expect(sidebar.getByText("E2E_BATCH_CANCEL_THREE", { exact: true }).last()).toBeVisible()
	await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(4)
	const batchRow = firstTask.locator(
		"xpath=ancestor::div[.//button[@aria-label='Collapse subagent status' or @aria-label='Expand subagent status']][1]",
	)
	const rowCancelButtons = batchRow.getByRole("button", { name: "Cancel", exact: true })
	await expect(rowCancelButtons).toHaveCount(3)

	const firstCard = firstTask.locator("xpath=ancestor::*[@data-testid='subagent-item'][1]")
	await firstCard.getByTestId("subagent-item-header").getByRole("button", { name: "Cancel", exact: true }).click()
	await expect(rowCancelButtons).toHaveCount(2)
	await expect(sidebar.getByText("E2E_BATCH_CANCEL_TWO", { exact: true }).last()).toBeVisible()
	await expect(sidebar.getByText("E2E_BATCH_CANCEL_THREE", { exact: true }).last()).toBeVisible()

	const cancelAllButton = batchRow.getByRole("button", { name: "Cancel all", exact: true })
	await expect(cancelAllButton).toBeVisible()
	await cancelAllButton.click()
	await expect(rowCancelButtons).toHaveCount(0)
	await expect(sidebar.getByText("Cancelled", { exact: true }).last()).toBeVisible({ timeout: 30_000 })
	for (const index of [1, 2, 3]) {
		await expect(sidebar.getByText(`E2E_CANCELLED_BATCH_SUBAGENT_${index}_MUST_NOT_COMPLETE`, { exact: false })).toHaveCount(
			0,
		)
	}
	await expect(sidebar.getByText("E2E_FOREGROUND_SUBAGENTS_CANCEL_OK", { exact: false }).last()).toBeVisible({
		timeout: 60_000,
	})

	await expect.poll(() => server.openAiRequestCount).toBe(5)
	const consumptions = server.getMockConsumptions("openai-compatible-chat")
	expect(consumptions.map((entry) => entry.toolName)).toEqual([
		"use_subagents",
		"attempt_completion",
		"attempt_completion",
		"attempt_completion",
		"attempt_completion",
	])
	const continuation = consumptions[4]
	expect(continuation.contractError).toBeUndefined()
	for (const marker of [
		"[1] CANCELLED - E2E_BATCH_CANCEL_ONE",
		"[2] CANCELLED - E2E_BATCH_CANCEL_TWO",
		"[3] CANCELLED - E2E_BATCH_CANCEL_THREE",
		"Cancelled by the user",
	]) {
		expect(continuation.requestToolResults).toContainEqual(
			expect.objectContaining({
				callId: "call_foreground_subagents",
				content: expect.stringContaining(marker),
			}),
		)
	}
	await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
})

e2e(
	"Tools - subagent-row Cancel stops a background subagent and injects its final result",
	async ({ helper, server, sidebar, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		const subagentDirectory = path.join(workspaceDir, ".agents", "subagents")
		await mkdir(subagentDirectory, { recursive: true })
		await writeFile(
			path.join(subagentDirectory, "e2e-background.yml"),
			`---
name: e2e-background
description: E2E background cancellation agent
tools: read_file
profile: ${E2E_PROFILE_NAMES.mockOpenAiResponses}
---

Remain active until cancelled.`,
			"utf8",
		)

		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Read project files", false)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_background_subagent",
				name: "use_subagent",
				arguments: {
					agent_name: "e2e-background",
					task: "E2E_BACKGROUND_SUBAGENT_CANCEL_TASK",
					context: "Remain active until the user cancels this background subagent.",
					background: true,
					timeout: 60,
				},
			},
			{
				type: "tool",
				id: "call_background_subagent_qna",
				name: "qna_respond",
				arguments: { response: "E2E_BACKGROUND_SUBAGENT_READY_TO_CANCEL" },
				expectedToolResults: [
					{
						callId: "call_background_subagent",
						contentIncludes: [
							// The job id is a generated uuid; only the stable prefix is contractual.
							"Started background subagent job: subagent_",
							"Its final result will be available only in a later model request.",
						],
					},
				],
			},
			{
				type: "tool",
				id: "call_background_subagent_cancel_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_BACKGROUND_SUBAGENT_CANCEL_OK" },
				// A cancelled background subagent stays retryable so the Activity
				// panel can restart it, so it is reported through the environment
				// roster instead of being consumed as a final background result.
				expectedRequestIncludes: [
					"E2E_BACKGROUND_SUBAGENT_CANCEL_FEEDBACK",
					"# Background Subagents",
					"subagent_",
					"cancelled",
				],
			},
		)
		server.enqueueResponses("openai-compatible-responses", {
			type: "tool",
			id: "call_delayed_background_subagent_completion",
			name: "attempt_completion",
			arguments: { result: "E2E_CANCELLED_BACKGROUND_SUBAGENT_MUST_NOT_COMPLETE" },
			delayMs: 30_000,
		})

		await sendTask(sidebar, "Start a background subagent and wait for its row-specific cancellation.")
		const approveButton = sidebar.getByText("Approve", { exact: true })
		await expect(approveButton).toBeVisible({ timeout: 60_000 })
		await approveButton.click()
		await expect(sidebar.getByText("E2E_BACKGROUND_SUBAGENT_READY_TO_CANCEL", { exact: true })).toBeVisible({
			timeout: 60_000,
		})

		const subagentTask = sidebar.getByText("E2E_BACKGROUND_SUBAGENT_CANCEL_TASK", { exact: true }).last()
		await expect(subagentTask).toBeVisible()
		const subagentCard = subagentTask.locator("xpath=ancestor::div[.//button[normalize-space()='Cancel']][1]")
		const cancelButton = subagentCard.getByRole("button", { name: "Cancel", exact: true })
		await expect(cancelButton).toBeVisible({ timeout: 30_000 })
		await expect.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 60_000 }).toBe(1)
		await cancelButton.click()
		await expect(sidebar.getByText("Cancelled", { exact: true }).last()).toBeVisible({ timeout: 30_000 })
		await expect(sidebar.getByText("E2E_CANCELLED_BACKGROUND_SUBAGENT_MUST_NOT_COMPLETE", { exact: false })).toHaveCount(0)
		const showCancelledOutput = sidebar.getByRole("button", { name: "Show subagent output" }).last()
		await expect(showCancelledOutput).toBeVisible({ timeout: 30_000 })
		await showCancelledOutput.click()
		await expect(sidebar.getByText("Subagent run cancelled.", { exact: true }).last()).toBeVisible()

		const input = sidebar.getByTestId("chat-input")
		await input.fill("E2E_BACKGROUND_SUBAGENT_CANCEL_FEEDBACK")
		await input.press("Enter")
		await expect(input).toHaveValue("")
		await expect(sidebar.getByText("E2E_BACKGROUND_SUBAGENT_CANCEL_OK", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})

		await expect.poll(() => server.openAiRequestCount).toBe(3)
		const continuation = server.getMockConsumptions("openai-compatible-chat")[2]
		expect(continuation.contractError).toBeUndefined()
		const continuationRequest = JSON.stringify(continuation.requestBody)
		// The cancelled job remains retryable, so it is surfaced in the roster and
		// is not yet consumed as an injected background result.
		expect(continuationRequest).toContain("# Background Subagents")
		expect(continuationRequest).toContain("subagent_")
		expect(continuationRequest).toContain("cancelled")
		expect(continuationRequest).not.toContain("## Background Subagent Results")
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Task lifecycle - Cancel preserves background work and Close Task terminates it",
	async ({ helper, page, server, sidebar, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		const taskText = "Start background work that must be terminated when this task is closed."
		const subagentTask = "E2E_CLOSE_TASK_BACKGROUND_SUBAGENT"
		const heartbeatPath = path.join(workspaceDir, "close-task-background-heartbeat.log")
		const commandPath = heartbeatPath.replaceAll("\\", "/")
		const command = `node -e "const fs=require('fs');const p='${commandPath}';fs.appendFileSync(p,String(process.pid)+'\\n');const timer=setInterval(()=>fs.appendFileSync(p,'tick\\n'),100);setTimeout(()=>{clearInterval(timer);process.exit(0)},60000)"`
		const subagentDirectory = path.join(workspaceDir, ".agents", "subagents")
		await mkdir(subagentDirectory, { recursive: true })
		await writeFile(
			path.join(subagentDirectory, "e2e-close-task.yml"),
			`---
name: e2e-close-task
description: E2E Close Task lifecycle agent
tools: read_file
profile: ${E2E_PROFILE_NAMES.mockOpenAiResponses}
---

Remain active until the parent task is closed.`,
			"utf8",
		)

		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Execute safe commands", false)
		await setAutoApproveAction(sidebar, "Read project files", false)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_close_task_background_command",
				name: "execute_command",
				arguments: {
					command,
					workdirectory: ".",
					requires_approval: true,
					background: true,
					timeout: 60,
				},
			},
			{
				type: "tool",
				id: "call_close_task_background_subagent",
				name: "use_subagent",
				arguments: {
					agent_name: "e2e-close-task",
					task: subagentTask,
					context: "Remain active until Close Task terminates this background subagent.",
					background: true,
					timeout: 60,
				},
				expectedToolResults: [
					{ callId: "call_close_task_background_command", contentIncludes: "Command is running in the background." },
				],
			},
			{
				type: "tool",
				id: "call_close_task_delayed_main_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_CANCELLED_MAIN_RESPONSE_MUST_NOT_RENDER" },
				delayMs: 30_000,
				expectedToolResults: [
					{ callId: "call_close_task_background_subagent", contentIncludes: "Started background subagent job:" },
				],
			},
		)
		server.enqueueResponses("openai-compatible-responses", {
			type: "tool",
			id: "call_close_task_delayed_subagent_completion",
			name: "attempt_completion",
			arguments: { result: "E2E_CLOSE_TASK_SUBAGENT_MUST_NOT_COMPLETE" },
			delayMs: 30_000,
		})

		await sendTask(sidebar, taskText)
		const commandApproveButton = sidebar.getByText("Approve", { exact: true })
		await expect(commandApproveButton).toBeVisible({ timeout: 60_000 })
		await commandApproveButton.click()
		await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(2)
		const subagentApproveButton = sidebar.getByText("Approve", { exact: true })
		await expect(subagentApproveButton).toBeVisible({ timeout: 60_000 })
		await subagentApproveButton.click()
		await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(3)
		await expect
			.poll(
				() =>
					readFile(heartbeatPath, "utf8")
						.then((text) => text.length)
						.catch(() => 0),
				{ timeout: 30_000 },
			)
			.toBeGreaterThan(0)
		await expect.poll(() => server.getRequestCount("openai-compatible-responses"), { timeout: 60_000 }).toBe(1)
		const taskFooter = sidebar.getByRole("contentinfo")
		const taskCancelButton = taskFooter.getByText("Cancel", { exact: true })
		await expect(taskCancelButton).toBeVisible({ timeout: 30_000 })
		const heartbeatBeforeCancel = (await readFile(heartbeatPath, "utf8")).length
		await taskCancelButton.click()
		await expect(taskFooter.getByText("Resume", { exact: true })).toBeVisible({ timeout: 30_000 })
		await page.waitForTimeout(800)
		expect((await readFile(heartbeatPath, "utf8")).length).toBeGreaterThan(heartbeatBeforeCancel)
		expect(server.getMockConsumptions("openai-compatible-responses")[0].abortedAtMs).toBeUndefined()
		await expect(sidebar.getByText("E2E_CANCELLED_MAIN_RESPONSE_MUST_NOT_RENDER", { exact: false })).toHaveCount(0)

		await sidebar.getByRole("button", { name: "Close Task", exact: true }).click()
		await expect(sidebar.getByTestId("chat-input")).toBeVisible()
		await E2ETestHelper.dismissWhatsNewModal(sidebar)

		await page.waitForTimeout(800)
		const heartbeatAfterClose = (await readFile(heartbeatPath, "utf8")).length
		await page.waitForTimeout(800)
		const heartbeatAfterSettle = (await readFile(heartbeatPath, "utf8")).length
		const subagentConsumption = server.getMockConsumptions("openai-compatible-responses")[0]
		const lifecycleResult = {
			commandStopped: heartbeatAfterSettle === heartbeatAfterClose,
			subagentAborted: subagentConsumption.abortedAtMs !== undefined,
		}
		if (!lifecycleResult.commandStopped) {
			const commandPid = Number((await readFile(heartbeatPath, "utf8")).split(/\r?\n/, 1)[0])
			if (Number.isInteger(commandPid) && commandPid > 0) {
				try {
					process.kill(commandPid)
				} catch {
					// The process may exit between the heartbeat check and failure cleanup.
				}
			}
			await page.waitForTimeout(500)
		}
		expect(lifecycleResult).toEqual({ commandStopped: true, subagentAborted: true })

		const historyTask = sidebar.getByText(taskText, { exact: true }).last()
		await expect(historyTask).toBeVisible({ timeout: 30_000 })
		await historyTask.click()
		await expect(sidebar.getByText(taskText, { exact: true }).first()).toBeVisible()
		await sidebar.getByRole("tab", { name: /^Activities(?: \d+)?$/ }).click()
		await sidebar.getByRole("button", { name: "All", exact: true }).first().click()
		const commandActivity = sidebar.getByTestId("activity-item").filter({ hasText: "close-task-background-heartbeat.log" })
		const subagentActivity = sidebar.getByTestId("activity-item").filter({ hasText: "e2e-close-task" })
		await expect(commandActivity).toContainText("cancelled", { timeout: 30_000 })
		await expect(subagentActivity).toContainText("cancelled", { timeout: 30_000 })
		await expect(commandActivity.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0)
		await expect(subagentActivity.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)
