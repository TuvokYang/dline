import { E2ETestHelper, e2e } from "@e2e/utils/helpers"
import { expect } from "@playwright/test"

/**
 * BUGFIX-097 — a Webview failure must reach the extension log.
 *
 * A panel that went blank left nothing behind to diagnose, because nothing on
 * the Webview side forwarded its own failures. The render boundary is pinned by
 * the Webview component tests; what only a launched extension can show is that
 * an uncaught Webview error crosses the ProtoBus route and lands in the Dline
 * output as an error, which is what feeds runtime telemetry.
 */

const MARKER = "E2E_WEBVIEW_UNCAUGHT_REPORTED"

e2e("An uncaught Webview error is reported to the extension log", async ({ helper, sidebar, userDataDir }) => {
	e2e.setTimeout(120_000)
	await helper.signin(sidebar)

	// Thrown from a timer so it escapes every React boundary and reaches the
	// window-level handler, which is the path a blank panel leaves behind.
	await sidebar.evaluate((message) => {
		setTimeout(() => {
			throw new Error(message)
		}, 0)
	}, MARKER)

	await expect
		.poll(
			() =>
				(E2ETestHelper.readDlineOutputIfPresent(userDataDir) ?? "")
					.split(/\r?\n/)
					.find((line) => line.includes("[Webview] uncaught error")) ?? "",
			{ timeout: 30_000 },
		)
		.toContain("[Webview] uncaught error")
	expect(E2ETestHelper.readDlineOutputIfPresent(userDataDir) ?? "").toContain(MARKER)

	// The panel keeps working: reporting must not take the Webview down with it.
	await expect(sidebar.getByTestId("chat-input")).toBeEnabled()
	await E2ETestHelper.expectNoUnexpectedDlineErrors(userDataDir, [/\[Webview\] uncaught error/, new RegExp(MARKER)])
})
