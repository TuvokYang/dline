import { isCommandLogNoticeLine } from "@shared/command-log-notice"

const ANSI_SEQUENCE_PATTERN =
    /(?:(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~])|(?:(?:\u001B\]|\u009D)[^\u0007\u009C]*(?:\u0007|\u001B\\|\u009C))/g
const TERMINAL_TITLE_PATTERN = /(?:\u001B\]|\u009D)0;[^\u0007\u009C]*(?:\u0007|\u001B\\|\u009C)/
const RESULT_METADATA_PATTERN = /^Full output saved to:\s*/

/** Return whether one visible line only carries log-file metadata instead of command output. */
function isOutputMetadataLine(line: string): boolean {
    return isCommandLogNoticeLine(line) || RESULT_METADATA_PATTERN.test(line)
}

function parseShellPromptArtifact(line: string): { environmentLabel?: string } | undefined {
    if (!TERMINAL_TITLE_PATTERN.test(line)) return undefined
    const visible = line.replace(ANSI_SEQUENCE_PATTERN, "").trim()
    if (visible.length === 0) return {}
    const environment = visible.match(/^\(([^()\r\n]+)\)$/)?.[1]?.trim()
    return environment ? { environmentLabel: environment } : undefined
}

/** Make non-printing terminal controls visible without changing Unicode text or ANSI sequences. */
export function sanitizeCommandOutput(output: string): string {
    return output.replace(/\x09/g, "→   ").replace(/\x08/g, "⌫").replace(/\x0c/g, "⏏").replace(/\x0b/g, "⇳")
}

/** Return the environment modifier attached to a terminal-title prompt artifact. */
export function getCommandEnvironmentLabel(output: string | undefined): string | undefined {
    if (!output) return undefined
    let environmentLabel: string | undefined
    for (const line of output.replace(/\r\n/g, "\n").split("\n")) {
        environmentLabel = parseShellPromptArtifact(line)?.environmentLabel ?? environmentLabel
    }
    return environmentLabel
}

/** Remove terminal-title prompt artifacts without treating ordinary parenthesized output as an environment. */
export function stripCommandPromptArtifacts(output: string): string {
    return output
        .replace(/\r\n/g, "\n")
        .split("\n")
        .filter((line) => parseShellPromptArtifact(line) === undefined)
        .join("\n")
}

/** Return the final visible terminal line for compact command and Activity previews. */
export function getCommandOutputSummary(output: string | undefined): string | undefined {
    if (!output) return undefined
    const visibleOutput = sanitizeCommandOutput(stripCommandPromptArtifacts(output).replace(ANSI_SEQUENCE_PATTERN, ""))
    const lines = visibleOutput.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n")
    for (let index = lines.length - 1; index >= 0; index--) {
        const line = lines[index].trim()
        if (line.length > 0 && !isOutputMetadataLine(line)) return line
    }
    return undefined
}
