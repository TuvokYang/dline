import { defineConfig } from "@playwright/test"
import { E2E_OUTPUT_ROOT } from "./src/test/e2e/utils/run-context"

const isCI = !!process?.env?.CI
const isWindow = process?.platform?.startsWith("win")
const configuredWorkers = process.env.DLINE_E2E_WORKERS?.trim()
export const PRESSURE_E2E_TAG = /@pressure/
export const REQUIRED_E2E_MATCH = /^(?!.*[\\/]dev[\\/]).*\.test\.ts$/

if (configuredWorkers && !/^[1-9]\d*$/.test(configuredWorkers)) {
	throw new Error(`Invalid DLINE_E2E_WORKERS: ${configuredWorkers}`)
}

export default defineConfig({
	workers: configuredWorkers ? Number(configuredWorkers) : 2,
	retries: 1,
	forbidOnly: isCI,
	testDir: "src/test/e2e",
	testMatch: REQUIRED_E2E_MATCH,
	timeout: isCI || isWindow ? 60000 : 20000,
	expect: {
		timeout: isCI || isWindow ? 5000 : 2000,
	},
	fullyParallel: true,
	outputDir: E2E_OUTPUT_ROOT,
	reporter: isCI ? [["github"], ["list"]] : [["list"]],
	use: {
		screenshot: "only-on-failure",
		video: "off",
	},
	projects: [
		{
			name: "setup test environment",
			testMatch: /global\.setup\.ts/,
			teardown: "teardown test environment",
		},
		{
			name: "e2e tests",
			grepInvert: PRESSURE_E2E_TAG,
			dependencies: ["setup test environment"],
		},
		{
			name: "teardown test environment",
			testMatch: /global\.teardown\.ts/,
		},
	],
})
