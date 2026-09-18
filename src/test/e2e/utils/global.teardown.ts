import { rmdir } from "node:fs/promises"
import { test as teardown } from "@playwright/test"
import { E2ETestHelper } from "./helpers"
import { E2E_EXTENSIONS_ROOT } from "./vscode-launch-isolation"

async function removeEmptyPuppeteerCacheRoot(): Promise<void> {
	try {
		await rmdir(E2ETestHelper.PUPPETEER_CACHE_ROOT)
	} catch (error) {
		const code = error instanceof Error && "code" in error ? String(error.code) : undefined
		if (!code || !["ENOENT", "ENOTEMPTY", "EEXIST", "EPERM"].includes(code)) throw error
	}
}

teardown("teardown test environment", async ({}, testInfo) => {
	testInfo.setTimeout(5 * 60_000)
	await Promise.all([
		E2ETestHelper.rmForRetries(E2ETestHelper.PUPPETEER_CACHE_DIR, { recursive: true, force: true }),
		E2ETestHelper.rmForRetries(E2E_EXTENSIONS_ROOT, { recursive: true, force: true }),
	])
	await removeEmptyPuppeteerCacheRoot()
})
