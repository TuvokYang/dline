import { execa } from "@packages/execa"
import os from "os"
import * as path from "path"
import { Logger } from "@/shared/services/Logger"

/**
 * Dline storage roots.
 *
 * This module is a leaf on purpose. Low-level owners such as task temporary
 * storage need the resolved roots without pulling in the rest of `disk.ts`,
 * whose transitive imports reach the host provider and the Webview layer and
 * would close an import cycle through the terminal and editor integrations.
 */

let cachedDocumentsPath: string | undefined
let cachedDlineDocumentsPath: string | undefined

export async function getDocumentsPath(): Promise<string> {
	if (cachedDocumentsPath) return cachedDocumentsPath

	if (process.platform === "win32") {
		try {
			const { stdout: docsPath } = await execa("powershell", [
				"-NoProfile",
				"-Command",
				"[System.Environment]::GetFolderPath([System.Environment+SpecialFolder]::MyDocuments)",
			])
			if (docsPath.trim()) {
				cachedDocumentsPath = docsPath.trim()
				return cachedDocumentsPath
			}
		} catch {
			Logger.error("Failed to retrieve Windows Documents path.")
		}
	} else if (process.platform === "linux") {
		try {
			await execa("which", ["xdg-user-dir"])
			const { stdout } = await execa("xdg-user-dir", ["DOCUMENTS"])
			if (stdout.trim()) {
				cachedDocumentsPath = stdout.trim()
				return cachedDocumentsPath
			}
		} catch {
			Logger.error("Failed to retrieve XDG Documents path.")
		}
	}

	cachedDocumentsPath = path.join(os.homedir(), "Documents")
	return cachedDocumentsPath
}

export function getDlineHomePath(): string {
	if (process.env.DLINE_HOME_DIR) return process.env.DLINE_HOME_DIR
	return path.join(os.homedir(), ".dline")
}

/**
 * Get the Dline data directory path.
 * Used by StateManager for secrets/state storage and api_profiles.
 *
 * Priority: DLINE_DIR (secrets/test override) → ~/.dline
 * Note: DLINE_DIR is separate from DLINE_HOME_DIR — the former is for
 * secrets/sensitive data that may be redirected during testing, while the
 * latter is for the main .dline directory (providers, rules, etc.).
 */
export function getDlineDataDir(): string {
	const dlineDir = process.env.DLINE_DIR || path.join(os.homedir(), ".dline")
	return path.join(dlineDir, "data")
}

export function getDlineDocumentsPathSync(): string {
	if (process.env.DLINE_DOCS_DIR) return process.env.DLINE_DOCS_DIR
	if (cachedDocumentsPath) return path.join(cachedDocumentsPath, "dline")
	return path.join(os.homedir(), "Documents", "dline")
}

/**
 * Prime the Documents path cache at startup so synchronous consumers
 * (getDlineDocumentsPathSync) use the correct system Documents directory.
 * Call once during extension initialization, before any filesystem operations.
 */
export async function warmupDocumentsPathCache(): Promise<void> {
	await getDocumentsPath()
}

export async function getDlineDocumentsPath(): Promise<string> {
	if (process.env.DLINE_DOCS_DIR) return process.env.DLINE_DOCS_DIR
	if (cachedDlineDocumentsPath) return cachedDlineDocumentsPath
	cachedDlineDocumentsPath = path.join(await getDocumentsPath(), "dline")
	return cachedDlineDocumentsPath
}
