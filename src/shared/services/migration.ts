import fs from "fs/promises"
import os from "os"
import * as path from "path"
import { getDlineDocumentsPath, getDocumentsPath } from "@/core/storage/disk"
import { Logger } from "@/shared/services/Logger"
import { fileExistsAtPath, isDirectory } from "@/utils/fs"

/**
 * Result of a migration operation from Cline to Dline paths.
 */
export interface MigrationResult {
	migrated: boolean
	details: string[]
}

export interface ClineToDlineMigrationOptions {
	homeDir?: string
	documentsDir?: string
	dlineDocumentsDir?: string
	legacyVscodeGlobalStoragePaths?: string[]
}

interface MigrationStep {
	detail: string
	run: () => Promise<boolean>
}

const IGNORED_EMPTY_DIR_ENTRIES = new Set([".DS_Store", "Thumbs.db", "desktop.ini"])

/**
 * Documents entries that are deliberately not carried over from Cline.
 *
 * Task history is no longer portable. Dline indexes tasks in a SQLite database
 * and stores per-task runtime state - canonical turn and interaction identity,
 * snapshots, activities - that a Cline task directory simply does not contain.
 * Copying those directories produced entries that the current runtime cannot
 * open or resume, so the data is left where it is rather than imported into a
 * shape it no longer fits. Settings, rules, workflows, and MCP configuration
 * are still plain documents and continue to migrate.
 */
const NON_MIGRATABLE_DOCUMENT_ENTRIES = new Set(["tasks"])

async function directoryHasContent(dir: string): Promise<boolean> {
	if (!(await isDirectory(dir))) {
		return false
	}

	for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
		if (!IGNORED_EMPTY_DIR_ENTRIES.has(entry.name)) {
			return true
		}
	}

	return false
}

async function isEmptyDirectoryTarget(dir: string): Promise<boolean> {
	if (!(await fileExistsAtPath(dir))) {
		return true
	}

	if (!(await isDirectory(dir))) {
		return false
	}

	return !(await directoryHasContent(dir))
}

async function shouldCopyDirectory(src: string, dest: string): Promise<boolean> {
	return (await directoryHasContent(src)) && (await isEmptyDirectoryTarget(dest))
}

async function shouldCopyFile(src: string, dest: string): Promise<boolean> {
	return (await fileExistsAtPath(src)) && !(await fileExistsAtPath(dest))
}

async function copyDirIntoEmptyTarget(
	src: string,
	dest: string,
	skippedTopLevelEntries: ReadonlySet<string> = new Set(),
): Promise<void> {
	if (!(await isEmptyDirectoryTarget(dest))) {
		throw new Error(`Migration destination is not empty: ${dest}`)
	}

	await copyDirContents(src, dest, skippedTopLevelEntries)
}

async function copyDirContents(
	src: string,
	dest: string,
	skippedTopLevelEntries: ReadonlySet<string> = new Set(),
): Promise<void> {
	await fs.mkdir(dest, { recursive: true })

	for (const entry of await fs.readdir(src, { withFileTypes: true })) {
		if (IGNORED_EMPTY_DIR_ENTRIES.has(entry.name) || skippedTopLevelEntries.has(entry.name)) {
			continue
		}

		const sourcePath = path.join(src, entry.name)
		const destPath = path.join(dest, entry.name)

		if (entry.isDirectory()) {
			await copyDirContents(sourcePath, destPath)
			continue
		}

		if (await fileExistsAtPath(destPath)) {
			throw new Error(`Migration destination file already exists: ${destPath}`)
		}

		await fs.copyFile(sourcePath, destPath)
	}
}

async function copyFileIntoEmptyTarget(src: string, dest: string): Promise<void> {
	if (await fileExistsAtPath(dest)) {
		throw new Error(`Migration destination file already exists: ${dest}`)
	}

	await fs.mkdir(path.dirname(dest), { recursive: true })
	await fs.copyFile(src, dest)
}

function uniquePaths(paths: string[] | undefined): string[] {
	const seen = new Set<string>()
	const result: string[] = []

	for (const candidate of paths ?? []) {
		const normalized = path.normalize(candidate)
		const key = process.platform === "win32" ? normalized.toLowerCase() : normalized
		if (seen.has(key)) {
			continue
		}

		seen.add(key)
		result.push(normalized)
	}

	return result
}

