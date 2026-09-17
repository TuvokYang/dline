import { defineConfig } from "@playwright/test"
import baseConfig, { PRESSURE_E2E_TAG } from "./playwright.config"
import {
	exactWorkTestMatch,
	WORK_SMOKE_FILE,
	WORK_SMOKE_TIMEOUT_MS,
	WORKFLOW_E2E_CASES,
	WORKFLOW_TIMEOUT_MS,
} from "./src/test/e2e/work/manifest"

const isCI = Boolean(process.env.CI)

export default defineConfig({
	...baseConfig,
	workers: 4,
	retries: 0,
	fullyParallel: false,
	timeout: WORKFLOW_TIMEOUT_MS,
	globalTimeout: isCI ? 20 * 60_000 : undefined,
	failOnFlakyTests: isCI,
	projects: [
		{
			name: "setup work environment",
			testMatch: /global\.setup\.ts$/,
			retries: 0,
			teardown: "teardown work environment",
		},
		{
			name: "work smoke",
			testMatch: exactWorkTestMatch(WORK_SMOKE_FILE),
			timeout: WORK_SMOKE_TIMEOUT_MS,
			retries: 0,
			dependencies: ["setup work environment"],
		},
		...WORKFLOW_E2E_CASES.map(({ projectName, fileName }) => ({
			name: projectName,
			testMatch: exactWorkTestMatch(fileName),
			timeout: WORKFLOW_TIMEOUT_MS,
			retries: isCI ? 1 : 0,
			grepInvert: PRESSURE_E2E_TAG,
			dependencies: ["work smoke"],
		})),
		{
			name: "teardown work environment",
			testMatch: /global\.teardown\.ts$/,
			retries: 0,
		},
	],
})
