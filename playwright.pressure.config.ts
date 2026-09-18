import { defineConfig } from "@playwright/test"
import { PRESSURE_E2E_TAG } from "./playwright.config"
import functionalConfig from "./playwright.functional.config"

export default defineConfig({
	...functionalConfig,
	workers: 1,
	retries: 0,
	fullyParallel: false,
	projects: [
		{
			name: "setup pressure test environment",
			testMatch: /global\.setup\.ts/,
			teardown: "teardown pressure test environment",
		},
		{
			name: "pressure e2e tests",
			grep: PRESSURE_E2E_TAG,
			dependencies: ["setup pressure test environment"],
		},
		{
			name: "teardown pressure test environment",
			testMatch: /global\.teardown\.ts/,
		},
	],
})