async function getMigrationPaths(options: ClineToDlineMigrationOptions) {
	const homeDir = options.homeDir ?? os.homedir()
	const documentsDir = options.documentsDir ?? (await getDocumentsPath())
	const dlineDocumentsDir = options.dlineDocumentsDir ?? (await getDlineDocumentsPath())

	return {
		oldData: path.join(homeDir, ".cline", "data"),
		newData: path.join(homeDir, ".dline", "data"),
		oldEndpoints: path.join(homeDir, ".cline", "endpoints.json"),
		newEndpoints: path.join(homeDir, ".dline", "endpoints.json"),
		oldDocuments: path.join(documentsDir, "Cline"),
		newDocuments: dlineDocumentsDir,
		newCheckpointsDir: path.join(dlineDocumentsDir, "checkpoints"),
		newPuppeteerDir: path.join(homeDir, ".dline", "puppeteer"),
		newCacheDir: path.join(homeDir, ".dline", "cache"),
		oldMcpSettings: path.join(documentsDir, "Cline", "settings", "cline_mcp_settings.json"),
		newMcpSettings: path.join(dlineDocumentsDir, "settings", "mcp_settings.json"),
		legacyVscodeGlobalStoragePaths: uniquePaths(options.legacyVscodeGlobalStoragePaths),
	}
}

async function createCheckpointsMigrationStep(
	legacyVscodeGlobalStoragePaths: string[],
	newCheckpointsDir: string,
): Promise<MigrationStep | undefined> {
	if (!(await isEmptyDirectoryTarget(newCheckpointsDir))) {
		return undefined
	}

	for (const globalStoragePath of legacyVscodeGlobalStoragePaths) {
		const srcCheckpointsDir = path.join(globalStoragePath, "checkpoints")
		if (!(await directoryHasContent(srcCheckpointsDir))) {
			continue
		}

		return {
			detail: "legacy VSCode checkpoints -> Documents/dline/checkpoints/",
			run: async () => {
				if (!(await isEmptyDirectoryTarget(newCheckpointsDir))) {
					Logger.log(`[Migration] Skipped legacy VSCode checkpoints: destination is not empty: ${newCheckpointsDir}`)
					return false
				}
				await copyDirIntoEmptyTarget(srcCheckpointsDir, newCheckpointsDir)
				return true
			},
		}
	}

	return undefined
}

async function createPuppeteerMigrationStep(
	legacyVscodeGlobalStoragePaths: string[],
	newPuppeteerDir: string,
): Promise<MigrationStep | undefined> {
	if (!(await isEmptyDirectoryTarget(newPuppeteerDir))) {
		return undefined
	}

	for (const globalStoragePath of legacyVscodeGlobalStoragePaths) {
		const srcPuppeteerDir = path.join(globalStoragePath, "puppeteer")
		if (!(await directoryHasContent(srcPuppeteerDir))) {
			continue
		}

		return {
			detail: "legacy VSCode puppeteer -> ~/.dline/puppeteer/",
			run: async () => {
				if (!(await isEmptyDirectoryTarget(newPuppeteerDir))) {
					Logger.log(`[Migration] Skipped legacy VSCode puppeteer: destination is not empty: ${newPuppeteerDir}`)
					return false
				}
				await copyDirIntoEmptyTarget(srcPuppeteerDir, newPuppeteerDir)
				return true
			},
		}
	}

	return undefined
}

async function createCacheMigrationStep(
	legacyVscodeGlobalStoragePaths: string[],
	newCacheDir: string,
): Promise<MigrationStep | undefined> {
	for (const globalStoragePath of legacyVscodeGlobalStoragePaths) {
		const srcSyncQueue = path.join(globalStoragePath, "cache", "sync-queue.json")
		const destSyncQueue = path.join(newCacheDir, "sync-queue.json")

		if (!(await fileExistsAtPath(srcSyncQueue))) {
			continue
		}

		return {
			detail: "legacy VSCode sync-queue -> ~/.dline/cache/sync-queue.json",
			run: async () => {
				if (!(await shouldCopyFile(srcSyncQueue, destSyncQueue))) {
					Logger.log(`[Migration] Skipped legacy VSCode sync-queue: destination already exists or source missing`)
					return false
				}
				await copyFileIntoEmptyTarget(srcSyncQueue, destSyncQueue)
				return true
			},
		}
	}

	return undefined
}

