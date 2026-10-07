import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest"

const reportWebviewError = vi.hoisted(() => vi.fn(() => Promise.resolve()))

vi.mock("@/services/grpc-client", () => ({
	StateServiceClient: { reportWebviewError },
}))

import { installGlobalWebviewErrorReporting } from "../webviewErrorReporter"

const RESIZE_OBSERVER_LOOP_NOTICE = "ResizeObserver loop completed with undelivered notifications."

function dispatchWindowError(init: ErrorEventInit): void {
	window.dispatchEvent(new ErrorEvent("error", init))
}

describe("global Webview error reporting", () => {
	beforeAll(() => installGlobalWebviewErrorReporting())
	beforeEach(() => reportWebviewError.mockClear())

	it("does not report the browser's ResizeObserver loop notice as an uncaught error", () => {
		dispatchWindowError({ message: RESIZE_OBSERVER_LOOP_NOTICE })
		dispatchWindowError({ message: "ResizeObserver loop limit exceeded" })

		expect(reportWebviewError).not.toHaveBeenCalled()
	})

	it("still reports a thrown error whose text matches the notice", () => {
		const thrown = new Error(RESIZE_OBSERVER_LOOP_NOTICE)
		dispatchWindowError({ message: thrown.message, error: thrown })

		expect(reportWebviewError).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "uncaught", name: "Error", message: RESIZE_OBSERVER_LOOP_NOTICE }),
		)
	})

	it("reports any other uncaught error event", () => {
		dispatchWindowError({ message: "Script error." })

		expect(reportWebviewError).toHaveBeenCalledWith(
			expect.objectContaining({ kind: "uncaught", name: "NonError", message: "Script error." }),
		)
	})
})
