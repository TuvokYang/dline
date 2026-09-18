import { spawnSync } from "node:child_process"
import { existsSync, mkdirSync, mkdtempSync, readdirSync } from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { resolveCliPathFromVSCodeExecutablePath } from "@vscode/test-electron"
import { E2E_RUN_ID } from "./run-context"

/**
 * Filesystem locations that hold the machine state of a single test VS Code launch.
 *
 * Removing {@link portableRoot} removes every persistent side effect of that launch, so callers
 * clean up the root rather than the individual directories below it.
 */
export interface VSCodeLaunchIsolation {
	/** Value passed as `VSCODE_PORTABLE`; owns user data, `argv.json`, and shared data. */
	readonly portableRoot: string
	/** Real VS Code user data path. The Dline output channel log lives under its `logs` directory. */
	readonly userDataDir: string
}

export const E2E_EXTENSIONS_ROOT = path.join(os.tmpdir(), "dline-e2e-extensions", E2E_RUN_ID)
const DLINE_EXTENSION_DIRECTORY_PATTERN = /^tuvokyang\.dline-/i
export const E2E_VSIX_INSTALL_TIMEOUT_MS = 120_000
const INSTALL_DIAGNOSTIC_LIMIT = 4_000
const PACKAGED_E2E_LIFECYCLES = new Set(["test:e2e", "test:e2e:optimal", "test:e2e:pressure"])

export interface VSCodeExtensionInstallInvocation {
	readonly command: string
	readonly args: readonly string[]
	readonly environment?: NodeJS.ProcessEnv
	readonly timeoutMs: number
}

function trimInstallDiagnostic(value: string | null | undefined): string {
	const diagnostic = value?.trim() ?? ""
	return diagnostic.length <= INSTALL_DIAGNOSTIC_LIMIT ? diagnostic : diagnostic.slice(-INSTALL_DIAGNOSTIC_LIMIT)
}

function hasInstalledDlineVsix(extensionsDir: string): boolean {
	if (!existsSync(extensionsDir)) return false
	return readdirSync(extensionsDir, { withFileTypes: true }).some(
		(entry) => entry.isDirectory() && DLINE_EXTENSION_DIRECTORY_PATTERN.test(entry.name),
	)
}

/** Whether the current npm lifecycle builds the packaged VSIX before running Playwright. */
export function shouldPreinstallDlineVsix(environment: Pick<NodeJS.ProcessEnv, "npm_lifecycle_event"> = process.env): boolean {
	return PACKAGED_E2E_LIFECYCLES.has(environment.npm_lifecycle_event?.trim() ?? "")
}

/**
 * Select the extension directory slot for one Playwright worker.
 *
 * Full packaged runs reuse `parallelIndex` because Playwright preserves it when a failed worker is
 * replaced. Ordinary focused runs retain `workerIndex` so their on-demand directories stay unique.
 */
export function resolveWorkerExtensionsSlot(
	workerIndex: number,
	parallelIndex: number,
	environment: Pick<NodeJS.ProcessEnv, "npm_lifecycle_event"> = process.env,
): number {
	return shouldPreinstallDlineVsix(environment) ? parallelIndex : workerIndex
}

/**
 * Build launch arguments that select exactly one extension source.
 *
 * Packaged runs load the VSIX from the isolated extension directory. Source runs disable installed
 * extensions and load the checkout through `--extensionDevelopmentPath` instead.
 */
export function createVSCodeExtensionLaunchArguments(extensionsDir: string, extensionDevelopmentPath?: string): string[] {
	return [
		...(extensionDevelopmentPath ? ["--disable-extensions"] : []),
		`--extensions-dir=${extensionsDir}`,
		...(extensionDevelopmentPath ? [`--extensionDevelopmentPath=${extensionDevelopmentPath}`] : []),
	]
}

/** Build the isolated arguments shared by every VS Code CLI installation path. */
export function createVSCodeExtensionInstallArguments(extensionsDir: string, vsixPath: string): string[] {
	return [
		`--extensions-dir=${extensionsDir}`,
		`--user-data-dir=${path.join(extensionsDir, ".install-user-data")}`,
		"--force",
		"--install-extension",
		vsixPath,
	]
}

function resolveWindowsCliScriptPath(executablePath: string): string {
	const installDirectory = path.dirname(executablePath)
	const relativeCliPath = path.join("resources", "app", "out", "cli.js")
	const directCliPath = path.join(installDirectory, relativeCliPath)
	if (existsSync(directCliPath)) return directCliPath

	for (const entry of readdirSync(installDirectory, { withFileTypes: true })) {
		if (!entry.isDirectory() || !/^[0-9a-f]{10}$/i.test(entry.name)) continue
		const candidate = path.join(installDirectory, entry.name, relativeCliPath)
		if (existsSync(candidate)) return candidate
	}
	throw new Error(`Unable to locate the VS Code CLI script beside ${executablePath}`)
}

