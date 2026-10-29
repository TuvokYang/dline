/** Prepare the VS Code and Playwright binaries used by the E2E tests. */
import { readFile } from "node:fs/promises"
import { fileURLToPath } from "node:url"
import { downloadAndUnzipVSCode } from "@vscode/test-electron"
import { execa } from "execa"

const { stable: vscodeVersion, downloadTimeoutMs } = JSON.parse(
    await readFile(new URL("../vscode-version.json", import.meta.url), "utf8"),
)
const vscodeCachePath = fileURLToPath(new URL("../../../../.vscode-test/", import.meta.url))

async function installVSCode() {
    console.log(`Preparing pinned VS Code ${vscodeVersion} in ${vscodeCachePath}...`)
    await downloadAndUnzipVSCode({
        version: vscodeVersion,
        cachePath: vscodeCachePath,
        timeout: downloadTimeoutMs,
    })
    console.log(`VS Code ${vscodeVersion} is ready.`)
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
