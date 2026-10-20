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

/**
 * Bound for a single UI action. Waits for product state go through `expect`
 * with their own timeouts; an action that cannot complete in this window is
 * stalled, and failing it here names the step instead of the test timeout.
 */
const WORK_ACTION_TIMEOUT_MS = 15_000

export default defineConfig({
    ...baseConfig,
    use: {
        ...baseConfig.use,
        actionTimeout: WORK_ACTION_TIMEOUT_MS,
        trace: "retain-on-failure",
    },
    workers: 1,
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
            retries: 0,
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
