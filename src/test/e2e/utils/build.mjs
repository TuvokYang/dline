/** Prepare the VS Code and Playwright binaries used by the E2E tests. */
import { downloadAndUnzipVSCode, SilentReporter } from "@vscode/test-electron"
import { execa } from "execa"

async function installVSCode() {
    console.log("Downloading VS Code...")
    await downloadAndUnzipVSCode("stable", undefined, new SilentReporter())
    console.log("VS Code is ready.")
}

async function installPlaywright() {
    console.log("Installing Playwright Chromium and media tools...")
    await execa("npm", ["exec", "playwright", "install", "chromium"], { stdio: "inherit" })
    console.log("Playwright is ready.")
}

async function main() {
    await Promise.all([installVSCode(), installPlaywright()])
}

main().catch((error) => {
    console.error("Failed to prepare VS Code for E2E tests", error)
    process.exitCode = 1
})
