const INVALID_PROMPT_OUTPUT = [
	{ reason: "missing prompt lookup", pattern: /\[MISSING:/ },
	{ reason: "legacy placeholder", pattern: /\{\{[A-Za-z_][^}]*\}\}/ },
	{ reason: "unresolved canonical token", pattern: /@[A-Z][A-Z0-9_]+@/ },
] as const

/** Reject invalid replacements before generated prompt content is compared or persisted. */
export function assertPromptContent(snapshotName: string, content: string): void {
	for (const { reason, pattern } of INVALID_PROMPT_OUTPUT) {
		if (pattern.test(content)) {
			throw new Error(`Refusing to use prompt snapshot with ${reason}: ${snapshotName}`)
		}
	}
}
