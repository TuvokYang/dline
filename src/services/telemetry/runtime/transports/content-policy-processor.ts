import type { Context } from "@opentelemetry/api"
import type { LogRecord, LogRecordProcessor } from "@opentelemetry/sdk-logs"
import { RuntimeContentPolicy } from "../content-policy"

/**
 * Applies the runtime content policy before records reach an exporter.
 *
 * The SDK has no opinion about what an attribute may contain, but this project
 * does: command lines, prompts and file contents must never leave the host.
 * Implementing the gate as a `LogRecordProcessor` keeps that rule inside the
 * standard pipeline instead of a private transport, which is what allows the
 * export path to be swapped for an official exporter without weakening the
 * privacy contract.
 *
 * Registration order matters. This processor has to run before the batching
 * processor, because once a record is queued for export it is too late to
 * redact it.
 */
export class ContentPolicyProcessor implements LogRecordProcessor {
	constructor(private readonly policy: RuntimeContentPolicy = RuntimeContentPolicy.forEvents()) {}

	/**
	 * Rewrites the record's attributes in place.
	 *
	 * The SDK gives no way to replace the attribute bag wholesale, so rejected
	 * keys are deleted and retained ones written back. Deleting rather than
	 * masking is deliberate: a truncated command line is still a command line.
	 */
	onEmit(logRecord: LogRecord, _context?: Context): void {
		const { attributes } = logRecord
		const result = this.policy.apply(attributes as Record<string, unknown>)

		for (const key of Object.keys(attributes)) {
			delete attributes[key]
		}
		Object.assign(attributes, result.attributes)
	}

	async forceFlush(): Promise<void> {
		// Nothing is buffered here; redaction is synchronous.
	}

	async shutdown(): Promise<void> {
		// Cardinality tracking is per-session and must not leak into the next one.
		this.policy.reset()
	}
}
