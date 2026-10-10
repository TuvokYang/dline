import { defineConfig } from "@playwright/test"

const isCI = Boolean(process.env.CI)
const STORYBOOK_URL = "http://127.0.0.1:6006"

export default defineConfig({
    testDir: "tests/storybook",
    testMatch: /.*\.spec\.ts/,
    timeout: 90_000,
    expect: {
        timeout: 15_000,
    },
    fullyParallel: true,
    // Storybook uses one Vite compiler process; parallel cold compilation starves the preview root.
    workers: 1,
    retries: isCI ? 1 : 0,
    forbidOnly: isCI,
    reporter: [["list"]],
    use: {
        baseURL: STORYBOOK_URL,
        viewport: { width: 1280, height: 900 },
        screenshot: "only-on-failure",
        trace: "retain-on-failure",
    },
    webServer: {
        command: "npm --prefix webview-ui run storybook -- --ci --host 127.0.0.1 --no-open",
        url: `${STORYBOOK_URL}/index.json`,
        reuseExistingServer: !isCI,
        timeout: 120_000,
    },
})
