import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	type PathLike,
	type RmOptions,
	readdirSync,
	readFileSync,
	statSync,
	writeFileSync,
} from "node:fs"
import { rm } from "node:fs/promises"
import * as os from "node:os"
import * as path from "node:path"
import { type ElectronApplication, expect, type Frame, type Page, test } from "@playwright/test"
import { downloadAndUnzipVSCode, SilentReporter } from "@vscode/test-electron"
import { _electron } from "playwright"
import { ClineApiServerMock } from "../fixtures/server"
import { type E2EProfileMode, type PreparedE2EState, prepareE2EState } from "./api-profile"
import { E2E_OUTPUT_ROOT as E2E_OUTPUT_ROOT_PATH, E2E_RUN_ID as E2E_RUN_NAMESPACE } from "./run-context"
import {
	createLaunchIsolation,
	createVSCodeExtensionLaunchArguments,
	createWorkerExtensionsDir,
	ensureDlineVsixInstalled,
	portableEnvironment,
	resolveWorkerExtensionsSlot,
	shouldPreinstallDlineVsix,
	type VSCodeLaunchIsolation,
} from "./vscode-launch-isolation"
import { resolveVSCodeDownloadPlatform, resolveVSCodeDownloadVersion } from "./vscode-version-resolver"

interface E2ETaskDirectories {
	dlineDir: string
	dlineDocsDir: string
}

interface E2ETestDirectories {
	testDirectories: E2ETaskDirectories
	workspaceDir: string
	multiRootWorkspaceDir: string
	launchIsolation: VSCodeLaunchIsolation
	userDataDir: string
	dlineDir: string
	dlineHomeDir: string
	dlineDocsDir: string
}

interface E2EWorkerDirectories {
	dlineDir: string
	dlineDocsDir: string
	dlineStateTemplateDir: string
}

interface E2EWorkerFixtures {
	server: ClineApiServerMock
	workerDirectories: E2EWorkerDirectories
	dlineStateTemplateDir: string
	extensionsDir: string
	preparedE2EState: PreparedE2EState
	profileMode: E2EProfileMode
}

export interface E2ETestConfigs {
	workspaceType: "single" | "multi"
	channel: "stable" | "insiders"
	forceStaleInitialState: boolean
	stateBuildTimingLogs: boolean
	mockConda: boolean
	isolateOsHome: boolean
	grpcRecorderEnabled: boolean
	grpcUnaryFaults: string | undefined
	installVsix: boolean
	devWebview: boolean
}

/**
 * Output-channel errors that never indicate a product regression under test.
 *
 * These background refreshes reach the real network, which the mock provider
 * does not serve. They fire on timers, so they can land in any test's log
 * window and would otherwise turn every suite into a flaky one.
 */
const ALWAYS_ALLOWED_DLINE_OUTPUT_ERRORS: RegExp[] = [/Error fetching OpenRouter models/i, /Failed to refresh MCP marketplace/i]

export class E2ETestHelper {
	// Constants
	public static readonly CODEBASE_ROOT_DIR = path.resolve(__dirname, "..", "..", "..", "..")
	public static readonly E2E_TESTS_DIR = path.join(E2ETestHelper.CODEBASE_ROOT_DIR, "src", "test", "e2e")
	public static readonly E2E_OUTPUT_ROOT = E2E_OUTPUT_ROOT_PATH
	public static readonly DLINE_DIR_ROOT = path.join(os.tmpdir(), ".dline-e2e", E2E_RUN_NAMESPACE)
	public static readonly DLINE_DOCS_DIR_ROOT = path.join(os.tmpdir(), "dline-e2e", E2E_RUN_NAMESPACE)
	public static readonly DLINE_STATE_TEMPLATE_DIR_ROOT = path.join(os.tmpdir(), ".dline-e2e-template", E2E_RUN_NAMESPACE)
	public static readonly PUPPETEER_CACHE_ROOT = path.join(E2ETestHelper.CODEBASE_ROOT_DIR, "tmp", "e2e-puppeteer-cache")
	public static readonly PUPPETEER_CACHE_DIR = path.join(E2ETestHelper.PUPPETEER_CACHE_ROOT, E2E_RUN_NAMESPACE)

	// Instance properties for caching
	private cachedFrame: Frame | null = null

	// Path utilities
	public static escapeToPath(text: string): string {
		return text.trim().toLowerCase().replaceAll(/\W/g, "_")
	}

	public static getWorkerDirectories(workerIndex: number): E2EWorkerDirectories {
		const workerDirectoryName = `worker-${workerIndex}`
		return {
			dlineDir: path.join(E2ETestHelper.DLINE_DIR_ROOT, workerDirectoryName),
			dlineDocsDir: path.join(E2ETestHelper.DLINE_DOCS_DIR_ROOT, workerDirectoryName),
			dlineStateTemplateDir: path.join(E2ETestHelper.DLINE_STATE_TEMPLATE_DIR_ROOT, workerDirectoryName),
		}
	}

