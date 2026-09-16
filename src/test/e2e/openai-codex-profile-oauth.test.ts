import { randomUUID } from "node:crypto"
import { access, readFile, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import * as path from "node:path"
import { expect, type Frame, type Locator, type Page } from "@playwright/test"
import type { ElectronApplication } from "playwright"
import { getOpenAiCodexProfileAuthFileName } from "../../core/storage/secrets/OpenAiCodexProfileAuthPath"
import { E2ETestHelper, e2e } from "./utils/helpers"
import { MultiInstanceLauncher } from "./utils/multi-instance"
import { resizePrimarySidebar } from "./utils/resize-primary-sidebar"

interface OAuthScenario {
	accountId: string
	accessToken: string
	refreshToken: string
	responseText: string
}

interface CodexRequest {
	authorization?: string
	accountId?: string
	sessionId?: string
	threadId?: string
	clientRequestId?: string
	body: Record<string, unknown>
}

interface ModelRequest extends CodexRequest {
	clientVersion?: string
}

interface ResetCreditRequest extends CodexRequest {
	body: Record<string, unknown>
}

interface StoredProfile {
	id: string
	name: string
	provider: string
	modelId: string
	usedFor: string[]
	enabled: boolean
	webToolsMode?: string
}

class CodexOAuthE2EServer {
	private readonly server: Server
	private readonly scenarios: OAuthScenario[] = []
	private readonly exchanges = new Map<string, OAuthScenario>()
	private readonly callbackByState = new Map<string, string>()
	private readonly callbacks: string[] = []
	private readonly codexResponseEventBatches: unknown[][] = []
	readonly authorizationRequests: string[] = []
	readonly codexRequests: CodexRequest[] = []
	readonly modelRequests: ModelRequest[] = []
	readonly usageRequests: CodexRequest[] = []
	readonly resetCreditListRequests: CodexRequest[] = []
	readonly resetCreditRequests: ResetCreditRequest[] = []
	private usageResponse: unknown = { rate_limit: {}, credits: { balance: 0 } }
	private resetCreditsResponse: unknown = { credits: [], total_count: 0 }
	tokenRequestCount = 0
	baseUrl = ""

	constructor() {
		this.server = createServer((request, response) => void this.handle(request, response))
	}

	async start(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			this.server.once("error", reject)
			this.server.listen(0, "127.0.0.1", () => resolve())
		})
		const address = this.server.address() as AddressInfo
		this.baseUrl = `http://127.0.0.1:${address.port}`
	}

	async stop(): Promise<void> {
		await new Promise<void>((resolve, reject) => {
			this.server.close((error) => (error ? reject(error) : resolve()))
		})
	}

	enqueue(scenario: OAuthScenario): void {
		this.scenarios.push(scenario)
	}

	enqueueCodexResponseEvents(events: readonly unknown[]): void {
		this.codexResponseEventBatches.push([...events])
	}

	setUsageResponse(response: unknown): void {
		this.usageResponse = response
	}

	setResetCreditsResponse(response: unknown): void {
		this.resetCreditsResponse = response
	}

	latestCallback(): string | undefined {
		return this.callbacks.at(-1)
	}

	allCallbacks(): readonly string[] {
		return [...this.callbacks]
	}

	private async handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
		try {
			const url = new URL(request.url ?? "/", this.baseUrl)
			if (request.method === "GET" && url.pathname.startsWith("/oauth/authorize/")) {
				this.authorize(url, response)
				return
			}
			if (request.method === "POST" && url.pathname === "/oauth/token") {
				await this.token(request, response)
				return
			}
			if (request.method === "POST" && url.pathname === "/codex/responses") {
				await this.codex(request, response)
				return
			}
			if (request.method === "GET" && url.pathname === "/codex/models") {
				this.models(url, request, response)
				return
			}
			if (request.method === "GET" && url.pathname === "/usage") {
				this.usageRequests.push({
					authorization: typeof request.headers.authorization === "string" ? request.headers.authorization : undefined,
					accountId:
						typeof request.headers["chatgpt-account-id"] === "string"
							? request.headers["chatgpt-account-id"]
							: undefined,
				})
				this.json(response, 200, this.usageResponse)
				return
			}
			if (request.method === "GET" && url.pathname === "/rate-limit-reset-credits") {
				this.resetCreditListRequests.push({
					authorization: typeof request.headers.authorization === "string" ? request.headers.authorization : undefined,
					accountId:
						typeof request.headers["chatgpt-account-id"] === "string"
							? request.headers["chatgpt-account-id"]
							: undefined,
				})
				this.json(response, 200, this.resetCreditsResponse)
				return
			}
			if (request.method === "POST" && url.pathname === "/rate-limit-reset-credits/consume") {
				this.resetCreditRequests.push({
					authorization: typeof request.headers.authorization === "string" ? request.headers.authorization : undefined,
					accountId:
						typeof request.headers["chatgpt-account-id"] === "string"
							? request.headers["chatgpt-account-id"]
							: undefined,
					body: JSON.parse(await this.readBody(request)) as Record<string, unknown>,
				})
				this.json(response, 200, { result: "reset", windows_reset: ["primary", "secondary"] })
				return
			}
			this.json(response, 404, { error: "not_found" })
		} catch {
			this.json(response, 500, { error: "mock_failure" })
		}
	}

	private authorize(url: URL, response: ServerResponse): void {
		this.authorizationRequests.push(url.toString())
		const redirectUri = url.searchParams.get("redirect_uri")
		const state = url.searchParams.get("state")
		if (!redirectUri || !state || !url.searchParams.get("code_challenge")) {
			this.json(response, 400, { error: "invalid_authorization_request" })
			return
		}

		let callbackUri = this.callbackByState.get(state)
		if (!callbackUri) {
			const scenario = this.scenarios.shift()
			if (!scenario) {
				this.json(response, 400, { error: "missing_oauth_scenario" })
				return
			}
			const code = randomUUID()
			this.exchanges.set(code, scenario)
			const callback = new URL(redirectUri)
			callback.searchParams.set("code", code)
			callback.searchParams.set("state", state)
			callbackUri = callback.toString()
			this.callbackByState.set(state, callbackUri)
			this.callbacks.push(callbackUri)
		}

		if (url.pathname.endsWith("/manual")) {
			response.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
			response.end(
				`<!doctype html><title>OAuth callback</title><p>Copy this callback URI into Dline:</p><code>${callbackUri}</code>`,
			)
			return
		}
		response.writeHead(302, {
			"Cache-Control": "no-store",
			Connection: "close",
			Location: callbackUri,
		})
		response.end()
	}

	private async token(request: IncomingMessage, response: ServerResponse): Promise<void> {
		this.tokenRequestCount += 1
		const body = new URLSearchParams(await this.readBody(request))
		const scenario = this.exchanges.get(body.get("code") ?? "")
		if (!scenario || body.get("grant_type") !== "authorization_code" || !body.get("code_verifier")) {
			this.json(response, 400, { error: "invalid_grant" })
			return
		}
		this.exchanges.delete(body.get("code")!)
		this.json(response, 200, {
			access_token: scenario.accessToken,
			refresh_token: scenario.refreshToken,
			expires_in: 3600,
			id_token: this.jwt({ chatgpt_account_id: scenario.accountId }),
		})
	}

	private models(url: URL, request: IncomingMessage, response: ServerResponse): void {
		const authorization = typeof request.headers.authorization === "string" ? request.headers.authorization : undefined
		const accountId =
			typeof request.headers["chatgpt-account-id"] === "string" ? request.headers["chatgpt-account-id"] : undefined
		this.modelRequests.push({ authorization, accountId, clientVersion: url.searchParams.get("client_version") ?? undefined })
		this.json(response, 200, {
			models: [
				{
					slug: "gpt-codex-remote-e2e",
					display_name: "Codex Remote E2E",
					supported_in_api: true,
					visibility: "list",
				},
			],
		})
	}

	private async codex(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const authorization = typeof request.headers.authorization === "string" ? request.headers.authorization : undefined
		const accountId =
			typeof request.headers["chatgpt-account-id"] === "string" ? request.headers["chatgpt-account-id"] : undefined
		const body = JSON.parse(await this.readBody(request)) as Record<string, unknown>
		const requestIndex = this.codexRequests.length + 1
		this.codexRequests.push({
			authorization,
			accountId,
			sessionId: typeof request.headers["session-id"] === "string" ? request.headers["session-id"] : undefined,
			threadId: typeof request.headers["thread-id"] === "string" ? request.headers["thread-id"] : undefined,
			clientRequestId:
				typeof request.headers["x-client-request-id"] === "string" ? request.headers["x-client-request-id"] : undefined,
			body,
		})
		const text = accountId ? `CODEX_E2E_${accountId}` : "CODEX_E2E_MISSING_ACCOUNT"
		const messageId = `msg_e2e_${requestIndex}`
		const responseId = `resp_e2e_${requestIndex}`
		const events = this.codexResponseEventBatches.shift() ?? [
			{
				type: "response.output_item.added",
				output_index: 0,
				sequence_number: 1,
				item: { type: "message", id: messageId, role: "assistant", content: [] },
			},
			{ type: "response.output_text.delta", item_id: messageId, delta: text, output_index: 0, sequence_number: 2 },
			{
				type: "response.output_item.done",
				output_index: 0,
				sequence_number: 3,
				item: { type: "message", id: messageId, role: "assistant", content: [{ type: "output_text", text }] },
			},
			{
				type: "response.completed",
				response: {
					id: responseId,
					usage: { input_tokens: 1, input_tokens_details: { cached_tokens: 0 }, output_tokens: 1 },
				},
			},
		]
		response.writeHead(200, {
			"Content-Type": "text/event-stream",
			"Cache-Control": "no-cache",
			Connection: "keep-alive",
		})
		for (const event of events) response.write(`data: ${JSON.stringify(event)}\n\n`)
		response.end("data: [DONE]\n\n")
	}

	private jwt(payload: Record<string, unknown>): string {
		return `e2e.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.signature`
	}

	private readBody(request: IncomingMessage): Promise<string> {
		return new Promise((resolve, reject) => {
			let body = ""
			request.setEncoding("utf8")
			request.on("data", (chunk) => (body += chunk))
			request.on("end", () => resolve(body))
			request.on("error", reject)
		})
	}

	private json(response: ServerResponse, status: number, body: unknown): void {
		response.writeHead(status, { "Content-Type": "application/json" })
		response.end(JSON.stringify(body))
	}
}

