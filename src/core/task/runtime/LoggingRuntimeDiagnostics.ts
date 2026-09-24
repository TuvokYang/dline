import type { RuntimeDiagnostic, RuntimeDiagnosticSeverity, RuntimeDiagnosticSink } from "./contracts"

/**
 * Reports a runtime diagnostic without depending on a concrete logger.
 *
 * The severity is passed through rather than resolved here, so the host decides
 * which channel each entry belongs on. Logging a normal observation as a
 * failure is not cosmetic: it makes a healthy run indistinguishable from a
 * broken one for anything that watches the error channel.
 */
export type RuntimeDiagnosticReporter = (message: string, severity: RuntimeDiagnosticSeverity) => void

function describe(taskId: string, entry: RuntimeDiagnostic): string {
	const parts = [
		`[TaskRuntime ${taskId}]`,
		`${entry.source}:${entry.code}`,
		entry.commandId ? `commandId=${entry.commandId}` : undefined,
		entry.revision === undefined ? undefined : `revision=${entry.revision}`,
		entry.message,
	]
	return parts.filter((part): part is string => part !== undefined).join(" ")
}

/**
 * Surface runtime failures that no caller is waiting on.
 *
 * Command dispatch, durable publication and commit all run behind the event
 * loop, so a failure there has no caller to reject: without a sink the outbox
 * and router record it into nothing. A task that silently stops replaying its
 * restored commands then looks identical to a task that had nothing to do,
 * which is exactly the state a recovery cannot be diagnosed from.
 */
export class LoggingRuntimeDiagnostics implements RuntimeDiagnosticSink {
	constructor(
		private readonly taskId: string,
		private readonly report: RuntimeDiagnosticReporter,
	) {}

	record(entry: RuntimeDiagnostic): void {
		this.report(describe(this.taskId, entry), entry.severity ?? "failure")
	}
}
