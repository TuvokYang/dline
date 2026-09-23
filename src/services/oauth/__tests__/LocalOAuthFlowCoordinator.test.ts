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

const HOSTED_REDIRECT_URI = "https://auth.example.test/oauth/code/callback"

/**
 * Never a valid TCP port, so binding it always fails. Port 0 would instead ask
 * the OS for an arbitrary free port and succeed.
 */
const UNBINDABLE_PORT = -1

/**
 * Strategy that also publishes a hosted page, like providers whose authorization
 * URL can route the code to a page the user reads instead of a loopback server.
 */
class ManualCapableStrategy extends TestStrategy {
	readonly manualRedirectUri = HOSTED_REDIRECT_URI
	readonly exchangedRedirectUris: string[] = []
	readonly exchangedStates: (string | undefined)[] = []
	readonly exchangedCallbackParams: (Readonly<Record<string, string>> | undefined)[] = []
	/** Rejections applied to the next exchanges, oldest first. */
	readonly pendingExchangeFailures: Error[] = []

	/**
	 * Point the flow at a port no listener can take, reproducing an environment
	 * without a usable loopback callback. Patching the shared callback server
	 * class instead would leak the stub into every later test in this file.
	 */
	static withoutBindablePort(): ManualCapableStrategy {
		return new ManualCapableStrategy([UNBINDABLE_PORT])
	}

	override exchangeAuthorizationCode(input: {
		code: string
		codeVerifier: string
		redirectUri: string
		callbackParams?: Readonly<Record<string, string>>
	}): Promise<TestCredential> {
		this.exchangedRedirectUris.push(input.redirectUri)
		this.exchangedCallbackParams.push(input.callbackParams)
		this.exchangedStates.push(input.callbackParams?.state)
		const failure = this.pendingExchangeFailures.shift()
		if (failure) return Promise.reject(failure)
		return super.exchangeAuthorizationCode(input)
	}

	parseManualCode(pastedValue: string): { code: string; state?: string } {
		const separator = pastedValue.indexOf("#")
		if (separator === -1) return { code: pastedValue }
		return { code: pastedValue.slice(0, separator), state: pastedValue.slice(separator + 1) }
	}
}

