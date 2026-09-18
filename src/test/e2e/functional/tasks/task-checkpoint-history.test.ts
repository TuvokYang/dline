import { access, appendFile, readdir, readFile, writeFile } from "node:fs/promises"
import * as path from "node:path"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Locator } from "@playwright/test"

async function sendTask(sidebar: Frame, text: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(text, { exact: true }).first()).toBeVisible()
}

async function expectCommandCardReady(sidebar: Frame, command: string): Promise<Locator> {
	const card = sidebar.getByTestId("command-card").filter({ hasText: command }).last()
	await expect(card).toBeVisible({ timeout: 30_000 })
	await expect(card.locator('[aria-label="Copy command"]')).toBeVisible({ timeout: 30_000 })
	return card
}

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

async function closeCurrentTask(sidebar: Frame): Promise<void> {
	const closeButton = sidebar.getByRole("button", { name: "Close Task", exact: true })
	await expect(closeButton).toBeVisible()
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
	await expect(sidebar.getByText(taskText, { exact: true }).first()).toBeVisible()
}

async function taskDirectoryIds(dlineDocsDir: string): Promise<string[]> {
	const tasksDir = path.join(dlineDocsDir, "tasks")
	return readdir(tasksDir, { withFileTypes: true })
		.then((entries) =>
			entries
				.filter((entry) => entry.isDirectory())
				.map((entry) => entry.name)
				.sort(),
		)
		.catch(() => [])
}

async function pathExists(filePath: string): Promise<boolean> {
	return access(filePath)
		.then(() => true)
		.catch(() => false)
}

async function seedPersistedCommandLayoutActivities(dlineDocsDir: string, taskId: string): Promise<void> {
	const createdAt = Date.now()
	const commandLines = Array.from({ length: 16 }, (_, index) => `echo E2E_ACTIVITY_COMMAND_LINE_${index}`).join("\n")
	const outputLines = Array.from({ length: 40 }, (_, index) => `E2E_ACTIVITY_OUTPUT_LINE_${index}`).join("\n")
	const resultLines = Array.from({ length: 40 }, (_, index) => `E2E_ACTIVITY_RESULT_LINE_${index}`).join("\n")
	const errorLines = Array.from({ length: 40 }, (_, index) => `E2E_ACTIVITY_ERROR_LINE_${index}`).join("\n")
	await writeFile(
		path.join(dlineDocsDir, "tasks", taskId, "activities.json"),
		JSON.stringify({
			schemaVersion: 1,
			taskId,
			activities: [
				{
					schemaVersion: 1,
					activityId: "e2e-command-layout-completed",
					taskId,
					kind: "command",
					executionMode: "foreground",
					cancellationOwner: "task",
					status: "completed",
					createdAt,
					updatedAt: createdAt + 1_000,
					finishedAt: createdAt + 1_000,
					title: "E2E_ACTIVITY_COMMAND_COMPLETED",
					detail: commandLines,
					output: outputLines,
					result: resultLines,
					timeoutSeconds: 60,
					events: [],
				},
				{
					schemaVersion: 1,
					activityId: "e2e-command-layout-failed",
					taskId,
					kind: "command",
					executionMode: "foreground",
					cancellationOwner: "task",
					status: "failed",
					createdAt: createdAt + 2_000,
					updatedAt: createdAt + 3_000,
					finishedAt: createdAt + 3_000,
					title: "E2E_ACTIVITY_COMMAND_FAILED",
					detail: commandLines.replaceAll("COMPLETED", "FAILED"),
					output: outputLines.replaceAll("OUTPUT", "FAILED_OUTPUT"),
					error: errorLines,
					timeoutSeconds: 60,
					events: [],
				},
			],
		}),
		"utf8",
	)
}

async function seedPersistedRunningCommand(dlineDocsDir: string, taskId: string, command: string): Promise<string> {
	const taskDir = path.join(dlineDocsDir, "tasks", taskId)
	const activitiesPath = path.join(taskDir, "activities.json")
	const persistedActivities = JSON.parse(await readFile(activitiesPath, "utf8")) as {
		activities?: Array<Record<string, unknown>>
	}
	const activity = persistedActivities.activities?.find((candidate) => candidate.detail === command)
	if (!activity || typeof activity.activityId !== "string") {
		throw new Error("Expected the closed task to persist its command activity")
	}
	activity.status = "running"
	activity.executionMode = "background"
	activity.timeoutSeconds = 0
	activity.latestEvent = "E2E_ORPHAN_COMMAND_STILL_RUNNING"
	delete activity.finishedAt
	await writeFile(activitiesPath, JSON.stringify(persistedActivities), "utf8")

	const messagesPath = path.join(taskDir, "ui_messages.jsonl")
	const messages = (await readFile(messagesPath, "utf8"))
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
	const commandMessage = messages.find(
		(message) =>
			(message.say === "command" || message.ask === "command") &&
			typeof message.text === "string" &&
			message.text.startsWith(command),
	)
	if (!commandMessage) {
		throw new Error("Expected the closed task to persist its command message")
	}
	commandMessage.activityId = activity.activityId
	commandMessage.commandExecutionMode = "background"
	commandMessage.commandStatus = "running"
	await writeFile(messagesPath, `${messages.map((message) => JSON.stringify(message)).join("\n")}\n`, "utf8")
	return activity.activityId
}

async function readTaskSnapshot(
	dlineDocsDir: string,
	taskId: string,
): Promise<{
	interaction?: { interactionId: string; turnId: string; kind: string }
	turn?: { turnId: string; blocks: Array<{ dlineTid: string }> }
}> {
	return JSON.parse(await readFile(path.join(dlineDocsDir, "tasks", taskId, "snapshot.json"), "utf8"))
}

async function simulateIncompleteTurnEndContinuation(dlineDocsDir: string, taskId: string): Promise<void> {
	const taskDir = path.join(dlineDocsDir, "tasks", taskId)
	const uiMessagesPath = path.join(taskDir, "ui_messages.jsonl")
	const uiMessages = (await readFile(uiMessagesPath, "utf8"))
		.split(/\r?\n/)
		.filter(Boolean)
		.map((line) => JSON.parse(line) as Record<string, unknown>)
	const ask = uiMessages.findLast((message) => message.type === "ask" && message.ask === "qna_respond")
	const interactionId = typeof ask?.interactionId === "string" ? ask.interactionId : undefined
	const apiIndex = typeof ask?.conversationHistoryIndex === "number" ? ask.conversationHistoryIndex : undefined
	if (!interactionId || apiIndex === undefined || apiIndex < 0) {
		throw new Error("Expected one persisted qna_respond ask with a causal API index")
	}

	const snapshotPath = path.join(taskDir, "snapshot.json")
	const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as Record<string, unknown>
	const interaction = snapshot.interaction as { interactionId?: unknown } | undefined
	if (interaction?.interactionId !== interactionId || !snapshot.turn) {
		throw new Error("Expected the closed task snapshot to retain the pending qna continuation")
	}
	delete snapshot.turn
	await writeFile(snapshotPath, `${JSON.stringify(snapshot, null, 2)}\n`, "utf8")

	const apiHistoryPath = path.join(taskDir, "api_conversation_history.jsonl")
	const apiHistory = (await readFile(apiHistoryPath, "utf8")).split(/\r?\n/).filter(Boolean)
	const causalMessage = JSON.parse(apiHistory[apiIndex] ?? "null") as {
		role?: unknown
		ts?: unknown
		content?: Array<{ type?: unknown; dline_tid?: unknown }>
	} | null
	if (
		causalMessage?.role !== "assistant" ||
		!Array.isArray(causalMessage.content) ||
		!causalMessage.content.some((block) => block.type === "tool_use" && block.dline_tid === interactionId)
	) {
		throw new Error("Expected the qna ask to reference its canonical assistant tool block")
	}
	apiHistory[apiIndex] = JSON.stringify({
		role: "assistant",
		content: "Earlier details no longer contain the pending turn-end tool declaration.",
		ts: causalMessage.ts,
	})
	await writeFile(apiHistoryPath, `${apiHistory.join("\n")}\n`, "utf8")
}

