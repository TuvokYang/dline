import { cpSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import * as path from "node:path"
import type { TestInfo } from "@playwright/test"
import { downloadAndUnzipVSCode, SilentReporter } from "@vscode/test-electron"
import { _electron, type ElectronApplication, type Frame, type Page } from "playwright"
import type { ClineApiServerMock } from "../fixtures/server"
import { E2ETestHelper } from "./helpers"
import { createLaunchIsolation, createVSCodeExtensionLaunchArguments, portableEnvironment } from "./vscode-launch-isolation"
import { resolveVSCodeDownloadPlatform, resolveVSCodeDownloadVersion } from "./vscode-version-resolver"

export interface MultiInstanceSurface {
	readonly app: ElectronApplication
	readonly controlDirectory: string
	readonly helper: E2ETestHelper
	readonly label: string
	readonly page: Page
	readonly sidebar: Frame
	/** Real VS Code user data path of this instance; its `logs` directory holds the Dline output. */
	readonly userDataDir: string
	/** Portable root owning every persistent artifact of this instance. */
	readonly portableRoot: string
}

export interface MultiInstanceLauncherOptions {
	readonly dlineDir: string
	readonly dlineDocsDir: string
	/** Extension host storage shared by every instance of the current worker. */
	readonly extensionsDir: string
	readonly environment?: Readonly<Record<string, string>>
	readonly server: ClineApiServerMock
	readonly testInfo: TestInfo
	readonly workspaceDir: string
}

function createElectronEnvironment(): NodeJS.ProcessEnv {
	const environment = { ...process.env }
	delete environment.ELECTRON_RUN_AS_NODE
	for (const name of Object.keys(environment)) {
		if (/^(?:CONDA_|_CONDA_|_CE_)/i.test(name)) delete environment[name]
	}
	return {
		...environment,
		CONDA_AUTO_ACTIVATE_BASE: "false",
	}
}

function findDlineOutputLogs(directory: string): string[] {
	if (!existsSync(directory)) return []
	const result: string[] = []
	for (const entry of readdirSync(directory, { withFileTypes: true })) {
		const entryPath = path.join(directory, entry.name)
		if (entry.isDirectory()) result.push(...findDlineOutputLogs(entryPath))
		else if (/^\d+-Dline\.log$/i.test(entry.name)) result.push(entryPath)
	}
	return result
}

function readDlineOutputIfPresent(userDataDir: string): string | undefined {
	const outputPath = findDlineOutputLogs(path.join(userDataDir, "logs")).sort(
		(left, right) => statSync(right).mtimeMs - statSync(left).mtimeMs,
	)[0]
	return outputPath ? readFileSync(outputPath, "utf8") : undefined
}

async function attachFailureArtifacts(surface: MultiInstanceSurface, testInfo: TestInfo): Promise<void> {
	if (testInfo.status === testInfo.expectedStatus) return
	if (!surface.page.isClosed()) {
		const screenshotPath = testInfo.outputPath(`${surface.label}-vscode-failure.png`)
		await surface.page.screenshot({ path: screenshotPath, fullPage: true, timeout: 5_000 }).catch(() => undefined)
		if (existsSync(screenshotPath)) {
			await testInfo.attach(`${surface.label}-vscode-failure.png`, {
				path: screenshotPath,
				contentType: "image/png",
			})
		}
	}

	const output = readDlineOutputIfPresent(surface.userDataDir)
	await testInfo.attach(`${surface.label}-dline-output.log`, {
		body: Buffer.from(output ?? "Dline Output log was not created before the test stopped.", "utf8"),
		contentType: "text/plain",
	})
	const logsDir = path.join(surface.userDataDir, "logs")
	if (existsSync(logsDir)) {
		const artifactDir = testInfo.outputPath(`${surface.label}-vscode-logs`)
		cpSync(logsDir, artifactDir, { recursive: true })
		await testInfo.attach(`${surface.label}-vscode-logs`, {
			path: artifactDir,
			contentType: "application/zip",
		})
	}
}

export class MultiInstanceLauncher {
	private readonly options: MultiInstanceLauncherOptions
	private readonly surfaces: MultiInstanceSurface[] = []
	private executablePath?: string

	constructor(options: MultiInstanceLauncherOptions) {
		this.options = options
	}

	private async getExecutablePath(): Promise<string> {
		if (this.executablePath) return this.executablePath
		const vscodeCachePath = path.join(E2ETestHelper.CODEBASE_ROOT_DIR, ".vscode-test")
		const vscodePlatform = resolveVSCodeDownloadPlatform()
		const vscodeVersion = resolveVSCodeDownloadVersion("stable", vscodeCachePath, vscodePlatform)
		this.executablePath = await downloadAndUnzipVSCode({
			version: vscodeVersion,
			platform: vscodePlatform,
			cachePath: vscodeCachePath,
			reporter: new SilentReporter(),
		})
		return this.executablePath
	}

	async launch(label: string): Promise<MultiInstanceSurface> {
		const isolation = createLaunchIsolation(`dline-e2e-${label}-user-data-`)
		const { portableRoot, userDataDir } = isolation
		const controlDirectory = path.join(userDataDir, "task-history-control")
		const executablePath = await this.getExecutablePath()
		const app = await _electron.launch({
			executablePath,
			env: {
				...createElectronEnvironment(),
				...portableEnvironment(isolation),
				E2E_TEST: "true",
				// Match the single-instance launcher: perf and diagnostic mirrors
				// are debug-gated, and multi-window suites assert on them.
				DLINE_LOG_LEVEL: "debug",
				DLINE_ENVIRONMENT: "local",
				DLINE_DIR: this.options.dlineDir,
				DLINE_HOME_DIR: this.options.dlineDir,
				DLINE_E2E_API_BASE_URL: this.options.server.baseUrl,
				DLINE_SKIP_MIGRATION: "1",
				...this.options.environment,
				DLINE_DOCS_DIR: this.options.dlineDocsDir,
				DLINE_E2E_TASK_HISTORY_CONTROL_DIR: controlDirectory,
				GRPC_RECORDER_FILE_NAME: E2ETestHelper.generateTestFileName(
					`${this.options.testInfo.title}-${label}`,
					this.options.testInfo.project.name,
				),
				DEV_WORKSPACE_FOLDER: E2ETestHelper.CODEBASE_ROOT_DIR,
			},
			args: [
				"--no-sandbox",
				"--disable-updates",
				"--disable-workspace-trust",
				"--skip-welcome",
				"--skip-release-notes",
				// User data comes from VSCODE_PORTABLE, which outranks --user-data-dir.
				...createVSCodeExtensionLaunchArguments(this.options.extensionsDir, E2ETestHelper.CODEBASE_ROOT_DIR),
				this.options.workspaceDir,
			],
		})
		await E2ETestHelper.waitUntil(() => app.windows().length > 0, 30_000)
		const page = await app.firstWindow()
		const helper = new E2ETestHelper()
		await E2ETestHelper.openClineSidebar(page)
		const sidebar = await helper.getSidebar(page)
		await E2ETestHelper.dismissWhatsNewModal(sidebar)
		await helper.signin(sidebar)
		const surface = { app, controlDirectory, helper, label, page, portableRoot, sidebar, userDataDir }
		this.surfaces.push(surface)
		return surface
	}

	async close(surface: MultiInstanceSurface): Promise<void> {
		await surface.app.close().catch(() => undefined)
	}

	async dispose(): Promise<void> {
		for (const surface of [...this.surfaces].reverse()) {
			await attachFailureArtifacts(surface, this.options.testInfo).catch(() => undefined)
			await surface.app.close().catch(() => undefined)
			await E2ETestHelper.rmForRetries(surface.portableRoot, { recursive: true, force: true })
		}
		this.surfaces.length = 0
	}
}
