import { test as teardown } from "@playwright/test"
import { E2ETestHelper } from "./helpers"
import { E2E_EXTENSIONS_ROOT } from "./vscode-launch-isolation"

teardown("teardown test environment", async ({}, testInfo) => {
	testInfo.setTimeout(5 * 60_000)
	await E2ETestHelper.rmForRetries(E2E_EXTENSIONS_ROOT, { recursive: true, force: true })
})
