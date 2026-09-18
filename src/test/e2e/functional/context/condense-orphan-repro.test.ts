import { readdir, readFile, writeFile } from "node:fs/promises"
import path from "node:path"
import type { MockApiConsumption } from "@e2e/fixtures/server"
import { E2E_PROFILE_NAMES } from "@e2e/utils/api-profile"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect, type Frame, type Locator } from "@playwright/test"
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

const COMPACT_INSTRUCTION_MARKER = "The current conversation is rapidly running out of context"
const PROVIDER_TOOL_PAIRING_ERROR = "must have a corresponding tool_use block in the previous message"
const WEBVIEW_ERROR_ALLOWLIST = [
	/vscode\.mermaid-markdown-features.*legacyToolReferenceFullNames.*chatParticipantPrivate/is,
	/\[DEP0040\].*punycode.*deprecated/is,
	/\[DEP0169\].*url\.parse\(\).*not standardized/is,
	/Unable to create workbench contribution 'chat\.contextContributions'.*chatSessionRoutingProviderService/is,
	/Failed to load resource: the server responded with a status of 404/is,
	/DialogContent.*requires a `DialogTitle`/is,
]
const profilesPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "api_profiles.json")
const settingsPath = (dlineDir: string) => path.join(dlineDir, "data", "settings", "settings.json")

