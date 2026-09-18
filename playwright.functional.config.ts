import { defineConfig } from "@playwright/test"
import baseConfig, { PRESSURE_E2E_TAG } from "./playwright.config"

export const FUNCTIONAL_E2E_MATCH = /(?:^|[\\/])functional[\\/].*\.test\.ts$/

export default defineConfig({
	...baseConfig,
	testMatch: FUNCTIONAL_E2E_MATCH,
	projects: [
		{
			name: "setup functional environment",
			testMatch: /global\.setup\.ts$/,
			teardown: "teardown functional environment",
		},
		{
			name: "functional e2e tests",
			testMatch: FUNCTIONAL_E2E_MATCH,
			grepInvert: PRESSURE_E2E_TAG,
			dependencies: ["setup functional environment"],
		},
		{
			name: "teardown functional environment",
			testMatch: /global\.teardown\.ts$/,
		},
	],
})