	public static getTestDirectories(workerDirectories: E2EWorkerDirectories, testId: string, retry: number): E2ETaskDirectories {
		const testDirectoryName = `test-${E2ETestHelper.escapeToPath(testId)}-retry-${retry}`
		return {
			dlineDir: path.join(workerDirectories.dlineDir, testDirectoryName),
			dlineDocsDir: path.join(workerDirectories.dlineDocsDir, testDirectoryName),
		}
	}

	public static getResultsDir(testName = "", label?: string, testIdentity?: string): string {
		const testDirectoryName = testIdentity
			? `${E2ETestHelper.escapeToPath(testIdentity)}-${E2ETestHelper.escapeToPath(testName)}`
			: E2ETestHelper.escapeToPath(testName)
		const testDir = path.join(E2ETestHelper.E2E_OUTPUT_ROOT, testDirectoryName)
		return label ? path.join(testDir, label) : testDir
	}

	/**
	 * Generates a filename for gRPC recorder logs based on test information
	 * @param testTitle The title of the test
	 * @param projectName The name of the test project (optional)
	 * @returns A sanitized filename suitable for gRPC recorder logs
	 */
	public static generateTestFileName(testTitle: string, projectName?: string): string {
		// Create a base name from the test title
		const baseName = E2ETestHelper.escapeToPath(testTitle)

		// Add project name if provided and different from default
		const projectSuffix = projectName && projectName !== "e2e tests" ? `_${E2ETestHelper.escapeToPath(projectName)}` : ""

		return `${baseName}${projectSuffix}`
	}

	public static async waitUntil(predicate: () => boolean | Promise<boolean>, maxDelay = 10000): Promise<void> {
		let delay = 10
		const start = Date.now()

		while (!(await predicate())) {
			if (Date.now() - start > maxDelay) {
				throw new Error(`waitUntil timeout after ${maxDelay}ms`)
			}
			await new Promise((resolve) => setTimeout(resolve, delay))
			delay = Math.min(delay << 1, 1000) // Cap at 1s
		}
	}

	public static async waitForValue<T>(predicate: () => T | undefined | Promise<T | undefined>, maxDelay = 10000): Promise<T> {
		let value: T | undefined
		await E2ETestHelper.waitUntil(async () => {
			value = await predicate()
			return value !== undefined
		}, maxDelay)
		return value as T
	}

	public async getSidebar(page: Page): Promise<Frame> {
		const consoleErrors: string[] = []
		const pageErrors: string[] = []
		const onConsole = (message: { type(): string; text(): string }) => {
			if (message.type() === "error") consoleErrors.push(message.text())
		}
		const onPageError = (error: Error) => pageErrors.push(error.stack ?? error.message)
		page.on("console", onConsole)
		page.on("pageerror", onPageError)

		const findSidebarFrame = async (): Promise<Frame | null> => {
			// Check cached frame first
			if (this.cachedFrame && !this.cachedFrame.page().isClosed() && !this.cachedFrame.isDetached()) {
				return this.cachedFrame
			}
			this.cachedFrame = null

			for (const frame of page.frames()) {
				if (frame.isDetached()) {
					continue
				}

				try {
					const title = await frame.title()
					const isNamedDlineFrame = title.startsWith("Cline") || title.startsWith("Dline")
					const isVsCodeWebviewFrame =
						frame !== page.mainFrame() &&
						frame.url().startsWith("vscode-webview://") &&
						(await frame.locator("#root").count()) > 0
					if (isNamedDlineFrame || isVsCodeWebviewFrame) {
						this.cachedFrame = frame
						return frame
					}
				} catch (error: unknown) {
					const message = error instanceof Error ? error.message : String(error)
					if (!message.includes("detached") && !message.includes("navigation")) {
						throw error
					}
				}
			}
			return null
		}

		// Use longer timeout (30s) for sidebar - macOS CI runners can be slow
		try {
			await E2ETestHelper.waitUntil(async () => (await findSidebarFrame()) !== null, 30000)
		} catch (error) {
			const observedFrames: Array<{ title?: string; url: string; rootCount?: number; error?: string }> = []
			for (const frame of page.frames()) {
				try {
					observedFrames.push({
						title: await frame.title(),
						url: frame.url(),
						rootCount: await frame.locator("#root").count(),
					})
				} catch (frameError) {
					observedFrames.push({
						url: frame.url(),
						error: frameError instanceof Error ? frameError.message : String(frameError),
					})
				}
			}
			const dlineTabs = await page.getByRole("tab", { name: /Dline/ }).evaluateAll((elements) =>
				elements.map((element) => ({
					ariaExpanded: element.getAttribute("aria-expanded"),
					ariaSelected: element.getAttribute("aria-selected"),
					className: element.className,
					outerHtml: element.outerHTML.slice(0, 1_000),
				})),
			)
			const webviewHosts = await page.locator("iframe, webview").evaluateAll((elements) =>
				elements.map((element) => ({
					className: element.className,
					hidden: element.hasAttribute("hidden"),
					outerHtml: element.outerHTML.slice(0, 1_000),
				})),
			)
			throw new Error(
				`Dline sidebar frame unavailable; observed=${JSON.stringify({ observedFrames, dlineTabs, webviewHosts, consoleErrors, pageErrors })}`,
				{ cause: error },
			)
		} finally {
			page.off("console", onConsole)
			page.off("pageerror", onPageError)
		}
		return (await findSidebarFrame()) || page.mainFrame()
	}

