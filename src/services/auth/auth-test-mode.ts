/** Whether the current process explicitly enables the E2E authentication mock. */
export function isE2EAuthMockEnabled(environment: NodeJS.ProcessEnv = process.env): boolean {
	return environment.E2E_TEST === "true"
}