/**
 * Build the isolated VS Code CLI invocation used to install the packaged E2E extension.
 *
 * Installing before the GUI starts avoids the reload-required state produced when
 * `--install-extension` is passed to the same process that is expected to host the Webview.
 */
export function createVSCodeExtensionInstallInvocation(
	executablePath: string,
	extensionsDir: string,
	vsixPath: string,
): VSCodeExtensionInstallInvocation {
	const installArgs = createVSCodeExtensionInstallArguments(extensionsDir, vsixPath)
	if (process.platform === "win32") {
		return {
			command: executablePath,
			args: [resolveWindowsCliScriptPath(executablePath), ...installArgs],
			environment: { ...process.env, ELECTRON_RUN_AS_NODE: "1", VSCODE_DEV: "" },
			timeoutMs: E2E_VSIX_INSTALL_TIMEOUT_MS,
		}
	}
	return {
		command: resolveCliPathFromVSCodeExecutablePath(executablePath),
		args: installArgs,
		timeoutMs: E2E_VSIX_INSTALL_TIMEOUT_MS,
	}
}

/**
 * Install the packaged Dline VSIX into one worker-owned extension directory before launch.
 *
 * The operation is synchronous by design: each Playwright worker prepares its isolated
 * directory once, and multi-instance launches must not race while unpacking the same VSIX.
 */
export function ensureDlineVsixInstalled(executablePath: string, extensionsDir: string, vsixPath: string): void {
	if (hasInstalledDlineVsix(extensionsDir)) return

	const invocation = createVSCodeExtensionInstallInvocation(executablePath, extensionsDir, vsixPath)
	const result = spawnSync(invocation.command, [...invocation.args], {
		encoding: "utf8",
		env: invocation.environment,
		timeout: invocation.timeoutMs,
		windowsHide: true,
	})
	const diagnostic = [trimInstallDiagnostic(result.stderr), trimInstallDiagnostic(result.stdout)].filter(Boolean).join("\n")

	if (result.error) {
		throw new Error(`Failed to install the Dline E2E VSIX: ${diagnostic || result.error.message}`, {
			cause: result.error,
		})
	}
	if (result.status !== 0) {
		throw new Error(`Dline E2E VSIX installer exited with status ${result.status}: ${diagnostic || "no output"}`)
	}
	if (!hasInstalledDlineVsix(extensionsDir)) {
		throw new Error(`Dline E2E VSIX installer completed without creating an extension under ${extensionsDir}`)
	}
}

/**
 * Create the per-launch portable layout for one VS Code instance.
 *
 * Portable mode is what keeps a test launch out of machine-global state. On Windows and Linux VS
 * Code re-registers itself as the `vscode://` protocol handler on every startup unless it detects
 * portable mode, which would otherwise point the developer's protocol handler at the downloaded
 * test build. Detection requires the portable directory to already exist when the process starts,
 * so the layout is created eagerly here.
 *
 * The `tmp` subdirectory is deliberately not created: VS Code redirects `TMP`/`TEMP` to it when
 * present, which would move temporary files that tests and mocked tooling rely on.
 */
export function createLaunchIsolation(prefix: string): VSCodeLaunchIsolation {
	const portableRoot = mkdtempSync(path.join(os.tmpdir(), prefix))
	const userDataDir = path.join(portableRoot, "user-data")
	mkdirSync(userDataDir, { recursive: true })
	return { portableRoot, userDataDir }
}

/**
 * Create the extension host storage shared by every launch of one worker slot.
 *
 * The extension under test is installed once per slot and reused by later launches. Sharing at
 * slot scope keeps concurrent workers off a single directory, while allowing a replacement worker
 * in a packaged full run to reuse the preinstalled directory for its stable `parallelIndex`.
 */
export function createWorkerExtensionsDir(workerSlot: number): string {
	const extensionsDir = path.join(E2E_EXTENSIONS_ROOT, `worker-${workerSlot}`)
	mkdirSync(extensionsDir, { recursive: true })
	return extensionsDir
}

/** Environment entries that activate portable mode for one launch. */
export function portableEnvironment(isolation: VSCodeLaunchIsolation): Record<string, string> {
	return { VSCODE_PORTABLE: isolation.portableRoot }
}