	public static async rmForRetries(path: PathLike, options?: RmOptions): Promise<void> {
		const maxAttempts = 10
		for (let attempt = 1; attempt <= maxAttempts; attempt++) {
			try {
				await rm(path, options)
				return
			} catch (error) {
				const code = error instanceof Error && "code" in error ? String(error.code) : undefined
				const retryable = code === "EBUSY" || code === "ENOTEMPTY" || code === "EPERM"
				if (!retryable || attempt === maxAttempts) {
					throw new Error(`Failed to remove ${path} after ${attempt} attempt(s): ${error}`, { cause: error })
				}
				await new Promise((resolve) => setTimeout(resolve, 100 * attempt))
			}
		}
	}

	public async signin(webview: Frame): Promise<void> {
		const consoleErrors: string[] = []
		const pageErrors: string[] = []
		const page = webview.page()
		const onConsole = (message: { type(): string; text(): string }) => {
			if (message.type() === "error") consoleErrors.push(message.text())
		}
		const onPageError = (error: Error) => pageErrors.push(error.stack ?? error.message)
		page.on("console", onConsole)
		page.on("pageerror", onPageError)
		const bringYourOwnKey = webview.getByText("Bring my own API key")
		const chatInput = webview.getByTestId("chat-input")
		try {
			await expect(bringYourOwnKey.or(chatInput)).toBeVisible()

			if (await bringYourOwnKey.isVisible()) {
				await bringYourOwnKey.click()
				await webview.getByRole("button", { name: "Continue" }).click()
				await webview.getByRole("button", { name: "Add API" }).click()

				const providerSelector = webview.getByRole("combobox").first()
				await providerSelector.selectOption("openrouter")
				await webview.getByRole("textbox", { name: "OpenRouter API Key" }).fill("test-api-key")
				await webview.getByRole("button", { name: "Continue" }).click()
			}

			await expect(chatInput).toBeVisible()

			// Dismiss "What's New" version announcement if present
			await E2ETestHelper.dismissWhatsNewModal(webview)
		} catch (error) {
			const rootHtml = await webview
				.locator("#root")
				.innerHTML()
				.catch(() => "<root unavailable>")
			throw new Error(
				`Dline sign-in UI unavailable; diagnostics=${JSON.stringify({ consoleErrors, pageErrors, rootHtml })}`,
				{ cause: error },
			)
		} finally {
			page.off("console", onConsole)
			page.off("pageerror", onPageError)
		}
	}

	public static async openClineSidebar(page: Page): Promise<void> {
		const dlineTab = page.getByRole("tab", { name: /Dline/ })
		await expect(dlineTab).toBeVisible({ timeout: 30_000 })
		for (let attempt = 1; attempt <= 3; attempt++) {
			if ((await dlineTab.getAttribute("aria-expanded")) === "true") return
			await dlineTab.locator("a").click()
			try {
				await expect(dlineTab).toHaveAttribute("aria-expanded", "true", { timeout: 5_000 })
				return
			} catch (error) {
				if (attempt === 3) throw error
			}
		}
	}

	public static async runCommandPalette(page: Page, command: string): Promise<void> {
		await page.keyboard.press("ControlOrMeta+Shift+p")
		const commandPalette = page.locator(".quick-input-widget:visible")
		await expect(commandPalette).toHaveCount(1)
		const commandInput = commandPalette.locator("input")
		await expect(commandInput).toBeVisible()
		await expect(commandInput).toHaveAttribute("placeholder", /command/i)
		await expect(commandInput).toHaveValue(">")
		// pressSequentially uses Playwright's keyboard focus path; direct DOM focus can deactivate VS Code QuickInput.
		await commandInput.pressSequentially(` ${command}`)
		await expect(commandInput).toHaveAttribute("placeholder", /command/i)
		await expect(commandInput).toHaveValue(`> ${command}`)
		const commandOption = commandPalette.locator(".monaco-list-row").filter({ has: page.getByText(command, { exact: true }) })
		await expect(commandOption).toHaveCount(1)
		await expect(commandOption).toBeVisible()
		await commandOption.click()
	}

