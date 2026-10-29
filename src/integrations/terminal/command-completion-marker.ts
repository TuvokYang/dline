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

export interface MarkedCommandCompletion {
    exitCode: number
    /** Lines printed between the echoed wrapper and the marker; undefined when the echo is not captured. */
    output: string | undefined
}

/**
 * Find one command's completion in a captured terminal buffer.
 *
 * Only the exact token counts, so markers of earlier commands in the scrollback never match.
 * The echoed wrapper carries the token followed by a format placeholder rather than a number,
 * which both keeps it from matching and marks where this command's output starts. When the echo
 * is not in the buffer the output is left undefined instead of returning unrelated scrollback.
 */
export function findMarkedCommandCompletion(buffer: string, token: string): MarkedCommandCompletion | undefined {
    const lines = buffer.split(/\r?\n/)
    let markerIndex = -1
    let exitCode: number | undefined
    for (let index = lines.length - 1; index >= 0; index--) {
        exitCode = parseInternalCommandExitMarker(lines[index], token)
        if (exitCode !== undefined) {
            markerIndex = index
            break
        }
    }
    if (exitCode === undefined) return undefined

    const tokenPrefix = `${INTERNAL_COMMAND_EXIT_MARKER_PREFIX}${token}:`
    let echoIndex = markerIndex - 1
    while (echoIndex >= 0 && !lines[echoIndex].includes(tokenPrefix)) echoIndex--
    const output = echoIndex < 0 ? undefined : lines.slice(echoIndex + 1, markerIndex).join("\n")
    return { exitCode, output }
}

export function containsInternalCommandExitMarker(value: string): boolean {
    return value.includes(INTERNAL_COMMAND_EXIT_MARKER_PREFIX)
}

export function removeInternalCommandExitMarkers(output: string): string {
    return output.replace(INTERNAL_COMMAND_EXIT_MARKER_LINE_PATTERN, "")
}