async function appendPersistedTimelineTail(dlineDocsDir: string, taskId: string, count: number): Promise<void> {
	const messagesPath = path.join(dlineDocsDir, "tasks", taskId, "ui_messages.jsonl")
	const persisted = await readFile(messagesPath, "utf8")
	let maxTs = 0
	for (const line of persisted.split(/\r?\n/)) {
		if (!line.trim()) continue
		const message = JSON.parse(line) as { ts?: unknown }
		if (typeof message.ts === "number") maxTs = Math.max(maxTs, message.ts)
	}
	const tail = Array.from({ length: count }, (_, index) =>
		JSON.stringify({
			ts: maxTs + index + 1,
			type: "say",
			say: "text",
			text: `E2E_MESSAGE_WINDOW_FILLER_${index + 1}`,
		}),
	)
	const separator = persisted.length > 0 && !persisted.endsWith("\n") ? "\n" : ""
	await appendFile(messagesPath, `${separator}${tail.join("\n")}\n`, "utf8")
}

e2e(
	"Checkpoint - Compare opens the real diff and Restore All stops at Resume before continuing",
	async ({ helper, page, server, sidebar, userDataDir, workspaceDir }) => {
		e2e.setTimeout(240_000)
		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				name: "write_to_file",
				arguments: { path: "checkpoint-e2e.txt", content: "checkpoint content\n" },
			},
			{
				type: "tool",
				name: "attempt_completion",
				arguments: { result: "E2E_CHECKPOINT_WRITE_COMPLETE" },
			},
			{
				type: "tool",
				name: "attempt_completion",
				arguments: { result: "E2E_CHECKPOINT_RESUME_OK" },
			},
		)

		await sendTask(sidebar, "Create a file so checkpoint Compare and Restore can be exercised.")
		await sidebar.getByText("Approve", { exact: true }).click()
		const filePath = path.join(workspaceDir, "checkpoint-e2e.txt")
		await expect.poll(() => pathExists(filePath)).toBe(true)
		await expect(sidebar.getByText("E2E_CHECKPOINT_WRITE_COMPLETE", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await page.waitForTimeout(1_000)

		const checkpointLabels = sidebar.getByText("Checkpoint", { exact: true })
		await expect.poll(() => checkpointLabels.count()).toBeGreaterThan(0)
		const firstCheckpointControl = checkpointLabels.first().locator("..").locator("..")
		await firstCheckpointControl.hover()
		const restoreButton = firstCheckpointControl.getByRole("button", { name: "Restore", exact: true })
		await restoreButton.click()
		const restoreAllButton = sidebar.getByRole("button", { name: "Restore Files & Task", exact: true })
		await expect(restoreAllButton).toBeVisible()
		await sidebar.getByTestId("chat-input").hover()
		await page.waitForTimeout(500)
		await expect(restoreAllButton).toBeVisible()
		await sidebar.getByTestId("chat-input").click()
		await expect(restoreAllButton).not.toBeVisible()

		await firstCheckpointControl.hover()
		const compareButton = firstCheckpointControl.getByRole("button", { name: "Compare", exact: true })
		await expect(compareButton).toBeVisible()
		await compareButton.click()
		await expect(page.getByRole("tab", { name: /Changes since snapshot/ })).toBeVisible({ timeout: 30_000 })
		await expect
			.poll(
				async () => {
					const output = await E2ETestHelper.readDlineOutput(userDataDir)
					return output.includes("presentMultifileDiff")
				},
				{ timeout: 30_000 },
			)
			.toBe(true)
		await expect(compareButton).toBeEnabled()
		await page.waitForTimeout(500)

		await firstCheckpointControl.hover()
		await restoreButton.click()
		await expect(restoreAllButton).toBeVisible()
		await restoreAllButton.click()
		await expect.poll(() => pathExists(filePath)).toBe(false)

		const resumeButton = sidebar.getByText("Resume", { exact: true })
		await expect(resumeButton).toBeVisible({ timeout: 30_000 })
		await page.waitForTimeout(500)
		expect(server.openAiRequestCount).toBe(2)
		const input = sidebar.getByTestId("chat-input")
		await input.fill("E2E_CHECKPOINT_RESUME_DRAFT")
		await resumeButton.click()
		await expect(sidebar.getByText("E2E_CHECKPOINT_RESUME_OK", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		await expect.poll(() => server.openAiRequestCount).toBe(3)
		expect(JSON.stringify(server.getOpenAiRequestBodies()[2])).toContain("E2E_CHECKPOINT_RESUME_DRAFT")
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"History - approved read survives Close and Resume with its durable tool result",
	async ({ helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Read project files", false)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_history_resume_read",
				name: "read_file",
				arguments: { path: "README.md" },
			},
			{
				type: "tool",
				id: "call_history_interrupted_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_CLOSED_RESPONSE_MUST_NOT_RENDER" },
				delayMs: 30_000,
				expectedToolResults: [{ callId: "call_history_resume_read", contentIncludes: "# Test Workspace" }],
			},
			{
				type: "tool",
				id: "call_history_resume_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_HISTORY_RESUME_OK" },
				expectedToolResults: [{ callId: "call_history_resume_read", contentIncludes: "# Test Workspace" }],
				expectedRequestIncludes: [
					"The previous task session was closed and has now been restored.",
					"E2E_HISTORY_RESUME_DRAFT",
				],
			},
		)

		const taskText = "E2E_CLOSE_RUNNING_HISTORY_TASK"
		await sendTask(sidebar, taskText)
		const approveButton = sidebar.getByText("Approve", { exact: true })
		await expect(approveButton).toBeVisible({ timeout: 60_000 })
		await approveButton.click()
		await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(2)
		await expect(sidebar.getByText("Dline read 1 file:", { exact: true })).toBeVisible({ timeout: 30_000 })
		await expect(sidebar.getByRole("button", { name: /README\.md/ }).last()).toBeVisible()
		await closeCurrentTask(sidebar)
		await reopenTask(sidebar, taskText)

		const resumeButton = sidebar.getByText("Resume", { exact: true })
		await expect(resumeButton).toBeVisible({ timeout: 30_000 })
		await expect(sidebar.getByText("Dline read 1 file:", { exact: true })).toBeVisible()
		await expect(sidebar.getByRole("button", { name: /README\.md/ }).last()).toBeVisible()
		await expect(sidebar.getByText("Approve", { exact: true })).toHaveCount(0)
		await expect(sidebar.getByText("Reject", { exact: true })).toHaveCount(0)
		await page.waitForTimeout(750)
		expect(server.openAiRequestCount).toBe(2)
		await expect(sidebar.getByText("E2E_CLOSED_RESPONSE_MUST_NOT_RENDER", { exact: false })).toHaveCount(0)

		const input = sidebar.getByTestId("chat-input")
		await input.fill("E2E_HISTORY_RESUME_DRAFT")
		await resumeButton.click()
		await expect(sidebar.getByText("E2E_HISTORY_RESUME_OK", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		await expect.poll(() => server.openAiRequestCount).toBe(3)
		const continuation = server.getMockConsumptions("openai-compatible-chat")[2]
		expect(continuation.contractError).toBeUndefined()
		expect(continuation.requestToolResults).toContainEqual(
			expect.objectContaining({
				callId: "call_history_resume_read",
				content: expect.stringContaining("# Test Workspace"),
			}),
		)
		const continuationRequest = JSON.stringify(continuation.requestBody)
		expect(continuationRequest).toContain("The previous task session was closed and has now been restored.")
		expect(continuationRequest).toContain("E2E_HISTORY_RESUME_DRAFT")
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"History - current input survives a restored turn-end interaction whose causal assistant turn is missing",
	async ({ dlineDocsDir, helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_history_missing_qna",
				name: "qna_respond",
				arguments: { response: "E2E_MISSING_QNA_PROMPT" },
			},
			{
				type: "tool",
				id: "call_history_missing_qna_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_MISSING_QNA_CONTINUED" },
				expectedRequestIncludes: [
					"The previous task session was closed and has now been restored.",
					"E2E_MISSING_QNA_CURRENT_INPUT",
				],
			},
		)

		const taskText = "E2E_MISSING_TURN_END_HISTORY_TASK"
		await sendTask(sidebar, taskText)
		await expect(sidebar.getByText("E2E_MISSING_QNA_PROMPT", { exact: true })).toBeVisible({ timeout: 60_000 })
		const [taskId] = await E2ETestHelper.waitForValue(async () => {
			const ids = await taskDirectoryIds(dlineDocsDir)
			return ids.length === 1 ? ids : undefined
		})

		await closeCurrentTask(sidebar)
		await simulateIncompleteTurnEndContinuation(dlineDocsDir, taskId)
		await reopenTask(sidebar, taskText)
		await expect(sidebar.getByText("E2E_MISSING_QNA_PROMPT", { exact: true })).toBeVisible()
		await expect(sidebar.getByRole("contentinfo").getByText("Resume", { exact: true })).toBeVisible({
			timeout: 30_000,
		})

		const input = sidebar.getByTestId("chat-input")
		await expect(input).toBeEnabled()
		await input.fill("E2E_MISSING_QNA_CURRENT_INPUT")
		await input.press("Enter")
		await expect(input).toHaveValue("")

		await expect
			.poll(
				async () => {
					const output = await E2ETestHelper.readDlineOutput(userDataDir)
					if (output.includes("resume_turn_missing")) return "resume_turn_missing"
					return server.openAiRequestCount === 2 ? "continued" : "pending"
				},
				{ timeout: 15_000 },
			)
			.toBe("continued")
		await expect(sidebar.getByText("E2E_MISSING_QNA_CONTINUED", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		const continuation = server.getMockConsumptions("openai-compatible-chat")[1]
		expect(continuation.contractError).toBeUndefined()
		expect(continuation.requestToolResults).not.toContainEqual(
			expect.objectContaining({ callId: "call_history_missing_qna" }),
		)
		const output = await E2ETestHelper.readDlineOutput(userDataDir)
		expect(output).not.toContain("resume_turn_missing")
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"History - pending tool approval survives close and reopen with its original actions",
	async ({ dlineDocsDir, helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Read project files", false)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{ type: "tool", name: "read_file", arguments: { path: "README.md" } },
			{
				type: "tool",
				name: "attempt_completion",
				arguments: { result: "E2E_RESTORED_APPROVAL_OK" },
			},
		)

		const taskText = "E2E_PENDING_APPROVAL_HISTORY_TASK"
		await sendTask(sidebar, taskText)
		await expect(sidebar.getByText("Approve", { exact: true })).toBeVisible({ timeout: 60_000 })
		const [taskId] = await E2ETestHelper.waitForValue(async () => {
			const ids = await taskDirectoryIds(dlineDocsDir)
			return ids.length === 1 ? ids : undefined
		})
		await closeCurrentTask(sidebar)
		await reopenTask(sidebar, taskText)
		const restoredSnapshot = await E2ETestHelper.waitForValue(async () => {
			const snapshot = await readTaskSnapshot(dlineDocsDir, taskId)
			return snapshot.interaction?.kind === "tool_approval" ? snapshot : undefined
		})
		expect(restoredSnapshot.turn, "restored approval must retain its canonical assistant turn").toBeDefined()
		expect(restoredSnapshot.turn?.turnId).toBe(restoredSnapshot.interaction?.turnId)
		expect(
			restoredSnapshot.turn?.blocks.some((block) => block.dlineTid === restoredSnapshot.interaction?.interactionId),
		).toBe(true)

		const approveButton = sidebar.getByText("Approve", { exact: true })
		await expect(approveButton).toBeVisible({ timeout: 30_000 })
		await expect(sidebar.getByText("Reject", { exact: true })).toBeVisible()
		await page.waitForTimeout(750)
		expect(server.openAiRequestCount).toBe(1)

		const input = sidebar.getByTestId("chat-input")
		await input.fill("E2E_RESTORED_APPROVAL_DRAFT")
		await approveButton.click()
		await expect.poll(() => server.openAiRequestCount, { timeout: 30_000 }).toBe(2)
		await expect(sidebar.getByText("E2E_RESTORED_APPROVAL_OK", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		const continuation = JSON.stringify(server.getOpenAiRequestBodies()[1])
		expect(continuation).toContain("# Test Workspace")
		expect(continuation).toContain("E2E_RESTORED_APPROVAL_DRAFT")
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"History - an approval anchor older than the latest message window remains actionable",
	async ({ dlineDocsDir, helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Read project files", false)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{ type: "tool", id: "call_history_older_anchor", name: "read_file", arguments: { path: "README.md" } },
			{
				type: "tool",
				id: "call_history_older_anchor_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_OLDER_ANCHOR_APPROVAL_OK" },
				expectedToolResults: [{ callId: "call_history_older_anchor", contentIncludes: "# Test Workspace" }],
				expectedRequestIncludes: ["E2E_OLDER_ANCHOR_APPROVAL_DRAFT"],
			},
		)

		const taskText = "E2E_OLDER_INTERACTION_ANCHOR_HISTORY_TASK"
		await sendTask(sidebar, taskText)
		await expect(sidebar.getByText("Approve", { exact: true })).toBeVisible({ timeout: 60_000 })
		const [taskId] = await E2ETestHelper.waitForValue(async () => {
			const ids = await taskDirectoryIds(dlineDocsDir)
			return ids.length === 1 ? ids : undefined
		})

		await closeCurrentTask(sidebar)
		await appendPersistedTimelineTail(dlineDocsDir, taskId, 220)
		await reopenTask(sidebar, taskText)

		const taskFooter = sidebar.getByRole("contentinfo")
		const approveButton = taskFooter.getByText("Approve", { exact: true })
		await expect(approveButton).toBeVisible({ timeout: 30_000 })
		await expect(taskFooter.getByText("Reject", { exact: true })).toBeVisible()
		await expect(taskFooter.getByText("Resume", { exact: true })).toHaveCount(0)
		await page.waitForTimeout(500)
		expect(server.openAiRequestCount).toBe(1)

		const input = sidebar.getByTestId("chat-input")
		await expect(input).toBeEnabled()
		await input.fill("E2E_OLDER_ANCHOR_APPROVAL_DRAFT")
		await approveButton.click()
		await expect(sidebar.getByText("E2E_OLDER_ANCHOR_APPROVAL_OK", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => server.openAiRequestCount).toBe(2)
		const continuation = server.getMockConsumptions("openai-compatible-chat")[1]
		expect(continuation.contractError).toBeUndefined()
		expect(continuation.requestToolResults).toContainEqual(
			expect.objectContaining({
				callId: "call_history_older_anchor",
				content: expect.stringContaining("# Test Workspace"),
			}),
		)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"History - pending command approval survives close and resumes with the original command",
	async ({ dlineDocsDir, helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Execute safe commands", false)
		server.resetOpenAiMock()
		const command = `node -e "process.stdout.write('E2E_RESTORED_PENDING_COMMAND_STDOUT')"`
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_history_pending_command",
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
				id: "call_history_pending_command_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_RESTORED_PENDING_COMMAND_OK" },
				expectedToolResults: [
					{
						callId: "call_history_pending_command",
						contentIncludes: ["Command executed successfully (exit code 0).", "E2E_RESTORED_PENDING_COMMAND_STDOUT"],
					},
				],
				expectedRequestIncludes: ["E2E_RESTORED_PENDING_COMMAND_DRAFT"],
			},
		)

		const taskText = "E2E_PENDING_COMMAND_APPROVAL_HISTORY_TASK"
		await sendTask(sidebar, taskText)
		await expect(sidebar.getByText("Approve", { exact: true })).toBeVisible({ timeout: 60_000 })
		await expectCommandCardReady(sidebar, command)
		const [taskId] = await E2ETestHelper.waitForValue(async () => {
			const ids = await taskDirectoryIds(dlineDocsDir)
			return ids.length === 1 ? ids : undefined
		})

		await closeCurrentTask(sidebar)
		await reopenTask(sidebar, taskText)
		const restoredSnapshot = await E2ETestHelper.waitForValue(async () => {
			const snapshot = await readTaskSnapshot(dlineDocsDir, taskId)
			return snapshot.interaction?.kind === "command_approval" ? snapshot : undefined
		})
		expect(restoredSnapshot.turn?.turnId).toBe(restoredSnapshot.interaction?.turnId)
		expect(
			restoredSnapshot.turn?.blocks.some((block) => block.dlineTid === restoredSnapshot.interaction?.interactionId),
		).toBe(true)

		const approveButton = sidebar.getByText("Approve", { exact: true })
		await expect(approveButton).toBeVisible({ timeout: 30_000 })
		await expect(sidebar.getByText("Reject", { exact: true })).toBeVisible()
		await expectCommandCardReady(sidebar, command)
		await page.waitForTimeout(750)
		expect(server.openAiRequestCount).toBe(1)

		const input = sidebar.getByTestId("chat-input")
		await input.fill("E2E_RESTORED_PENDING_COMMAND_DRAFT")
		await approveButton.click()
		await expect(sidebar.getByText("E2E_RESTORED_PENDING_COMMAND_STDOUT", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect(sidebar.getByText("E2E_RESTORED_PENDING_COMMAND_OK", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => server.openAiRequestCount).toBe(2)
		const continuation = server.getMockConsumptions("openai-compatible-chat")[1]
		expect(continuation.contractError).toBeUndefined()
		expect(continuation.requestToolResults).toContainEqual(
			expect.objectContaining({
				callId: "call_history_pending_command",
				content: expect.stringContaining("E2E_RESTORED_PENDING_COMMAND_STDOUT"),
			}),
		)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"History - completed approved command stays terminal after close and Resume",
	async ({ helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Execute safe commands", false)
		server.resetOpenAiMock()
		const command = `node -e "process.stdout.write('E2E_HISTORY_COMPLETED_COMMAND_STDOUT')"`
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_history_completed_command",
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
				id: "call_history_completed_command_interrupted_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_HISTORY_COMPLETED_COMMAND_CLOSED_MUST_NOT_RENDER" },
				delayMs: 30_000,
				expectedToolResults: [
					{
						callId: "call_history_completed_command",
						contentIncludes: ["Command executed successfully (exit code 0).", "E2E_HISTORY_COMPLETED_COMMAND_STDOUT"],
					},
				],
			},
			{
				type: "tool",
				id: "call_history_completed_command_resume_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_HISTORY_COMPLETED_COMMAND_RESUME_OK" },
				expectedToolResults: [
					{
						callId: "call_history_completed_command",
						contentIncludes: ["Command executed successfully (exit code 0).", "E2E_HISTORY_COMPLETED_COMMAND_STDOUT"],
					},
				],
				expectedRequestIncludes: [
					"The previous task session was closed and has now been restored.",
					"E2E_HISTORY_COMPLETED_COMMAND_RESUME_DRAFT",
				],
			},
		)

		const taskText = "E2E_COMPLETED_COMMAND_HISTORY_TASK"
		await sendTask(sidebar, taskText)
		const approveButton = sidebar.getByText("Approve", { exact: true })
		await expect(approveButton).toBeVisible({ timeout: 60_000 })
		await approveButton.click()
		await expect(sidebar.getByText("E2E_HISTORY_COMPLETED_COMMAND_STDOUT", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(2)

		await closeCurrentTask(sidebar)
		await reopenTask(sidebar, taskText)
		const taskFooter = sidebar.getByRole("contentinfo")
		const resumeButton = taskFooter.getByText("Resume", { exact: true })
		await expect(resumeButton).toBeVisible({ timeout: 30_000 })
		const restoredCommandCard = await expectCommandCardReady(sidebar, command)
		await expect(restoredCommandCard).toContainText("E2E_HISTORY_COMPLETED_COMMAND_STDOUT")
		await expect(taskFooter.getByText("Approve", { exact: true })).toHaveCount(0)
		await expect(taskFooter.getByText("Reject", { exact: true })).toHaveCount(0)
		const expandTaskHeader = sidebar.getByLabel("Expand task header")
		if (await expandTaskHeader.isVisible()) await expandTaskHeader.click()
		const progress = sidebar.getByTestId("context-window-segmented-progress")
		await expect(progress).toHaveAttribute("data-phase", "stable", { timeout: 30_000 })
		await expect(progress).toHaveAttribute("data-context-window", /^[1-9]\d*$/)
		await expect(sidebar.locator('[title="Maximum context window size for this model"]')).toHaveText(/[1-9]/)
		const environmentSegment = sidebar.getByTestId("context-window-segment-environment")
		await expect(environmentSegment).toHaveAttribute("data-tokens", /^[1-9]\d*$/, { timeout: 30_000 })
		// The stable refresh runs on a timer and no longer advances the revision
		// when every value it recomputed is unchanged, so a rising revision is no
		// longer evidence that the restored task is being refreshed. What the
		// restored indicator must still hold is a recomputed environment
		// occupancy and a settled phase, which the assertions above establish.
		const restoredRevision = Number((await progress.getAttribute("data-revision")) ?? 0)
		expect(restoredRevision).toBeGreaterThan(0)
		await page.waitForTimeout(750)
		await expect(progress).toHaveAttribute("data-phase", "stable")
		await expect(environmentSegment).toHaveAttribute("data-tokens", /^[1-9]\d*$/)
		expect(server.openAiRequestCount).toBe(2)
		await expect(sidebar.getByText("E2E_HISTORY_COMPLETED_COMMAND_CLOSED_MUST_NOT_RENDER", { exact: false })).toHaveCount(0)

		const input = sidebar.getByTestId("chat-input")
		await input.fill("E2E_HISTORY_COMPLETED_COMMAND_RESUME_DRAFT")
		await resumeButton.click()
		await expect(sidebar.getByText("E2E_HISTORY_COMPLETED_COMMAND_RESUME_OK", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => server.openAiRequestCount).toBe(3)
		const continuation = server.getMockConsumptions("openai-compatible-chat")[2]
		expect(continuation.contractError).toBeUndefined()
		expect(continuation.requestToolResults).toContainEqual(
			expect.objectContaining({
				callId: "call_history_completed_command",
				content: expect.stringContaining("E2E_HISTORY_COMPLETED_COMMAND_STDOUT"),
			}),
		)
		expect(JSON.stringify(continuation.requestBody)).toContain("<environment_details>")
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"History - pending write approval survives Close and executes only after restored approval",
	async ({ dlineDocsDir, helper, page, server, sidebar, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Edit project files", false)
		server.resetOpenAiMock()
		const relativePath = "e2e-pending-write-history.txt"
		const filePath = path.join(workspaceDir, relativePath)
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_history_pending_write",
				name: "write_to_file",
				arguments: { path: relativePath, content: "pending write restored\n" },
			},
			{
				type: "tool",
				id: "call_history_pending_write_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_RESTORED_PENDING_WRITE_OK" },
				expectedToolResults: [{ callId: "call_history_pending_write", contentIncludes: "successfully saved" }],
				expectedRequestIncludes: ["E2E_RESTORED_PENDING_WRITE_DRAFT"],
			},
		)

		const taskText = "E2E_PENDING_WRITE_APPROVAL_HISTORY_TASK"
		await sendTask(sidebar, taskText)
		await expect(sidebar.getByText("Approve", { exact: true })).toBeVisible({ timeout: 60_000 })
		expect(server.openAiRequestCount).toBe(1)
		const [taskId] = await E2ETestHelper.waitForValue(async () => {
			const ids = await taskDirectoryIds(dlineDocsDir)
			return ids.length === 1 ? ids : undefined
		})

		await closeCurrentTask(sidebar)
		await reopenTask(sidebar, taskText)
		const restoredSnapshot = await E2ETestHelper.waitForValue(async () => {
			const snapshot = await readTaskSnapshot(dlineDocsDir, taskId)
			return snapshot.interaction?.kind === "tool_approval" ? snapshot : undefined
		})
		expect(restoredSnapshot.turn?.turnId).toBe(restoredSnapshot.interaction?.turnId)

		const taskFooter = sidebar.getByRole("contentinfo")
		const approveButton = taskFooter.getByText("Approve", { exact: true })
		await expect(approveButton).toBeVisible({ timeout: 30_000 })
		await expect(taskFooter.getByText("Reject", { exact: true })).toBeVisible()
		await expect(taskFooter.getByText("Resume", { exact: true })).toHaveCount(0)
		await page.waitForTimeout(500)
		expect(server.openAiRequestCount).toBe(1)

		const input = sidebar.getByTestId("chat-input")
		await input.fill("E2E_RESTORED_PENDING_WRITE_DRAFT")
		await approveButton.click()
		await expect.poll(() => pathExists(filePath)).toBe(true)
		await expect(sidebar.getByText("E2E_RESTORED_PENDING_WRITE_OK", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => server.openAiRequestCount).toBe(2)
		const continuation = server.getMockConsumptions("openai-compatible-chat")[1]
		expect(continuation.contractError).toBeUndefined()
		expect(continuation.requestToolResults).toContainEqual(
			expect.objectContaining({
				callId: "call_history_pending_write",
				content: expect.stringContaining("successfully saved"),
			}),
		)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"History - approved write survives Close and Resume without reopening approval",
	async ({ helper, page, server, sidebar, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Edit project files", false)
		server.resetOpenAiMock()
		const relativePath = "e2e-approved-write-history.txt"
		const filePath = path.join(workspaceDir, relativePath)
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_history_approved_write",
				name: "write_to_file",
				arguments: { path: relativePath, content: "approved write persisted\n" },
			},
			{
				type: "tool",
				id: "call_history_approved_write_interrupted_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_HISTORY_APPROVED_WRITE_CLOSED_MUST_NOT_RENDER" },
				delayMs: 30_000,
				expectedToolResults: [{ callId: "call_history_approved_write", contentIncludes: "successfully saved" }],
			},
			{
				type: "tool",
				id: "call_history_approved_write_resume_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_HISTORY_APPROVED_WRITE_RESUME_OK" },
				expectedToolResults: [{ callId: "call_history_approved_write", contentIncludes: "successfully saved" }],
				expectedRequestIncludes: [
					"The previous task session was closed and has now been restored.",
					"E2E_HISTORY_APPROVED_WRITE_RESUME_DRAFT",
				],
			},
		)

		const taskText = "E2E_APPROVED_WRITE_HISTORY_TASK"
		await sendTask(sidebar, taskText)
		const approveButton = sidebar.getByText("Approve", { exact: true })
		await expect(approveButton).toBeVisible({ timeout: 60_000 })
		await approveButton.click()
		await expect.poll(() => pathExists(filePath)).toBe(true)
		await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(2)

		await closeCurrentTask(sidebar)
		await reopenTask(sidebar, taskText)
		const taskFooter = sidebar.getByRole("contentinfo")
		const resumeButton = taskFooter.getByText("Resume", { exact: true })
		await expect(resumeButton).toBeVisible({ timeout: 30_000 })
		await expect(taskFooter.getByText("Approve", { exact: true })).toHaveCount(0)
		await expect(taskFooter.getByText("Reject", { exact: true })).toHaveCount(0)
		await expect(sidebar.getByText("E2E_HISTORY_APPROVED_WRITE_CLOSED_MUST_NOT_RENDER", { exact: false })).toHaveCount(0)
		await page.waitForTimeout(500)
		expect(server.openAiRequestCount).toBe(2)

		const input = sidebar.getByTestId("chat-input")
		await input.fill("E2E_HISTORY_APPROVED_WRITE_RESUME_DRAFT")
		await resumeButton.click()
		await expect(sidebar.getByText("E2E_HISTORY_APPROVED_WRITE_RESUME_OK", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => server.openAiRequestCount).toBe(3)
		const continuation = server.getMockConsumptions("openai-compatible-chat")[2]
		expect(continuation.contractError).toBeUndefined()
		expect(continuation.requestToolResults).toContainEqual(
			expect.objectContaining({
				callId: "call_history_approved_write",
				content: expect.stringContaining("successfully saved"),
			}),
		)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"History - replace survives both pending approval and completed-result Close boundaries",
	async ({ helper, page, server, sidebar, userDataDir, workspaceDir }) => {
		e2e.setTimeout(240_000)
		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Edit project files", false)
		const relativePath = "e2e-replace-history.txt"
		const filePath = path.join(workspaceDir, relativePath)
		await writeFile(filePath, "before\n", "utf8")
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_history_replace",
				name: "replace_in_file",
				arguments: {
					path: relativePath,
					diff: "------- SEARCH\nbefore\n=======\nafter\n+++++++ REPLACE",
				},
			},
			{
				type: "tool",
				id: "call_history_replace_interrupted_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_HISTORY_REPLACE_CLOSED_MUST_NOT_RENDER" },
				delayMs: 30_000,
				expectedToolResults: [{ callId: "call_history_replace", contentIncludes: "successfully replaced" }],
			},
			{
				type: "tool",
				id: "call_history_replace_resumed_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_HISTORY_REPLACE_RESUME_OK" },
				expectedToolResults: [{ callId: "call_history_replace", contentIncludes: "successfully replaced" }],
				expectedRequestIncludes: [
					"The previous task session was closed and has now been restored.",
					"E2E_HISTORY_REPLACE_RESUME_DRAFT",
				],
			},
		)

		const taskText = "E2E_REPLACE_HISTORY_TASK"
		await sendTask(sidebar, taskText)
		await expect(sidebar.getByText("Approve", { exact: true })).toBeVisible({ timeout: 60_000 })
		expect((await readFile(filePath, "utf8")).replaceAll("\r\n", "\n")).toBe("before\n")

		await closeCurrentTask(sidebar)
		await reopenTask(sidebar, taskText)
		const taskFooter = sidebar.getByRole("contentinfo")
		const restoredApprove = taskFooter.getByText("Approve", { exact: true })
		await expect(restoredApprove).toBeVisible({ timeout: 30_000 })
		await expect(taskFooter.getByText("Reject", { exact: true })).toBeVisible()
		await expect(taskFooter.getByText("Resume", { exact: true })).toHaveCount(0)
		await page.waitForTimeout(500)
		expect(server.openAiRequestCount).toBe(1)

		await restoredApprove.click()
		await expect.poll(async () => (await readFile(filePath, "utf8")).replaceAll("\r\n", "\n")).toBe("after\n")
		await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(2)
		await closeCurrentTask(sidebar)
		await reopenTask(sidebar, taskText)

		const resumeButton = taskFooter.getByText("Resume", { exact: true })
		await expect(resumeButton).toBeVisible({ timeout: 30_000 })
		await expect(taskFooter.getByText("Approve", { exact: true })).toHaveCount(0)
		await expect(taskFooter.getByText("Reject", { exact: true })).toHaveCount(0)
		await expect(sidebar.getByText("E2E_HISTORY_REPLACE_CLOSED_MUST_NOT_RENDER", { exact: false })).toHaveCount(0)
		const input = sidebar.getByTestId("chat-input")
		await input.fill("E2E_HISTORY_REPLACE_RESUME_DRAFT")
		await resumeButton.click()
		await expect(sidebar.getByText("E2E_HISTORY_REPLACE_RESUME_OK", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => server.openAiRequestCount).toBe(3)
		const continuation = server.getMockConsumptions("openai-compatible-chat")[2]
		expect(continuation.contractError).toBeUndefined()
		expect(continuation.requestToolResults.filter((result) => result.callId === "call_history_replace")).toHaveLength(1)
		expect((await readFile(filePath, "utf8")).replaceAll("\r\n", "\n")).toBe("after\n")
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"History - persisted command activities keep independently bounded detail and output sections",
	async ({ dlineDocsDir, helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(180_000)
		await helper.signin(sidebar)
		const beforeTaskIds = await taskDirectoryIds(dlineDocsDir)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses({
			type: "tool",
			id: "call_activity_layout_ready",
			name: "attempt_completion",
			arguments: { result: "E2E_ACTIVITY_LAYOUT_READY" },
		})

		const taskText = "E2E_ACTIVITY_LAYOUT_HISTORY_TASK"
		await sendTask(sidebar, taskText)
		await expect(sidebar.getByText("E2E_ACTIVITY_LAYOUT_READY", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		await closeCurrentTask(sidebar)
		const persistedTaskId = await E2ETestHelper.waitForValue(async () => {
			const ids = await taskDirectoryIds(dlineDocsDir)
			return ids.find((id) => !beforeTaskIds.includes(id))
		}, 30_000)
		await seedPersistedCommandLayoutActivities(dlineDocsDir, persistedTaskId)
		await reopenTask(sidebar, taskText)

		await sidebar.getByRole("tab", { name: /^Activities(?: \d+)?$/ }).click()
		await sidebar.getByRole("button", { name: "All", exact: true }).first().click()
		const completedActivity = sidebar.getByTestId("activity-item").filter({ hasText: "E2E_ACTIVITY_COMMAND_COMPLETED" })
		const failedActivity = sidebar.getByTestId("activity-item").filter({ hasText: "E2E_ACTIVITY_COMMAND_FAILED" })
		await expect(completedActivity).toHaveCount(1)
		await expect(failedActivity).toHaveCount(1)
		await completedActivity.getByTestId("activity-toggle").click()
		await failedActivity.getByTestId("activity-toggle").click()

		const completedBody = completedActivity.getByTestId("activity-body")
		const bodyLayout = await completedBody.evaluate((element) => {
			const style = getComputedStyle(element)
			return { maxHeight: style.maxHeight, overflowY: style.overflowY }
		})
		expect(bodyLayout).toEqual({ maxHeight: "none", overflowY: "visible" })

		const commandLine = completedActivity.getByTestId("activity-command-line")
		const commandLayout = await commandLine.evaluate((element) => {
			const style = getComputedStyle(element)
			return {
				maxHeight: style.maxHeight,
				overflowY: style.overflowY,
				clientHeight: element.clientHeight,
				scrollHeight: element.scrollHeight,
			}
		})
		expect(commandLayout.maxHeight).toBe("72px")
		expect(commandLayout.overflowY).toBe("auto")
		expect(commandLayout.scrollHeight).toBeGreaterThan(commandLayout.clientHeight)

		const output = completedActivity.getByTestId("command-output-scroll")
		const outputLayout = await output.evaluate((element) => {
			const style = getComputedStyle(element)
			return {
				maxHeight: style.maxHeight,
				overflowY: style.overflowY,
				clientHeight: element.clientHeight,
				scrollHeight: element.scrollHeight,
			}
		})
		expect(outputLayout.maxHeight).toBe("96px")
		expect(outputLayout.overflowY).toBe("auto")
		expect(outputLayout.scrollHeight).toBeGreaterThan(outputLayout.clientHeight)

		const result = completedActivity.getByText("E2E_ACTIVITY_RESULT_LINE_0", { exact: false })
		const resultLayout = await result.evaluate((element) => {
			const style = getComputedStyle(element)
			return {
				maxHeight: style.maxHeight,
				overflowY: style.overflowY,
				clientHeight: element.clientHeight,
				scrollHeight: element.scrollHeight,
			}
		})
		expect(resultLayout.maxHeight).toBe("120px")
		expect(resultLayout.overflowY).toBe("auto")
		expect(resultLayout.scrollHeight).toBeGreaterThan(resultLayout.clientHeight)

		const error = failedActivity.getByText("E2E_ACTIVITY_ERROR_LINE_0", { exact: false })
		const errorLayout = await error.evaluate((element) => {
			const style = getComputedStyle(element)
			return {
				maxHeight: style.maxHeight,
				overflowY: style.overflowY,
				clientHeight: element.clientHeight,
				scrollHeight: element.scrollHeight,
			}
		})
		expect(errorLayout.maxHeight).toBe("120px")
		expect(errorLayout.overflowY).toBe("auto")
		expect(errorLayout.scrollHeight).toBeGreaterThan(errorLayout.clientHeight)
		await completedActivity.screenshot({ path: e2e.info().outputPath("activity-command-bounded-sections.png") })
		expect(server.openAiRequestCount).toBe(1)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"History - an orphaned no-timeout background command reopens as interrupted without stale controls",
	async ({ dlineDocsDir, helper, page, server, sidebar, userDataDir, workspaceDir }) => {
		e2e.setTimeout(240_000)
		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Execute safe commands", false)
		const markerPath = path.join(workspaceDir, "e2e-running-command-should-not-finish.txt")
		const command = `node -e "const fs=require('fs'); console.log(['E2E','RUNNING','COMMAND','STARTED'].join('_')); setTimeout(()=>fs.writeFileSync('e2e-running-command-should-not-finish.txt','unexpected'),8000)"`
		const beforeTaskIds = await taskDirectoryIds(dlineDocsDir)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_history_running_command",
				name: "execute_command",
				arguments: {
					command,
					workdirectory: ".",
					requires_approval: true,
					background: true,
					timeout: 0,
				},
			},
			{
				type: "tool",
				id: "call_history_running_command_closed_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_CLOSED_BACKGROUND_COMMAND_MUST_NOT_RENDER" },
				delayMs: 30_000,
				expectedToolResults: [
					{ callId: "call_history_running_command", contentIncludes: "Command is running in the background." },
				],
			},
		)

		const taskText = "E2E_RUNNING_COMMAND_CLOSE_HISTORY_TASK"
		await sendTask(sidebar, taskText)
		await sidebar.getByText("Approve", { exact: true }).click()
		await expect.poll(() => server.openAiRequestCount, { timeout: 60_000 }).toBe(2)
		expect(await pathExists(markerPath)).toBe(false)
		await expect(sidebar.getByRole("contentinfo").getByText("Approve", { exact: true })).toHaveCount(0)

		const copyCommandButton = sidebar.getByRole("button", { name: "Copy command" }).last()
		const commandActions = copyCommandButton.locator("xpath=ancestor::div[.//button[normalize-space()='Cancel']][1]")
		await expect(commandActions.getByRole("button", { name: "Cancel", exact: true })).toBeVisible()
		const activitiesTab = sidebar.getByRole("tab", { name: /^Activities(?: \d+)?$/ })
		await expect(activitiesTab).toHaveAccessibleName(/Activities 1/)
		await activitiesTab.click()
		const runningActivity = sidebar.getByTestId("activity-item").filter({ hasText: command })
		await expect(runningActivity.getByTestId("activity-execution-mode")).toHaveText("Background")
		await expect(runningActivity.getByText("Command", { exact: true })).toHaveCount(0)
		await expect(runningActivity).toContainText("running")
		await expect(runningActivity.getByRole("button", { name: "Cancel", exact: true })).toBeVisible()

		await closeCurrentTask(sidebar)
		const persistedTaskId = await E2ETestHelper.waitForValue(async () => {
			const ids = await taskDirectoryIds(dlineDocsDir)
			return ids.find((id) => !beforeTaskIds.includes(id))
		}, 30_000)
		// Closing releases the Webview immediately while command cancellation and
		// activity persistence finish in the deferred teardown. Wait for that real
		// terminal write before seeding the crash-recovery fixture back to running,
		// or the late cancellation can overwrite the synthetic orphan with cancelled.
		await expect
			.poll(
				async () => {
					const persisted = JSON.parse(
						await readFile(path.join(dlineDocsDir, "tasks", persistedTaskId, "activities.json"), "utf8"),
					) as { activities?: Array<{ detail?: string; status?: string }> }
					return persisted.activities?.find((activity) => activity.detail === command)?.status
				},
				{ timeout: 30_000 },
			)
			.toBe("cancelled")
		const activityId = await seedPersistedRunningCommand(dlineDocsDir, persistedTaskId, command)
		await reopenTask(sidebar, taskText)

		const taskFooter = sidebar.getByRole("contentinfo")
		const resumeButton = taskFooter.getByText("Resume", { exact: true })
		await expect(resumeButton).toBeVisible({ timeout: 30_000 })
		await expect(taskFooter.getByText("Approve", { exact: true })).toHaveCount(0)
		await expect(taskFooter.getByText("Reject", { exact: true })).toHaveCount(0)
		const restoredCommandCard = await expectCommandCardReady(sidebar, command)
		await expect(restoredCommandCard).toContainText("Interrupted")
		await expect(sidebar.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0)
		await expect(sidebar.getByText("E2E_CLOSED_BACKGROUND_COMMAND_MUST_NOT_RENDER", { exact: false })).toHaveCount(0)

		const reopenedActivitiesTab = sidebar.getByRole("tab", { name: "Activities", exact: true })
		await expect(reopenedActivitiesTab).toBeVisible()
		await reopenedActivitiesTab.click()
		await expect(sidebar.getByText("No matching activities.", { exact: true })).toBeVisible()
		await sidebar.getByRole("button", { name: "All", exact: true }).first().click()
		const interruptedActivity = sidebar.getByTestId("activity-item").filter({ hasText: command })
		await expect(interruptedActivity).toContainText("interrupted")
		await expect(interruptedActivity.locator(".animate-spin")).toHaveCount(0)
		await expect(interruptedActivity.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0)
		await expect
			.poll(async () => {
				const persisted = JSON.parse(
					await readFile(path.join(dlineDocsDir, "tasks", persistedTaskId, "activities.json"), "utf8"),
				) as { activities?: Array<{ activityId?: string; status?: string }> }
				return persisted.activities?.find((activity) => activity.activityId === activityId)?.status
			})
			.toBe("interrupted")

		await closeCurrentTask(sidebar)
		await reopenTask(sidebar, taskText)
		await sidebar.getByRole("tab", { name: "Activities", exact: true }).click()
		await sidebar.getByRole("button", { name: "All", exact: true }).first().click()
		const reopenedInterruptedActivity = sidebar.getByTestId("activity-item").filter({ hasText: command })
		await expect(reopenedInterruptedActivity).toContainText("interrupted")
		await expect(reopenedInterruptedActivity.locator(".animate-spin")).toHaveCount(0)
		await expect(reopenedInterruptedActivity.getByRole("button", { name: "Cancel", exact: true })).toHaveCount(0)
		await page.waitForTimeout(9_000)
		expect(await pathExists(markerPath)).toBe(false)
		expect(server.openAiRequestCount).toBe(2)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"History - subagent approval and running execution each restore to an explicit continuation",
	async ({ helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(240_000)
		await helper.signin(sidebar)
		await setAutoApproveAction(sidebar, "Read project files", false)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses(
			{
				type: "tool",
				id: "call_history_running_subagent",
				name: "use_subagent",
				arguments: {
					agent_name: "default",
					task: "E2E_RUNNING_SUBAGENT_CLOSE_TASK",
					context: "Remain active until the parent task is closed.",
					timeout: 60,
				},
			},
			{
				type: "tool",
				id: "call_history_subagent_delayed_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_CLOSED_SUBAGENT_MUST_NOT_COMPLETE" },
				delayMs: 30_000,
			},
			{
				type: "tool",
				id: "call_history_subagent_resumed_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_HISTORY_SUBAGENT_RESUME_OK" },
				expectedRequestIncludes: [
					"The previous task session was closed and has now been restored.",
					"E2E_HISTORY_SUBAGENT_RESUME_DRAFT",
				],
			},
		)

		const taskText = "E2E_SUBAGENT_CLOSE_HISTORY_TASK"
		await sendTask(sidebar, taskText)
		await expect(sidebar.getByText("Approve", { exact: true })).toBeVisible({ timeout: 60_000 })
		await closeCurrentTask(sidebar)
		await reopenTask(sidebar, taskText)
		const taskFooter = sidebar.getByRole("contentinfo")
		const restoredApprove = taskFooter.getByText("Approve", { exact: true })
		await expect(restoredApprove).toBeVisible({ timeout: 30_000 })
		await expect(taskFooter.getByText("Resume", { exact: true })).toHaveCount(0)
		await page.waitForTimeout(500)
		expect(server.openAiRequestCount).toBe(1)

		await restoredApprove.click()
		await expect(sidebar.getByText("E2E_RUNNING_SUBAGENT_CLOSE_TASK", { exact: true }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => server.openAiRequestCount).toBe(2)
		await closeCurrentTask(sidebar)
		await reopenTask(sidebar, taskText)

		const resumeButton = taskFooter.getByText("Resume", { exact: true })
		await expect(resumeButton).toBeVisible({ timeout: 30_000 })
		await expect(taskFooter.getByText("Approve", { exact: true })).toHaveCount(0)
		await expect(taskFooter.getByText("Reject", { exact: true })).toHaveCount(0)
		await expect(sidebar.getByText("E2E_CLOSED_SUBAGENT_MUST_NOT_COMPLETE", { exact: false })).toHaveCount(0)
		await page.waitForTimeout(750)
		expect(server.openAiRequestCount).toBe(2)

		const input = sidebar.getByTestId("chat-input")
		await input.fill("E2E_HISTORY_SUBAGENT_RESUME_DRAFT")
		await resumeButton.click()
		await expect(sidebar.getByText("E2E_HISTORY_SUBAGENT_RESUME_OK", { exact: false }).last()).toBeVisible({
			timeout: 60_000,
		})
		await expect.poll(() => server.openAiRequestCount).toBe(3)
		const continuation = server.getMockConsumptions("openai-compatible-chat")[2]
		expect(continuation.contractError).toBeUndefined()
		const results = continuation.requestToolResults.filter((result) => result.callId === "call_history_running_subagent")
		expect(results).toHaveLength(1)
		expect(results[0].content).toMatch(/interrupted|cancelled/i)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Task deletion - header delete removes the active task directory",
	async ({ dlineDocsDir, helper, server, sidebar, userDataDir }) => {
		e2e.setTimeout(120_000)
		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses({
			type: "tool",
			name: "attempt_completion",
			arguments: { result: "E2E_HEADER_DELETE_READY" },
		})

		await sendTask(sidebar, "E2E_HEADER_DELETE_TASK")
		await expect(sidebar.getByText("E2E_HEADER_DELETE_READY", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		const [taskId] = await E2ETestHelper.waitForValue(async () => {
			const ids = await taskDirectoryIds(dlineDocsDir)
			return ids.length === 1 ? ids : undefined
		})

		const expandHeader = sidebar.getByLabel("Expand task header")
		if (await expandHeader.isVisible()) await expandHeader.click()
		await sidebar
			.locator("button")
			.filter({ has: sidebar.locator("svg.lucide-trash") })
			.first()
			.click()
		await expect(sidebar.getByRole("dialog")).toContainText("Delete Task")
		await sidebar.getByText("Delete", { exact: true }).click()

		await expect.poll(async () => (await taskDirectoryIds(dlineDocsDir)).includes(taskId)).toBe(false)
		await expect(sidebar.getByText("E2E_HEADER_DELETE_TASK", { exact: true })).toHaveCount(0)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)

e2e(
	"Task deletion - History delete removes the selected task directory",
	async ({ dlineDocsDir, helper, page, server, sidebar, userDataDir }) => {
		e2e.setTimeout(120_000)
		await helper.signin(sidebar)
		server.resetOpenAiMock()
		server.enqueueOpenAiResponses({
			type: "tool",
			name: "attempt_completion",
			arguments: { result: "E2E_HISTORY_DELETE_READY" },
		})

		const taskText = "E2E_HISTORY_DELETE_TASK"
		await sendTask(sidebar, taskText)
		await expect(sidebar.getByText("E2E_HISTORY_DELETE_READY", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
		const [taskId] = await E2ETestHelper.waitForValue(async () => {
			const ids = await taskDirectoryIds(dlineDocsDir)
			return ids.length === 1 ? ids : undefined
		})
		await closeCurrentTask(sidebar)

		await page.getByRole("button", { name: "History", exact: true }).click()
		await expect(sidebar.getByText("History", { exact: true }).first()).toBeVisible()
		const historyItem = sidebar.locator(".history-item").filter({ hasText: taskText })
		await expect(historyItem).toHaveCount(1)
		await historyItem.hover()
		await historyItem.getByRole("button", { name: "Delete", exact: true }).click()

		await expect.poll(async () => (await taskDirectoryIds(dlineDocsDir)).includes(taskId)).toBe(false)
		await expect(historyItem).toHaveCount(0)
		await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
	},
)
