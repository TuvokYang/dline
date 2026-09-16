import fs from "node:fs/promises"
import http from "node:http"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { FileOAuthFlowLease } from "../FileOAuthFlowLease"
import { LocalOAuthCallbackServer } from "../LocalOAuthCallbackServer"
import { LocalOAuthFlowCoordinator } from "../LocalOAuthFlowCoordinator"
import type { OAuthAuthorizationStrategy, OAuthFlowLease } from "../types"

interface TestCredential {
	code: string
	verifier: string
}

class TestStrategy implements OAuthAuthorizationStrategy<TestCredential> {
	readonly strategyId = "test-oauth"
	readonly callbackPath = "/oauth/callback"

	private configuredCallbackPorts: readonly number[]
	readonly callbackRedirectHost: string | undefined

	get callbackPort(): number {
		return this.configuredCallbackPorts[0] ?? 0
	}

	get callbackPorts(): readonly number[] {
		return this.configuredCallbackPorts
	}

	constructor(
		callbackPorts: number | readonly number[] = 0,
		private readonly exchange: (code: string, verifier: string) => Promise<TestCredential> = async (code, verifier) => ({
			code,
			verifier,
		}),
		callbackRedirectHost?: string,
	) {
		this.configuredCallbackPorts = typeof callbackPorts === "number" ? [callbackPorts] : callbackPorts
		this.callbackRedirectHost = callbackRedirectHost
	}

	useCallbackPortForNextFlow(port: number): void {
		this.configuredCallbackPorts = [port]
	}

	buildAuthorizationUrl(input: { redirectUri: string; codeChallenge: string; state: string }): URL {
		const url = new URL("https://auth.example.test/authorize")
		url.searchParams.set("redirect_uri", input.redirectUri)
		url.searchParams.set("code_challenge", input.codeChallenge)
		url.searchParams.set("state", input.state)
		return url
	}

	exchangeAuthorizationCode(input: { code: string; codeVerifier: string }): Promise<TestCredential> {
		return this.exchange(input.code, input.codeVerifier)
	}
}

