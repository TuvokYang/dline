import { defineConfig } from "@playwright/test"
import baseConfig from "./playwright.config"
import { DEMO_THEME_ENV, type DemoThemeOptions, resolveDemoTheme } from "./src/test/e2e/demo/utils/demo-theme"

export default defineConfig<DemoThemeOptions>({
    ...baseConfig,
    workers: 1,
    retries: 0,
    fullyParallel: false,
    timeout: 180_000,
    testMatch: /.*\.demo\.ts/,
    projects: [
        {
            name: "setup demo environment",
            testMatch: /global\.setup\.ts/,
        },
        {
            name: "demo recordings",
            testMatch: /.*\.demo\.ts/,
            dependencies: ["setup demo environment"],
            use: { demoTheme: resolveDemoTheme(process.env[DEMO_THEME_ENV]) },
        },
    ],
})
