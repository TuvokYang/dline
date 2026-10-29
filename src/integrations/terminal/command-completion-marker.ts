export const INTERNAL_COMMAND_EXIT_MARKER_PREFIX = "__DLINE_INTERNAL_COMMAND_EXIT__"

const INTERNAL_COMMAND_EXIT_MARKER_PATTERN = /__DLINE_INTERNAL_COMMAND_EXIT__[A-Za-z0-9-]+:(-?\d+)/
/** Internal marker output or the shell command echo that produces it. */
const INTERNAL_COMMAND_EXIT_MARKER_LINE_PATTERN = /^.*__DLINE_INTERNAL_COMMAND_EXIT__[A-Za-z0-9-]+.*(?:\r?\n|$)/gm

export function parseInternalCommandExitMarker(line: string, expectedToken?: string): number | undefined {
    if (expectedToken) {
        const marker = `${INTERNAL_COMMAND_EXIT_MARKER_PREFIX}${expectedToken}:`
        let searchFrom = 0
        while (searchFrom < line.length) {
            const markerIndex = line.indexOf(marker, searchFrom)
            if (markerIndex === -1) return undefined
            const exitCodeMatch = /^-?\d+/.exec(line.slice(markerIndex + marker.length))
            if (exitCodeMatch) {
                const exitCode = Number.parseInt(exitCodeMatch[0], 10)
                return Number.isInteger(exitCode) ? exitCode : undefined
            }
            searchFrom = markerIndex + marker.length
        }
        return undefined
    }

    const match = INTERNAL_COMMAND_EXIT_MARKER_PATTERN.exec(line.trim())
    if (!match) return undefined
    const exitCode = Number.parseInt(match[1], 10)
    return Number.isInteger(exitCode) ? exitCode : undefined
}

export function containsInternalCommandExitMarker(value: string): boolean {
    return value.includes(INTERNAL_COMMAND_EXIT_MARKER_PREFIX)
}

export function removeInternalCommandExitMarkers(output: string): string {
    return output.replace(INTERNAL_COMMAND_EXIT_MARKER_LINE_PATTERN, "")
}