describe("LocalOAuthFlowCoordinator", () => {
	let tempDir: string | undefined
	const coordinators: LocalOAuthFlowCoordinator<TestCredential>[] = []
	const openedAuthorizationUrls: string[] = []

	afterEach(async () => {
		await Promise.all(coordinators.map((coordinator) => coordinator.dispose()))
		coordinators.length = 0
		openedAuthorizationUrls.length = 0
		if (tempDir) await fs.rm(tempDir, { recursive: true, force: true })
		tempDir = undefined
		vi.restoreAllMocks()
	})

	async function createCoordinator(
		options: {
			strategy?: TestStrategy
			lease?: OAuthFlowLease
			openExternal?: (url: string) => Promise<void>
			timeoutMs?: number
		} = {},
	): Promise<LocalOAuthFlowCoordinator<TestCredential>> {
		tempDir ??= await fs.mkdtemp(path.join(os.tmpdir(), "dline-oauth-flow-"))
		const coordinator = new LocalOAuthFlowCoordinator(options.strategy ?? new TestStrategy(), {
			lease: options.lease ?? new FileOAuthFlowLease(path.join(tempDir, "flow-lease.json")),
			openExternal:
				options.openExternal ??
				(async (authorizationUrl) => {
					openedAuthorizationUrls.push(authorizationUrl)
				}),
			timeoutMs: options.timeoutMs ?? 5_000,
		})
		coordinators.push(coordinator)
		return coordinator
	}

	function lastAuthorizationUrl(): URL {
		const authorizationUrl = openedAuthorizationUrls.at(-1)
		if (!authorizationUrl) throw new Error("expected the authorization URL to be opened")
		return new URL(authorizationUrl)
	}

	function requestWithAgent(url: string, agent: http.Agent): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
		return new Promise((resolve, reject) => {
			const request = http.get(url, { agent }, (response) => {
				response.resume()
				response.once("end", () => resolve({ status: response.statusCode ?? 0, headers: response.headers }))
			})
			request.once("error", reject)
		})
	}

	it("listens before opening the browser and completes from a pasted callback URI", async () => {
		let listenedRedirectUri = ""
		let openedAuthorizationUrl = ""
		const openExternal = vi.fn(async (authorizationUrl: string) => {
			openedAuthorizationUrl = authorizationUrl
			const redirectUri = new URL(authorizationUrl).searchParams.get("redirect_uri")
			expect(redirectUri).toBeTruthy()
			listenedRedirectUri = redirectUri!
			const probe = await fetch(new URL("/not-the-callback", redirectUri!))
			expect(probe.status).toBe(404)
		})
		const coordinator = await createCoordinator({ openExternal })
		const flow = await coordinator.startFlow({ profileId: "profile-a" })
		const state = new URL(openedAuthorizationUrl).searchParams.get("state")

		const credential = await coordinator.completeFromCallbackUri({
			flowId: flow.flowId,
			profileId: "profile-a",
			callbackUri: `${listenedRedirectUri}?code=manual-code&state=${state}`,
		})

		expect(flow.authorizationUrl).toBe(openedAuthorizationUrl)
		expect(flow.redirectUri).toBe(listenedRedirectUri)
		expect(flow.expiresAtMs).toBeGreaterThan(Date.now())
		expect(flow.browserOpenStatus).toBe("opened")
		expect(credential).toMatchObject({ code: "manual-code" })
		await expect(flow.result).resolves.toEqual(credential)
		expect(openExternal).toHaveBeenCalledOnce()
	})

	it("completes the same flow through the HTTP callback", async () => {
		const coordinator = await createCoordinator()
		const flow = await coordinator.startFlow({ profileId: "profile-a" })
		const authorization = lastAuthorizationUrl()
		const redirectUri = authorization.searchParams.get("redirect_uri")!
		const state = authorization.searchParams.get("state")!

		const response = await fetch(`${redirectUri}?code=browser-code&state=${state}`)
		expect(response.status).toBe(200)
		await expect(flow.result).resolves.toMatchObject({ code: "browser-code" })
	})

	it("publishes the strategy redirect host while still binding the loopback address", async () => {
		const coordinator = await createCoordinator({
			strategy: new TestStrategy(0, undefined, "localhost"),
		})
		const flow = await coordinator.startFlow({ profileId: "profile-a" })
		const authorization = lastAuthorizationUrl()
		const state = authorization.searchParams.get("state")!
		const callbackPort = Number(new URL(flow.redirectUri).port)

		expect(flow.redirectUri).toBe(`http://localhost:${callbackPort}/oauth/callback`)
		expect(authorization.searchParams.get("redirect_uri")).toBe(flow.redirectUri)

		const response = await fetch(`http://127.0.0.1:${callbackPort}/oauth/callback?code=loopback-code&state=${state}`)
		expect(response.status).toBe(200)
		await expect(flow.result).resolves.toMatchObject({ code: "loopback-code" })
	})

	it("closes a fixed-port callback connection before the next flow starts", async () => {
		const strategy = new TestStrategy()
		const coordinator = await createCoordinator({ strategy })
		const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })
		let callbackPort: number | undefined
		try {
			for (const [profileId, code] of [
				["profile-a", "browser-code-a"],
				["profile-b", "browser-code-b"],
			] as const) {
				const flow = await coordinator.startFlow({ profileId })
				const authorization = lastAuthorizationUrl()
				const redirectUri = authorization.searchParams.get("redirect_uri")!
				const currentPort = Number(new URL(redirectUri).port)
				if (callbackPort === undefined) {
					callbackPort = currentPort
					strategy.useCallbackPortForNextFlow(currentPort)
				} else {
					expect(currentPort).toBe(callbackPort)
				}
				const state = authorization.searchParams.get("state")!
				const response = await requestWithAgent(`${redirectUri}?code=${code}&state=${state}`, agent)

				expect(response.status).toBe(200)
				expect(response.headers.connection).toBe("close")
				expect(response.headers["cache-control"]).toBe("no-store")
				await expect(flow.result).resolves.toMatchObject({ code })
			}
		} finally {
			agent.destroy()
		}
	})

	it("waits for the previous callback server close barrier before acquiring the next flow lease", async () => {
		let releaseFirstClose: () => void = () => undefined
		const firstCloseGate = new Promise<void>((resolve) => {
			releaseFirstClose = resolve
		})
		let markFirstCloseReachedBarrier: () => void = () => undefined
		const firstCloseReachedBarrier = new Promise<void>((resolve) => {
			markFirstCloseReachedBarrier = resolve
		})
		const originalClose = LocalOAuthCallbackServer.prototype.close
		let closeCount = 0
		vi.spyOn(LocalOAuthCallbackServer.prototype, "close").mockImplementation(async function (this: LocalOAuthCallbackServer) {
			closeCount++
			if (closeCount === 1) {
				markFirstCloseReachedBarrier()
				await firstCloseGate
			}
			await originalClose.call(this)
		})
		const acquire = vi.fn(async () => ({ release: async () => undefined }))
		const strategy = new TestStrategy()
		const coordinator = await createCoordinator({ strategy, lease: { acquire } })
		const agent = new http.Agent({ keepAlive: true, maxSockets: 1 })

		try {
			const first = await coordinator.startFlow({ profileId: "profile-a" })
			const authorization = lastAuthorizationUrl()
			strategy.useCallbackPortForNextFlow(Number(new URL(first.redirectUri).port))
			const response = await requestWithAgent(
				`${authorization.searchParams.get("redirect_uri")}?code=browser-code&state=${authorization.searchParams.get("state")}`,
				agent,
			)
			expect(response.status).toBe(200)
			await expect(first.result).resolves.toMatchObject({ code: "browser-code" })
			await firstCloseReachedBarrier

			const nextFlowPromise = coordinator.startFlow({ profileId: "profile-b" })
			expect(acquire).toHaveBeenCalledTimes(1)
			releaseFirstClose()
			const next = await nextFlowPromise
			expect(acquire).toHaveBeenCalledTimes(2)
			await coordinator.cancelFlow({ flowId: next.flowId, profileId: next.profileId })
			await expect(next.result).rejects.toMatchObject({ code: "FLOW_CANCELLED" })
		} finally {
			releaseFirstClose()
			agent.destroy()
		}
	})

	it("rejects a wrong state without terminating the pending flow", async () => {
		const coordinator = await createCoordinator()
		const flow = await coordinator.startFlow({ profileId: "profile-a" })
		const authorization = lastAuthorizationUrl()
		const redirectUri = authorization.searchParams.get("redirect_uri")!
		const state = authorization.searchParams.get("state")!

		const invalid = await fetch(`${redirectUri}?code=bad&state=wrong`)
		expect(invalid.status).toBe(400)
		const valid = await fetch(`${redirectUri}?code=good&state=${state}`)
		expect(valid.status).toBe(200)
		await expect(flow.result).resolves.toMatchObject({ code: "good" })
	})

	it("turns an OAuth error callback into a terminal authorization result without exposing provider details", async () => {
		const coordinator = await createCoordinator()
		const flow = await coordinator.startFlow({ profileId: "profile-a" })
		const authorization = lastAuthorizationUrl()
		const redirectUri = authorization.searchParams.get("redirect_uri")!
		const state = authorization.searchParams.get("state")!

		const response = await fetch(`${redirectUri}?error=access_denied&error_description=private-detail&state=${state}`)
		const body = await response.text()
		expect(response.status).toBe(400)
		expect(body).not.toContain("access_denied")
		expect(body).not.toContain("private-detail")
		await expect(flow.result).rejects.toMatchObject({ code: "AUTHORIZATION_DENIED" })
	})

	it("prevents a second coordinator from stealing the active flow", async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "dline-oauth-flow-"))
		const leasePath = path.join(tempDir, "shared-lease.json")
		const left = new LocalOAuthFlowCoordinator(new TestStrategy(), {
			lease: new FileOAuthFlowLease(leasePath),
			openExternal: async () => undefined,
		})
		const right = new LocalOAuthFlowCoordinator(new TestStrategy(), {
			lease: new FileOAuthFlowLease(leasePath),
			openExternal: async () => undefined,
		})
		coordinators.push(left, right)
		const active = await left.startFlow({ profileId: "profile-a" })

		await expect(right.startFlow({ profileId: "profile-b" })).rejects.toMatchObject({ code: "FLOW_ALREADY_IN_PROGRESS" })
		await expect(right.cancelFlow({ flowId: active.flowId, profileId: "profile-a" })).rejects.toMatchObject({
			code: "FLOW_NOT_FOUND",
		})
		await left.cancelFlow({ flowId: active.flowId, profileId: "profile-a" })
		await expect(active.result).rejects.toMatchObject({ code: "FLOW_CANCELLED" })
	})

	it("keeps the flow active when the browser cannot be opened", async () => {
		const coordinator = await createCoordinator({
			openExternal: async () => {
				throw new Error("browser unavailable")
			},
		})
		const flow = await coordinator.startFlow({ profileId: "profile-a" })
		const authorization = new URL(flow.authorizationUrl)

		expect(flow.browserOpenStatus).toBe("failed")
		await expect(
			coordinator.completeFromCallbackUri({
				flowId: flow.flowId,
				profileId: "profile-a",
				callbackUri: `${flow.redirectUri}?code=manual-code&state=${authorization.searchParams.get("state")}`,
			}),
		).resolves.toMatchObject({ code: "manual-code" })
	})

	it("uses the next approved callback port when the first one is occupied", async () => {
		const occupied = http.createServer()
		await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve))
		const address = occupied.address()
		if (!address || typeof address === "string") throw new Error("expected TCP address")
		try {
			const coordinator = await createCoordinator({ strategy: new TestStrategy([address.port, 0]) })
			const flow = await coordinator.startFlow({ profileId: "profile-a" })
			const redirectUri = new URL(flow.redirectUri)
			expect(Number(redirectUri.port)).not.toBe(address.port)
			expect(new URL(flow.authorizationUrl).searchParams.get("redirect_uri")).toBe(flow.redirectUri)
			await coordinator.cancelFlow({ flowId: flow.flowId, profileId: "profile-a" })
		} finally {
			await new Promise<void>((resolve) => occupied.close(() => resolve()))
		}
	})

	it("distinguishes an occupied callback port from another Dline flow", async () => {
		const occupied = http.createServer()
		await new Promise<void>((resolve) => occupied.listen(0, "127.0.0.1", resolve))
		const address = occupied.address()
		if (!address || typeof address === "string") throw new Error("expected TCP address")
		try {
			const coordinator = await createCoordinator({ strategy: new TestStrategy(address.port) })
			await expect(coordinator.startFlow({ profileId: "profile-a" })).rejects.toMatchObject({
				code: "CALLBACK_PORT_IN_USE",
			})
		} finally {
			await new Promise<void>((resolve) => occupied.close(() => resolve()))
		}
	})

	it("times out, reports stale callbacks as timed out, and releases the flow lease", async () => {
		const coordinator = await createCoordinator({ timeoutMs: 20 })
		const flow = await coordinator.startFlow({ profileId: "profile-a" })
		const state = new URL(flow.authorizationUrl).searchParams.get("state")
		await expect(flow.result).rejects.toMatchObject({ code: "FLOW_TIMED_OUT" })
		await expect(
			coordinator.completeFromCallbackUri({
				flowId: flow.flowId,
				profileId: "profile-a",
				callbackUri: `${flow.redirectUri}?code=late&state=${state}`,
			}),
		).rejects.toMatchObject({ code: "FLOW_TIMED_OUT" })
		const replacement = await coordinator.startFlow({ profileId: "profile-a" })
		await coordinator.cancelFlow({ flowId: replacement.flowId, profileId: "profile-a" })
		await expect(replacement.result).rejects.toMatchObject({ code: "FLOW_CANCELLED" })
	})

	it("does not expose token exchange error details in the callback response", async () => {
		const coordinator = await createCoordinator({
			strategy: new TestStrategy(0, async () => {
				throw new Error("upstream-secret-response")
			}),
		})
		const flow = await coordinator.startFlow({ profileId: "profile-a" })
		const authorization = lastAuthorizationUrl()
		const response = await fetch(
			`${authorization.searchParams.get("redirect_uri")}?code=bad&state=${authorization.searchParams.get("state")}`,
		)
		const body = await response.text()
		expect(response.status).toBe(500)
		expect(body).not.toContain("upstream-secret-response")
		await expect(flow.result).rejects.toMatchObject({ code: "TOKEN_EXCHANGE_FAILED" })
	})
})