describe("LocalOAuthFlowCoordinator manual completion", () => {
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
		strategy: OAuthAuthorizationStrategy<TestCredential>,
	): Promise<LocalOAuthFlowCoordinator<TestCredential>> {
		tempDir ??= await fs.mkdtemp(path.join(os.tmpdir(), "dline-oauth-manual-"))
		const coordinator = new LocalOAuthFlowCoordinator(strategy, {
			lease: new FileOAuthFlowLease(path.join(tempDir, "flow-lease.json")),
			openExternal: async (authorizationUrl) => {
				openedAuthorizationUrls.push(authorizationUrl)
			},
			timeoutMs: 5_000,
		})
		coordinators.push(coordinator)
		return coordinator
	}

	function stateOf(authorizationUrl: string): string {
		return new URL(authorizationUrl).searchParams.get("state") ?? ""
	}

	it("offers both paths when the callback server is listening", async () => {
		const strategy = new ManualCapableStrategy()
		const flow = await (await createCoordinator(strategy)).startFlow({ profileId: "profile-a" })

		expect(flow.loopbackListening).toBe(true)
		expect(flow.redirectUri).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/oauth\/callback$/)
		expect(new URL(flow.manualAuthorizationUrl ?? "").searchParams.get("redirect_uri")).toBe(HOSTED_REDIRECT_URI)
		// The browser still opens the loopback variant, which completes on its own.
		expect(flow.authorizationUrl).toBe(openedAuthorizationUrls.at(-1))
		expect(new URL(flow.authorizationUrl).searchParams.get("redirect_uri")).toBe(flow.redirectUri)
		// One authorization, so both URLs must carry the same state.
		expect(stateOf(flow.manualAuthorizationUrl ?? "")).toBe(stateOf(flow.authorizationUrl))
	})

	it("exchanges a pasted code against the hosted redirect URI", async () => {
		const strategy = new ManualCapableStrategy()
		const coordinator = await createCoordinator(strategy)
		const flow = await coordinator.startFlow({ profileId: "profile-a" })

		const credential = await coordinator.completeFromPastedValue({
			flowId: flow.flowId,
			profileId: "profile-a",
			pastedValue: `hosted-code#${stateOf(flow.authorizationUrl)}`,
		})

		expect(credential).toMatchObject({ code: "hosted-code" })
		// Echoing the loopback URI here would make the token endpoint reject the call.
		expect(strategy.exchangedRedirectUris).toEqual([HOSTED_REDIRECT_URI])
		await expect(flow.result).resolves.toEqual(credential)
	})

	it("accepts a pasted code with no trailing state", async () => {
		const strategy = new ManualCapableStrategy()
		const coordinator = await createCoordinator(strategy)
		const flow = await coordinator.startFlow({ profileId: "profile-a" })

		await expect(
			coordinator.completeFromPastedValue({
				flowId: flow.flowId,
				profileId: "profile-a",
				pastedValue: "bare-code",
			}),
		).resolves.toMatchObject({ code: "bare-code" })
	})

	it("rejects a pasted code carrying another attempt's state", async () => {
		const strategy = new ManualCapableStrategy()
		const coordinator = await createCoordinator(strategy)
		const flow = await coordinator.startFlow({ profileId: "profile-a" })

		await expect(
			coordinator.completeFromPastedValue({
				flowId: flow.flowId,
				profileId: "profile-a",
				pastedValue: "hosted-code#state-from-another-sign-in",
			}),
		).rejects.toMatchObject({ code: "STATE_MISMATCH" })
		await expect(flow.result).rejects.toMatchObject({ code: "STATE_MISMATCH" })
	})

	it("routes a pasted callback URL to the loopback parser", async () => {
		const strategy = new ManualCapableStrategy()
		const coordinator = await createCoordinator(strategy)
		const flow = await coordinator.startFlow({ profileId: "profile-a" })

		const credential = await coordinator.completeFromPastedValue({
			flowId: flow.flowId,
			profileId: "profile-a",
			pastedValue: `${flow.redirectUri}?code=loopback-code&state=${stateOf(flow.authorizationUrl)}`,
		})

		expect(credential).toMatchObject({ code: "loopback-code" })
		expect(strategy.exchangedRedirectUris).toEqual([flow.redirectUri])
	})

	it("hands the whole callback query to the strategy", async () => {
		const strategy = new ManualCapableStrategy()
		const coordinator = await createCoordinator(strategy)
		const flow = await coordinator.startFlow({ profileId: "profile-a" })
		const state = stateOf(flow.authorizationUrl)

		await coordinator.completeFromPastedValue({
			flowId: flow.flowId,
			profileId: "profile-a",
			pastedValue: `${flow.redirectUri}?code=loopback-code&state=${state}&organization_id=org-7`,
		})

		// A provider that issued these may require them back at the token
		// endpoint, and which ones it needs is not the framework's knowledge,
		// so the parameters are forwarded rather than interpreted.
		expect(strategy.exchangedCallbackParams).toEqual([{ code: "loopback-code", state, organization_id: "org-7" }])
	})

	it("keeps the flow open so a failed exchange can still be completed by pasting", async () => {
		const strategy = new ManualCapableStrategy()
		strategy.pendingExchangeFailures.push(new Error("token endpoint rejected the loopback attempt"))
		const coordinator = await createCoordinator(strategy)
		const flow = await coordinator.startFlow({ profileId: "profile-a" })
		const state = stateOf(flow.authorizationUrl)

		const response = await fetch(`${flow.redirectUri}?code=browser-code&state=${state}`)
		expect(response.status).toBe(500)

		// The authorization itself succeeded, so the user must still be able to
		// recover by pasting rather than being forced to restart the sign-in.
		await expect(
			coordinator.completeFromPastedValue({
				flowId: flow.flowId,
				profileId: "profile-a",
				pastedValue: `hosted-code#${state}`,
			}),
		).resolves.toMatchObject({ code: "hosted-code" })
	})

	it("degrades to manual-only when no callback port can be bound", async () => {
		const strategy = ManualCapableStrategy.withoutBindablePort()
		const coordinator = await createCoordinator(strategy)
		const flow = await coordinator.startFlow({ profileId: "profile-a" })

		expect(flow.loopbackListening).toBe(false)
		// With no server to return to, the hosted page is the only way to authorize.
		expect(flow.authorizationUrl).toBe(flow.manualAuthorizationUrl)
		expect(flow.redirectUri).toBe(HOSTED_REDIRECT_URI)

		await expect(
			coordinator.completeFromPastedValue({
				flowId: flow.flowId,
				profileId: "profile-a",
				pastedValue: `degraded-code#${stateOf(flow.authorizationUrl)}`,
			}),
		).resolves.toMatchObject({ code: "degraded-code" })
	})

	it("still fails the flow when the strategy has no manual fallback", async () => {
		const coordinator = await createCoordinator(new TestStrategy([UNBINDABLE_PORT]))

		await expect(coordinator.startFlow({ profileId: "profile-a" })).rejects.toThrow()
	})

	it("reports an unsupported paste for a strategy without manual completion", async () => {
		const coordinator = await createCoordinator(new TestStrategy())
		const flow = await coordinator.startFlow({ profileId: "profile-a" })

		await expect(
			coordinator.completeFromPastedValue({
				flowId: flow.flowId,
				profileId: "profile-a",
				pastedValue: "bare-code",
			}),
		).rejects.toMatchObject({ code: "MANUAL_CODE_UNSUPPORTED" })
	})
})
