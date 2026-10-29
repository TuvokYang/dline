import * as path from "node:path"
import { test as setup } from "@playwright/test"
import { downloadAndUnzipVSCode, SilentReporter } from "@vscode/test-electron"
import { E2ETestHelper } from "./helpers"
import {
    createWorkerExtensionsDir,
    E2E_EXTENSIONS_ROOT,
    E2E_VSIX_INSTALL_TIMEOUT_MS,
    ensureDlineVsixInstalled,
    resolveDlineVsixPath,
    shouldPreinstallDlineVsix,
} from "./vscode-launch-isolation"
import {
    E2E_VSCODE_DOWNLOAD_TIMEOUT_MS,
    resolveVSCodeDownloadPlatform,
    resolveVSCodeDownloadVersion,
} from "./vscode-version-resolver"

setup("setup test environment", async ({}, testInfo) => {
    const shouldPreinstall = shouldPreinstallDlineVsix()
    if (shouldPreinstall) {
        const vscodePreparationBudgetMs = 5 * 60_000
        testInfo.setTimeout(vscodePreparationBudgetMs + testInfo.config.workers * E2E_VSIX_INSTALL_TIMEOUT_MS)
    }

    await Promise.all([
        E2ETestHelper.rmForRetries(E2ETestHelper.DLINE_DIR_ROOT, { recursive: true, force: true }),
        E2ETestHelper.rmForRetries(E2ETestHelper.DLINE_DOCS_DIR_ROOT, { recursive: true, force: true }),
        E2ETestHelper.rmForRetries(E2ETestHelper.DLINE_STATE_TEMPLATE_DIR_ROOT, { recursive: true, force: true }),
        E2ETestHelper.rmForRetries(E2ETestHelper.PUPPETEER_CACHE_DIR, { recursive: true, force: true }),
        E2ETestHelper.rmForRetries(E2E_EXTENSIONS_ROOT, { recursive: true, force: true }),
    ])

    if (!shouldPreinstall) return

    const vscodeCachePath = path.join(E2ETestHelper.CODEBASE_ROOT_DIR, ".vscode-test")
    const vscodePlatform = resolveVSCodeDownloadPlatform()
    const vscodeVersion = resolveVSCodeDownloadVersion("stable", vscodeCachePath, vscodePlatform)
    const executablePath = await downloadAndUnzipVSCode({
        version: vscodeVersion,
        platform: vscodePlatform,
        cachePath: vscodeCachePath,
        reporter: new SilentReporter(),
        timeout: E2E_VSCODE_DOWNLOAD_TIMEOUT_MS,
    })
    const vsixPath = resolveDlineVsixPath(E2ETestHelper.CODEBASE_ROOT_DIR)

    for (let workerSlot = 0; workerSlot < testInfo.config.workers; workerSlot++) {
        ensureDlineVsixInstalled(executablePath, createWorkerExtensionsDir(workerSlot), vsixPath)
    }
})