function scenario(label: string): OAuthScenario {
	const accountId = `account-${label}`
	return {
		accountId,
		accessToken: `e2e.${Buffer.from(
			JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: accountId } }),
		).toString("base64url")}.signature`,
		refreshToken: randomUUID(),
		responseText: `CODEX_E2E_${accountId}`,
	}
}

interface CodexResponseTool {
	itemId: string
	callId: string
	name: string
	arguments: string
}

function codexConversationEvents(text: string, suffix: string, includeReasoning = false, tool?: CodexResponseTool): unknown[] {
	const messageId = `msg_${suffix}`
	const responseId = `resp_${suffix}`
	const reasoningId = `rs_${suffix}`
	return [
		...(includeReasoning
			? [
					{
						type: "response.output_item.added",
						output_index: 0,
						sequence_number: 1,
						item: { type: "reasoning", id: reasoningId, summary: [], encrypted_content: "partial-cache-reasoning" },
					},
					{ type: "response.reasoning.delta", delta: "cache reasoning", output_index: 0, sequence_number: 2 },
					{
						type: "response.output_item.done",
						output_index: 0,
						sequence_number: 3,
						item: {
							type: "reasoning",
							id: reasoningId,
							text: "cache reasoning",
							encrypted_content: "final-cache-reasoning",
						},
					},
				]
			: []),
		{
			type: "response.output_item.added",
			output_index: includeReasoning ? 1 : 0,
			sequence_number: 4,
			item: { type: "message", id: messageId, role: "assistant", content: [] },
		},
		{ type: "response.text.delta", delta: text, output_index: includeReasoning ? 1 : 0, sequence_number: 5 },
		{
			type: "response.output_item.done",
			output_index: includeReasoning ? 1 : 0,
			sequence_number: 6,
			item: { type: "message", id: messageId, role: "assistant", content: [{ type: "output_text", text }] },
		},
		...(tool
			? [
					{
						type: "response.output_item.added",
						output_index: includeReasoning ? 2 : 1,
						sequence_number: 7,
						item: {
							type: "tool_call",
							id: tool.itemId,
							tool_call_id: tool.callId,
							name: tool.name,
							arguments: "",
						},
					},
					{
						type: "response.tool_call_arguments.delta",
						item_id: tool.itemId,
						tool_call_id: tool.callId,
						function_name: tool.name,
						delta: tool.arguments,
						output_index: includeReasoning ? 2 : 1,
						sequence_number: 8,
					},
					{
						type: "response.tool_call_arguments.done",
						item_id: tool.itemId,
						tool_call_id: tool.callId,
						function_name: tool.name,
						arguments: tool.arguments,
						output_index: includeReasoning ? 2 : 1,
						sequence_number: 9,
					},
					{
						type: "response.output_item.done",
						output_index: includeReasoning ? 2 : 1,
						sequence_number: 10,
						item: {
							type: "tool_call",
							id: tool.itemId,
							tool_call_id: tool.callId,
							name: tool.name,
							arguments: tool.arguments,
						},
					},
				]
			: []),
		{
			type: "response.done",
			response: {
				id: responseId,
				usage: { input_tokens: 100, input_tokens_details: { cached_tokens: 80 }, output_tokens: 10 },
			},
		},
	]
}

