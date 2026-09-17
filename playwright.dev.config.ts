import { defineConfig } from "@playwright/test"
import baseConfig from "./playwright.config"

const DEV_E2E_MATCH = /(?:^|[\\/])dev[\\/].*\.test\.ts$/

export default defineConfig({
	...baseConfig,
	workers: 1,
	retries: 0,
	fullyParallel: false,
	testMatch: DEV_E2E_MATCH,
	timeout: 15 * 60_000,
	use: {
		...baseConfig.use,
		trace: "retain-on-failure",
	},
	projects: [
		{
			name: "setup dev environment",
			testMatch: /global\.setup\.ts$/,
			teardown: "teardown dev environment",
		},
		{
			name: "development e2e tests",
			testMatch: DEV_E2E_MATCH,
			dependencies: ["setup dev environment"],
		},
		{
			name: "teardown dev environment",
			testMatch: /global\.teardown\.ts$/,
		},
	],
})
