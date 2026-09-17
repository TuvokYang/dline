export const WORK_SMOKE_FILE = "smoke.test.ts"

export const WORKFLOW_E2E_CASES = [
	{ projectName: "work chat tools", fileName: "daily-chat-tools.test.ts" },
	{ projectName: "work background subagents", fileName: "daily-background-subagents.test.ts" },
	{ projectName: "work context recovery", fileName: "daily-context-recovery.test.ts" },
	{ projectName: "work profiles policies", fileName: "daily-profiles-policies.test.ts" },
] as const

export const WORK_SMOKE_TIMEOUT_MS = 60_000
export const WORKFLOW_TIMEOUT_MS = 10 * 60_000

function escapeRegExp(value: string): string {
	return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

export function exactWorkTestMatch(fileName: string): RegExp {
	return new RegExp(`(?:^|[\\\\/])work[\\\\/]${escapeRegExp(fileName)}$`)
}