async function buildMigrationPlan(options: ClineToDlineMigrationOptions = {}): Promise<MigrationStep[]> {
	if (process.env.DLINE_HOME_DIR || process.env.DLINE_DOCS_DIR) {
		return []
	}

	const paths = await getMigrationPaths(options)
	const steps: MigrationStep[] = []

	if (await shouldCopyDirectory(paths.oldData, paths.newData)) {
		steps.push({
			detail: "~/.cline/data/ -> ~/.dline/data/",
			run: async () => {
				if (!(await shouldCopyDirectory(paths.oldData, paths.newData))) {
					return false
				}
				await copyDirIntoEmptyTarget(paths.oldData, paths.newData)
				return true
			},
		})
	}

	if (await shouldCopyFile(paths.oldEndpoints, paths.newEndpoints)) {
		steps.push({
			detail: "~/.cline/endpoints.json -> ~/.dline/endpoints.json",
			run: async () => {
				if (!(await shouldCopyFile(paths.oldEndpoints, paths.newEndpoints))) {
					return false
				}
				await copyFileIntoEmptyTarget(paths.oldEndpoints, paths.newEndpoints)
				return true
			},
		})
	}

	if (await shouldCopyFile(paths.oldMcpSettings, paths.newMcpSettings)) {
		steps.push({
			detail: "Documents/Cline/settings/cline_mcp_settings.json -> Documents/Dline/settings/mcp_settings.json",
			run: async () => {
				if (!(await shouldCopyFile(paths.oldMcpSettings, paths.newMcpSettings))) {
					return false
				}
				await copyFileIntoEmptyTarget(paths.oldMcpSettings, paths.newMcpSettings)
				return true
			},
		})
	}

	if (await shouldCopyDirectory(paths.oldDocuments, paths.newDocuments)) {
		steps.push({
			detail: "Documents/Cline/ -> Documents/Dline/ (excluding task history)",
			run: async () => {
				if (!(await shouldCopyDirectory(paths.oldDocuments, paths.newDocuments))) {
					return false
				}
				await copyDirIntoEmptyTarget(paths.oldDocuments, paths.newDocuments, NON_MIGRATABLE_DOCUMENT_ENTRIES)
				return true
			},
		})
	}

	const checkpointsStep = await createCheckpointsMigrationStep(paths.legacyVscodeGlobalStoragePaths, paths.newCheckpointsDir)
	if (checkpointsStep) {
		steps.push(checkpointsStep)
	}

	const puppeteerStep = await createPuppeteerMigrationStep(paths.legacyVscodeGlobalStoragePaths, paths.newPuppeteerDir)
	if (puppeteerStep) {
		steps.push(puppeteerStep)
	}

	const cacheStep = await createCacheMigrationStep(paths.legacyVscodeGlobalStoragePaths, paths.newCacheDir)
	if (cacheStep) {
		steps.push(cacheStep)
	}

	return steps
}

export async function hasClineToDlineMigrationCandidates(options: ClineToDlineMigrationOptions = {}): Promise<boolean> {
	return (await buildMigrationPlan(options)).length > 0
}

/**
 * Migrate data from legacy Cline paths to Dline paths.
 *
 * The migration is intentionally conservative: each target location must be
 * missing or empty before data is copied. Existing Dline data is never merged
 * with legacy Cline data and is never overwritten.
 */
export async function migrateFromClineToDline(options: ClineToDlineMigrationOptions = {}): Promise<MigrationResult> {
	if (process.env.DLINE_HOME_DIR || process.env.DLINE_DOCS_DIR) {
		Logger.log("[Migration] Skipped: custom Dline paths configured via environment variables")
		return { migrated: false, details: [] }
	}

	const details: string[] = []
	let migrated = false
	const steps = await buildMigrationPlan(options)

	for (const step of steps) {
		try {
			Logger.log(`[Migration] Copying ${step.detail} ...`)
			if (await step.run()) {
				details.push(step.detail)
				migrated = true
				Logger.log(`[Migration] Completed: ${step.detail}`)
			}
		} catch (error) {
			Logger.error(`[Migration] Failed: ${step.detail}`, error)
			details.push(`${step.detail} failed: ${error}`)
		}
	}

	Logger.log("[Migration] Result:", { migrated, details })
	return { migrated, details }
}
