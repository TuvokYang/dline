import { createServer, type Server } from "node:http"
import type { AddressInfo } from "node:net"
import { mockFetchForTesting } from "@shared/net"
import { afterEach, describe, expect, it } from "vitest"
import { shouldVisitLoopbackUrlDirectly, visitLoopbackUrl } from "./e2e-loopback-visit"

describe("shouldVisitLoopbackUrlDirectly", () => {
	const e2e = { E2E_TEST: "true" } as NodeJS.ProcessEnv

	it("never bypasses the browser outside an E2E run", () => {
		expect(shouldVisitLoopbackUrlDirectly("http://127.0.0.1:4100/oauth/authorize", {} as NodeJS.ProcessEnv)).toBe(false)
	})

	it.each([
		"http://127.0.0.1:4100/oauth/authorize?state=a",
		"http://localhost:4100/oauth/authorize",
		"http://[::1]:4100/oauth/authorize",
	])("visits the loopback URL %s directly during an E2E run", (url) => {
		expect(shouldVisitLoopbackUrlDirectly(url, e2e)).toBe(true)
	})

	it.each([
		"https://127.0.0.1:4100/oauth/authorize",
		"http://auth.example.com/oauth/authorize",
		"http://192.0.2.10/oauth/authorize",
		"vscode://dline/callback",
		"not a url",
	])("keeps %s on the host browser path", (url) => {
		expect(shouldVisitLoopbackUrlDirectly(url, e2e)).toBe(false)
	})
})

describe("visitLoopbackUrl", () => {
	let server: Server | undefined

	afterEach(async () => {
		await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()))
		server = undefined
	})

	async function listen(handler: Parameters<typeof createServer>[1]): Promise<string> {
		server = createServer(handler)
		await new Promise<void>((resolve) => server?.listen(0, "127.0.0.1", resolve))
		return `http://127.0.0.1:${(server?.address() as AddressInfo).port}`
	}

	it("follows the authorization redirect to the loopback callback like a browser", async () => {
		const visited: string[] = []
		const base = await listen((request, response) => {
			visited.push(request.url ?? "")
			if (request.url?.startsWith("/oauth/authorize")) {
				response.writeHead(302, { Location: "/callback?code=c1&state=s1" }).end()
				return
			}
			response.writeHead(200, { "Content-Type": "text/html" }).end("<p>Signed in</p>")
		})

		const status = await mockFetchForTesting(globalThis.fetch, () => visitLoopbackUrl(`${base}/oauth/authorize?state=s1`))

		expect(status).toBe(200)
		expect(visited).toEqual(["/oauth/authorize?state=s1", "/callback?code=c1&state=s1"])
	})

	it("reports an error page as a status instead of failing to open", async () => {
		const base = await listen((_request, response) => {
			response.writeHead(400, { "Content-Type": "application/json" }).end('{"error":"missing_oauth_scenario"}')
		})

		await expect(mockFetchForTesting(globalThis.fetch, () => visitLoopbackUrl(`${base}/oauth/authorize`))).resolves.toBe(400)
	})

	it("rejects when the visit exceeds its bound", async () => {
		const base = await listen(() => {
			// Never respond; the visit must give up on its own.
		})

		await expect(
			mockFetchForTesting(globalThis.fetch, () => visitLoopbackUrl(`${base}/oauth/authorize`, 50)),
		).rejects.toThrow()
		server?.closeAllConnections()
	})
})
