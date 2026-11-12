const SAMPLE_MESSAGE = /^console: (?:%c\s+ERR\s+color:\s*#[\da-f]+\s+)?PerfSampleError: PerfSampleError: by [\w.-]+ in [^\r\n]+$/i
const WORKBENCH_LOCATION =
    /^location: \{"url":"vscode-file:\/\/vscode-app\/[^"\r\n]+\/workbench\.desktop\.main\.js"(?:,[^\r\n]*)?\}$/

/** VS Code's profilingTelemetrySpec reports CPU samples as synthetic errors, not Webview exceptions. */
export function isWorkbenchSample(error: string): boolean {
    const lines = error.split(/\r?\n/)
    return lines.length === 2 && SAMPLE_MESSAGE.test(lines[0]) && WORKBENCH_LOCATION.test(lines[1])
}
