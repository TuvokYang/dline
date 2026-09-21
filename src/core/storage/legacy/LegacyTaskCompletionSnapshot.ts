interface LegacyTaskCompletionRecord {
	readonly phase?: unknown
	readonly completion?: unknown
	readonly completionId?: unknown
	readonly flow?: unknown
}

export interface LegacyTaskCompletionVerdict {
	readonly isCompleted: boolean
}

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
	return typeof value === "object" && value !== null && !Array.isArray(value)
}

/** Decode only the legacy completion fact required by task-history repair. */
export function decodeLegacyTaskCompletionSnapshot(input: unknown): LegacyTaskCompletionVerdict {
	if (!isRecord(input)) throw new Error("InvalidLegacyTaskSnapshot")
	const snapshot = input as LegacyTaskCompletionRecord
	if (isRecord(snapshot.flow)) {
		return {
			isCompleted: snapshot.flow.phase === "completed" && typeof snapshot.flow.completionId === "string",
		}
	}
	return {
		isCompleted:
			snapshot.phase === "completed" && (isRecord(snapshot.completion) || typeof snapshot.completionId === "string"),
	}
}
