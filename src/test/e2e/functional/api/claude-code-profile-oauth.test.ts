import { randomUUID } from "node:crypto"
import { readFile, writeFile } from "node:fs/promises"
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http"
import type { AddressInfo } from "node:net"
import * as path from "node:path"
import { getClaudeCodeProfileAuthFileName } from "@core/storage/secrets/ClaudeCodeProfileAuthPath"
import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import type { ElectronApplication, Frame, Locator, Page } from "@playwright/test"
import { expect } from "@playwright/test"

/**
 * Claude Code subscription sign-in, end to end through real VS Code.
 *
 * A subscription token is only issued to something that looks like the real
 * client, so these assert the wire shape of the authorization request rather
 * than only that a credential eventually appeared: a flow can store a token in
 * a mock while still being rejected by Anthropic.
 */

interface AuthorizationRequest {
	readonly query: URLSearchParams
	/** Parameter names in emitted order, which is itself part of the fingerprint. */
	readonly parameterOrder: readonly string[]
}

interface TokenRequest {
	readonly body: Record<string, unknown>
	readonly headers: Record<string, string | undefined>
	readonly status: number
}

const TOKEN_LIFETIME_SECONDS = 3_600

/** Mock Anthropic OAuth and usage endpoints, bound to loopback. */
class ClaudeCodeOAuthE2EServer {
	private readonly server: Server
	private address: AddressInfo | undefined
	readonly authorizationRequests: AuthorizationRequest[] = []
	readonly tokenRequests: TokenRequest[] = []
	/** Access token the next exchange hands out. */
	accessToken = randomUUID()
	/** States issued to authorization requests, so the exchange can be checked against them. */
	private readonly issuedStates = new Set<string>()

	constructor() {
		this.server = createServer((request, response) => {
			void this.route(request, response)
		})
	}

	async start(): Promise<void> {
		await new Promise<void>((resolve) => this.server.listen(0, "127.0.0.1", resolve))
		this.address = this.server.address() as AddressInfo
	}

	async stop(): Promise<void> {
		await new Promise<void>((resolve) => this.server.close(() => resolve()))
	}

	get baseUrl(): string {
		if (!this.address) throw new Error("The mock OAuth server is not listening")
		return `http://127.0.0.1:${this.address.port}`
	}

	private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const url = new URL(request.url ?? "/", this.baseUrl)
		if (request.method === "GET" && url.pathname === "/oauth/authorize") {
			this.authorize(url, response)
			return
		}
		if (request.method === "POST" && url.pathname === "/oauth/token") {
			await this.token(request, response)
			return
		}
		if (request.method === "GET" && url.pathname === "/usage") {
			response.writeHead(200, { "Content-Type": "application/json" })
			response.end(JSON.stringify({ five_hour: { utilization: 12, resets_at: "2026-10-01T00:00:00Z" } }))
			return
		}
		response.writeHead(404).end()
	}

	/**
	 * Record the authorization request, then redirect to the loopback callback.
	 *
	 * The redirect stands in for the user approving the grant in a browser.
	 */
	private authorize(url: URL, response: ServerResponse): void {
		this.authorizationRequests.push({
			query: new URLSearchParams(url.search),
			parameterOrder: [...new URLSearchParams(url.search).keys()],
		})
		const redirectUri = url.searchParams.get("redirect_uri")
		const state = url.searchParams.get("state")
		if (state) this.issuedStates.add(state)
		if (!redirectUri || !redirectUri.startsWith("http://localhost")) {
			// The hosted path has no loopback to return to; the test pastes the code.
			response.writeHead(200, { "Content-Type": "text/plain" }).end(`${randomUUID()}#${state ?? ""}`)
			return
		}
		const callback = new URL(redirectUri)
		callback.searchParams.set("code", randomUUID())
		if (state) callback.searchParams.set("state", state)
		response.writeHead(302, { Location: callback.toString() }).end()
	}

	/**
	 * Redeem a code, rejecting anything the real endpoint would reject.
	 *
	 * The state check is the point of this mock: a client that verifies the
	 * state locally but drops it here still looks correct to a permissive mock,
	 * which is exactly how a real sign-in failure went unnoticed.
	 */
	private async token(request: IncomingMessage, response: ServerResponse): Promise<void> {
		const raw = await this.readBody(request)
		const body = JSON.parse(raw) as Record<string, unknown>
		const state = typeof body.state === "string" ? body.state : undefined
		const accepted = state !== undefined && this.issuedStates.has(state)
		this.tokenRequests.push({
			body,
			headers: { "content-type": request.headers["content-type"] },
			status: accepted ? 200 : 400,
		})
		if (!accepted) {
			response.writeHead(400, { "Content-Type": "application/json" })
			response.end(JSON.stringify({ error: "invalid_request", error_description: "state does not match" }))
			return
		}
		response.writeHead(200, { "Content-Type": "application/json" })
		response.end(
			JSON.stringify({
				access_token: this.accessToken,
				refresh_token: randomUUID(),
				expires_in: TOKEN_LIFETIME_SECONDS,
				token_type: "Bearer",
				account: { uuid: randomUUID(), email_address: "claude-code-e2e@example.test", display_name: "Claude E2E" },
				organization: { uuid: randomUUID(), name: "Claude E2E Org" },
			}),
		)
	}

	private async readBody(request: IncomingMessage): Promise<string> {
		const chunks: Buffer[] = []
		for await (const chunk of request) chunks.push(chunk as Buffer)
		return Buffer.concat(chunks).toString("utf8")
	}
}