	private static findDlineOutputLogs(directory: string): string[] {
		if (!existsSync(directory)) return []
		const result: string[] = []
		for (const entry of readdirSync(directory, { withFileTypes: true })) {
			const entryPath = path.join(directory, entry.name)
			if (entry.isDirectory()) result.push(...E2ETestHelper.findDlineOutputLogs(entryPath))
			else if (/^\d+-Dline\.log$/i.test(entry.name)) result.push(entryPath)
		}
		return result
	}

	/** Read the backing log for the live Dline VS Code Output channel. */
	public static async readDlineOutput(userDataDir: string): Promise<string> {
		const outputPath = await E2ETestHelper.waitForValue(() => {
			const candidates = E2ETestHelper.findDlineOutputLogs(path.join(userDataDir, "logs"))
			return candidates.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0]
		}, 10_000)
		return readFileSync(outputPath, "utf8")
	}

	/** Read the newest Dline Output log without waiting for one to be created. */
	public static readDlineOutputIfPresent(userDataDir: string): string | undefined {
		const candidates = E2ETestHelper.findDlineOutputLogs(path.join(userDataDir, "logs"))
		const outputPath = candidates.sort((left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs)[0]
		return outputPath ? readFileSync(outputPath, "utf8") : undefined
	}

	/** Fail when the Dline output channel contains an unexpected internal error or persistent write loop. */
	public static async expectNoUnexpectedDlineErrors(userDataDir: string, allowed: RegExp[] = []): Promise<void> {
		const output = await E2ETestHelper.readDlineOutput(userDataDir)
		const outputLines = output.split(/\r?\n/)
		const suspiciousLines = outputLines.filter((line) =>
			/\[error\]|uncaught|unhandled|TypeError|ReferenceError|invalid_runtime_event/i.test(line),
		)
		const ignored = [...ALWAYS_ALLOWED_DLINE_OUTPUT_ERRORS, ...allowed]
		const unexpected = suspiciousLines.filter((line) => !ignored.some((pattern) => pattern.test(line)))
		const profileRewriteLines = outputLines.filter((line) =>
			line.includes("[cleanRewriteApiProfiles] Stripped apiKey fields from api_profiles.json"),
		)
		if (profileRewriteLines.length > 1) {
			unexpected.push(
				`[profile_rewrite_storm] api_profiles.json was clean-rewritten ${profileRewriteLines.length} times in one VS Code instance`,
			)
		}
		expect(unexpected, `Unexpected Dline output errors:\n${unexpected.join("\n")}`).toEqual([])
	}

	// Clear cached frame when needed
	public clearCachedFrame(): void {
		this.cachedFrame = null
	}

	/** Dismiss "What's New" version announcement modal if visible. */
	public static async dismissWhatsNewModal(sidebar: Frame): Promise<void> {
		const whatsNewDialog = sidebar.getByRole("heading", { name: /New in v/ })
		const closeButton = sidebar.getByRole("button", { name: "Close" }).last()
		let consecutiveHiddenChecks = 0

		for (let attempt = 0; attempt < 12; attempt += 1) {
			if (await whatsNewDialog.isVisible()) {
				consecutiveHiddenChecks = 0
				await closeButton.click({ force: true, timeout: 1_000 }).catch(() => undefined)
			} else {
				consecutiveHiddenChecks += 1
				if (consecutiveHiddenChecks === 3) return
			}

			await sidebar.page().waitForTimeout(250)
		}

		await expect(whatsNewDialog).not.toBeVisible()
	}
}