async function pathExists(filePath: string): Promise<boolean> {
	return access(filePath)
		.then(() => true)
		.catch(() => false)
}

async function addCodexProfiles(dlineDir: string, profiles: readonly StoredProfile[]): Promise<void> {
	const profilesPath = path.join(dlineDir, "data", "settings", "api_profiles.json")
	const current = JSON.parse(await readFile(profilesPath, "utf8")) as StoredProfile[]
	await writeFile(profilesPath, `${JSON.stringify([...current, ...profiles], null, 2)}\n`, "utf8")
}

function codexProfile(id: string, name: string): StoredProfile {
	return {
		id,
		name,
		provider: "openai-codex",
		modelId: "gpt-5.6-sol",
		usedFor: ["act", "plan"],
		enabled: true,
		webToolsMode: "WEB_TOOLS_MODE_FORCE_OFF",
	}
}

function profileCard(sidebar: Frame, name: string): Locator {
	const escapedName = name.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
	const cards = sidebar.getByTestId("api-profile-card")
	const expanded = cards.filter({
		has: sidebar.locator(`input[aria-label="Profile name"][value="${escapedName}"]`),
	})
	return expanded.or(cards.filter({ hasText: name }))
}

async function openSettings(page: Page, sidebar: Frame): Promise<void> {
	await page.getByRole("button", { name: "Settings", exact: true }).click()
	await expect(sidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible()
}

async function expandProfile(sidebar: Frame, name: string): Promise<Locator> {
	let card = profileCard(sidebar, name)
	await expect(card).toHaveCount(1)
	const expand = card.getByRole("button", { name: `Expand ${name}` })
	if (await expand.isVisible()) await expand.click()
	card = profileCard(sidebar, name)
	await expect(card.getByRole("combobox", { name: "Provider", exact: true })).toBeVisible()
	return card
}

async function signInProfile(sidebar: Frame, name: string, server: CodexOAuthE2EServer): Promise<void> {
	const authorizationCount = server.authorizationRequests.length
	const callbackCount = server.allCallbacks().length
	const tokenRequestCount = server.tokenRequestCount
	const card = await expandProfile(sidebar, name)
	await card.getByRole("button", { name: "Sign in", exact: true }).click()
	await expect.poll(() => server.authorizationRequests.length, { timeout: 30_000 }).toBeGreaterThan(authorizationCount)
	await expect.poll(() => server.allCallbacks().length, { timeout: 30_000 }).toBeGreaterThan(callbackCount)
	await expect
		.poll(() => server.tokenRequestCount, {
			timeout: 30_000,
			message: "OAuth browser redirect did not reach token exchange",
		})
		.toBeGreaterThan(tokenRequestCount)
	await expect(sidebar.getByRole("dialog", { name: "Sign in to ChatGPT" })).not.toBeVisible({ timeout: 30_000 })
	await expect(card.getByText("ChatGPT: Signed in", { exact: true })).toBeVisible({ timeout: 30_000 })
}

async function selectProfile(sidebar: Frame, name: string): Promise<void> {
	const switcher = sidebar.getByRole("button", { name: "Select model" })
	for (let attempt = 1; attempt <= 3; attempt++) {
		if ((await switcher.innerText()).trim() === name) return
		await switcher.click()
		const option = sidebar.getByRole("option").filter({ has: sidebar.getByText(name, { exact: true }) })
		await expect(option).toHaveCount(1)
		await option.click()
		try {
			await expect(switcher).toHaveText(name, { timeout: 15_000 })
			return
		} catch (error) {
			if (attempt === 3) throw error
		}
	}
}

async function send(sidebar: Frame, text: string, expected: string): Promise<void> {
	const input = sidebar.getByTestId("chat-input")
	await expect(input).toBeEnabled({ timeout: 60_000 })
	await input.fill(text)
	await sidebar.getByTestId("send-button").click()
	await expect(sidebar.getByText(expected, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
}

async function openReadySidebar(
	openVSCode: (workspacePath: string, environmentOverrides?: Readonly<Record<string, string>>) => Promise<ElectronApplication>,
	workspaceDir: string,
	helper: E2ETestHelper,
	environment: Readonly<Record<string, string>>,
): Promise<{ app: ElectronApplication; page: Page; sidebar: Frame }> {
	let first: ElectronApplication | undefined
	try {
		first = await openVSCode(workspaceDir, environment)
		const page = await first.firstWindow()
		await E2ETestHelper.openClineSidebar(page)
		return { app: first, page, sidebar: await helper.getSidebar(page) }
	} catch {
		await first?.close().catch(() => undefined)
		helper.clearCachedFrame()
		const app = await openVSCode(workspaceDir, environment)
		const page = await app.firstWindow()
		await E2ETestHelper.openClineSidebar(page)
		return { app, page, sidebar: await helper.getSidebar(page) }
	}
}

interface CodexEnvironmentOptions {
	callbackPorts?: readonly number[]
	timeoutMs?: number
}

function codexEnvironment(
	server: CodexOAuthE2EServer,
	mode: "automatic" | "manual",
	options: CodexEnvironmentOptions = {},
): Readonly<Record<string, string>> {
	return {
		DLINE_E2E_OPENAI_CODEX_OAUTH_BASE_URL: `${server.baseUrl}/oauth`,
		DLINE_E2E_OPENAI_CODEX_API_BASE_URL: `${server.baseUrl}/codex`,
		DLINE_E2E_OPENAI_CODEX_USAGE_URL: `${server.baseUrl}/usage`,
		DLINE_E2E_OPENAI_CODEX_OAUTH_MODE: mode,
		...(options.callbackPorts ? { DLINE_E2E_OPENAI_CODEX_CALLBACK_PORTS: options.callbackPorts.join(",") } : {}),
		...(options.timeoutMs ? { DLINE_E2E_OPENAI_CODEX_OAUTH_TIMEOUT_MS: String(options.timeoutMs) } : {}),
	}
}

function assertNoRuntimeSecrets(value: string, scenarios: readonly OAuthScenario[], callbacks: readonly string[]): void {
	for (const item of scenarios) {
		expect(value).not.toContain(item.accessToken)
		expect(value).not.toContain(item.refreshToken)
	}
	for (const callback of callbacks) {
		expect(value).not.toContain(callback)
		const parsed = new URL(callback)
		for (const name of ["code", "state"] as const) {
			const secret = parsed.searchParams.get(name)
			if (secret) expect(value).not.toContain(secret)
		}
	}
}

e2e(
	"OpenAI Codex OAuth remote models appear in the Profile model picker",
	async ({ dlineDir, helper, openVSCode, workspaceDir }) => {
		e2e.setTimeout(120_000)
		const server = new CodexOAuthE2EServer()
		await server.start()
		const profile = codexProfile("codex-profile-models", "Codex Remote Models")
		const accessToken = randomUUID()
		const accountId = "account-models"
		await addCodexProfiles(dlineDir, [profile])
		const authPath = path.join(dlineDir, "data", "secrets", getOpenAiCodexProfileAuthFileName(profile.id))
		await writeFile(
			authPath,
			`${JSON.stringify({
				type: "openai-codex",
				access_token: accessToken,
				expires: Date.now() + 3_600_000,
				accountId,
			})}\n`,
			"utf8",
		)
		let app: ElectronApplication | undefined

		try {
			const ready = await openReadySidebar(openVSCode, workspaceDir, helper, codexEnvironment(server, "manual"))
			app = ready.app
			await helper.signin(ready.sidebar)
			await openSettings(ready.page, ready.sidebar)
			const card = await expandProfile(ready.sidebar, profile.name)
			await expect(card.getByText("ChatGPT: Signed in", { exact: true })).toBeVisible({ timeout: 30_000 })
			const modelLabel = card.getByText("Model", { exact: true }).first()
			await modelLabel.scrollIntoViewIfNeeded()
			await modelLabel.click()
			await expect.poll(() => server.modelRequests.length).toBeGreaterThan(0)
			await expect(card.getByText("gpt-codex-remote-e2e", { exact: true })).toBeVisible({ timeout: 30_000 })
			expect(server.modelRequests.at(-1)).toMatchObject({
				authorization: `Bearer ${accessToken}`,
				accountId,
			})
			expect(server.modelRequests.at(-1)?.clientVersion).toBeTruthy()
		} finally {
			await app?.close().catch(() => undefined)
			await server.stop()
		}
	},
)

e2e(
	"Provider usage renders one neutral effective quota and confirms reset-card consumption",
	async ({ dlineDir, helper, openVSCode, userDataDir, workspaceDir }) => {
		e2e.setTimeout(120_000)
		const server = new CodexOAuthE2EServer()
		await server.start()
		const profile = codexProfile("codex-profile-usage", "Codex Usage")
		const accessToken = randomUUID()
		const accountId = "account-usage"
		const credentialExpiresAtMs = Date.now() + 3_600_000
		const resetCreditExpiresAt = "2026-10-10T12:00:00Z"
		server.setUsageResponse({
			plan_type: "pro",
			rate_limit: {
				allowed: true,
				limit_reached: false,
				primary_window: { used_percent: 80, limit_window_seconds: 18_000, reset_at: 1_800_000_000 },
				secondary_window: { used_percent: 30, limit_window_seconds: 604_800, reset_at: 1_800_500_000 },
			},
			credits: { balance: "0.00" },
			rate_limit_reset_credits: { available_count: 1 },
		})
		server.setResetCreditsResponse({
			credits: [{ id: "credit-e2e", granted_at: "2026-09-10T00:00:00Z", expires_at: resetCreditExpiresAt }],
			total_count: 1,
		})
		await addCodexProfiles(dlineDir, [profile])
		const authPath = path.join(dlineDir, "data", "secrets", getOpenAiCodexProfileAuthFileName(profile.id))
		await writeFile(
			authPath,
			`${JSON.stringify({
				type: "openai-codex",
				access_token: accessToken,
				expires: credentialExpiresAtMs,
				accountId,
				displayName: "Codex E2E User",
				email: "codex-e2e@example.test",
				accountType: "pro",
			})}\n`,
			"utf8",
		)
		let app: ElectronApplication | undefined

		try {
			const ready = await openReadySidebar(openVSCode, workspaceDir, helper, codexEnvironment(server, "manual"))
			app = ready.app
			await helper.signin(ready.sidebar)
			await openSettings(ready.page, ready.sidebar)
			const card = await expandProfile(ready.sidebar, profile.name)
			const account = card.getByLabel("Signed-in ChatGPT account")
			await expect(account.getByText("Codex E2E User", { exact: true })).toBeVisible({ timeout: 30_000 })
			await expect(account.getByText("codex-e2e@example.test", { exact: true })).toBeVisible()
			await expect(account.getByText("Pro", { exact: true })).toBeVisible()
			await expect(account.getByText(/^Sign-in expires /)).toBeVisible()
			const accountCard = account.locator("..")
			await expect(accountCard.getByRole("button", { name: "Sign in again" })).toBeVisible()
			await expect(accountCard.getByRole("button", { name: "Sign out" })).toBeVisible()
			await expect.poll(() => server.usageRequests.length).toBeGreaterThan(0)
			await expect.poll(() => server.resetCreditListRequests.length).toBeGreaterThan(0)
			expect(server.usageRequests.at(-1)).toEqual({ authorization: `Bearer ${accessToken}`, accountId })
			expect(server.resetCreditListRequests.at(-1)).toEqual({ authorization: `Bearer ${accessToken}`, accountId })

			const summary = card.getByRole("button", { name: "Usage 5 hour 20%" })
			await expect(summary).toBeVisible({ timeout: 30_000 })
			expect(await summary.evaluate((element) => getComputedStyle(element).borderTopWidth)).toBe("0px")
			await summary.click()
			await expect(card.getByText("20% remaining", { exact: true })).toBeVisible()
			await expect(card.getByText("70% remaining", { exact: true })).toBeVisible()
			await expect(card.getByRole("progressbar", { name: "5 hour usage" })).toHaveAttribute("data-usage-tone", "warning")
			await expect(card.getByRole("progressbar", { name: "7 day usage" })).toHaveAttribute("data-usage-tone", "success")
			await expect(card.getByText("Reset cards: 1", { exact: true })).toBeVisible()
			await expect(card.getByText(/^Expires /)).toBeVisible()

			await card.getByRole("button", { name: "Use reset card 1" }).click()
			const dialog = ready.sidebar.getByRole("dialog", { name: "Use a rate-limit reset card?" })
			await expect(dialog).toBeVisible()
			expect(server.resetCreditRequests).toHaveLength(0)
			await dialog.getByRole("button", { name: "Cancel" }).click()
			await expect(dialog).not.toBeVisible()
			expect(server.resetCreditRequests).toHaveLength(0)

			await card.getByRole("button", { name: "Use reset card 1" }).click()
			await dialog.getByRole("button", { name: "Use reset card" }).click()
			await expect.poll(() => server.resetCreditRequests.length).toBe(1)
			const resetRequest = server.resetCreditRequests[0]
			expect(resetRequest).toMatchObject({ authorization: `Bearer ${accessToken}`, accountId })
			expect(Object.keys(resetRequest.body)).toEqual(["credit_id", "redeem_request_id"])
			expect(resetRequest.body.credit_id).toBe("credit-e2e")
			expect(resetRequest.body.redeem_request_id).toEqual(expect.any(String))
			await expect(card.getByText("Reset completed for primary and secondary.", { exact: true })).toBeVisible()

			await ready.sidebar.getByRole("button", { name: "Done", exact: true }).click()
			await selectProfile(ready.sidebar, profile.name)
			await resizePrimarySidebar(ready.page, 700)
			await expect.poll(() => ready.sidebar.evaluate(() => window.innerWidth)).toBeGreaterThan(420)
			const inputUsage = ready.sidebar.getByRole("button", { name: "Provider usage" })
			await expect(inputUsage).toBeVisible({ timeout: 30_000 })
			await expect(inputUsage).toHaveCount(1)
			await expect(inputUsage).toHaveText("5h: 20%")
			await expect(inputUsage).toHaveClass(/text-foreground/)
			await expect(inputUsage).not.toHaveClass(/text-success|text-editor-warning-foreground|text-error/)
			await expect(ready.sidebar.getByRole("button", { name: "OpenAI Codex usage" })).toHaveCount(0)
			const colors = await inputUsage.evaluate((element) => {
				const successProbe = document.createElement("span")
				successProbe.className = "text-success"
				document.body.appendChild(successProbe)
				const value = {
					usage: getComputedStyle(element).color,
					success: getComputedStyle(successProbe).color,
				}
				successProbe.remove()
				return value
			})
			expect(colors.usage).not.toBe(colors.success)
			await inputUsage.hover()
			const usageTooltip = ready.sidebar.locator('[data-slot="tooltip-content"]:visible')
			await expect(usageTooltip).toContainText("5 hour20% remaining")
			await expect(usageTooltip).toContainText("Reset cards: 1")
			await expect(usageTooltip).toContainText("Next card expires")
			await inputUsage.click()
			const usagePanel = ready.sidebar.getByLabel("Provider usage details")
			await expect(usagePanel).toBeVisible()
			await expect(usagePanel.getByRole("button", { name: "Use reset card 1" })).toBeVisible()
			await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir)
		} finally {
			await app?.close().catch(() => undefined)
			await server.stop()
		}
	},
)

e2e(
	"OpenAI Codex OAuth keeps two Profiles isolated across restart, requests and targeted lifecycle changes",
	async ({ dlineDir, helper, openVSCode, userDataDir, workspaceDir }) => {
		e2e.setTimeout(240_000)
		const server = new CodexOAuthE2EServer()
		await server.start()
		const profileA = codexProfile("codex-profile-a", "Codex Profile A")
		const profileB = codexProfile("codex-profile-b", "Codex Profile B")
		const authA = scenario("a")
		const authB = scenario("b")
		const authA2 = scenario("a2")
		server.enqueue(authA)
		server.enqueue(authB)
		server.enqueue(authA2)
		await addCodexProfiles(dlineDir, [profileA, profileB])
		const environment = codexEnvironment(server, "automatic")
		let app: ElectronApplication | undefined
		let reopened: ElectronApplication | undefined

		try {
			const initial = await openReadySidebar(openVSCode, workspaceDir, helper, environment)
			app = initial.app
			const page = initial.page
			let sidebar = initial.sidebar
			await helper.signin(sidebar)
			await openSettings(page, sidebar)
			await signInProfile(sidebar, profileA.name, server)
			await signInProfile(sidebar, profileB.name, server)

			const secretsDir = path.join(dlineDir, "data", "secrets")
			const authPathA = path.join(secretsDir, getOpenAiCodexProfileAuthFileName(profileA.id))
			const authPathB = path.join(secretsDir, getOpenAiCodexProfileAuthFileName(profileB.id))
			await expect.poll(() => pathExists(authPathA)).toBe(true)
			await expect.poll(() => pathExists(authPathB)).toBe(true)
			const storedA = JSON.parse(await readFile(authPathA, "utf8")) as Record<string, unknown>
			const storedB = JSON.parse(await readFile(authPathB, "utf8")) as Record<string, unknown>
			expect(storedA.accountId).toBe(authA.accountId)
			expect(storedB.accountId).toBe(authB.accountId)
			expect(storedA.access_token).not.toBe(storedB.access_token)

			await app.close()
			app = undefined
			helper.clearCachedFrame()
			const restarted = await openReadySidebar(openVSCode, workspaceDir, helper, environment)
			reopened = restarted.app
			const reopenedPage = restarted.page
			sidebar = restarted.sidebar
			await helper.signin(sidebar)
			await openSettings(reopenedPage, sidebar)
			for (const profile of [profileA, profileB]) {
				await expandProfile(sidebar, profile.name)
				await expect(profileCard(sidebar, profile.name).getByText("ChatGPT: Signed in", { exact: true })).toBeVisible()
			}
			await sidebar.getByRole("button", { name: "Done", exact: true }).click()

			await selectProfile(sidebar, profileA.name)
			const firstCacheText = `${authA.responseText}_CACHE_FIRST`
			const secondCacheText = `${authA.responseText}_CACHE_SECOND`
			server.enqueueCodexResponseEvents(
				codexConversationEvents(firstCacheText, "cache_a_first", true, {
					itemId: "fc_cache_read",
					callId: "call_cache_read",
					name: "read_file",
					arguments: JSON.stringify({ path: "README.md" }),
				}),
			)
			server.enqueueCodexResponseEvents(
				codexConversationEvents(secondCacheText, "cache_a_second", false, {
					itemId: "fc_cache_complete",
					callId: "call_cache_complete",
					name: "attempt_completion",
					arguments: JSON.stringify({ result: secondCacheText }),
				}),
			)
			const cacheRequestStart = server.codexRequests.length
			await send(sidebar, "Run Codex Profile A", firstCacheText)
			await expect(sidebar.getByText(firstCacheText, { exact: true }).last()).toBeVisible()
			await expect(sidebar.getByText(secondCacheText, { exact: false }).last()).toBeVisible({ timeout: 60_000 })
			await expect.poll(() => server.codexRequests.length, { timeout: 60_000 }).toBe(cacheRequestStart + 2)
			const [firstCacheRequest, secondCacheRequest] = server.codexRequests.slice(cacheRequestStart)
			if (!firstCacheRequest || !secondCacheRequest) throw new Error("Missing consecutive Codex cache requests")
			expect(secondCacheRequest.body.prompt_cache_key).toBe(firstCacheRequest.body.prompt_cache_key)
			expect(secondCacheRequest.sessionId).toBe(firstCacheRequest.sessionId)
			expect(secondCacheRequest.threadId).toBe(firstCacheRequest.threadId)
			expect(secondCacheRequest.clientRequestId).toBe(firstCacheRequest.clientRequestId)
			const firstInput = firstCacheRequest.body.input as unknown[]
			const secondInput = secondCacheRequest.body.input as unknown[]
			expect(secondInput.slice(0, firstInput.length)).toEqual(firstInput)
			const replayedHistory = JSON.stringify(secondInput)
			expect(replayedHistory.match(new RegExp(firstCacheText, "g"))).toHaveLength(1)
			expect(replayedHistory).toContain("rs_cache_a_first")
			expect(replayedHistory).toContain("final-cache-reasoning")
			await sidebar.getByRole("button", { name: "Close Task", exact: true }).click()
			const profileBRequestStart = server.codexRequests.length
			const profileARequests = server.codexRequests.slice(0, profileBRequestStart)
			expect(profileARequests.length).toBeGreaterThan(0)
			expect(
				profileARequests.every(
					(request) => request.authorization === `Bearer ${authA.accessToken}` && request.accountId === authA.accountId,
				),
			).toBe(true)

			await selectProfile(sidebar, profileB.name)
			await send(sidebar, "Run Codex Profile B", authB.responseText)
			await sidebar.getByRole("button", { name: "Close Task", exact: true }).click()
			const profileBRequests = server.codexRequests.slice(profileBRequestStart)
			expect(profileBRequests.length).toBeGreaterThan(0)
			expect(
				profileBRequests.every(
					(request) => request.authorization === `Bearer ${authB.accessToken}` && request.accountId === authB.accountId,
				),
			).toBe(true)

			await openSettings(reopenedPage, sidebar)
			await expandProfile(sidebar, profileA.name)
			const renamedA = "Codex Profile A Renamed"
			const profileName = profileCard(sidebar, profileA.name).getByRole("textbox", { name: "Profile name" })
			await profileName.fill(renamedA)
			await profileName.blur()
			await expect(profileCard(sidebar, renamedA)).toHaveCount(1)
			expect(await pathExists(authPathA)).toBe(true)

			await profileCard(sidebar, renamedA).getByRole("button", { name: "Sign out", exact: true }).click()
			await expect.poll(() => pathExists(authPathA)).toBe(false)
			expect(await pathExists(authPathB)).toBe(true)
			await signInProfile(sidebar, renamedA, server)
			await expect.poll(() => pathExists(authPathA)).toBe(true)

			await sidebar.getByRole("button", { name: "Manage profiles" }).click()
			await sidebar.getByRole("checkbox", { name: `Select ${renamedA}` }).check()
			await sidebar.getByRole("button", { name: "Delete selected (1)" }).click()
			await sidebar.getByRole("button", { name: "Confirm delete (1)" }).click()
			await expect.poll(() => pathExists(authPathA)).toBe(false)
			expect(await pathExists(authPathB)).toBe(true)
			await sidebar.getByRole("button", { name: "Done managing profiles" }).click()

			await expandProfile(sidebar, profileB.name)
			await profileCard(sidebar, profileB.name)
				.getByRole("combobox", { name: "Provider", exact: true })
				.selectOption("anthropic")
			await expect.poll(() => pathExists(authPathB)).toBe(false)

			const profileCatalog = await readFile(path.join(dlineDir, "data", "settings", "api_profiles.json"), "utf8")
			const settings = await readFile(path.join(dlineDir, "data", "settings", "settings.json"), "utf8")
			await reopened.close()
			reopened = undefined
			const output = E2ETestHelper.readDlineOutputIfPresent(userDataDir) ?? ""
			assertNoRuntimeSecrets(`${profileCatalog}\n${settings}\n${output}`, [authA, authB, authA2], server.allCallbacks())
		} finally {
			await reopened?.close().catch(() => undefined)
			await app?.close().catch(() => undefined)
			await server.stop()
		}
	},
)

e2e(
	"OpenAI Codex OAuth flow lease prevents a second VS Code instance from stealing the active Profile flow",
	async ({ dlineDir, dlineDocsDir, extensionsDir, server: apiServer, workspaceDir }, testInfo) => {
		e2e.setTimeout(240_000)
		const oauthServer = new CodexOAuthE2EServer()
		await oauthServer.start()
		const ownerProfile = codexProfile("codex-profile-lease-owner", "Codex Lease Owner")
		const contenderProfile = codexProfile("codex-profile-lease-contender", "Codex Lease Contender")
		const auth = scenario("lease-owner")
		oauthServer.enqueue(auth)
		await addCodexProfiles(dlineDir, [ownerProfile, contenderProfile])
		const launcher = new MultiInstanceLauncher({
			dlineDir,
			dlineDocsDir,
			environment: codexEnvironment(oauthServer, "manual"),
			extensionsDir,
			server: apiServer,
			testInfo,
			workspaceDir,
		})

		try {
			const owner = await launcher.launch("codex-oauth-owner")
			const contender = await launcher.launch("codex-oauth-contender")
			await Promise.all([openSettings(owner.page, owner.sidebar), openSettings(contender.page, contender.sidebar)])

			const ownerCard = await expandProfile(owner.sidebar, ownerProfile.name)
			await ownerCard.getByRole("button", { name: "Sign in", exact: true }).click()
			const ownerDialog = owner.sidebar.getByRole("dialog", { name: "Sign in to ChatGPT" })
			await expect(ownerDialog).toBeVisible()
			const callback = await E2ETestHelper.waitForValue(() => oauthServer.latestCallback(), 30_000)
			const leasePath = path.join(dlineDir, "data", "oauth", "local-oauth-flow.json")
			await expect.poll(() => pathExists(leasePath)).toBe(true)

			const contenderCard = await expandProfile(contender.sidebar, contenderProfile.name)
			await contenderCard.getByRole("button", { name: "Sign in", exact: true }).click()
			await expect(contender.sidebar.getByText("Cannot start the ChatGPT sign-in. Try again.")).toBeVisible()
			await expect(ownerDialog).toBeVisible()
			expect(oauthServer.authorizationRequests).toHaveLength(1)
			expect(await pathExists(leasePath)).toBe(true)

			await ownerDialog.getByRole("textbox", { name: "Full callback URL" }).fill(callback)
			await ownerDialog.getByRole("button", { name: "Finish sign-in" }).click()
			await expect(ownerDialog).not.toBeVisible({ timeout: 30_000 })
			await expect(ownerCard.getByText("ChatGPT: Signed in", { exact: true })).toBeVisible({ timeout: 30_000 })
			await expect.poll(() => pathExists(leasePath)).toBe(false)

			const secretsDir = path.join(dlineDir, "data", "secrets")
			const ownerAuthPath = path.join(secretsDir, getOpenAiCodexProfileAuthFileName(ownerProfile.id))
			const contenderAuthPath = path.join(secretsDir, getOpenAiCodexProfileAuthFileName(contenderProfile.id))
			await expect.poll(() => pathExists(ownerAuthPath)).toBe(true)
			expect(await pathExists(contenderAuthPath)).toBe(false)
			expect(oauthServer.tokenRequestCount).toBe(1)

			await Promise.all([launcher.close(owner), launcher.close(contender)])
			const profileCatalog = await readFile(path.join(dlineDir, "data", "settings", "api_profiles.json"), "utf8")
			const outputs = [owner.userDataDir, contender.userDataDir]
				.map((userDataDir) => E2ETestHelper.readDlineOutputIfPresent(userDataDir) ?? "")
				.join("\n")
			assertNoRuntimeSecrets(`${profileCatalog}\n${outputs}`, [auth], [callback])
		} finally {
			await launcher.dispose()
			await oauthServer.stop()
		}
	},
)

e2e(
	"OpenAI Codex OAuth manual fallback accepts only the full active localhost callback URI",
	async ({ dlineDir, helper, openVSCode, userDataDir, workspaceDir }, testInfo) => {
		e2e.setTimeout(150_000)
		const server = new CodexOAuthE2EServer()
		await server.start()
		const profile = codexProfile("codex-profile-manual", "Codex Profile Manual")
		const auth = scenario("manual")
		server.enqueue(auth)
		await addCodexProfiles(dlineDir, [profile])
		const occupiedCallbackServer = createServer()
		await new Promise<void>((resolve, reject) => {
			occupiedCallbackServer.once("error", reject)
			occupiedCallbackServer.listen(0, "127.0.0.1", resolve)
		})
		const occupiedAddress = occupiedCallbackServer.address() as AddressInfo
		const environment = codexEnvironment(server, "manual", { callbackPorts: [occupiedAddress.port, 0] })
		let app: ElectronApplication | undefined

		try {
			const ready = await openReadySidebar(openVSCode, workspaceDir, helper, environment)
			app = ready.app
			const page = ready.page
			const sidebar = ready.sidebar
			await resizePrimarySidebar(page, 480)
			await helper.signin(sidebar)
			await openSettings(page, sidebar)
			const card = await expandProfile(sidebar, profile.name)
			await card.getByRole("button", { name: "Sign in", exact: true }).click()
			const dialog = sidebar.getByRole("dialog", { name: "Sign in to ChatGPT" })
			await expect(dialog).toBeVisible()
			const callback = await E2ETestHelper.waitForValue(() => server.latestCallback(), 30_000)
			const authorizationUri = await dialog.getByRole("textbox", { name: "ChatGPT sign-in URL" }).inputValue()
			const redirectUri = new URL(authorizationUri).searchParams.get("redirect_uri")
			if (!redirectUri) throw new Error("expected authorization URI to contain redirect_uri")
			expect(Number(new URL(redirectUri).port)).not.toBe(occupiedAddress.port)
			expect(dialog.getByText(/callback listener/i)).toHaveCount(0)

			for (const width of [320, 480, 700] as const) {
				await resizePrimarySidebar(page, width)
				await expect(dialog).toBeVisible()
				const layout = await sidebar.evaluate(() => ({
					clientWidth: document.documentElement.clientWidth,
					scrollWidth: document.documentElement.scrollWidth,
				}))
				expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1)
				await page.screenshot({ path: testInfo.outputPath(`codex-oauth-modal-active-${width}px.png`) })
			}

			await resizePrimarySidebar(page, 480)
			await dialog.getByRole("button", { name: /Advanced: import OAuth credential JSON/ }).click()
			await expect(dialog.getByRole("textbox", { name: "OpenAI Codex OAuth JSON" })).toBeVisible()
			await page.screenshot({ path: testInfo.outputPath("codex-oauth-modal-json-expanded-480px.png") })
			await dialog.getByRole("button", { name: /Advanced: import OAuth credential JSON/ }).click()

			const input = dialog.getByRole("textbox", { name: "Full callback URL" })
			await input.fill("http://localhost:1455/auth/callback?code=wrong&state=wrong")
			await dialog.getByRole("button", { name: "Finish sign-in" }).click()
			await expect(dialog.getByText("Cannot finish the sign-in. Check the full callback URL and try again.")).toBeVisible()
			await expect(input).toHaveValue("")
			await input.fill(callback)
			await dialog.getByRole("button", { name: "Finish sign-in" }).click()
			await expect(dialog).not.toBeVisible({ timeout: 30_000 })
			await expect(card.getByText("ChatGPT: Signed in", { exact: true })).toBeVisible({ timeout: 30_000 })

			const authPath = path.join(dlineDir, "data", "secrets", getOpenAiCodexProfileAuthFileName(profile.id))
			await expect.poll(() => pathExists(authPath)).toBe(true)
			const profileCatalog = await readFile(path.join(dlineDir, "data", "settings", "api_profiles.json"), "utf8")
			await app.close()
			app = undefined
			const output = E2ETestHelper.readDlineOutputIfPresent(userDataDir) ?? ""
			assertNoRuntimeSecrets(`${profileCatalog}\n${output}`, [auth], [callback])
		} finally {
			await app?.close().catch(() => undefined)
			await new Promise<void>((resolve) => occupiedCallbackServer.close(() => resolve()))
			await server.stop()
		}
	},
)

e2e(
	"OpenAI Codex OAuth manual JSON imports a non-refreshable Profile credential without leaking secrets",
	async ({ dlineDir, helper, openVSCode, userDataDir, workspaceDir }) => {
		e2e.setTimeout(150_000)
		const server = new CodexOAuthE2EServer()
		await server.start()
		const profile = codexProfile("codex-profile-manual-json", "Codex Profile Manual JSON")
		const accessToken = randomUUID()
		const accountId = "account-manual-json"
		const privateClaim = randomUUID()
		const malformedSecret = randomUUID()
		await addCodexProfiles(dlineDir, [profile])
		const environment = codexEnvironment(server, "manual")
		const authPath = path.join(dlineDir, "data", "secrets", getOpenAiCodexProfileAuthFileName(profile.id))
		let app: ElectronApplication | undefined

		try {
			const ready = await openReadySidebar(openVSCode, workspaceDir, helper, environment)
			app = ready.app
			const page = ready.page
			const sidebar = ready.sidebar
			await resizePrimarySidebar(page, 480)
			await helper.signin(sidebar)
			await openSettings(page, sidebar)
			const card = await expandProfile(sidebar, profile.name)
			await card.getByRole("button", { name: "Sign in", exact: true }).click()
			const dialog = sidebar.getByRole("dialog", { name: "Sign in to ChatGPT" })
			await expect(dialog).toBeVisible()
			await dialog.getByRole("button", { name: /Advanced: import OAuth credential JSON/ }).click()
			const input = dialog.getByRole("textbox", { name: "OpenAI Codex OAuth JSON" })

			await input.fill(`{"access_token":"${malformedSecret}"`)
			await dialog.getByRole("button", { name: "Import credential" }).click()
			await expect(dialog.getByText("Cannot import the credential. Check the JSON and try again.")).toBeVisible()
			await expect(input).toHaveValue("")
			expect(await pathExists(authPath)).toBe(false)
			await expect(sidebar.locator("body")).not.toContainText(malformedSecret)

			const oauthJson = JSON.stringify({
				type: "gpt-team",
				access_token: accessToken,
				expires: Date.now() + 3_600_000,
				accountId,
				provider_private_claim: privateClaim,
			})
			await input.fill(oauthJson)
			await dialog.getByRole("button", { name: "Import credential" }).click()
			await expect(dialog).not.toBeVisible()
			await expect(card.getByText("ChatGPT: Signed in", { exact: true })).toBeVisible({ timeout: 30_000 })
			await expect.poll(() => pathExists(authPath)).toBe(true)

			const stored = JSON.parse(await readFile(authPath, "utf8")) as Record<string, unknown>
			expect(stored).toMatchObject({ access_token: accessToken, accountId, provider_private_claim: privateClaim })
			expect(stored).not.toHaveProperty("refresh_token")
			expect(server.tokenRequestCount).toBe(0)

			await sidebar.getByRole("button", { name: "Done", exact: true }).click()
			await selectProfile(sidebar, profile.name)
			await send(sidebar, "Run manually imported Codex Profile", `CODEX_E2E_${accountId}`)
			await expect.poll(() => server.codexRequests.length).toBe(1)
			expect(server.codexRequests[0]).toMatchObject({ authorization: `Bearer ${accessToken}`, accountId })

			await app.close()
			app = undefined
			const profileCatalog = await readFile(path.join(dlineDir, "data", "settings", "api_profiles.json"), "utf8")
			const output = E2ETestHelper.readDlineOutputIfPresent(userDataDir) ?? ""
			for (const secret of [accessToken, privateClaim, malformedSecret, oauthJson]) {
				expect(`${profileCatalog}\n${output}`).not.toContain(secret)
			}
		} finally {
			await app?.close().catch(() => undefined)
			await server.stop()
		}
	},
)

e2e(
	"OpenAI Codex OAUTH dialog expires the active flow and rejects stale manual completion",
	async ({ dlineDir, helper, openVSCode, workspaceDir }, testInfo) => {
		e2e.setTimeout(150_000)
		const server = new CodexOAuthE2EServer()
		await server.start()
		const profile = codexProfile("codex-profile-timeout", "Codex Profile Timeout")
		server.enqueue(scenario("timeout"))
		await addCodexProfiles(dlineDir, [profile])
		const environment = codexEnvironment(server, "manual", { timeoutMs: 1_200 })
		let app: ElectronApplication | undefined

		try {
			const ready = await openReadySidebar(openVSCode, workspaceDir, helper, environment)
			app = ready.app
			const page = ready.page
			const sidebar = ready.sidebar
			await resizePrimarySidebar(page, 480)
			await helper.signin(sidebar)
			await openSettings(page, sidebar)
			const card = await expandProfile(sidebar, profile.name)
			await card.getByRole("button", { name: "Sign in", exact: true }).click()
			const dialog = sidebar.getByRole("dialog", { name: "Sign in to ChatGPT" })
			await expect(dialog).toBeVisible()
			await expect(dialog.getByText("This sign-in timed out. Start again.")).toBeVisible({ timeout: 10_000 })
			await expect(dialog.getByRole("textbox", { name: "Full callback URL" })).toBeDisabled()
			await expect(dialog.getByRole("button", { name: "Try again" })).toBeVisible()
			const layout = await sidebar.evaluate(() => ({
				clientWidth: document.documentElement.clientWidth,
				scrollWidth: document.documentElement.scrollWidth,
			}))
			expect(layout.scrollWidth).toBeLessThanOrEqual(layout.clientWidth + 1)
			await page.screenshot({ path: testInfo.outputPath("codex-oauth-modal-timed-out-480px.png") })
		} finally {
			await app?.close().catch(() => undefined)
			await server.stop()
		}
	},
)
