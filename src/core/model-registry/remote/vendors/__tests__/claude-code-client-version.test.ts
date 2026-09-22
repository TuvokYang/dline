import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import {
	CLAUDE_CODE_CLIENT_VERSION_FLOOR,
	CLAUDE_CODE_CLIENT_VERSION_REGISTRY_URL,
	ClaudeCodeClientVersionResolver,
	getClaudeCodeClientVersionResolver,
	isSupportedClaudeCodeClientVersion,
	resetClaudeCodeClientVersionResolver,
} from "../claude-code-client-version"

function jsonResponse(payload: unknown, status = 200): Response {
	return new Response(JSON.stringify(payload), { status, headers: { "content-type": "application/json" } })
}

interface Clock {
	now: () => number
	advance: (ms: number) => void
}

function createClock(start = 1_000): Clock {
	let current = start
	return {
		now: () => current,
		advance: (ms: number) => {
			current += ms
		},
	}
}

describe("isSupportedClaudeCodeClientVersion", () => {
	it("accepts a strict three-part version", () => {
		expect(isSupportedClaudeCodeClientVersion("2.1.280")).toBe(true)
		expect(isSupportedClaudeCodeClientVersion(" 2.1.280 ")).toBe(true)
		expect(isSupportedClaudeCodeClientVersion("0.0.0")).toBe(true)
	})

	it("rejects prerelease and build metadata", () => {
		// Upstream treats a suffixed version as an unofficial client, so these
		// must never reach the declared version.
		expect(isSupportedClaudeCodeClientVersion("2.1.280-rc.1")).toBe(false)
		expect(isSupportedClaudeCodeClientVersion("2.1.280+build")).toBe(false)
	})

	it("rejects malformed shapes", () => {
		for (const value of ["2.1", "2.1.280.1", "v2.1.280", "02.1.280", "", "latest"]) {
			expect(isSupportedClaudeCodeClientVersion(value)).toBe(false)
		}
	})
})