/**
 * NOTE: Use the `e2e` test fixture for all E2E tests to test the Cline extension.
 *
 * Extended Playwright test configuration for Cline E2E testing.
 *
 * This test configuration provides a comprehensive setup for end-to-end testing of the Cline VS Code extension,
 * including server mocking, temporary directories, VS Code instance management, and helper utilities.
 *
 * NOTE: Tests select single-root or multi-root workspaces through the `workspaceType` fixture.
 *
 * @extends test - Base Playwright test with multiple fixture extensions
 *
 * Fixtures provided:
 * - `server`: Shared ClineApiServerMock instance for API mocking (reused across all tests)
 * - `workspaceDir`: Path to the test workspace directory
 * - `userDataDir`: Temporary directory for VS Code user data
 * - `openVSCode`: Function that returns a Promise resolving to an ElectronApplication instance
 * - `app`: ElectronApplication instance with automatic cleanup
 * - `helper`: E2ETestHelper instance for test utilities
 * - `page`: Playwright Page object representing the main VS Code window with Cline sidebar opened
 * - `sidebar`: Playwright Frame object representing the Cline extension's sidebar iframe
 *
 * @returns Extended test object with all fixtures available for E2E test scenarios:
 * - **server**: Automatically starts and manages a ClineApiServerMock instance
 * - **workspaceDir**: Sets up a test workspace directory from fixtures
 * - **userDataDir**: Creates a temporary directory for VS Code user data
 * - **openVSCode**: Factory function that launches VS Code with proper configuration for testing
 * - **app**: Manages the VS Code ElectronApplication lifecycle with automatic cleanup
 * - **helper**: Provides E2ETestHelper utilities for test operations
 * - **page**: Configures the main VS Code window with notifications disabled and Cline sidebar open
 * - **sidebar**: Provides access to the Cline extension's sidebar frame
 *
 * @example
 * ```typescript
 * e2e('should perform basic operations', async ({ sidebar, helper }) => {
 *   // Test implementation using the configured sidebar and helper
 * });
 * ```
 *
 * @remarks
 * - Automatically handles VS Code download and setup
 * - Installs the Cline extension in development mode
 * - Records test videos for debugging
 * - Performs cleanup of temporary directories after each test
 * - Configures VS Code with disabled updates, workspace trust, and welcome screens
 */
