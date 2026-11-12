import { describe, expect, it } from "vitest"
import { isWorkbenchSample } from "../test/e2e/utils/console-diagnostics"

const WORKBENCH_URL = "vscode-file://vscode-app/test/resources/app/out/vs/workbench/workbench.desktop.main.js"
const SAMPLE_TEXT = "PerfSampleError: PerfSampleError: by tuvokyangdline.dline-main in (anonymous)#extension.js:3:348"

function consoleError(text: string, url = WORKBENCH_URL): string {
    return `console: %c  ERR color: #f33 ${text}\nlocation: ${JSON.stringify({ url, lineNumber: 441, columnNumber: 1542 })}`
}

describe("workbench performance sample classification", () => {
    it.each([
        consoleError(SAMPLE_TEXT),
        consoleError(SAMPLE_TEXT.replace("tuvokyangdline.dline-main", "tuvokyang.dline")),
        consoleError(SAMPLE_TEXT, WORKBENCH_URL.replace("/test/", "/c%3A/vscode/")),
        consoleError(SAMPLE_TEXT).replace("%c  ERR color: #f33 ", ""),
        consoleError(SAMPLE_TEXT).replace("\n", "\r\n"),
    ])("recognizes the host's synthetic sample without relying on extension identity: %s", (error) => {
        expect(isWorkbenchSample(error)).toBe(true)
    })

    it.each([
        consoleError("TypeError: Cannot read properties of undefined"),
        consoleError("Unary RPC updateState failed: HTTP 500"),
        consoleError(`Error: ${SAMPLE_TEXT}`),
        consoleError(SAMPLE_TEXT).replace(/^console:/, "pageerror:"),
        consoleError(SAMPLE_TEXT, "vscode-webview://task/assets/index.js"),
        consoleError(SAMPLE_TEXT, "file:///extensions/dline/dist/extension.js"),
        consoleError(SAMPLE_TEXT, "https://example.test/workbench.desktop.main.js"),
        consoleError(SAMPLE_TEXT, ""),
        `${consoleError(SAMPLE_TEXT)}\n    at renderTask (index.js:1:2)`,
        `console: ${SAMPLE_TEXT}`,
        consoleError(SAMPLE_TEXT).replace(/\}$/, ""),
    ])("keeps genuine, unattributed, and malformed errors visible: %s", (error) => {
        expect(isWorkbenchSample(error)).toBe(false)
    })
})
