import * as fs from "node:fs"
import * as fsPromises from "node:fs/promises"
import * as path from "node:path"
import { getDlineDocumentsPathSync } from "./documents-path"

/**
 * Task-owned temporary storage.
 *
 * Every ephemeral file that belongs to one task lives under
 * `<documents-root>/tasks/<taskId>/tmp/<section>/`. Placing them there ties their
 * lifetime to the task: deleting the task removes them, and the task read scope
 * (`isTaskReadScopePath`) already authorizes the agent to read its own files.
 *
 * This module is the single source of truth for that layout. Callers must not
 * rebuild the `tmp` path themselves.
 */

/** Directory name of the task-owned temporary root. */
export const TASK_TEMP_DIRECTORY_NAME = "tmp"

/** Sections of the task-owned temporary root, each with one owner. */
export const TaskTempSection = {
	/** Complete command output retained for one command activity. */
	CommandLogs: "command-logs",
	/** Shell startup/pre/post command failure diagnostics, consumed then deleted. */
	ShellDiagnostics: "shell-diagnostics",
	/** Provider partial image previews. */
	ImagePreviews: "image-previews",
	/** Images materialized for the editor image viewer. */
	ImageViewer: "image-viewer",
} as const

export type TaskTempSection = (typeof TaskTempSection)[keyof typeof TaskTempSection]

/**
 * Retention policy for one task's command logs.
 *
 * Command logs are the only task temp section that must survive across sessions,
 * because chat rows and Activities keep a clickable path to them. They are
 * therefore bounded by total size instead of cleared or expired: a log stays
 * reachable from its chat row for as long as the task's budget allows, however
 * old the task is.
 */
export interface TaskCommandLogRetentionPolicy {
	readonly maxTotalBytes: number
}

export const DEFAULT_COMMAND_LOG_RETENTION: TaskCommandLogRetentionPolicy = {
	maxTotalBytes: 200 * 1024 * 1024,
}

export interface TaskTempPruneResult {
	readonly deletedCount: number
	readonly freedBytes: number
}

const FILE_STEM_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]*$/

interface TempFileInfo {
	readonly path: string
	readonly size: number
	readonly mtime: number
}

function assertTaskId(taskId: string): void {
	if (!TASK_ID_PATTERN.test(taskId)) {
		throw new Error(`Invalid task identity for task temp storage: ${taskId}`)
	}
}

/** Absolute path of the task-owned temporary root. */
export function getTaskTempDirectory(taskId: string): string {
	assertTaskId(taskId)
	return path.join(getDlineDocumentsPathSync(), "tasks", taskId, TASK_TEMP_DIRECTORY_NAME)
}

/** Absolute path of one section inside the task-owned temporary root. */
export function getTaskTempSectionDirectory(taskId: string, section: TaskTempSection): string {
	return path.join(getTaskTempDirectory(taskId), section)
}

/**
 * Absolute path of one temp section for a task directory that the caller already resolved.
 *
 * Used by owners that receive the task directory instead of the task identity.
 */
export function getTaskTempSectionDirectoryFor(taskDirectory: string, section: TaskTempSection): string {
	if (!path.isAbsolute(taskDirectory)) {
		throw new Error(`Task temp storage requires an absolute task directory: ${taskDirectory}`)
	}
	return path.join(path.resolve(taskDirectory), TASK_TEMP_DIRECTORY_NAME, section)
}

/**
 * Create one task temp section synchronously.
 *
 * The command log writers open their file with `fs.openSync` immediately after
 * resolving the path, so the directory cannot be created asynchronously.
 */
export function ensureTaskTempSectionSync(taskId: string, section: TaskTempSection): string {
	const directory = getTaskTempSectionDirectory(taskId, section)
	try {
		fs.mkdirSync(directory, { recursive: true })
	} catch (error) {
		throw new Error(`Failed to create task temp directory: ${directory}`, { cause: error })
	}
	return directory
}

/**
 * Resolve a deterministic `.log` path from a stable domain identity.
 *
 * The caller owns uniqueness; this module never replaces the supplied identity.
 * The section directory exists when this returns.
 */
export function resolveTaskTempLogPath(taskId: string, section: TaskTempSection, stableStem: string): string {
	if (!FILE_STEM_PATTERN.test(stableStem)) {
		throw new Error(`Invalid task temp file stem: ${stableStem}`)
	}

	const directory = ensureTaskTempSectionSync(taskId, section)
	const filePath = path.join(directory, `${stableStem}.log`)
	if (path.dirname(path.resolve(filePath)) !== path.resolve(directory)) {
		throw new Error(`Task temp file escapes its section: ${stableStem}`)
	}
	return filePath
}

/** Return whether an absolute path belongs to the task-owned temporary root. */
export function isTaskTempPath(taskId: string, absolutePath: string): boolean {
	if (!path.isAbsolute(absolutePath)) return false
	const relativePath = path.relative(getTaskTempDirectory(taskId), path.resolve(absolutePath))
	return (
		relativePath === "" ||
		(!relativePath.startsWith(`..${path.sep}`) && relativePath !== ".." && !path.isAbsolute(relativePath))
	)
}

/**
 * Bound one task's command logs to the retained size budget.
 *
 * Age alone never deletes a log, because an old chat row keeps a clickable path
 * to it. Only exceeding the budget does, and then the oldest logs go first.
 *
 * Runs while the task holds its lock and before this session writes new logs, so
 * an actively written file is never the prune target. Cleanup is best effort: a
 * file another process still owns is skipped rather than failing the caller.
 */
export async function pruneTaskCommandLogs(
	taskId: string,
	policy: TaskCommandLogRetentionPolicy = DEFAULT_COMMAND_LOG_RETENTION,
): Promise<TaskTempPruneResult> {
	const directory = getTaskTempSectionDirectory(taskId, TaskTempSection.CommandLogs)
	const files = await readDirectoryEntries(directory)
	if (files.length === 0) {
		return { deletedCount: 0, freedBytes: 0 }
	}

	const fileInfos = await readFileInfos(directory, files)
	let totalSize = fileInfos.reduce((sum, file) => sum + file.size, 0)
	if (totalSize <= policy.maxTotalBytes) {
		return { deletedCount: 0, freedBytes: 0 }
	}

	let deletedCount = 0
	let freedBytes = 0
	const oldestFirst = [...fileInfos].sort((left, right) => left.mtime - right.mtime)
	for (const fileInfo of oldestFirst) {
		if (totalSize <= policy.maxTotalBytes) break
		if (await tryDelete(fileInfo.path)) {
			totalSize -= fileInfo.size
			deletedCount++
			freedBytes += fileInfo.size
		}
	}

	return { deletedCount, freedBytes }
}

async function readDirectoryEntries(directory: string): Promise<string[]> {
	try {
		return await fsPromises.readdir(directory)
	} catch (error) {
		if ((error as NodeJS.ErrnoException).code === "ENOENT") {
			return []
		}
		throw error
	}
}

async function readFileInfos(directory: string, files: readonly string[]): Promise<TempFileInfo[]> {
	const fileInfos: TempFileInfo[] = []
	for (const file of files) {
		const filePath = path.join(directory, file)
		try {
			const stats = await fsPromises.stat(filePath)
			if (stats.isFile()) {
				fileInfos.push({ path: filePath, size: stats.size, mtime: stats.mtimeMs })
			}
		} catch {
			// Another window may have removed the file after enumeration.
		}
	}
	return fileInfos
}

async function tryDelete(filePath: string): Promise<boolean> {
	try {
		await fsPromises.unlink(filePath)
		return true
	} catch {
		return false
	}
}