export const e2e = test
	.extend<E2ETestConfigs>({
		workspaceType: "single",
		channel: "stable",
		forceStaleInitialState: [false, { option: true }],
		stateBuildTimingLogs: [false, { option: true }],
		mockConda: [false, { option: true }],
		isolateOsHome: [false, { option: true }],
		grpcRecorderEnabled: [false, { option: true }],
		grpcUnaryFaults: [undefined, { option: true }],
		installVsix: [shouldPreinstallDlineVsix(), { option: true }],
		devWebview: [false, { option: true }],
	})
	.extend<E2ETestDirectories, E2EWorkerFixtures>({
		profileMode: ["mock", { scope: "worker", option: true }],
		workerDirectories: [
			async ({}, use, workerInfo) => {
				await use(E2ETestHelper.getWorkerDirectories(workerInfo.workerIndex))
			},
			{ scope: "worker" },
		],
		testDirectories: async ({ workerDirectories }, use, testInfo) => {
			await use(E2ETestHelper.getTestDirectories(workerDirectories, testInfo.testId, testInfo.retry))
		},
		extensionsDir: [
			async ({}, use, workerInfo) => {
				const workerSlot = resolveWorkerExtensionsSlot(workerInfo.workerIndex, workerInfo.parallelIndex)
				const extensionsDir = createWorkerExtensionsDir(workerSlot)
				try {
					await use(extensionsDir)
				} finally {
					if (!shouldPreinstallDlineVsix()) {
						await E2ETestHelper.rmForRetries(extensionsDir, { recursive: true, force: true })
					}
				}
			},
			{ scope: "worker" },
		],
		server: [
			async ({}, use) => {
				const server = await ClineApiServerMock.startGlobalServer()
				try {
					await use(server)
				} finally {
					await ClineApiServerMock.stopGlobalServer()
				}
			},
			{ scope: "worker" },
		],
		preparedE2EState: [
			async ({ server, profileMode, workerDirectories }, use) => {
				const { dlineDir, dlineDocsDir, dlineStateTemplateDir: templateDir } = workerDirectories
				await Promise.all([
					E2ETestHelper.rmForRetries(templateDir, { recursive: true, force: true }),
					E2ETestHelper.rmForRetries(dlineDir, { recursive: true, force: true }),
					E2ETestHelper.rmForRetries(dlineDocsDir, { recursive: true, force: true }),
				])
				try {
					const preparedState = await prepareE2EState({
						dlineDir: templateDir,
						mockBaseUrl: server.baseUrl,
						profileMode,
					})
					await use(preparedState)
				} finally {
					await Promise.all([
						E2ETestHelper.rmForRetries(templateDir, { recursive: true, force: true }),
						E2ETestHelper.rmForRetries(dlineDir, { recursive: true, force: true }),
						E2ETestHelper.rmForRetries(dlineDocsDir, { recursive: true, force: true }),
					])
				}
			},
			{ scope: "worker" },
		],
		dlineStateTemplateDir: [
			async ({ preparedE2EState }, use) => {
				await use(preparedE2EState.dlineDir)
			},
			{ scope: "worker" },
		],
		workspaceDir: async ({}, use) => {
			const fixtureRoot = path.join(E2ETestHelper.E2E_TESTS_DIR, "fixtures")
			const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "dline-e2e-workspace-"))
			const workspaceDir = path.join(temporaryRoot, "workspace")
			cpSync(path.join(fixtureRoot, "workspace"), workspaceDir, { recursive: true })
			try {
				await use(workspaceDir)
			} finally {
				await E2ETestHelper.rmForRetries(temporaryRoot, { recursive: true, force: true })
			}
		},
		multiRootWorkspaceDir: async ({}, use) => {
			// DOCS: https://code.visualstudio.com/docs/editing/workspaces/multi-root-workspaces
			const fixtureRoot = path.join(E2ETestHelper.E2E_TESTS_DIR, "fixtures")
			const temporaryRoot = mkdtempSync(path.join(os.tmpdir(), "dline-e2e-multiroot-"))
			cpSync(path.join(fixtureRoot, "workspace"), path.join(temporaryRoot, "workspace"), { recursive: true })
			cpSync(path.join(fixtureRoot, "workspace_2"), path.join(temporaryRoot, "workspace_2"), { recursive: true })
			const workspaceFile = path.join(temporaryRoot, "multiroots.code-workspace")
			cpSync(path.join(fixtureRoot, "multiroots.code-workspace"), workspaceFile)
			try {
				await use(workspaceFile)
			} finally {
				await E2ETestHelper.rmForRetries(temporaryRoot, { recursive: true, force: true })
			}
		},
		launchIsolation: async ({}, use, testInfo) => {
			const isolation = createLaunchIsolation("dline-e2e-user-data-")
			const { portableRoot, userDataDir } = isolation
			try {
				await use(isolation)
			} finally {
				const logsDir = path.join(userDataDir, "logs")
				if (testInfo.status !== testInfo.expectedStatus) {
					try {
						const output = E2ETestHelper.readDlineOutputIfPresent(userDataDir)
						const outputArtifact = testInfo.outputPath("dline-output.log")
						writeFileSync(
							outputArtifact,
							output ?? "Dline Output log was not created before the test stopped.",
							"utf8",
						)
						await testInfo.attach("dline-output.log", { path: outputArtifact, contentType: "text/plain" })
						if (existsSync(logsDir)) {
							cpSync(logsDir, testInfo.outputPath("vscode-logs"), { recursive: true })
						}
					} catch (error) {
						await testInfo.attach("dline-output-capture-error.txt", {
							body: Buffer.from(error instanceof Error ? (error.stack ?? error.message) : String(error)),
							contentType: "text/plain",
						})
					}
				}
				// Removing the portable root also removes user data, argv.json, and shared data.
				await E2ETestHelper.rmForRetries(portableRoot, { recursive: true, force: true })
			}
		},
		userDataDir: async ({ launchIsolation }, use) => {
			await use(launchIsolation.userDataDir)
		},
		dlineDir: async ({ dlineStateTemplateDir, server, testDirectories }, use, testInfo) => {
			const { dlineDir, dlineDocsDir } = testDirectories
			server.resetOpenAiMock()
			await Promise.all([
				E2ETestHelper.rmForRetries(dlineDir, { recursive: true, force: true }),
				E2ETestHelper.rmForRetries(dlineDocsDir, { recursive: true, force: true }),
			])
			cpSync(dlineStateTemplateDir, dlineDir, { recursive: true })
			try {
				await use(dlineDir)
			} finally {
				const cacheReport = server.getCacheDiagnosticReport()
				if (cacheReport.requests.length > 0) {
					const cacheArtifact = testInfo.outputPath("openai-cache-diagnostics.json")
					writeFileSync(cacheArtifact, `${JSON.stringify(cacheReport, null, 2)}\n`, "utf8")
					await testInfo.attach("openai-cache-diagnostics.json", {
						path: cacheArtifact,
						contentType: "application/json",
					})
				}
				const taskStateDir = path.join(dlineDocsDir, "tasks")
				if (testInfo.status !== testInfo.expectedStatus && existsSync(taskStateDir)) {
					cpSync(taskStateDir, testInfo.outputPath("dline-task-state"), { recursive: true })
				}
				await Promise.all([
					E2ETestHelper.rmForRetries(dlineDir, { recursive: true, force: true }),
					E2ETestHelper.rmForRetries(dlineDocsDir, { recursive: true, force: true }),
				])
			}
		},
		dlineHomeDir: async ({ dlineDir }, use) => {
			await use(dlineDir)
		},
		dlineDocsDir: async ({ dlineDir, testDirectories }, use) => {
			void dlineDir
			await use(testDirectories.dlineDocsDir)
		},
	})
	.extend<{
		openVSCode: (
			workspacePath: string,
			environmentOverrides?: Readonly<Record<string, string>>,
			launchOptions?: {
				windowSize?: { width: number; height: number }
				forceDeviceScaleFactor?: number
			},
		) => Promise<ElectronApplication>
	}>({
		openVSCode: async (
			{
				launchIsolation,
				userDataDir,
				extensionsDir,
				dlineDir,
				dlineHomeDir,
				dlineDocsDir,
				channel,
				forceStaleInitialState,
				stateBuildTimingLogs,
				mockConda,
				isolateOsHome,
				grpcRecorderEnabled,
				grpcUnaryFaults,
				installVsix,
				devWebview,
				server,
			},
			use,
			testInfo,
		) => {
			const vscodeCachePath = path.join(E2ETestHelper.CODEBASE_ROOT_DIR, ".vscode-test")
			const vscodePlatform = resolveVSCodeDownloadPlatform()
			const vscodeVersion = resolveVSCodeDownloadVersion(channel, vscodeCachePath, vscodePlatform)
			const executablePath = await downloadAndUnzipVSCode({
				version: vscodeVersion,
				platform: vscodePlatform,
				cachePath: vscodeCachePath,
				reporter: new SilentReporter(),
			})
			const electronEnvironment = { ...process.env, ...portableEnvironment(launchIsolation) }
			delete electronEnvironment.ELECTRON_RUN_AS_NODE
			// Keep E2E terminals independent from the developer's active Conda session and profile auto-activation.
			for (const name of Object.keys(electronEnvironment)) {
				if (/^(?:CONDA_|_CONDA_|_CE_)/i.test(name)) delete electronEnvironment[name]
			}
			electronEnvironment.CONDA_AUTO_ACTIVATE_BASE = "false"
			if (isolateOsHome) {
				const isolatedOsHome = path.join(userDataDir, "os-home")
				mkdirSync(isolatedOsHome, { recursive: true })
				electronEnvironment.HOME = isolatedOsHome
				electronEnvironment.USERPROFILE = isolatedOsHome
			}
			const configuredCdpPort = process.env.DLINE_E2E_CDP_PORT?.trim()
			if (configuredCdpPort && (!/^\d+$/.test(configuredCdpPort) || Number(configuredCdpPort) < 1)) {
				throw new Error(`Invalid DLINE_E2E_CDP_PORT: ${configuredCdpPort}`)
			}
			const cdpPort = configuredCdpPort ? Number(configuredCdpPort) + testInfo.workerIndex : undefined
			if (cdpPort !== undefined && cdpPort > 65_535) {
				throw new Error(`DLINE_E2E_CDP_PORT exceeds 65535 for worker ${testInfo.workerIndex}: ${cdpPort}`)
			}
			if (mockConda) {
				const inheritedPath = Object.entries(electronEnvironment).find(([name]) => name.toLowerCase() === "path")?.[1]
				for (const name of Object.keys(electronEnvironment)) {
					if (name.toLowerCase() === "path") delete electronEnvironment[name]
				}
				electronEnvironment.PATH = [userDataDir, inheritedPath].filter(Boolean).join(path.delimiter)
				if (process.platform === "win32") {
					writeFileSync(
						path.join(userDataDir, "conda.cmd"),
						'@echo off\r\nif /I "%1"=="info" if /I "%2"=="--envs" if /I "%3"=="--json" (\r\n  echo {"envs":["C:\\\\fake-conda","C:\\\\fake-envs\\\\dline"],"envs_details":{"C:\\\\fake-conda":{"name":"base","active":true,"base":true},"C:\\\\fake-envs\\\\dline":{"name":"dline","active":false,"base":false}}}\r\n  exit /b 0\r\n)\r\nexit /b 1\r\n',
						"utf8",
					)
				} else {
					const mockCondaPath = path.join(userDataDir, "conda")
					writeFileSync(
						mockCondaPath,
						'#!/bin/sh\nif [ "$1" = "info" ] && [ "$2" = "--envs" ] && [ "$3" = "--json" ]; then\n  printf \'%s\\n\' \'{"envs":["/opt/fake-conda","/opt/fake-envs/dline"],"envs_details":{"/opt/fake-conda":{"name":"base","active":true,"base":true},"/opt/fake-envs/dline":{"name":"dline","active":false,"base":false}}}\'\n  exit 0\nfi\nexit 1\n',
						"utf8",
					)
					chmodSync(mockCondaPath, 0o755)
				}
			}

			const vsixPath = path.join(E2ETestHelper.CODEBASE_ROOT_DIR, "dist", "e2e.vsix")
			await use(async (workspacePath: string, environmentOverrides = {}, launchOptions = {}) => {
				if (installVsix) ensureDlineVsixInstalled(executablePath, extensionsDir, vsixPath)
				const extensionLaunchArguments = createVSCodeExtensionLaunchArguments(
					extensionsDir,
					installVsix ? undefined : E2ETestHelper.CODEBASE_ROOT_DIR,
				)
				const app = await _electron.launch({
					executablePath,
					env: {
						...electronEnvironment,
						E2E_TEST: "true",
						...(stateBuildTimingLogs ? { DLINE_E2E_STATE_BUILD_TIMING: "true" } : {}),
						// Perf and diagnostic call sites publish to telemetry unconditionally
						// but mirror to Logger.debug only when debug logging is on. Several
						// suites assert against those mirrored lines, so raise the level here
						// rather than removing the guards and paying the cost in production.
						DLINE_LOG_LEVEL: "debug",
						...(devWebview ? { IS_DEV: "true", DLINE_E2E_DEV_WEBVIEW: "true" } : {}),
						DLINE_ENVIRONMENT: "local",
						DLINE_DIR: dlineDir,
						DLINE_HOME_DIR: dlineHomeDir,
						DLINE_E2E_API_BASE_URL: server.baseUrl,
						DLINE_SKIP_MIGRATION: "1",
						...environmentOverrides,
						DLINE_DOCS_DIR: dlineDocsDir,
						...(forceStaleInitialState ? { DLINE_E2E_FORCE_STALE_INITIAL_STATE: "true" } : {}),
						...(grpcUnaryFaults ? { DLINE_E2E_GRPC_UNARY_FAULTS: grpcUnaryFaults } : {}),
						GRPC_RECORDER_FILE_NAME: E2ETestHelper.generateTestFileName(testInfo.title, testInfo.project.name),
						...(grpcRecorderEnabled ? { GRPC_RECORDER_ENABLED: "true" } : {}),
						// GRPC_RECORDER_TESTS_FILTERS_ENABLED: "true"
						// IS_DEV: "true",
						DEV_WORKSPACE_FOLDER: E2ETestHelper.CODEBASE_ROOT_DIR,
					},
					args: [
						"--no-sandbox",
						...(cdpPort !== undefined ? [`--remote-debugging-port=${cdpPort}`] : []),
						"--disable-updates",
						"--disable-workspace-trust",
						...(launchOptions.windowSize
							? [`--window-size=${launchOptions.windowSize.width},${launchOptions.windowSize.height}`]
							: []),
						...(launchOptions.forceDeviceScaleFactor !== undefined
							? [`--force-device-scale-factor=${launchOptions.forceDeviceScaleFactor}`]
							: []),
						"--skip-welcome",
						"--skip-release-notes",
						// User data comes from VSCODE_PORTABLE, which outranks --user-data-dir.
						...extensionLaunchArguments,
						workspacePath,
					],
				})
				await E2ETestHelper.waitUntil(() => app.windows().length > 0)
				return app
			})
		},
	})
	.extend<{ app: ElectronApplication }>({
		app: async ({ openVSCode, workspaceType, workspaceDir, multiRootWorkspaceDir }, use) => {
			const workspacePath = workspaceType === "single" ? workspaceDir : multiRootWorkspaceDir
			const app = await openVSCode(workspacePath)

			try {
				await use(app)
			} finally {
				await app.close()
			}
		},
	})
	.extend<{ helper: E2ETestHelper }>({
		helper: async ({}, use) => {
			const helper = new E2ETestHelper()
			await use(helper)
		},
	})
	.extend({
		page: async ({ app }, use, testInfo) => {
			const page = await app.firstWindow()
			try {
				await use(page)
			} finally {
				if (testInfo.status !== testInfo.expectedStatus && !page.isClosed()) {
					try {
						const screenshotPath = testInfo.outputPath("vscode-failure.png")
						await page.screenshot({ path: screenshotPath, fullPage: true, timeout: 5_000 })
						await testInfo.attach("vscode-failure.png", { path: screenshotPath, contentType: "image/png" })
					} catch (error) {
						await testInfo.attach("vscode-screenshot-capture-error.txt", {
							body: Buffer.from(error instanceof Error ? (error.stack ?? error.message) : String(error)),
							contentType: "text/plain",
						})
					}
				}
			}
		},
	})
	.extend<{ sidebar: Frame }>({
		sidebar: async ({ page, helper, server }, use) => {
			await E2ETestHelper.openClineSidebar(page)
			const sidebar = await helper.getSidebar(page)
			// Auto-dismiss "What's New" version announcement if present
			await E2ETestHelper.dismissWhatsNewModal(sidebar)
			await use(sidebar)
		},
	})

export const E2E_WORKSPACE_TYPES = [
	{ title: "Single Root", workspaceType: "single" },
	{ title: "Multi-Roots", workspaceType: "multi" },
] as const
