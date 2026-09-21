import { resolveTaskTempLogPath, TaskTempSection } from "@core/storage/task-temp"
import { DlineRuntimeFileManager } from "@services/runtime-files"
import { Logger } from "@/shared/services/Logger"

/**
 * Owned log files for command execution.
 *
 * A command that belongs to a task writes into that task's temp storage, so the
 * file is removed with the task and stays inside the task read scope. Execution
 * without a task identity (standalone callers and tests) keeps the historical
 * process-level temp directory, which is also where pre-migration logs remain
 * readable.
 */

function resolveLogPath(taskId: string | undefined, section: TaskTempSection, stableStem: string): string {
	if (taskId) {
		try {
			return resolveTaskTempLogPath(taskId, section, stableStem)
		} catch (error) {
			// Losing the task-owned directory must not fail the command itself.
			Logger.warn(`[CommandLog] Falling back to process temp storage for ${stableStem}:`, error)
		}
	}
	return DlineRuntimeFileManager.createTempFilePath(stableStem)
}

/** Resolve the file that retains one command activity's complete output. */
export function resolveCommandLogPath(taskId: string | undefined, stableStem: string): string {
	return resolveLogPath(taskId, TaskTempSection.CommandLogs, stableStem)
}

/** Resolve the file that collects one command's shell environment failures. */
export function resolveShellDiagnosticsPath(taskId: string | undefined, stableStem: string): string {
	return resolveLogPath(taskId, TaskTempSection.ShellDiagnostics, stableStem)
}