async function configureManualCompact(dlineDir: string): Promise<void> {
	const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
	const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockOpenAiResponses)
	if (!profile?.openai?.capabilities) throw new Error("Missing configurable OpenAI Responses E2E profile")
	profile.modelId = "gpt-5.4-mini"
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
				useAutoCondense: false,
			},
			null,
			2,
		)}\n`,
		"utf8",
	)
}

async function configureAutoCompact(dlineDir: string): Promise<void> {
	await configureManualCompact(dlineDir)
	const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
	await writeFile(settingsPath(dlineDir), `${JSON.stringify({ ...settings, useAutoCondense: true }, null, 2)}\n`, "utf8")
}

async function configureAnthropicManualCompact(dlineDir: string): Promise<void> {
	const profiles = JSON.parse(await readFile(profilesPath(dlineDir), "utf8")) as StoredProfile[]
	const profile = profiles.find((candidate) => candidate.name === E2E_PROFILE_NAMES.mockAnthropic)
	if (!profile) throw new Error("Missing configurable Anthropic E2E profile")
	profile.modelId = "claude-sonnet-4-6"
	profile.webToolsMode = "WEB_TOOLS_MODE_FORCE_OFF"
	await writeFile(profilesPath(dlineDir), `${JSON.stringify(profiles, null, 2)}\n`, "utf8")

	const settings = JSON.parse(await readFile(settingsPath(dlineDir), "utf8")) as Record<string, unknown>
	await writeFile(
		settingsPath(dlineDir),
		`${JSON.stringify(
			{
				...settings,
				actModeProfile: E2E_PROFILE_NAMES.mockAnthropic,
				planModeProfile: E2E_PROFILE_NAMES.mockAnthropic,
				useAutoCondense: false,
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

async function attachScreenshot(app: ElectronApplication, name: string): Promise<void> {
	const screenshotPath = e2e.info().outputPath(`${name}.png`)
	try {
		await (await app.firstWindow()).screenshot({ path: screenshotPath, timeout: 5_000 })
		await e2e.info().attach(name, { path: screenshotPath, contentType: "image/png" })
	} catch (error) {
		await e2e.info().attach(`${name}-screenshot-error.txt`, {
			body: Buffer.from(error instanceof Error ? (error.stack ?? error.message) : String(error), "utf8"),
			contentType: "text/plain",
		})
	}
}

async function attachJson(name: string, value: unknown): Promise<void> {
	await e2e.info().attach(`${name}.json`, {
		body: Buffer.from(JSON.stringify(value, null, 2), "utf8"),
		contentType: "application/json",
	})
}

async function attachDlineOutput(userDataDir: string, name: string): Promise<void> {
	await e2e.info().attach(`${name}.log`, {
		body: Buffer.from(await E2ETestHelper.readDlineOutput(userDataDir), "utf8"),
		contentType: "text/plain",
	})
}

async function attachVsCodeLogEvidence(userDataDir: string, name: string): Promise<void> {
	const logsRoot = path.join(userDataDir, "logs")
	const files: Array<{ path: string; errorSamples: string[]; toolPairingError: boolean }> = []
	const visit = async (directory: string): Promise<void> => {
		const entries = await readdir(directory, { withFileTypes: true }).catch(() => [])
		for (const entry of entries) {
			const entryPath = path.join(directory, entry.name)
			if (entry.isDirectory()) {
				await visit(entryPath)
				continue
			}
			if (!entry.name.endsWith(".log")) continue
			const content = await readFile(entryPath, "utf8")
			const normalized = content.replaceAll("`", "").toLowerCase()
			files.push({
				path: path.relative(logsRoot, entryPath),
				errorSamples: content
					.split(/\r?\n/)
					.filter((line) => /error|uncaught|unhandled|exception/i.test(line))
					.slice(-100),
				toolPairingError: normalized.includes(PROVIDER_TOOL_PAIRING_ERROR),
			})
		}
	}
	await visit(logsRoot)
	await attachJson(name, files)
	expect(files.filter((file) => file.toolPairingError)).toEqual([])
}

function expectNoUnexpectedWebviewErrors(errors: string[]): void {
	const unexpected = errors.filter((error) => !WEBVIEW_ERROR_ALLOWLIST.some((pattern) => pattern.test(error)))
	expect(unexpected, `Unexpected Webview console/page errors:\n${unexpected.join("\n")}`).toEqual([])
}

async function expectSummaryScrollLayout(container: Locator): Promise<void> {
	await expect(container).toBeVisible()
	const metrics = await container.evaluate((element) => ({
		className: element.className,
		maxHeight: getComputedStyle(element).maxHeight,
		overflowY: getComputedStyle(element).overflowY,
		clientHeight: element.clientHeight,
		scrollHeight: element.scrollHeight,
		viewportHeight: window.innerHeight,
	}))
	expect(metrics.className).toContain("max-h-[60vh]")
	expect(metrics.overflowY).toBe("auto")
	expect(metrics.clientHeight).toBeLessThanOrEqual(metrics.viewportHeight * 0.6 + 1)
	expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight)
	expect(Number.parseFloat(metrics.maxHeight)).toBeCloseTo(metrics.viewportHeight * 0.6, 0)
}

async function observeWebviewErrors(app: ElectronApplication): Promise<{
	errors: string[]
	dispose: () => void
}> {
	const page = await app.firstWindow()
	const errors: string[] = []
	const onConsole = (message: { type(): string; text(): string }) => {
		if (message.type() === "error") errors.push(`console: ${message.text()}`)
	}
	const onPageError = (error: Error) => errors.push(`pageerror: ${error.stack ?? error.message}`)
	page.on("console", onConsole)
	page.on("pageerror", onPageError)
	return {
		errors,
		dispose: () => {
			page.off("console", onConsole)
			page.off("pageerror", onPageError)
		},
	}
}

function requestToolNames(consumption: MockApiConsumption): string[] {
	const body = consumption.requestBody as {
		tools?: Array<{ name?: string; function?: { name?: string } }>
	}
	return (body.tools ?? [])
		.map((tool) => tool.name ?? tool.function?.name)
		.filter((name): name is string => typeof name === "string")
}

/**
 * Extract Responses request items that reference a tool identity: function_call
 * (pairing source) and function_call_output (pairing consumer).
 */
function responsesUserTextBlocks(consumption: MockApiConsumption): string[] {
	const input = (consumption.requestBody as { input?: unknown[] })?.input ?? []
	return input.flatMap((item) => {
		if (typeof item !== "object" || item === null) return []
		const message = item as { role?: unknown; content?: unknown }
		if (message.role !== "user" || !Array.isArray(message.content)) return []
		return message.content.flatMap((content) => {
			if (typeof content !== "object" || content === null) return []
			const block = content as { type?: unknown; text?: unknown }
			return block.type === "input_text" && typeof block.text === "string" ? [block.text] : []
		})
	})
}

function extractResponsesToolItems(body: unknown): {
	calls: string[]
	outputs: string[]
} {
	const input = (body as { input?: unknown[] })?.input ?? []
	const calls: string[] = []
	const outputs: string[] = []
	for (const item of input) {
		if (typeof item !== "object" || item === null) continue
		const record = item as { type?: unknown; call_id?: unknown }
		if (record.type === "function_call" && typeof record.call_id === "string") {
			calls.push(record.call_id)
		}
		if (record.type === "function_call_output" && typeof record.call_id === "string") {
			outputs.push(record.call_id)
		}
	}
	return { calls, outputs }
}

/** Every tool output must reference a call id that was actually declared. */
function assertNoOrphanToolOutputs(consumption: MockApiConsumption): void {
	const body = consumption.requestBody
	const { calls, outputs } = extractResponsesToolItems(body)
	const callIdSet = new Set(calls)
	const orphans = outputs.filter((output) => !callIdSet.has(output))
	expect(orphans).toEqual([])
	// Internal Dline function identities must never leak into a provider request.
	expect(JSON.stringify(body)).not.toContain("call_dline_")
	expect(JSON.stringify(body)).not.toContain("dline_function_")
}

function summarizeAnthropicToolPairing(messages: unknown[]): unknown[] {
	return messages.map((value, index) => {
		if (typeof value !== "object" || value === null) return { index, role: "invalid" }
		const message = value as { role?: unknown; content?: unknown }
		const content = Array.isArray(message.content) ? message.content : []
		return {
			index,
			role: message.role,
			toolUseIds: content.flatMap((block) => {
				if (typeof block !== "object" || block === null) return []
				const record = block as { type?: unknown; id?: unknown }
				return record.type === "tool_use" && typeof record.id === "string" ? [record.id] : []
			}),
			toolResultIds: content.flatMap((block) => {
				if (typeof block !== "object" || block === null) return []
				const record = block as { type?: unknown; tool_use_id?: unknown }
				return record.type === "tool_result" && typeof record.tool_use_id === "string" ? [record.tool_use_id] : []
			}),
		}
	})
}

function assertAnthropicToolPairing(consumption: MockApiConsumption, requestIndex: number): void {
	const messages = (consumption.requestBody as { messages?: unknown[] }).messages ?? []
	const diagnostic = JSON.stringify({ requestIndex, messages: summarizeAnthropicToolPairing(messages) }, null, 2)
	for (const [index, value] of messages.entries()) {
		if (typeof value !== "object" || value === null) continue
		const message = value as { role?: unknown; content?: unknown }
		if (message.role !== "user" || !Array.isArray(message.content)) continue
		const resultIds = message.content.flatMap((content) => {
			if (typeof content !== "object" || content === null) return []
			const block = content as { type?: unknown; tool_use_id?: unknown }
			return block.type === "tool_result" && typeof block.tool_use_id === "string" ? [block.tool_use_id] : []
		})
		if (resultIds.length === 0) continue

		const previousValue = messages[index - 1]
		const previous =
			typeof previousValue === "object" && previousValue !== null
				? (previousValue as { role?: unknown; content?: unknown })
				: undefined
		expect(previous?.role, `Anthropic tool_result must immediately follow its tool_use:\n${diagnostic}`).toBe("assistant")
		const useIds = new Set(
			Array.isArray(previous?.content)
				? previous.content.flatMap((content) => {
						if (typeof content !== "object" || content === null) return []
						const block = content as { type?: unknown; id?: unknown }
						return block.type === "tool_use" && typeof block.id === "string" ? [block.id] : []
					})
				: [],
		)
		expect(
			resultIds.filter((id) => !useIds.has(id)),
			`Anthropic tool_result IDs must match the immediately preceding tool_use IDs:\n${diagnostic}`,
		).toEqual([])
	}
}

e2e(
	"Unauthorized summarize_task text never renders or compacts task history",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(150_000)
		await configureManualCompact(dlineDir)
		const unauthorizedSummary = "E2E_UNAUTHORIZED_SUMMARY_MUST_NOT_RENDER"
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "message",
				text: `<thinking>Attempt an unauthorized summary.</thinking><summarize_task><context>${unauthorizedSummary}</context></summarize_task>`,
				expectedRequestIncludes: ["E2E_UNAUTHORIZED_SUMMARY_TASK"],
				expectedRequestExcludes: [COMPACT_INSTRUCTION_MARKER],
			},
			{
				type: "tool",
				id: "call_unauthorized_summary_done",
				name: "attempt_completion",
				arguments: { result: "E2E_UNAUTHORIZED_SUMMARY_REJECTED" },
				expectedRequestIncludes: ["E2E_UNAUTHORIZED_SUMMARY_TASK", "explicit_instruction_missing"],
				expectedRequestExcludes: [COMPACT_INSTRUCTION_MARKER],
			},
		)

		const app = await openVSCode(workspaceDir)
		const webviewDiagnostics = await observeWebviewErrors(app)
		try {
			const sidebar = await openSidebar(app, helper)
			await sendTask(sidebar, "E2E_UNAUTHORIZED_SUMMARY_TASK")
			await expect(sidebar.getByText("E2E_UNAUTHORIZED_SUMMARY_REJECTED", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(2)
			await expect(sidebar.getByText(unauthorizedSummary, { exact: false })).toHaveCount(0)
			await expect(sidebar.getByText("Dline is condensing the conversation:", { exact: true })).toHaveCount(0)
			await expect(sidebar.locator('vscode-button[aria-label="Condense Conversation"]')).toHaveCount(0)
			await expect(sidebar.locator('vscode-button[aria-label="Regenerate Summary"]')).toHaveCount(0)

			const requests = server.getMockConsumptions("openai-compatible-responses")
			expect(requests[1].contractError).toBeUndefined()
			expect(JSON.stringify(requests[1].requestBody)).toContain("E2E_UNAUTHORIZED_SUMMARY_TASK")
			assertNoOrphanToolOutputs(requests[1])
			await attachScreenshot(app, "unauthorized-summarize-task-final-state")
			await attachJson("unauthorized-summarize-task-provider-consumptions", requests)
			await attachDlineOutput(userDataDir, "unauthorized-summarize-task-dline-output")
			await attachVsCodeLogEvidence(userDataDir, "unauthorized-summarize-task-vscode-log-scan")
			await attachJson("unauthorized-summarize-task-webview-errors", webviewDiagnostics.errors)
			expectNoUnexpectedWebviewErrors(webviewDiagnostics.errors)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			webviewDiagnostics.dispose()
			await app.close()
		}
	},
)

e2e(
	"Manual compaction - no orphaned function_call_output leaks into the request after task compaction",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		await configureManualCompact(dlineDir)
		const restoredQnaReply = "E2E_CONDENSE_ORPHAN_REPLY continue after the confirmed summary."
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_condense_orphan_ready",
				name: "qna_respond",
				arguments: { response: "E2E_CONDENSE_ORPHAN_READY" },
				usage: { inputTokens: 80_000, outputTokens: 100 },
			},
			{
				type: "message",
				text: "<thinking>E2E orphan-safe summary</thinking><summarize_task><context>E2E_CONDENSE_ORPHAN_SUMMARY preserves the task and current intent.</context></summarize_task>",
				expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER, "E2E_CONDENSE_ORPHAN_TASK"],
				expectedRequestExcludes: ["__dline_mode_switch_compact__", "/compact"],
			},
			{
				type: "tool",
				id: "call_condense_orphan_continued",
				name: "qna_respond",
				arguments: { response: "E2E_CONDENSE_ORPHAN_CONTINUED" },
				expectedRequestIncludes: ["E2E_CONDENSE_ORPHAN_SUMMARY"],
				expectedRequestExcludes: ["__dline_mode_switch_compact__", COMPACT_INSTRUCTION_MARKER, "/cmd:compact"],
			},
			{
				type: "tool",
				id: "call_condense_orphan_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_CONDENSE_ORPHAN_DONE" },
				expectedRequestIncludes: ["E2E_CONDENSE_ORPHAN_SUMMARY", restoredQnaReply],
				expectedRequestExcludes: ["__dline_mode_switch_compact__", COMPACT_INSTRUCTION_MARKER, "/cmd:compact"],
			},
		)

		const app = await openVSCode(workspaceDir)
		const webviewDiagnostics = await observeWebviewErrors(app)
		try {
			const sidebar = await openSidebar(app, helper)
			await sendTask(sidebar, "E2E_CONDENSE_ORPHAN_TASK")
			await expect(sidebar.getByText("E2E_CONDENSE_ORPHAN_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})

			// Trigger manual compaction through the task header control.
			const expandTaskHeader = sidebar.getByLabel("Expand task header")
			if (await expandTaskHeader.isVisible()) await expandTaskHeader.click()
			const compactButton = sidebar.locator("button").filter({
				has: sidebar.locator("svg.lucide-fold-vertical"),
			})
			await expect(compactButton).toBeVisible()
			await compactButton.click()
			await expect(sidebar.getByText("Compact the current task?", { exact: true })).toBeVisible()
			await sidebar.getByTitle("Yes, compact the task").click()

			await expect(sidebar.getByText("E2E_CONDENSE_ORPHAN_SUMMARY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(2)
			const confirmCompactionButton = sidebar.locator('vscode-button[aria-label="Condense Conversation"]')
			await expect(confirmCompactionButton).toBeVisible({ timeout: 60_000 })
			await attachScreenshot(app, "manual-compaction-summary-review")
			await confirmCompactionButton.click()
			await expect(confirmCompactionButton).toHaveCount(0)
			await expect(sidebar.locator('vscode-button[aria-label="Regenerate Summary"]')).toHaveCount(0)

			const input = sidebar.getByTestId("chat-input")
			await expect(sidebar.getByText("E2E_CONDENSE_ORPHAN_CONTINUED", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await expect(input).toBeEnabled()
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(3)
			await input.fill(restoredQnaReply)
			await input.press("Enter")
			await expect(input).toHaveValue("")

			await expect(sidebar.getByText("E2E_CONDENSE_ORPHAN_DONE", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(4)

			const requests = server.getMockConsumptions("openai-compatible-responses")
			expect(requests[1]).toMatchObject({ responseType: "message" })
			expect(requestToolNames(requests[1])).toEqual(requestToolNames(requests[0]))
			expect(requestToolNames(requests[1])).not.toContain("summarize_task")
			for (const request of requests) {
				expect(request.contractError).toBeUndefined()
				// The post-condense request must not carry orphaned tool outputs.
				assertNoOrphanToolOutputs(request)
			}
			expect(responsesUserTextBlocks(requests[3]).every((text) => text.trim().length > 0)).toBe(true)
			expect(requests[3].requestToolResults.some((result) => result.content.includes(restoredQnaReply))).toBe(true)
			await attachScreenshot(app, "manual-compaction-confirmed-final-state")
			await attachJson("manual-compaction-provider-consumptions", requests)
			await attachDlineOutput(userDataDir, "manual-compaction-dline-output")
			await attachVsCodeLogEvidence(userDataDir, "manual-compaction-vscode-log-scan")
			await attachJson("manual-compaction-webview-errors", webviewDiagnostics.errors)
			expectNoUnexpectedWebviewErrors(webviewDiagnostics.errors)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			webviewDiagnostics.dispose()
			await app.close()
		}
	},
)

e2e(
	"Manual compaction - Condense preserves draft until the user explicitly sends it",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(180_000)
		await configureAnthropicManualCompact(dlineDir)
		const guidance = "E2E_CONDENSE_INPUT_GUIDANCE"
		const summaryMarker = "E2E_CONDENSE_INPUT_SUMMARY"
		const summary = [
			`${summaryMarker} preserves the active implementation context.`,
			...Array.from(
				{ length: 120 },
				(_, index) => `Manual summary detail ${index + 1}: preserve the unresolved implementation evidence.`,
			),
		].join("\n")
		const continuationInput = "E2E_CONDENSE_POST_COMPACTION_INPUT continue with the unresolved verification."
		server.enqueueResponses(
			"anthropic-messages",
			{
				type: "tool",
				id: "call_condense_input_ready",
				name: "qna_respond",
				arguments: { response: "E2E_CONDENSE_INPUT_READY" },
				usage: { inputTokens: 80_000, outputTokens: 100 },
			},
			{
				type: "tool",
				id: "call_condense_input_summary",
				name: "summarize_task",
				arguments: { context: summary },
				expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER, "E2E_CONDENSE_INPUT_TASK", guidance],
				expectedRequestExcludes: ["/compact", continuationInput],
			},
			{
				type: "tool",
				id: "call_condense_input_completion",
				name: "qna_respond",
				arguments: { response: "E2E_CONDENSE_INPUT_DONE" },
				expectedRequestIncludes: [summaryMarker],
				expectedRequestExcludes: [COMPACT_INSTRUCTION_MARKER, guidance, continuationInput],
			},
			{
				type: "tool",
				id: "call_condense_input_explicit_continuation",
				name: "attempt_completion",
				arguments: { result: "E2E_CONDENSE_INPUT_SENT" },
				expectedRequestIncludes: [summaryMarker, continuationInput],
				expectedRequestExcludes: [COMPACT_INSTRUCTION_MARKER, guidance],
			},
		)

		const app = await openVSCode(workspaceDir)
		const webviewDiagnostics = await observeWebviewErrors(app)
		try {
			const sidebar = await openSidebar(app, helper)
			await sendTask(sidebar, "E2E_CONDENSE_INPUT_TASK")
			await expect(sidebar.getByText("E2E_CONDENSE_INPUT_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})

			await sendTask(sidebar, `/compact ${guidance}`)
			await expect(sidebar.getByText(summaryMarker, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			const confirmButton = sidebar.locator('vscode-button[aria-label="Condense Conversation"]')
			const input = sidebar.getByTestId("chat-input")
			const summaryScrollContainer = sidebar
				.getByTestId("summary-scroll-container")
				.filter({ hasText: summaryMarker })
				.last()
			await expect(confirmButton).toBeVisible()
			await expectSummaryScrollLayout(summaryScrollContainer)
			await input.fill(continuationInput)
			await attachScreenshot(app, "condense-input-summary-review")

			await confirmButton.click()
			await expect(input).toHaveValue(continuationInput)
			await expect(sidebar.getByText("E2E_CONDENSE_INPUT_DONE", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expect.poll(() => server.getRequestCount("anthropic-messages")).toBe(3)

			let requests = server.getMockConsumptions("anthropic-messages")
			const postCompactionRequest = requests[2]
			expect(postCompactionRequest.contractError).toBeUndefined()
			const postCompactionRequestText = JSON.stringify(postCompactionRequest.requestBody)
			expect(postCompactionRequestText).toContain(summaryMarker)
			expect(postCompactionRequestText).not.toContain(continuationInput)
			expect(postCompactionRequest.requestToolResults.some((result) => result.content.includes(continuationInput))).toBe(
				false,
			)

			await input.press("Enter")
			await expect(input).toHaveValue("")
			await expect(sidebar.getByText("E2E_CONDENSE_INPUT_SENT", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expect.poll(() => server.getRequestCount("anthropic-messages")).toBe(4)
			requests = server.getMockConsumptions("anthropic-messages")
			const explicitContinuationRequest = requests[3]
			expect(explicitContinuationRequest.contractError).toBeUndefined()
			const explicitContinuationRequestText = JSON.stringify(explicitContinuationRequest.requestBody)
			expect(explicitContinuationRequestText).toContain(summaryMarker)
			expect(explicitContinuationRequestText).toContain(continuationInput)
			for (const [requestIndex, request] of requests.entries()) {
				expect(request.contractError).toBeUndefined()
				assertAnthropicToolPairing(request, requestIndex)
			}
			await attachScreenshot(app, "condense-input-confirmed-final-state")
			await attachJson("condense-input-provider-consumptions", requests)
			await attachDlineOutput(userDataDir, "condense-input-dline-output")
			await attachVsCodeLogEvidence(userDataDir, "condense-input-vscode-log-scan")
			await attachJson("condense-input-webview-errors", webviewDiagnostics.errors)
			expectNoUnexpectedWebviewErrors(webviewDiagnostics.errors)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			webviewDiagnostics.dispose()
			await app.close()
		}
	},
)

e2e(
	"Automatic compaction - long summary is capped at 60vh with internal scrolling",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(150_000)
		await configureAutoCompact(dlineDir)
		const summaryMarker = "E2E_AUTO_SUMMARY_SCROLL"
		const summary = [
			`${summaryMarker} preserves automatic compaction context.`,
			...Array.from(
				{ length: 120 },
				(_, index) => `Automatic summary detail ${index + 1}: preserve the active task context.`,
			),
		].join("\n")
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_auto_summary_scroll_ready",
				name: "qna_respond",
				arguments: { response: "E2E_AUTO_SUMMARY_SCROLL_READY" },
				usage: { inputTokens: 125_000, outputTokens: 100 },
			},
			{
				type: "tool",
				id: "call_auto_summary_scroll_summary",
				name: "summarize_task",
				arguments: { context: summary },
				expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER, "E2E_AUTO_SUMMARY_SCROLL_TASK"],
			},
			{
				type: "tool",
				id: "call_auto_summary_scroll_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_AUTO_SUMMARY_SCROLL_DONE" },
				delayMs: 5_000,
				expectedRequestIncludes: [summaryMarker, "E2E_AUTO_SUMMARY_SCROLL_TRIGGER"],
				expectedRequestExcludes: [COMPACT_INSTRUCTION_MARKER],
			},
		)

		const app = await openVSCode(workspaceDir)
		const webviewDiagnostics = await observeWebviewErrors(app)
		try {
			const sidebar = await openSidebar(app, helper)
			await sendTask(sidebar, "E2E_AUTO_SUMMARY_SCROLL_TASK")
			await expect(sidebar.getByText("E2E_AUTO_SUMMARY_SCROLL_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await sendTask(sidebar, "E2E_AUTO_SUMMARY_SCROLL_TRIGGER")

			const summaryToggle = sidebar
				.getByRole("button", { name: "Expand summary" })
				.filter({ hasText: summaryMarker })
				.last()
			await expect(summaryToggle).toBeVisible({ timeout: 60_000 })
			await summaryToggle.click()
			const summaryScrollContainer = sidebar
				.getByTestId("summary-scroll-container")
				.filter({ hasText: summaryMarker })
				.last()
			await expectSummaryScrollLayout(summaryScrollContainer)
			await attachScreenshot(app, "automatic-compaction-summary-scroll")

			await expect(sidebar.getByText("E2E_AUTO_SUMMARY_SCROLL_DONE", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(3)
			const requests = server.getMockConsumptions("openai-compatible-responses")
			for (const request of requests) {
				expect(request.contractError).toBeUndefined()
				assertNoOrphanToolOutputs(request)
			}
			await attachJson("automatic-summary-scroll-provider-consumptions", requests)
			await attachDlineOutput(userDataDir, "automatic-summary-scroll-dline-output")
			await attachVsCodeLogEvidence(userDataDir, "automatic-summary-scroll-vscode-log-scan")
			await attachJson("automatic-summary-scroll-webview-errors", webviewDiagnostics.errors)
			expectNoUnexpectedWebviewErrors(webviewDiagnostics.errors)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			webviewDiagnostics.dispose()
			await app.close()
		}
	},
)

e2e(
	"Restore Chat - committed compaction returns to the pre-compaction task history",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(210_000)
		await configureAutoCompact(dlineDir)
		const summary = "E2E_COMPACTION_RESTORE_SUMMARY must disappear after checkpoint restore."
		const restoredSummary = "E2E_COMPACTION_RESTORE_RECOMPACTED must replace the restored summary."
		server.enqueueResponses(
			"openai-compatible-responses",
			{
				type: "tool",
				id: "call_compaction_restore_history_ready",
				name: "qna_respond",
				arguments: { response: "E2E_COMPACTION_RESTORE_HISTORY_READY" },
			},
			{
				type: "tool",
				id: "call_compaction_restore_ready",
				name: "qna_respond",
				arguments: { response: "E2E_COMPACTION_RESTORE_READY" },
				usage: { inputTokens: 125_000, outputTokens: 100 },
				expectedRequestIncludes: ["E2E_COMPACTION_RESTORE_HISTORY"],
			},
			{
				type: "tool",
				id: "call_compaction_restore_summary",
				name: "summarize_task",
				arguments: { context: summary },
				expectedRequestIncludes: [
					COMPACT_INSTRUCTION_MARKER,
					"E2E_COMPACTION_RESTORE_TASK",
					"E2E_COMPACTION_RESTORE_HISTORY",
				],
				expectedRequestExcludes: ["E2E_COMPACTION_RESTORE_TRIGGER"],
			},
			{
				type: "tool",
				id: "call_compaction_restore_committed",
				name: "attempt_completion",
				arguments: { result: "E2E_COMPACTION_RESTORE_COMMITTED" },
				expectedRequestIncludes: [summary, "E2E_COMPACTION_RESTORE_TRIGGER"],
				expectedRequestExcludes: [COMPACT_INSTRUCTION_MARKER],
			},
		)

		const app = await openVSCode(workspaceDir)
		const webviewDiagnostics = await observeWebviewErrors(app)
		try {
			const sidebar = await openSidebar(app, helper)
			await sendTask(sidebar, "E2E_COMPACTION_RESTORE_TASK")
			await expect(sidebar.getByText("E2E_COMPACTION_RESTORE_HISTORY_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await sendTask(sidebar, "E2E_COMPACTION_RESTORE_HISTORY")
			await expect(sidebar.getByText("E2E_COMPACTION_RESTORE_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})

			await sendTask(sidebar, "E2E_COMPACTION_RESTORE_TRIGGER")
			await expect(sidebar.locator("span.ph-no-capture").filter({ hasText: summary }).last()).toContainText(summary, {
				timeout: 60_000,
			})
			await expect(sidebar.getByText("E2E_COMPACTION_RESTORE_COMMITTED", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(4)

			const completedPass = sidebar.getByTestId("compaction-pass").filter({ hasText: summary }).last()
			await expect(completedPass).toHaveAttribute("data-compaction-status", "completed")
			await completedPass.scrollIntoViewIfNeeded()
			const restoreControl = completedPass.locator("svg.lucide-bookmark").locator("..")
			await expect(restoreControl).toBeVisible()
			await restoreControl.hover()
			const restoreButton = completedPass.getByRole("button", { name: "Restore", exact: true })
			await expect(restoreButton).toBeVisible()
			await restoreButton.focus()
			await expect(restoreButton).toBeVisible()
			await restoreButton.click()
			const restoreTaskButton = sidebar.getByRole("button", { name: "Restore Task Only", exact: true })
			await expect(restoreTaskButton).toBeVisible()
			await restoreTaskButton.click()

			await expect(sidebar.getByText(summary, { exact: false })).toHaveCount(0)
			await expect(sidebar.getByText("E2E_COMPACTION_RESTORE_COMMITTED", { exact: false })).toHaveCount(0)
			await expect(sidebar.getByTestId("compaction-pass").filter({ hasText: summary })).toHaveCount(0)
			const messageTimeline = sidebar.getByTestId("virtuoso-item-list")
			await expect(messageTimeline.getByText("E2E_COMPACTION_RESTORE_TASK", { exact: true })).toBeVisible()
			await expect(messageTimeline.getByText("E2E_COMPACTION_RESTORE_HISTORY", { exact: true })).toBeVisible()
			await expect(sidebar.locator('vscode-button[aria-label="Condense Conversation"]')).toHaveCount(0)
			await expect(sidebar.locator('vscode-button[aria-label="Regenerate Summary"]')).toHaveCount(0)
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(4)
			server.clearPendingResponses("openai-compatible-responses")
			server.enqueueResponses(
				"openai-compatible-responses",
				{
					type: "tool",
					id: "call_compaction_restore_recompacted",
					name: "summarize_task",
					arguments: { context: restoredSummary },
					expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER, "E2E_COMPACTION_RESTORE_TASK"],
					expectedRequestExcludes: [summary, "E2E_COMPACTION_RESTORE_TRIGGER"],
				},
				{
					type: "tool",
					id: "call_compaction_restore_resumed",
					name: "attempt_completion",
					arguments: { result: "E2E_COMPACTION_RESTORE_RESUMED" },
				},
			)

			const resumeButton = sidebar.getByText("Resume", { exact: true })
			await expect(resumeButton).toBeVisible({ timeout: 30_000 })
			const input = sidebar.getByTestId("chat-input")
			await input.fill("E2E_COMPACTION_RESTORE_AFTER_RESTORE")
			await resumeButton.click()
			await expect(input).toHaveValue("")
			await expect(sidebar.getByText("E2E_COMPACTION_RESTORE_RESUMED", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await expect.poll(() => server.getRequestCount("openai-compatible-responses")).toBe(6)

			const requests = server.getMockConsumptions("openai-compatible-responses")
			expect(requests[4]).toMatchObject({
				responseType: "tool",
				toolName: "summarize_task",
				toolCallId: "call_compaction_restore_recompacted",
			})
			const resumedRequest = requests[5]
			expect(resumedRequest.contractError).toBeUndefined()
			const resumedRequestText = JSON.stringify(resumedRequest.requestBody)
			expect(resumedRequestText).not.toContain("E2E_COMPACTION_RESTORE_TASK")
			expect(resumedRequestText).toContain("E2E_COMPACTION_RESTORE_AFTER_RESTORE")
			expect(resumedRequestText).not.toContain("E2E_COMPACTION_RESTORE_TRIGGER")
			expect(resumedRequestText).toContain("The previous task session was closed and has now been restored.")
			expect(resumedRequestText).not.toContain(summary)
			expect(resumedRequestText).toContain(restoredSummary)
			expect(resumedRequestText).not.toContain(COMPACT_INSTRUCTION_MARKER)
			assertNoOrphanToolOutputs(resumedRequest)
			await attachScreenshot(app, "checkpoint-restore-resumed-final-state")
			await attachJson("checkpoint-restore-provider-consumptions", requests)
			await attachDlineOutput(userDataDir, "checkpoint-restore-dline-output")
			await attachVsCodeLogEvidence(userDataDir, "checkpoint-restore-vscode-log-scan")
			await attachJson("checkpoint-restore-webview-errors", webviewDiagnostics.errors)
			expectNoUnexpectedWebviewErrors(webviewDiagnostics.errors)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			webviewDiagnostics.dispose()
			await app.close()
		}
	},
)

e2e(
	"Manual compaction - Regenerate without input starts a fresh Anthropic summary request",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(210_000)
		await configureAnthropicManualCompact(dlineDir)
		const guidance = "E2E_REGENERATE_EMPTY_GUIDANCE"
		const firstSummary = "E2E_REGENERATE_EMPTY_FIRST_SUMMARY must remain uncommitted."
		const regeneratedSummary = "E2E_REGENERATE_EMPTY_SECOND_SUMMARY uses a fresh request."
		server.enqueueResponses(
			"anthropic-messages",
			{
				type: "tool",
				id: "call_regenerate_empty_ready",
				name: "qna_respond",
				arguments: { response: "E2E_REGENERATE_EMPTY_READY" },
				usage: { inputTokens: 80_000, outputTokens: 100 },
			},
			{
				type: "tool",
				id: "call_regenerate_empty_summary_first",
				name: "summarize_task",
				arguments: { context: firstSummary },
				expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER, "E2E_REGENERATE_EMPTY_TASK", guidance],
				expectedRequestExcludes: ["/compact"],
			},
			{
				type: "tool",
				id: "call_regenerate_empty_summary_second",
				name: "summarize_task",
				arguments: { context: regeneratedSummary },
				matchRequestContract: true,
				expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER, "E2E_REGENERATE_EMPTY_TASK"],
				expectedRequestExcludes: ["/compact", guidance, firstSummary],
			},
			{
				type: "tool",
				id: "call_regenerate_empty_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_REGENERATE_EMPTY_DONE" },
				matchRequestContract: true,
				expectedRequestIncludes: [regeneratedSummary],
				expectedRequestExcludes: [COMPACT_INSTRUCTION_MARKER, guidance, firstSummary],
			},
		)

		const app = await openVSCode(workspaceDir)
		const webviewDiagnostics = await observeWebviewErrors(app)
		try {
			const sidebar = await openSidebar(app, helper)
			await sendTask(sidebar, "E2E_REGENERATE_EMPTY_TASK")
			await expect(sidebar.getByText("E2E_REGENERATE_EMPTY_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})

			await sendTask(sidebar, `/compact ${guidance}`)
			await expect(sidebar.getByText(firstSummary, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			const regenerateButton = sidebar.locator('vscode-button[aria-label="Regenerate Summary"]')
			const confirmButton = sidebar.locator('vscode-button[aria-label="Condense Conversation"]')
			const input = sidebar.getByTestId("chat-input")
			await expect(regenerateButton).toBeVisible()
			await expect(confirmButton).toBeVisible()
			await expect(input).toHaveValue("")
			await expect.poll(() => server.getRequestCount("anthropic-messages")).toBe(2)
			await attachScreenshot(app, "regenerate-empty-first-summary-review")

			await regenerateButton.click()
			await expect(input).toHaveValue("")
			await expect(sidebar.getByText(regeneratedSummary, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expect(regenerateButton).toBeVisible()
			await expect(confirmButton).toBeVisible()
			await expect.poll(() => server.getRequestCount("anthropic-messages")).toBe(3)
			await attachScreenshot(app, "regenerate-empty-second-summary-review")

			await confirmButton.click()
			await expect(sidebar.getByText("E2E_REGENERATE_EMPTY_DONE", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await expect.poll(() => server.getRequestCount("anthropic-messages")).toBe(4)

			const requests = server.getMockConsumptions("anthropic-messages")
			expect(requests[1]).toMatchObject({
				responseType: "tool",
				toolName: "summarize_task",
				toolCallId: "call_regenerate_empty_summary_first",
			})
			expect(requests[2]).toMatchObject({
				responseType: "tool",
				toolName: "summarize_task",
				toolCallId: "call_regenerate_empty_summary_second",
			})
			expect(requests[2].toolCallId).not.toBe(requests[1].toolCallId)
			for (const [requestIndex, request] of requests.entries()) {
				expect(request.contractError).toBeUndefined()
				assertAnthropicToolPairing(request, requestIndex)
			}
			await attachScreenshot(app, "regenerate-empty-confirmed-final-state")
			await attachJson("regenerate-empty-provider-consumptions", requests)
			await attachDlineOutput(userDataDir, "regenerate-empty-dline-output")
			await attachVsCodeLogEvidence(userDataDir, "regenerate-empty-vscode-log-scan")
			await attachJson("regenerate-empty-webview-errors", webviewDiagnostics.errors)
			expectNoUnexpectedWebviewErrors(webviewDiagnostics.errors)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			webviewDiagnostics.dispose()
			await app.close()
		}
	},
)

e2e(
	"Manual compaction - Regenerate with input sends feedback to a fresh Anthropic summary request",
	async ({ dlineDir, helper, openVSCode, server, userDataDir, workspaceDir }) => {
		e2e.setTimeout(210_000)
		await configureAnthropicManualCompact(dlineDir)
		const firstSummary = "E2E_REGENERATE_FIRST_SUMMARY must remain uncommitted."
		const feedback = "E2E_REGENERATE_FEEDBACK preserve the unresolved checkpoint requirement."
		const regeneratedSummary = "E2E_REGENERATE_SECOND_SUMMARY preserves the checkpoint requirement."
		server.enqueueResponses(
			"anthropic-messages",
			{
				type: "tool",
				id: "call_regenerate_history_ready",
				name: "qna_respond",
				arguments: { response: "E2E_REGENERATE_HISTORY_READY" },
			},
			{
				type: "tool",
				id: "call_regenerate_ready",
				name: "qna_respond",
				arguments: { response: "E2E_REGENERATE_READY" },
				usage: { inputTokens: 80_000, outputTokens: 100 },
				expectedRequestIncludes: ["E2E_REGENERATE_HISTORY"],
			},
			{
				type: "tool",
				id: "call_regenerate_summary_first",
				name: "summarize_task",
				arguments: { context: firstSummary },
				expectedRequestIncludes: [
					COMPACT_INSTRUCTION_MARKER,
					"E2E_REGENERATE_TASK",
					"E2E_REGENERATE_HISTORY",
					"E2E_REGENERATE_GUIDANCE",
				],
				expectedRequestExcludes: ["/compact", feedback],
			},
			{
				type: "tool",
				id: "call_regenerate_summary_second",
				name: "summarize_task",
				arguments: { context: regeneratedSummary },
				matchRequestContract: true,
				expectedRequestIncludes: [COMPACT_INSTRUCTION_MARKER, "E2E_REGENERATE_TASK", "E2E_REGENERATE_HISTORY", feedback],
				expectedRequestExcludes: ["/compact", firstSummary],
			},
			{
				type: "tool",
				id: "call_regenerate_unexpected_auto_commit",
				name: "attempt_completion",
				arguments: { result: "E2E_REGENERATE_UNEXPECTED_AUTO_COMMIT" },
				matchRequestContract: true,
				expectedRequestIncludes: [firstSummary],
				expectedRequestExcludes: [feedback, regeneratedSummary],
			},
			{
				type: "tool",
				id: "call_regenerate_completion",
				name: "attempt_completion",
				arguments: { result: "E2E_REGENERATE_DONE" },
				matchRequestContract: true,
				expectedRequestIncludes: [regeneratedSummary],
				expectedRequestExcludes: [COMPACT_INSTRUCTION_MARKER, firstSummary, feedback],
			},
		)

		const app = await openVSCode(workspaceDir)
		const webviewDiagnostics = await observeWebviewErrors(app)
		try {
			const sidebar = await openSidebar(app, helper)
			await sendTask(sidebar, "E2E_REGENERATE_TASK")
			await expect(sidebar.getByText("E2E_REGENERATE_HISTORY_READY", { exact: false }).last()).toBeVisible({
				timeout: 60_000,
			})
			await sendTask(sidebar, "E2E_REGENERATE_HISTORY")
			await expect(sidebar.getByText("E2E_REGENERATE_READY", { exact: false }).last()).toBeVisible({ timeout: 60_000 })

			await sendTask(sidebar, "/compact E2E_REGENERATE_GUIDANCE")
			await expect(sidebar.getByText(firstSummary, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expect(
				sidebar.getByText("Error executing summarize_task: Current ask promise was ignored", { exact: false }),
			).toHaveCount(0)
			const regenerateButton = sidebar.locator('vscode-button[aria-label="Regenerate Summary"]')
			const confirmButton = sidebar.locator('vscode-button[aria-label="Condense Conversation"]')
			await expect(regenerateButton).toBeVisible()
			await expect(confirmButton).toBeVisible()
			await expect(sidebar.getByText("E2E_REGENERATE_DONE", { exact: false })).toHaveCount(0)
			await expect.poll(() => server.getRequestCount("anthropic-messages")).toBe(3)
			await attachScreenshot(app, "regenerate-first-summary-review")

			const input = sidebar.getByTestId("chat-input")
			await input.fill(feedback)
			await regenerateButton.click()
			await expect(input).toHaveValue("")
			await expect(sidebar.getByText(regeneratedSummary, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expect(
				sidebar.getByText("Error executing summarize_task: Current ask promise was ignored", { exact: false }),
			).toHaveCount(0)
			await expect(regenerateButton).toBeVisible()
			await expect(confirmButton).toBeVisible()
			await expect(sidebar.getByText("E2E_REGENERATE_DONE", { exact: false })).toHaveCount(0)
			await expect.poll(() => server.getRequestCount("anthropic-messages")).toBe(4)
			await attachScreenshot(app, "regenerate-second-summary-review")

			await confirmButton.click()
			await expect(sidebar.getByText("E2E_REGENERATE_DONE", { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expect.poll(() => server.getRequestCount("anthropic-messages")).toBe(5)

			const requests = server.getMockConsumptions("anthropic-messages")
			expect(requests[2]).toMatchObject({
				responseType: "tool",
				toolName: "summarize_task",
				toolCallId: "call_regenerate_summary_first",
			})
			expect(requests[3]).toMatchObject({
				responseType: "tool",
				toolName: "summarize_task",
				toolCallId: "call_regenerate_summary_second",
			})
			expect(requests[3].toolCallId).not.toBe(requests[2].toolCallId)
			expect(JSON.stringify(requests[3].requestBody)).toContain(feedback)
			expect(requestToolNames(requests[3])).toEqual(requestToolNames(requests[2]))
			expect(requestToolNames(requests[3])).not.toContain("summarize_task")
			await attachJson("regenerate-provider-consumptions", requests)
			for (const [requestIndex, request] of requests.entries()) {
				expect(request.contractError).toBeUndefined()
				assertAnthropicToolPairing(request, requestIndex)
			}
			await attachScreenshot(app, "regenerate-confirmed-final-state")
			await attachDlineOutput(userDataDir, "regenerate-dline-output")
			await attachVsCodeLogEvidence(userDataDir, "regenerate-vscode-log-scan")
			await attachJson("regenerate-webview-errors", webviewDiagnostics.errors)
			expectNoUnexpectedWebviewErrors(webviewDiagnostics.errors)
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			webviewDiagnostics.dispose()
			await app.close()
		}
	},
)
