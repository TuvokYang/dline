import { afterEach, describe, expect, it, vi } from "vitest"
import { Logger } from "@/shared/services/Logger"
import type { Controller } from "../../index"
import { reportWebviewError } from "../reportWebviewError"

const controller = {} as Controller

function loggedError(spy: ReturnType<typeof vi.spyOn>): Error {
	expect(spy).toHaveBeenCalledTimes(1)
	const [message, error] = spy.mock.calls[0] as [string, Error]
	expect(message).toMatch(/^\[Webview\] /)
	expect(error).toBeInstanceOf(Error)
	return error
}

describe("reportWebviewError", () => {
	afterEach(() => {
		vi.restoreAllMocks()
	})

	it("routes a render failure into the extension error log with its component stack", async () => {
		const errorSpy = vi.spyOn(Logger, "error").mockImplementation(() => {})

		await reportWebviewError(controller, {
			kind: "render",
			message: "Cannot read properties of undefined",
			name: "TypeError",
			stack: "TypeError: Cannot read properties of undefined\n    at ChatRow",
			componentStack: "\n    at ChatRow\n    at ChatView",
		})

		expect(errorSpy.mock.calls[0]?.[0]).toBe("[Webview] render error")
		const error = loggedError(errorSpy)
		expect(error.name).toBe("WebviewError(render):TypeError")
		expect(error.message).toBe("Cannot read properties of undefined")
		expect(error.stack).toContain("at ChatRow")
		expect(error.stack).toContain("Component stack:")
		expect(error.stack).toContain("at ChatView")
	})

	it("normalizes an unknown kind and falls back to a generic message", async () => {
		const errorSpy = vi.spyOn(Logger, "error").mockImplementation(() => {})

		await reportWebviewError(controller, { kind: "arbitrary<script>", message: "" })

		expect(errorSpy.mock.calls[0]?.[0]).toBe("[Webview] unknown error")
		const error = loggedError(errorSpy)
		expect(error.name).toBe("WebviewError(unknown)")
		expect(error.message).toBe("Unknown Webview error")
		expect(error.stack).not.toContain("Component stack:")
	})

	it("bounds oversized fields supplied by the Webview", async () => {
		const errorSpy = vi.spyOn(Logger, "error").mockImplementation(() => {})

		await reportWebviewError(controller, {
			kind: "unhandled_rejection",
			message: "m".repeat(5_000),
			name: "n".repeat(500),
			stack: "s".repeat(20_000),
		})

		const error = loggedError(errorSpy)
		expect(error.message.length).toBe(1_001)
		expect(error.message.endsWith("…")).toBe(true)
		expect(error.name.length).toBeLessThan(160)
		expect(error.stack?.length ?? 0).toBeLessThan(6_000)
	})
})