describe("ClaudeCodeClientVersionResolver", () => {
	beforeEach(() => resetClaudeCodeClientVersionResolver())
	afterEach(() => resetClaudeCodeClientVersionResolver())

	it("reads the latest dist-tag endpoint", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ version: "2.1.281" }))
		const resolver = new ClaudeCodeClientVersionResolver({ fetchImpl })

		await expect(resolver.resolve()).resolves.toEqual({ version: "2.1.281", source: "registry" })
		expect(fetchImpl.mock.calls[0][0]).toBe(CLAUDE_CODE_CLIENT_VERSION_REGISTRY_URL)
		// The `stable` tag trails `latest` by many patches and fails the gate.
		expect(CLAUDE_CODE_CLIENT_VERSION_REGISTRY_URL).toContain("/latest")
	})

	it("keeps the floor when the registry answer is lower", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ version: "2.0.0" }))
		const resolver = new ClaudeCodeClientVersionResolver({ fetchImpl, floorVersion: "2.1.280" })

		await expect(resolver.resolve()).resolves.toEqual({ version: "2.1.280", source: "registry" })
	})

	it("rejects a registry version carrying prerelease metadata", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ version: "2.2.0-rc.1" }))
		const resolver = new ClaudeCodeClientVersionResolver({ fetchImpl, floorVersion: "2.1.280" })

		await expect(resolver.resolve()).resolves.toEqual({ version: "2.1.280", source: "floor" })
	})

	it("falls back to the floor without throwing when the request fails", async () => {
		const fetchImpl = vi.fn().mockRejectedValue(new Error("offline"))
		const resolver = new ClaudeCodeClientVersionResolver({ fetchImpl, floorVersion: "2.1.280" })

		await expect(resolver.resolve()).resolves.toEqual({ version: "2.1.280", source: "floor" })
	})

	it("falls back to the floor on an HTTP error", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({}, 503))
		const resolver = new ClaudeCodeClientVersionResolver({ fetchImpl, floorVersion: "2.1.280" })

		await expect(resolver.resolve()).resolves.toEqual({ version: "2.1.280", source: "floor" })
	})

	it("falls back to the floor on a malformed payload", async () => {
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ version: 280 }))
		const resolver = new ClaudeCodeClientVersionResolver({ fetchImpl, floorVersion: "2.1.280" })

		await expect(resolver.resolve()).resolves.toEqual({ version: "2.1.280", source: "floor" })
	})

	it("serves the cached version until the success TTL expires", async () => {
		const clock = createClock()
		const fetchImpl = vi.fn().mockResolvedValue(jsonResponse({ version: "2.1.281" }))
		const resolver = new ClaudeCodeClientVersionResolver({
			fetchImpl,
			now: clock.now,
			successTtlMs: 1_000,
			floorVersion: "2.1.280",
		})

		await resolver.resolve()
		clock.advance(999)
		await expect(resolver.resolve()).resolves.toEqual({ version: "2.1.281", source: "registry" })
		expect(fetchImpl).toHaveBeenCalledTimes(1)

		clock.advance(2)
		await resolver.resolve()
		expect(fetchImpl).toHaveBeenCalledTimes(2)
	})

	it("keeps the previously resolved version when a later refresh fails", async () => {
		const clock = createClock()
		const fetchImpl = vi
			.fn()
			.mockResolvedValueOnce(jsonResponse({ version: "2.1.281" }))
			.mockRejectedValueOnce(new Error("offline"))
		const resolver = new ClaudeCodeClientVersionResolver({
			fetchImpl,
			now: clock.now,
			successTtlMs: 1_000,
			failureTtlMs: 500,
			floorVersion: "2.1.280",
		})

		await resolver.resolve()
		clock.advance(1_001)
		await expect(resolver.resolve()).resolves.toEqual({ version: "2.1.281", source: "cache" })
	})

	it("collapses concurrent callers onto one registry request", async () => {
		let release: (value: Response) => void = () => {}
		const pending = new Promise<Response>((resolve) => {
			release = resolve
		})
		const fetchImpl = vi.fn().mockReturnValue(pending)
		const resolver = new ClaudeCodeClientVersionResolver({ fetchImpl, floorVersion: "2.1.280" })

		const first = resolver.resolve()
		const second = resolver.resolve()
		release(jsonResponse({ version: "2.1.281" }))

		await expect(Promise.all([first, second])).resolves.toEqual([
			{ version: "2.1.281", source: "registry" },
			{ version: "2.1.281", source: "registry" },
		])
		expect(fetchImpl).toHaveBeenCalledTimes(1)
	})

	it("aborts the registry request when the caller signal aborts", async () => {
		const controller = new AbortController()
		const fetchImpl = vi.fn().mockImplementation((_url: string, init?: RequestInit) => {
			return new Promise<Response>((_resolve, reject) => {
				init?.signal?.addEventListener("abort", () => reject(new Error("aborted")), { once: true })
			})
		})
		const resolver = new ClaudeCodeClientVersionResolver({ fetchImpl, floorVersion: "2.1.280" })

		const resolution = resolver.resolve(controller.signal)
		controller.abort()

		// Abort degrades the declared version rather than failing the request.
		await expect(resolution).resolves.toEqual({ version: "2.1.280", source: "floor" })
	})

	it("shares one resolver process-wide", () => {
		const resolver = getClaudeCodeClientVersionResolver()
		expect(getClaudeCodeClientVersionResolver()).toBe(resolver)
		resetClaudeCodeClientVersionResolver()
		expect(getClaudeCodeClientVersionResolver()).not.toBe(resolver)
	})

	it("ships a floor that is itself a valid declared version", () => {
		expect(isSupportedClaudeCodeClientVersion(CLAUDE_CODE_CLIENT_VERSION_FLOOR)).toBe(true)
	})
})