interface StoredProfile {
	id: string
	name: string
	provider: string
	modelId: string
	usedFor: string[]
	enabled: boolean
}

function claudeCodeProfile(id: string, name: string): StoredProfile {
	return { id, name, provider: "claude-code", modelId: "claude-opus-5-5", usedFor: ["act", "plan"], enabled: true }
}

async function addProfiles(dlineDir: string, profiles: readonly StoredProfile[]): Promise<void> {
	const profilesPath = path.join(dlineDir, "data", "settings", "api_profiles.json")
	const existing = JSON.parse(await readFile(profilesPath, "utf8")) as { profiles?: StoredProfile[] }
	await writeFile(profilesPath, JSON.stringify({ ...existing, profiles: [...(existing.profiles ?? []), ...profiles] }))
}

function profileCard(sidebar: Frame, name: string): Locator {
	const escapedName = name.replaceAll("\\", "\\\\").replaceAll('"', '\\"')
	const cards = sidebar.getByTestId("api-profile-card")
	return cards
		.filter({ has: sidebar.locator(`input[aria-label="Profile name"][value="${escapedName}"]`) })
		.or(cards.filter({ hasText: name }))
}

async function openSettings(page: Page, sidebar: Frame): Promise<void> {
	// The release announcement overlays the sidebar on a fresh profile, so the
	// settings button is present but not reachable until it is dismissed.
	await E2ETestHelper.dismissWhatsNewModal(sidebar)
	await page.getByRole("button", { name: "Settings", exact: true }).click()
	await expect(sidebar.getByRole("heading", { name: "API Configuration" })).toBeVisible({ timeout: 30_000 })
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

function claudeCodeEnvironment(server: ClaudeCodeOAuthE2EServer): Readonly<Record<string, string>> {
	return {
		DLINE_E2E_CLAUDE_CODE_OAUTH_BASE_URL: `${server.baseUrl}/oauth`,
		DLINE_E2E_CLAUDE_CODE_USAGE_URL: `${server.baseUrl}/usage`,
		// Bind an OS-assigned port rather than the production callback ports. Those
		// are fixed because the provider registered them, but a test host may have
		// them reserved or occupied, which fails the sign-in while the callback
		// server starts and reports a defect the product does not have. The mock
		// authorization endpoint echoes back whichever `redirect_uri` it receives,
		// so the flow under test is unchanged.
		DLINE_E2E_CLAUDE_CODE_CALLBACK_PORTS: "0",
	}
}

async function openReadySidebar(
	openVSCode: (workspacePath: string, environmentOverrides?: Readonly<Record<string, string>>) => Promise<ElectronApplication>,
	workspaceDir: string,
	helper: E2ETestHelper,
	environment: Readonly<Record<string, string>>,
): Promise<{ app: ElectronApplication; page: Page; sidebar: Frame }> {
	const app = await openVSCode(workspaceDir, environment)
	const page = await app.firstWindow()
	await E2ETestHelper.openClineSidebar(page)
	const sidebar = await helper.getSidebar(page)
	// Brings the Webview to the state a user sees after onboarding; without it
	// the sidebar stays on the welcome view and no Profile card is rendered.
	await helper.signin(sidebar)
	return { app, page, sidebar }
}

e2e(
	"Claude Code OAuth signs a Profile in and declares the real client authorization request",
	async ({ dlineDir, helper, openVSCode, workspaceDir }) => {
		e2e.setTimeout(150_000)
		const server = new ClaudeCodeOAuthE2EServer()
		await server.start()
		const profile = claudeCodeProfile("claude-code-profile-signin", "Claude Code Sign In")
		await addProfiles(dlineDir, [profile])
		let app: ElectronApplication | undefined
		try {
			const ready = await openReadySidebar(openVSCode, workspaceDir, helper, claudeCodeEnvironment(server))
			app = ready.app
			await openSettings(ready.page, ready.sidebar)
			const card = await expandProfile(ready.sidebar, profile.name)

			await card.getByRole("button", { name: "Sign in", exact: true }).click()

			await expect.poll(() => server.authorizationRequests.length, { timeout: 60_000 }).toBeGreaterThan(0)
			const authorization = server.authorizationRequests[0]

			// The subscription scopes and PKCE method are what make the grant
			// usable for inference; a missing scope yields a token the Messages
			// API refuses.
			expect(authorization.query.get("client_id")).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e")
			expect(authorization.query.get("response_type")).toBe("code")
			expect(authorization.query.get("code_challenge_method")).toBe("S256")
			expect(authorization.query.get("scope")).toBe(
				"org:create_api_key user:profile user:inference user:sessions:claude_code user:mcp_servers user:file_upload",
			)
			expect(authorization.query.get("state")).toBeTruthy()

			// Order is part of what the request looks like on the wire, so it is
			// asserted rather than left to whatever the encoder happens to emit.
			expect(authorization.parameterOrder.filter((name) => name !== "code")).toEqual([
				"client_id",
				"response_type",
				"redirect_uri",
				"scope",
				"code_challenge",
				"code_challenge_method",
				"state",
			])

			await expect.poll(() => server.tokenRequests.length, { timeout: 60_000 }).toBeGreaterThan(0)
			const token = server.tokenRequests[0]
			expect(token.headers["content-type"]).toContain("application/json")
			expect(token.body.grant_type).toBe("authorization_code")
			expect(token.body.client_id).toBe("9d1c250a-e61b-44d9-88ed-5944d1962f5e")
			expect(token.body.code_verifier).toBeTruthy()
			// The loopback path verifies the state locally, but this endpoint also
			// requires it back; returning it is what makes the exchange succeed.
			expect(token.body.state).toBe(authorization.query.get("state"))
			expect(token.status).toBe(200)

			const authPath = path.join(dlineDir, "data", "secrets", getClaudeCodeProfileAuthFileName(profile.id))
			await expect
				.poll(async () => JSON.parse(await readFile(authPath, "utf8")).access_token, { timeout: 60_000 })
				.toBe(server.accessToken)
			await expect(card.getByText("Signed in", { exact: false })).toBeVisible({ timeout: 30_000 })
		} finally {
			await app?.close().catch(() => undefined)
			await server.stop()
		}
	},
)
