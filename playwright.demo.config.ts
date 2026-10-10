import { defineConfig } from "@playwright/test"
import baseConfig from "./playwright.config"

export default defineConfig({
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
        },
    ],
})
