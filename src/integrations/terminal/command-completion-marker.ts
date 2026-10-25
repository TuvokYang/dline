export const INTERNAL_COMMAND_EXIT_MARKER_PREFIX = "__DLINE_INTERNAL_COMMAND_EXIT__"

const INTERNAL_COMMAND_EXIT_MARKER_PATTERN = /__DLINE_INTERNAL_COMMAND_EXIT__[A-Za-z0-9-]+:(-?\d+)/
/** Internal marker output or the shell command echo that produces it. */
const INTERNAL_COMMAND_EXIT_MARKER_LINE_PATTERN = /^.*__DLINE_INTERNAL_COMMAND_EXIT__[A-Za-z0-9-]+.*(?:\r?\n|$)/gm

export function parseInternalCommandExitMarker(line: string): number | undefined {
    const match = INTERNAL_COMMAND_EXIT_MARKER_PATTERN.exec(line.trim())
    if (!match) return undefined
    const exitCode = Number.parseInt(match[1], 10)
    return Number.isInteger(exitCode) ? exitCode : undefined
}

export function removeInternalCommandExitMarkers(output: string): string {
    return output.replace(INTERNAL_COMMAND_EXIT_MARKER_LINE_PATTERN, "")
}
